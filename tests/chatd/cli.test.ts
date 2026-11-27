/**
 * The `chat` CLI against chatd and a real Tuwunel (WO-2026-107 § Behaviour
 * rows 6, 13, 21, 22). The CLI runs under a stand-in `claude` process, as
 * Claude Code's hooks and Bash tool run it.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { MatrixEvent } from "../../apps/chatd/matrix.ts";
import { ClaudeProcess } from "../chat-behaviour/claude-process.ts";
import { type TestChatd, startChatdWithHomeserver } from "../helpers/chatd.ts";
import { childEnv, scrubSubagentEnv } from "../helpers/subagent-env.ts";
import { asCall, connectPeer, q, quiet, uniq } from "./harness.ts";

const restoreSubagentEnv = scrubSubagentEnv();
afterAll(restoreSubagentEnv);

const CLI = join(import.meta.dir, "..", "..", "apps", "chatd", "cli.ts");

let t: TestChatd;
const procs: ClaudeProcess[] = [];
beforeAll(async () => {
	t = await startChatdWithHomeserver();
}, 60_000);
afterAll(async () => {
	for (const p of procs) p.dispose();
	await t.dispose();
});

async function claude(): Promise<{ proc: ClaudeProcess; sid: string; name: string; hook: (event: string, extra?: Record<string, unknown>) => ReturnType<ClaudeProcess["run"]> }> {
	const proc = await ClaudeProcess.start(CLI, childEnv({ CHATD_SOCKET: t.socket }));
	procs.push(proc);
	const sid = crypto.randomUUID();
	const hook = (event: string, extra: Record<string, unknown> = {}) =>
		proc.run(["hook", event], JSON.stringify({ session_id: sid, cwd: "/w", hook_event_name: event, ...extra }));
	const start = await hook("session-start");
	expect(start.code).toBe(0);
	return { proc, sid, name: `claude-${sid}`, hook };
}

describe("row 6: a reply-wait ends per 015/33", () => {
	it("on the reply to its event", async () => {
		const c = await claude();
		const p = await connectPeer(t, uniq("p"));
		const waiter = c.proc.spawn(["send", "--from", c.name, "--wait", "1", p.name, "which branch?"]);
		const ask = await p.pushed("which branch?");
		await p.req("send", { to: "#peers", text: "unrelated chatter" });
		await p.req("send", { to: c.name, text: "main", replyTo: ask.event_id });
		const r = await waiter.exited;
		expect(r.code).toBe(0);
		expect(r.out).toContain(`[peer:${p.name}] main`);
	}, 30_000);

	it("on a reply relayed by a third peer", async () => {
		const c = await claude();
		const p = await connectPeer(t, uniq("p"));
		const relay = await connectPeer(t, uniq("relay"));
		const waiter = c.proc.spawn(["send", "--from", c.name, "--wait", "1", p.name, "route this"]);
		const ask = await p.pushed("route this");
		await relay.req("send", { to: "#peers", text: "p says: main", replyTo: ask.event_id });
		const r = await waiter.exited;
		expect(r.code).toBe(0);
		expect(r.out).toContain("p says: main");
	}, 30_000);

	it("on a DM from the target, with no reply stamp", async () => {
		const c = await claude();
		const p = await connectPeer(t, uniq("p"));
		const waiter = c.proc.spawn(["send", "--from", c.name, "--wait", "1", p.name, "status?"]);
		await p.pushed("status?");
		await p.req("send", { to: c.name, text: "all green" });
		const r = await waiter.exited;
		expect(r.code).toBe(0);
		expect(r.out).toContain("all green");
	}, 30_000);

	it("not on the target's post in a group room", async () => {
		const c = await claude();
		const p = await connectPeer(t, uniq("p"));
		const waiter = c.proc.spawn(["send", "--from", c.name, "--wait", "0.05", p.name, "status?"]);
		await p.pushed("status?");
		await p.req("send", { to: "#peers", text: `@${c.name} answering in the room` });
		const r = await waiter.exited;
		expect(r.code).toBe(4);
		expect(r.out).not.toContain("answering in the room");
	}, 30_000);

	it("on a reply sent while chatd was down, after the wait reconnects", async () => {
		const c = await claude();
		const p = await connectPeer(t, uniq("p"));
		const waiter = c.proc.spawn(["send", "--from", c.name, "--wait", "1", p.name, "during the outage?"]);
		const ask = await p.pushed("during the outage?");
		await t.kill();
		await asCall(t, "PUT", `/_matrix/client/v3/rooms/${q(ask.room_id)}/send/m.room.message/gap${Date.now()}`, p.userId, {
			msgtype: "m.text",
			body: "answered in the gap",
			"m.relates_to": { "m.in_reply_to": { event_id: ask.event_id } },
		});
		await t.start();
		const r = await waiter.exited;
		expect(r.code).toBe(0);
		expect(r.out).toContain("answered in the gap");
	}, 60_000);
});

describe("row 13: what wakes a watch", () => {
	it("a room post at all messages leaves it blocked; an @mention or a DM wakes it", async () => {
		const c = await claude();
		const p = await connectPeer(t, uniq("p"));
		for (const wake of [`@${c.name} look here`, "a direct word"]) {
			const watcher = c.proc.spawn(["watch", "--from", c.name]);
			await quiet(800);
			await p.req("send", { to: "#peers", text: "room traffic, no mention" });
			const blocked = await Promise.race([watcher.exited, Bun.sleep(1_500).then(() => "blocked" as const)]);
			expect(blocked).toBe("blocked");
			await p.req("send", wake.startsWith("@") ? { to: "#peers", text: wake } : { to: c.name, text: wake });
			const r = await watcher.exited;
			expect(r.code).toBe(0);
			expect(r.out).toContain(wake);
			expect(r.out).not.toContain("room traffic");
		}
	}, 40_000);
});

describe("row 21: the notification hook", () => {
	it("permission_prompt DMs the owner once; a second before the next prompt does not; after it, one more", async () => {
		const c = await claude();
		const user = `@pi-claude-${c.sid}:${t.hs.serverName}`;
		const ownerDm = async (): Promise<string[]> => {
			const direct = (await asCall(t, "GET", `/_matrix/client/v3/user/${q(user)}/account_data/m.direct`, user)).json;
			const room = direct[t.hs.owner.userId]?.[0];
			if (!room) return [];
			const msgs = (await asCall(t, "GET", `/_matrix/client/v3/rooms/${q(room)}/messages?dir=b&limit=50`, user)).json.chunk as MatrixEvent[];
			return msgs.filter((e) => e.type === "m.room.message").map((e) => String(e.content.body));
		};
		const note = { notification_type: "permission_prompt", message: "Claude needs your permission" };
		expect((await c.hook("notification", note)).code).toBe(0);
		expect((await c.hook("notification", note)).code).toBe(0);
		const once = await ownerDm();
		expect(once).toHaveLength(1);
		expect(once[0]).toMatch(/^w claude( \d+)? is waiting: Claude needs your permission$/);
		expect((await c.hook("notification", { notification_type: "auth_success", message: "x" })).code).toBe(0);
		expect(await ownerDm()).toHaveLength(1);
		await c.hook("prompt");
		await c.hook("notification", note);
		expect(await ownerDm()).toHaveLength(2);
	}, 30_000);
});

describe("row 22", () => {
	it("chat hook stop exits 1 as an unknown subcommand", async () => {
		const c = await claude();
		const r = await c.hook("stop");
		expect(r.code).toBe(1);
		expect(r.err).toContain('unknown hook subcommand "stop"');
	}, 30_000);
});
