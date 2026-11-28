/**
 * Rows from WO-2026-107's first review round: the code review's findings
 * (H1, H2, M1, M2, M4, M5, M7, M8 and the LOWs pinned here), the owner's
 * departure rulings (4, 6, 7, 9; 12 is in tests/chat-behaviour/claude.test.ts),
 * and the test review's verb and boundary rows.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classify } from "../../apps/chatd/classify.ts";
import type { MatrixEvent } from "../../apps/chatd/matrix.ts";
import { localpart } from "../../apps/chatd/names.ts";
import type { PeerEntry, Pushed } from "../../apps/chatd/protocol.ts";
import chat from "../../extensions/chat/index.ts";
import { pendingWaits } from "../../extensions/lib/waits.ts";
import { type PiStandin, makePiPeer } from "../chat-behaviour/adapters/pi-standin.ts";
import { injectedWith, until } from "../chat-behaviour/bus.ts";
import { ClaudeProcess } from "../chat-behaviour/claude-process.ts";
import { type TestChatd, startChatdWithHomeserver } from "../helpers/chatd.ts";
import { childEnv, scrubSubagentEnv } from "../helpers/subagent-env.ts";
import { TUWUNEL_PLATFORM_OK, ownerLogin } from "../helpers/tuwunel.ts";
import { asCall, connectPeer, ownerCall, q, quiet, uniq } from "./harness.ts";

/** The pinned Tuwunel runs on Linux x86_64 only; elsewhere these rows skip. */
const chatRows = TUWUNEL_PLATFORM_OK ? describe : describe.skip;

const restoreSubagentEnv = scrubSubagentEnv();
afterAll(restoreSubagentEnv);

const CLI = join(import.meta.dir, "..", "..", "apps", "chatd", "cli.ts");

let t: TestChatd;
let ownerToken: string;
const standins: PiStandin[] = [];
const procs: ClaudeProcess[] = [];
beforeAll(async () => {
	if (!TUWUNEL_PLATFORM_OK) return;
	t = await startChatdWithHomeserver();
	ownerToken = await ownerLogin(t.hs);
}, 60_000);
afterAll(async () => {
	if (!TUWUNEL_PLATFORM_OK) return;
	for (const s of standins) await s.shutdown();
	for (const p of procs) p.dispose();
	await t.dispose();
});

const user = (name: string) => `@${localpart(name)}:${t.hs.serverName}`;

async function pi(name: string, options: { inject?: (text: string) => void; sessionFile?: string; env?: Record<string, string> } = {}) {
	const s = await makePiPeer({
		factory: (api: ExtensionAPI) => chat(api),
		envName: name,
		kind: "pi",
		options: { inject: options.inject, sessionFile: options.sessionFile, sessionId: `${name}-sid` },
		env: { CHATD_SOCKET: t.socket, ...(options.env ?? {}) },
		roles: { send: "chat_send", who: "chat_who" },
		selfName: async (tool) => ((await tool("who", {})).details as { self: string }).self,
		waits: () => pendingWaits({ branch: () => [], persist() {} }).filter((w) => w.kind === "peer"),
	});
	standins.push(s);
	return { ...s.peer, shutdown: s.shutdown, peer: s.peer };
}

async function marker(name: string, room: string): Promise<string | undefined> {
	const r = await asCall(t, "GET", `/_matrix/client/v3/user/${q(user(name))}/rooms/${q(room)}/account_data/dev.pi.pushed`, user(name));
	return r.status === 200 ? r.json.event_id : undefined;
}

async function untilJoined(name: string, room: string): Promise<void> {
	await until(
		async () => ((await asCall(t, "GET", "/_matrix/client/v3/joined_rooms", user(name))).json.joined_rooms.includes(room) ? true : undefined),
		10_000,
		`${name} in ${room}`,
	);
}

