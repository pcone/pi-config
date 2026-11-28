/**
 * Rows from WO-2026-107's second review round: N1 (a racing prompt hook and
 * watch print an event once), N2 (a pending-invite ack writes no marker), N3
 * (an unreadable marker does not fail hello), and the DM scan past one page.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { Pushed } from "../../apps/chatd/protocol.ts";
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
const DAY = 86_400_000;

let t: TestChatd;
const procs: ClaudeProcess[] = [];
beforeAll(async () => {
	if (!TUWUNEL_PLATFORM_OK) return;
	t = await startChatdWithHomeserver();
}, 60_000);
afterAll(async () => {
	if (!TUWUNEL_PLATFORM_OK) return;
	for (const p of procs) p.dispose();
	await t.dispose();
});

chatRows("N1: one event, two readers", () => {
	it("a prompt hook and a watch racing on one event print it once in total", async () => {
		await t.restart({ TEST_ACK_DELAY_MS: "2000" });
		try {
			const proc = await ClaudeProcess.start(CLI, childEnv({ CHATD_SOCKET: t.socket }));
			procs.push(proc);
			const sid = crypto.randomUUID();
			const name = `claude-${sid}`;
			const hookInput = JSON.stringify({ session_id: sid, cwd: "/w" });
			await proc.run(["hook", "session-start"], hookInput);
			const p = await connectPeer(t, uniq("p"));
			await p.req("send", { to: name, text: "race me" });
			await quiet(500);
			// Both take the event before either ack lands (acks are held 2 s).
			const prompt = proc.spawn(["hook", "prompt"], hookInput);
			const watch = proc.spawn(["watch", "--from", name]);
			const promptOut = (await prompt.exited).out;
			const watchOut = await Promise.race([watch.exited.then((r) => r.out), Bun.sleep(5_000).then(() => "")]);
			watch.kill();
			const printed = (promptOut + watchOut).split("race me").length - 1;
			expect(printed).toBe(1);
			p.close();
		} finally {
			await t.restart({});
		}
	}, 60_000);
});

chatRows("N2: a pending-invite ack writes no marker", () => {
	it("after an invite ack and a join, a message older than chatd's clock is still delivered", async () => {
		// chatd's clock runs a day ahead of the homeserver's.
		await t.restart({ TEST_NOW_OFFSET_MS: String(DAY) });
		try {
			const name = uniq("b");
			(await connectPeer(t, name)).close();
			await quiet(300);
			const a = await connectPeer(t, uniq("a"));
			const room = await a.req<{ room: string; room_id: string }>("rooms", { action: "create", name: uniq("n2"), invite: [name] });
			await quiet(500);
			const b = await connectPeer(t, name);
			const inv = await b.pushed("invited you to");
			expect(inv.event_id).toBe(`invite:${room.room_id}`);
			await b.ack(inv);
			const pushedMarker = await asCall(t, "GET", `/_matrix/client/v3/user/${q(b.userId)}/rooms/${q(room.room_id)}/account_data/dev.pi.pushed`, b.userId);
			expect(pushedMarker.status).toBe(404);
			await b.req("rooms", { action: "join", room: room.room_id });
			await a.req("send", { to: room.room, text: `@${name} after the join` });
			await b.pushed("after the join");
			a.close();
			b.close();
		} finally {
			await t.restart({});
		}
	}, 60_000);
});

chatRows("N3: an unreadable marker", () => {
	it("a marker naming an event the homeserver will not show is logged, and hello catches up from membership start", async () => {
		const name = uniq("b");
		const a = await connectPeer(t, uniq("a"));
		const first = await connectPeer(t, name);
		const sent = await a.req<{ room: string }>("send", { to: name, text: "before" });
		await first.pushed("before");
		first.close();
		await asCall(t, "PUT", `/_matrix/client/v3/user/${q(first.userId)}/rooms/${q(sent.room)}/account_data/dev.pi.pushed`, first.userId, {
			event_id: "$no-such-event",
		});
		await a.req("send", { to: name, text: "after the bad marker" });
		const b = await connectPeer(t, name);
		await b.pushed("after the bad marker");
		expect(t.log()).toContain(`marker $no-such-event in ${sent.room} is unreadable`);
		a.close();
		b.close();
	}, 30_000);
});

chatRows("the DM scan past one page", () => {
	it("a wait registered after 120 DMs from its target ends on the first one after the ask", async () => {
		const asker = await connectPeer(t, uniq("asker"), "claude");
		const p = await connectPeer(t, uniq("p"));
		const ask = await asker.req<{ event_id: string; room: string }>("send", { to: p.name, text: "count?" });
		await p.pushed("count?");
		for (let i = 0; i < 120; i++) {
			await asCall(t, "PUT", `/_matrix/client/v3/rooms/${q(ask.room)}/send/m.room.message/scan${i}-${Date.now()}`, p.userId, { msgtype: "m.text", body: `dm${i}` });
		}
		await quiet(500);
		const r = await asker.req<{ outcome: string; reply: Pushed }>("wait", { event_id: ask.event_id, room: ask.room, minutes: 0.05 });
		expect(r.outcome).toBe("reply");
		expect(r.reply.body).toBe("dm0");
		asker.close();
		p.close();
	}, 60_000);
});
