/**
 * Reconnect windows and chatd's schedules (WO-2026-107 § 1 Waits, § 3, § 4;
 * test review round 1 items 1 and 2). "Reconnects once" is one window of at
 * most 30 s per drop; a later drop gets its own (coordinator, rework round 1).
 * The window and the intervals are shortened through internal test seams.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MatrixEvent } from "../../apps/chatd/matrix.ts";
import chat from "../../extensions/chat/index.ts";
import { pendingWaits } from "../../extensions/lib/waits.ts";
import { type PiStandin, makePiPeer } from "../chat-behaviour/adapters/pi-standin.ts";
import { injectedWith, until } from "../chat-behaviour/bus.ts";
import { ClaudeProcess } from "../chat-behaviour/claude-process.ts";
import { type TestChatd, startChatdWithHomeserver } from "../helpers/chatd.ts";
import { TUWUNEL_PLATFORM_OK } from "../helpers/tuwunel.ts";

import { childEnv, scrubSubagentEnv } from "../helpers/subagent-env.ts";
import { asCall, connectPeer, q, quiet, uniq } from "./harness.ts";

/** The pinned Tuwunel runs on Linux x86_64 only; elsewhere these rows skip. */
const chatRows = TUWUNEL_PLATFORM_OK ? describe : describe.skip;

const restoreSubagentEnv = scrubSubagentEnv();
afterAll(restoreSubagentEnv);

const CLI = join(import.meta.dir, "..", "..", "apps", "chatd", "cli.ts");
const WINDOW = "1500";

let t: TestChatd;
const standins: PiStandin[] = [];
const procs: ClaudeProcess[] = [];
beforeAll(async () => {
	if (!TUWUNEL_PLATFORM_OK) return;
	t = await startChatdWithHomeserver();
}, 60_000);
afterAll(async () => {
	if (!TUWUNEL_PLATFORM_OK) return;
	for (const s of standins) await s.shutdown();
	for (const p of procs) p.dispose();
	await t.dispose();
});

async function pi(name: string) {
	const s = await makePiPeer({
		factory: (api: ExtensionAPI) => chat(api),
		envName: name,
		kind: "pi",
		options: {},
		env: { CHATD_SOCKET: t.socket, CHAT_RECONNECT_MS: WINDOW },
		roles: { send: "chat_send", who: "chat_who" },
		selfName: async (tool) => ((await tool("who", {})).details as { self: string }).self,
		waits: () => pendingWaits({ branch: () => [], persist() {} }).filter((w) => w.kind === "peer"),
	});
	standins.push(s);
	return s.peer;
}

async function claude() {
	const proc = await ClaudeProcess.start(CLI, childEnv({ CHATD_SOCKET: t.socket, CHAT_RECONNECT_MS: WINDOW }));
	procs.push(proc);
	const sid = crypto.randomUUID();
	await proc.run(["hook", "session-start"], JSON.stringify({ session_id: sid, cwd: "/w" }));
	return { proc, name: `claude-${sid}` };
}