chatRows("H1: ack is idempotent", () => {
	it("a repeated ack, alone or in a batch, reports already-acked and acks the rest", async () => {
		const a = await connectPeer(t, uniq("a"));
		const b = await connectPeer(t, uniq("b"));
		await a.req("send", { to: b.name, text: "one" });
		await a.req("send", { to: b.name, text: "two" });
		const one = await b.pushed("one");
		const two = await b.pushed("two");
		expect(await b.req("ack", { event_ids: [one.event_id] })).toEqual({ acked: [one.event_id], already: [] });
		expect(await b.req("ack", { event_ids: [one.event_id] })).toEqual({ acked: [], already: [one.event_id] });
		expect(await b.req("ack", { event_ids: [one.event_id, two.event_id] })).toEqual({ acked: [two.event_id], already: [one.event_id] });
		expect(await marker(b.name, two.room_id)).toBe(two.event_id);
		a.close();
		b.close();
	}, 30_000);

	it("ack input is a list of event ids", async () => {
		const b = await connectPeer(t, uniq("b"));
		await expect(b.req("ack", { event_ids: "$abc" })).rejects.toThrow("list of event ids");
		await expect(b.req("ack", {})).rejects.toThrow("list of event ids");
		b.close();
	}, 30_000);
});

chatRows("H2 and departure 4: what a reconnecting puppet catches up", () => {
	it("a DM sent while a subagent was offline arrives although its derived display name changed", async () => {
		const name = uniq("sub");
		const first = await connectPeer(t, name, "subagent", { cwd: "/tmp/aaa" });
		const a = await connectPeer(t, uniq("a"));
		await a.req("send", { to: name, text: "before" });
		// Unacked: no marker, so the reconnect pages back to the start of membership.
		await first.pushed("before");
		first.close();
		await quiet(300);
		await a.req("send", { to: name, text: "while-offline" });
		await quiet(300);
		const back = await connectPeer(t, name, "subagent", { cwd: "/tmp/bbb" });
		const got = await back.pushed("while-offline");
		expect(got.sender).toBe(a.name);
		const profile = (await asCall(t, "GET", `/_matrix/client/v3/profile/${q(back.userId)}`, back.userId)).json;
		expect(profile.displayname).toMatch(/^bbb subagent/);
		a.close();
		back.close();
	}, 30_000);

	it("an offline puppet invited and messaged while chatd was down gets the message at hello: catch-up from the invite", async () => {
		const name = uniq("b");
		(await connectPeer(t, name)).close();
		await quiet(300);
		await t.kill();
		const dm = (await ownerCall(t, ownerToken, "POST", "/_matrix/client/v3/createRoom", { preset: "trusted_private_chat", is_direct: true, invite: [user(name)] })).json.room_id;
		await ownerCall(t, ownerToken, "PUT", `/_matrix/client/v3/rooms/${q(dm)}/send/m.room.message/early${Date.now()}`, { msgtype: "m.text", body: "sent before the join" });
		await t.start();
		await untilJoined(name, dm);
		const b = await connectPeer(t, name);
		const got = await b.pushed("sent before the join");
		expect(got.sender).toBe("owner");
		b.close();
	}, 60_000);

	it("rooms chatd creates keep shared history: a later member reads messages from before it joined", async () => {
		const a = await connectPeer(t, uniq("a"));
		const b = await connectPeer(t, uniq("b"));
		const room = await a.req<{ room: string; room_id: string }>("rooms", { action: "create", name: uniq("hist") });
		await a.req("send", { to: room.room, text: "said before b came" });
		await a.req("send", { to: room.room, text: `@${b.name} join us` });
		await b.pushed("invited you to");
		await b.req("rooms", { action: "join", room: room.room_id });
		const read = await b.req<{ events: Pushed[] }>("read", { room: room.room_id });
		expect(read.events.map((e) => e.body)).toContain("said before b came");
		const hv = await asCall(t, "GET", `/_matrix/client/v3/rooms/${q(room.room_id)}/state/m.room.history_visibility/`, a.userId);
		expect(hv.json.history_visibility).toBe("shared");
		a.close();
		b.close();
	}, 30_000);
});

chatRows("departure 9: pending invites at hello", () => {
	it("an invite to an offline puppet is pushed when it connects, once", async () => {
		const name = uniq("b");
		(await connectPeer(t, name)).close();
		await quiet(300);
		const a = await connectPeer(t, uniq("a"));
		const room = await a.req<{ room: string }>("rooms", { action: "create", name: uniq("inv"), invite: [name] });
		await quiet(500);
		const b = await connectPeer(t, name);
		const inv = await b.pushed(`invited you to ${room.room}`);
		expect(inv.sender).toBe(a.name);
		await b.ack(inv);
		b.close();
		await quiet(300);
		const again = await connectPeer(t, name);
		await quiet();
		expect(again.pushes.some((p) => p.what === "invite")).toBe(false);
		a.close();
		again.close();
	}, 30_000);
});

chatRows("M1: one DM room per pair", () => {
	it("two first sends at once make one room, and DMs to two peers at once both land in m.direct", async () => {
		const a = await connectPeer(t, uniq("a"));
		const b = await connectPeer(t, uniq("b"));
		const c = await connectPeer(t, uniq("c"));
		const [r1, r2] = await Promise.all([
			a.req<{ room: string }>("send", { to: b.name, text: "x" }),
			b.req<{ room: string }>("send", { to: a.name, text: "y" }),
		]);
		expect(r1.room).toBe(r2.room);
		const [rb, rc] = await Promise.all([
			c.req<{ room: string }>("send", { to: a.name, text: "p" }),
			c.req<{ room: string }>("send", { to: b.name, text: "q" }),
		]);
		const direct = (await asCall(t, "GET", `/_matrix/client/v3/user/${q(c.userId)}/account_data/m.direct`, c.userId)).json;
		expect(direct[a.userId]).toEqual([rb.room]);
		expect(direct[b.userId]).toEqual([rc.room]);
		for (const p of [a, b, c]) p.close();
	}, 30_000);
});

chatRows("M2: claimed events come back when the waiter goes", () => {
	it("a wait result's events show at the next prompt when the waiter closed without acking", async () => {
		const name = uniq("claude");
		const p = await connectPeer(t, uniq("p"));
		const waiter = await connectPeer(t, name, "claude");
		const sent = await waiter.req<{ event_id: string; room: string }>("send", { to: p.name, text: "q?" });
		const wait = waiter.req<{ outcome: string; events: Pushed[] }>("wait", { event_id: sent.event_id, room: sent.room, minutes: 1 });
		await p.pushed("q?");
		await p.req("send", { to: name, text: "the answer", replyTo: sent.event_id });
		const r = await wait;
		expect(r.events.map((e) => e.body)).toContain("the answer");
		const other = await connectPeer(t, name, "claude");
		expect((await other.req<{ events: Pushed[] }>("pending")).events.map((e) => e.body)).not.toContain("the answer");
		waiter.close();
		await quiet(300);
		expect((await other.req<{ events: Pushed[] }>("pending")).events.map((e) => e.body)).toContain("the answer");
		p.close();
		other.close();
	}, 30_000);
});