chatRows("reconnect windows", () => {
	it("send --wait: chatd gone and not back within the window exits 1 naming chatd", async () => {
		const c = await claude();
		const p = await connectPeer(t, uniq("p"));
		const waiter = c.proc.spawn(["send", "--from", c.name, "--wait", "1", p.name, "anyone?"]);
		await p.pushed("anyone?");
		await t.kill();
		try {
			const r = await waiter.exited;
			expect(r.code).toBe(1);
			expect(r.err).toContain("chatd did not come back within 2 s");
		} finally {
			await t.start();
		}
	}, 60_000);

	it("a CLI verb with chatd down exits 1 naming chatd", async () => {
		const c = await claude();
		await t.kill();
		try {
			const r = await c.proc.run(["who", "--from", c.name]);
			expect(r.code).toBe(1);
			expect(r.err).toContain(`chatd is not reachable at ${t.socket}`);
		} finally {
			await t.start();
		}
	}, 60_000);

	it("send --wait: each drop gets its own window; two restarts during a wait still end in the reply", async () => {
		const c = await claude();
		const p = await connectPeer(t, uniq("p"));
		const waiter = c.proc.spawn(["send", "--from", c.name, "--wait", "1", p.name, "twice?"]);
		const ask = await p.pushed("twice?");
		await t.kill();
		await t.start();
		await quiet(1_000);
		await t.kill();
		await t.start();
		const p2 = await connectPeer(t, p.name);
		await quiet(1_000);
		await p2.req("send", { to: c.name, text: "after two drops", replyTo: ask.event_id });
		const r = await waiter.exited;
		expect(r.code).toBe(0);
		expect(r.out).toContain("after two drops");
		p2.close();
	}, 60_000);

	it("the extension: a drop with chatd not back within the window notifies the session", async () => {
		const b = await pi(uniq("b"));
		await t.kill();
		try {
			await until(() => b.notices.find((n) => n.level === "error" && n.message.includes("lost chatd")), 10_000, "the lost-chatd notice");
			expect(b.notices.find((n) => n.message.includes("lost chatd"))?.message).toContain("chatd did not come back");
		} finally {
			await t.start();
		}
	}, 60_000);

	it("the extension: a second drop after a reconnect reconnects again", async () => {
		const name = uniq("b");
		const b = await pi(name);
		for (const round of [1, 2]) {
			await t.kill();
			await t.start();
			const a = await connectPeer(t, uniq("a"));
			await until(async () => {
				try {
					await a.req("send", { to: name, text: `round ${round}`, requireOnline: true });
					return true;
				} catch {
					await quiet(200);
					return undefined;
				}
			}, 15_000, `${name} back online, round ${round}`);
			await injectedWith(b, `round ${round}`);
			a.close();
		}
		expect(b.notices.filter((n) => n.message.includes("lost chatd"))).toEqual([]);
	}, 60_000);
});

chatRows("schedules", () => {
	it("the presence pass runs on its own: a dead Claude pid shows offline with no prompting", async () => {
		await t.restart({ TEST_PRESENCE_PASS_MS: "300" });
		try {
			const sleeper = Bun.spawn(["sleep", "600"], { env: childEnv() });
			const name = uniq("claude");
			const cl = await connectPeer(t, name, "claude", { claudePid: sleeper.pid });
			sleeper.kill("SIGKILL");
			await sleeper.exited;
			await until(
				async () => {
					const pr = (await asCall(t, "GET", `/_matrix/client/v3/presence/${q(cl.userId)}/status`, `@pi-system:${t.hs.serverName}`)).json;
					return pr.presence === "offline" ? true : undefined;
				},
				10_000,
				"presence offline from the pass",
			);
			cl.close();
		} finally {
			await t.restart({});
		}
	}, 60_000);

	it("the mirror sweep runs on its own schedule", async () => {
		const a = await connectPeer(t, uniq("a"));
		const b = await connectPeer(t, uniq("b"));
		await a.req("send", { to: b.name, text: "swept on schedule" });
		await b.pushed("swept on schedule");
		a.close();
		b.close();
		const sys = `@pi-system:${t.hs.serverName}`;
		const mirror = (await asCall(t, "GET", `/_matrix/client/v3/directory/room/${q(`#dm-mirror:${t.hs.serverName}`)}`)).json.room_id;
		const copies = async () =>
			((await asCall(t, "GET", `/_matrix/client/v3/rooms/${q(mirror)}/messages?dir=b&limit=100`, sys)).json.chunk as MatrixEvent[]).filter((e) =>
				String(e.content.body ?? "").includes("swept on schedule"),
			).length;
		await until(async () => ((await copies()) === 1 ? true : undefined), 10_000, "the copy");
		await t.restart({ TEST_NOW_OFFSET_MS: String(8 * 86_400_000), TEST_SWEEP_MS: "300" });
		try {
			await until(async () => ((await copies()) === 0 ? true : undefined), 10_000, "the scheduled sweep");
		} finally {
			await t.restart({});
		}
	}, 60_000);
});