chatRows("M7, M8: one session per name", () => {
	it("two pi hellos for one name at once: exactly one connects", async () => {
		const name = uniq("pi");
		const results = await Promise.allSettled([connectPeer(t, name), connectPeer(t, name)]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		for (const r of results) if (r.status === "fulfilled") r.value.close();
	}, 30_000);

	it("a pi hello does not replace a live Claude session of that name", async () => {
		const name = uniq("shared");
		const cl = await connectPeer(t, name, "claude");
		await expect(connectPeer(t, name, "pi")).rejects.toThrow("already connected (a claude session)");
		const who = await cl.req<PeerEntry[]>("who");
		expect(who.find((p) => p.name === name)?.kind).toBe("claude");
		cl.close();
	}, 30_000);
});

chatRows("M4: the extension acks after a reconnect", () => {
	it("a message injected just before chatd died is acked once the extension reconnects", async () => {
		const a = await connectPeer(t, uniq("a"));
		let kill = false;
		const b = await pi(uniq("b"), {
			env: { CHAT_RECONNECT_MS: "20000" },
			inject: (text) => {
				// Dies after the injection, before the ack reaches it.
				if (kill && text.includes("die after me")) {
					kill = false;
					Bun.spawnSync(["kill", "-9", String(t.pid())]);
				}
			},
		});
		const sent = await a.req<{ room: string }>("send", { to: b.name, text: "warm up" });
		await injectedWith(b.peer, "warm up");
		await until(async () => ((await marker(b.name, sent.room)) ? true : undefined), 10_000, "warm-up acked");
		kill = true;
		const last = await a.req<{ event_id: string }>("send", { to: b.name, text: "die after me" }).catch(() => undefined);
		await injectedWith(b.peer, "die after me");
		await t.kill();
		await t.start();
		await until(async () => ((await marker(b.name, sent.room)) === last?.event_id ? true : undefined), 20_000, "the marker at the last message");
		expect(b.injected.filter((m) => m.text.includes("die after me"))).toHaveLength(1);
		a.close();
	}, 60_000);
});

chatRows("M5 and the CLI's gone session", () => {
	it("watch exits 3 when the session already ended", async () => {
		const proc = await ClaudeProcess.start(CLI, childEnv({ CHATD_SOCKET: t.socket }));
		procs.push(proc);
		const sid = crypto.randomUUID();
		const hook = (event: string) => proc.run(["hook", event], JSON.stringify({ session_id: sid, cwd: "/w" }));
		await hook("session-start");
		await hook("session-end");
		const r = await proc.run(["watch", "--from", `claude-${sid}`]);
		expect(r.code).toBe(3);
		expect(r.out).toContain("watch exiting");
	}, 30_000);
});

chatRows("departures 6 and 7: what who shows", () => {
	it("/chat-autoreply off persists across a restart of the session and shows in who", async () => {
		const name = uniq("auto");
		const first = await pi(name);
		await first.peer.command("chat-autoreply", "off");
		await first.shutdown();
		await quiet(300);
		const again = await pi(name);
		const entry = ((await again.peer.tool("who", {})).details as { peers: PeerEntry[] }).peers.find((p) => p.name === name)!;
		expect(entry.autoreply).toBe(false);
		expect((await again.peer.tool("who", {})).text).toContain(`${name} (online, pi, auto-reply off)`);
	}, 30_000);

	it("the presence status and dev.pi.session carry the session id; dev.pi.session_file the log", async () => {
		const name = uniq("sess");
		await pi(name, { sessionFile: "/s/the-log.jsonl" });
		const prof = (await asCall(t, "GET", `/_matrix/client/v3/profile/${q(user(name))}`, user(name))).json;
		expect(prof["dev.pi.session"]).toBe(`${name}-sid`);
		expect(prof["dev.pi.session_file"]).toBe("/s/the-log.jsonl");
		await until(
			async () => {
				const pr = (await asCall(t, "GET", `/_matrix/client/v3/presence/${q(user(name))}/status`, `@pi-system:${t.hs.serverName}`)).json;
				return pr.status_msg === `${name}-sid` ? true : undefined;
			},
			10_000,
			"presence status",
		);
	}, 30_000);
});

chatRows("test review item 6: the verbs", () => {
	it("read moves m.read and m.fully_read, and never dev.pi.pushed", async () => {
		const a = await connectPeer(t, uniq("a"));
		const b = await connectPeer(t, uniq("b"));
		const sent = await a.req<{ event_id: string; room: string }>("send", { to: b.name, text: "read me" });
		await b.pushed("read me");
		await b.req("read", { room: a.name });
		const sync = (await asCall(t, "GET", "/_matrix/client/v3/sync?timeout=0", b.userId)).json;
		const joined = sync.rooms.join[sent.room];
		const fully = joined.account_data.events.find((e: { type: string }) => e.type === "m.fully_read");
		expect(fully.content.event_id).toBe(sent.event_id);
		const receipts = joined.ephemeral.events.find((e: { type: string }) => e.type === "m.receipt");
		expect(receipts.content[sent.event_id]["m.read"][b.userId]).toBeDefined();
		expect(await marker(b.name, sent.room)).toBeUndefined();
		a.close();
		b.close();
	}, 30_000);

	it("rooms level writes and removes the puppet's room push rule, and list reports the level", async () => {
		const a = await connectPeer(t, uniq("a"));
		const room = await a.req<{ room: string; room_id: string }>("rooms", { action: "create", name: uniq("lvl") });
		await a.req("rooms", { action: "level", room: room.room, level: "mentions" });
		const rule = await asCall(t, "GET", `/_matrix/client/v3/pushrules/global/room/${q(room.room_id)}`, a.userId);
		expect(rule.status).toBe(200);
		expect(rule.json.actions).toEqual([]);
		const list = await a.req<{ joined: { room_id: string; level: string }[] }>("rooms", { action: "list" });
		expect(list.joined.find((r) => r.room_id === room.room_id)?.level).toBe("mentions");
		await a.req("rooms", { action: "level", room: room.room, level: "all" });
		expect((await asCall(t, "GET", `/_matrix/client/v3/pushrules/global/room/${q(room.room_id)}`, a.userId)).status).toBe(404);
		a.close();
	}, 30_000);

	it("rooms leave leaves; rooms list shows pending invites with their inviter", async () => {
		const a = await connectPeer(t, uniq("a"));
		const b = await connectPeer(t, uniq("b"));
		const room = await a.req<{ room: string; room_id: string }>("rooms", { action: "create", name: uniq("lv"), invite: [b.name] });
		await b.pushed("invited you to");
		const list = await b.req<{ invites: { room_id: string; inviter: string }[] }>("rooms", { action: "list" });
		expect(list.invites.find((r) => r.room_id === room.room_id)?.inviter).toBe(a.name);
		await a.req("rooms", { action: "leave", room: room.room });
		expect((await asCall(t, "GET", "/_matrix/client/v3/joined_rooms", a.userId)).json.joined_rooms).not.toContain(room.room_id);
		a.close();
		b.close();
	}, 30_000);

	it("the extension's tools and commands: chat_read, chat_rooms, /chat-send, and the auto-reply", async () => {
		const a = await connectPeer(t, uniq("a"));
		const b = await pi(uniq("b"));
		const request = await a.req<{ event_id: string }>("send", { to: b.name, text: "for chat_read", expectReply: true });
		const asked = await injectedWith(b.peer, "for chat_read");
		const read = await b.peer.tool("chat_read", { room: a.name });
		expect(read.text).toContain("for chat_read");
		const rooms = await b.peer.tool("chat_rooms", { action: "list" });
		expect(rooms.text).toContain("#peers");
		// The auto-reply: the turn after the request is answered once, as a reply to it.
		b.peer.branch.push(
			{ type: "message", message: { role: "user", content: asked.text } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "auto answer" }] } },
		);
		await b.peer.emit("agent_settled");
		const reply = await a.pushed("auto answer");
		expect(reply.replyTo).toBe(request.event_id);
		await b.peer.emit("agent_settled");
		await quiet();
		expect(a.pushes.filter((p) => p.body === "auto answer")).toHaveLength(1);
		await b.peer.command("chat-send", `${a.name} via the command`);
		await a.pushed("via the command");
		a.close();
	}, 30_000);
});

chatRows("test review items 4 and 5: catch-up paths and paging", () => {
	it("a wait registered after its reply exists ends through the relations listing alone (a relayed reply in a room)", async () => {
		const asker = await connectPeer(t, uniq("asker"), "claude");
		const relay = await connectPeer(t, uniq("relay"));
		const ask = await asker.req<{ event_id: string; room: string }>("send", { to: "#peers", text: "release branch?" });
		await relay.req("send", { to: "#peers", text: "release-2", replyTo: ask.event_id });
		await quiet(800);
		const r = await asker.req<{ outcome: string; reply: Pushed }>("wait", { event_id: ask.event_id, room: ask.room, minutes: 0.05 });
		expect(r.outcome).toBe("reply");
		expect(r.reply.body).toBe("release-2");
		asker.close();
		relay.close();
	}, 30_000);

	it("a target's DM with no reply stamp, sent before the wait registered, ends it through the DM scan alone", async () => {
		const asker = await connectPeer(t, uniq("asker"), "claude");
		const p = await connectPeer(t, uniq("p"));
		const ask = await asker.req<{ event_id: string; room: string }>("send", { to: p.name, text: "status?" });
		await p.pushed("status?");
		await p.req("send", { to: asker.name, text: "green, unstamped" });
		await quiet(800);
		const r = await asker.req<{ outcome: string; reply: Pushed }>("wait", { event_id: ask.event_id, room: ask.room, minutes: 0.05 });
		expect(r.outcome).toBe("reply");
		expect(r.reply.body).toBe("green, unstamped");
		asker.close();
		p.close();
	}, 30_000);

	it("an offline peer's backlog spans more than one page: 130 DMs all arrive", async () => {
		const name = uniq("b");
		(await connectPeer(t, name)).close();
		const a = await connectPeer(t, uniq("a"));
		const r = await a.req<{ room: string }>("send", { to: name, text: "m0" });
		for (let i = 1; i < 130; i++) {
			await asCall(t, "PUT", `/_matrix/client/v3/rooms/${q(r.room)}/send/m.room.message/bulk${i}-${Date.now()}`, a.userId, { msgtype: "m.text", body: `m${i}` });
		}
		await quiet(500);
		const b = await connectPeer(t, name);
		await b.pushed("m129");
		const bodies = new Set(b.pushes.map((p) => p.body));
		for (let i = 0; i < 130; i++) expect(bodies.has(`m${i}`)).toBe(true);
		a.close();
		b.close();
	}, 60_000);
});

chatRows("LOWs pinned", () => {
	it("a socket line that is not a request object answers an error and chatd lives", async () => {
		const c = await t.client();
		const raw = (c as unknown as { socket: import("node:net").Socket }).socket;
		raw.write("null\n42\n[]\n");
		const answer = new Promise<string>((resolve) => raw.once("data", (d) => resolve(String(d))));
		raw.write('{"id": 99}\n');
		expect(await answer).toContain('"id":99');
		expect(await answer).toContain("a request is an object with a verb");
		await quiet(300);
		const b = await connectPeer(t, uniq("b"));
		expect(b.userId).toContain("@pi-");
		b.close();
		c.close();
	}, 30_000);

	it("an @mention at a sentence end mentions the peer", () => {
		const e: MatrixEvent = { event_id: "$e", room_id: "!r", sender: "@x:s", type: "m.room.message", origin_server_ts: 1, content: { body: "thanks @bob." } };
		const r = { userId: "@pi-bob:s", peer: "bob", kind: "pi" as const, membership: () => "join" as const, isDirect: () => false, level: () => "mentions" as const };
		expect(classify(e, "!r", r)).toBe("push");
		expect(classify({ ...e, content: { body: "see @bob.tail" } }, "!r", r)).toBe("none");
	});

	it("row 16 companion: a body @mention with no m.mentions at all pushes", async () => {
		const b = await connectPeer(t, uniq("b"));
		const room = (await asCall(t, "GET", `/_matrix/client/v3/directory/room/${q(`#peers:${t.hs.serverName}`)}`)).json.room_id;
		await ownerCall(t, ownerToken, "POST", `/_matrix/client/v3/join/${q(room)}`, {});
		await ownerCall(t, ownerToken, "PUT", `/_matrix/client/v3/rooms/${q(room)}/send/m.room.message/nm${Date.now()}`, { msgtype: "m.text", body: `@${b.name} no mentions key` });
		await b.pushed("no mentions key");
		b.close();
	}, 30_000);

	it("the certificate DM is once a day across a chatd restart", async () => {
		const day = 86_400_000;
		const sys = `@pi-system:${t.hs.serverName}`;
		const certDms = async () => {
			const room = (await asCall(t, "GET", `/_matrix/client/v3/user/${q(sys)}/account_data/m.direct`, sys)).json[t.hs.owner.userId]?.[0];
			if (!room) return 0;
			const chunk = (await asCall(t, "GET", `/_matrix/client/v3/rooms/${q(room)}/messages?dir=b&limit=100`, sys)).json.chunk as MatrixEvent[];
			return chunk.filter((e) => String(e.content.body ?? "").includes("certificate expires")).length;
		};
		const env = { TEST_CERT_NOT_AFTER: new Date(Date.now() + 10 * day).toISOString() };
		await t.restart(env);
		await until(async () => ((await certDms()) > 0 ? true : undefined), 10_000, "the first DM");
		const n = await certDms();
		await t.restart(env);
		await t.control("cert");
		expect(await certDms()).toBe(n);
		await t.restart({});
	}, 60_000);
});
