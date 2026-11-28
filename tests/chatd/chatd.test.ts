/**
 * chatd against a real Tuwunel (WO-2026-107 § Behaviour rows 1–5, 7–12,
 * 14–20). Peers here are raw socket clients; the CLI and the pi extension
 * have their own rows. Each row uses fresh peer names on one server.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { classify } from "../../apps/chatd/classify.ts";
import { loadConfig, socketPath } from "../../apps/chatd/config.ts";
import type { MatrixEvent } from "../../apps/chatd/matrix.ts";
import { isValidPeerName, localpart, peerName } from "../../apps/chatd/names.ts";
import type { Pushed } from "../../apps/chatd/protocol.ts";
import { type TestChatd, startChatdWithHomeserver } from "../helpers/chatd.ts";
import { childEnv, scrubSubagentEnv } from "../helpers/subagent-env.ts";
import { TUWUNEL_PLATFORM_OK, ownerLogin } from "../helpers/tuwunel.ts";
import { asCall, connectPeer, ownerCall, puppet, q, quiet, uniq } from "./harness.ts";

/** The pinned Tuwunel runs on Linux x86_64 only; elsewhere these rows skip. */
const chatRows = TUWUNEL_PLATFORM_OK ? describe : describe.skip;

const restoreSubagentEnv = scrubSubagentEnv();
afterAll(restoreSubagentEnv);

let t: TestChatd;
let ownerToken: string;
beforeAll(async () => {
	if (!TUWUNEL_PLATFORM_OK) return;
	t = await startChatdWithHomeserver();
	ownerToken = await ownerLogin(t.hs);
}, 60_000);
afterAll(async () => {
	if (!TUWUNEL_PLATFORM_OK) return;
	await t.dispose();
});

const sys = () => `@pi-system:${t.hs.serverName}`;
const peersAlias = () => `#peers:${t.hs.serverName}`;

async function mdirect(user: string): Promise<Record<string, string[]>> {
	const r = await asCall(t, "GET", `/_matrix/client/v3/user/${q(user)}/account_data/m.direct`, user);
	return r.status === 200 ? r.json : {};
}

async function roomMessages(room: string, as: string): Promise<MatrixEvent[]> {
	const r = await asCall(t, "GET", `/_matrix/client/v3/rooms/${q(room)}/messages?dir=b&limit=200`, as);
	return r.json.chunk ?? [];
}

/** What `@pi-system` has said to the owner, newest first. */
async function systemToOwner(): Promise<string[]> {
	const room = (await mdirect(sys()))[t.hs.owner.userId]?.[0];
	if (!room) return [];
	return (await roomMessages(room, sys())).filter((e) => e.type === "m.room.message").map((e) => String(e.content.body));
}

async function peersRoom(): Promise<string> {
	return (await asCall(t, "GET", `/_matrix/client/v3/directory/room/${q(peersAlias())}`)).json.room_id;
}

const messages = (p: { pushes: Pushed[] }) => p.pushes.filter((x) => x.what === "message");

chatRows("rows 1–5: who a message reaches", () => {
	it("row 1: a DM from A reaches only B; creating it writes m.direct on both puppets", async () => {
		const a = await connectPeer(t, uniq("a"));
		const b = await connectPeer(t, uniq("b"));
		const c = await connectPeer(t, uniq("c"));
		const r = await a.req<{ room: string }>("send", { to: b.name, text: "for b only" });
		await b.pushed("for b only");
		await quiet();
		expect(messages(c)).toEqual([]);
		expect(messages(a)).toEqual([]);
		expect((await mdirect(a.userId))[b.userId]).toEqual([r.room]);
		expect((await mdirect(b.userId))[a.userId]).toEqual([r.room]);
		for (const p of [a, b, c]) p.close();
	}, 30_000);

	it("row 2: a room mention pushes to the named peer only; another member at all messages gets digest, unconsumed", async () => {
		const a = await connectPeer(t, uniq("a"));
		const b = await connectPeer(t, uniq("b"));
		const c = await connectPeer(t, uniq("c"));
		const r = await a.req<{ event_id: string; room: string }>("send", { to: "#peers", text: `hey @${b.name}, a question` });
		const got = await b.pushed("a question");
		expect(got.direct).toBe(false);
		expect(got.room).toBe("#peers");
		await quiet();
		expect(c.pushes.some((x) => x.body.includes("a question"))).toBe(false);
		const ev = (await roomMessages(r.room, c.userId)).find((e) => e.event_id === r.event_id)!;
		ev.room_id = r.room;
		const verdict = classify(ev, r.room, { userId: c.userId, peer: c.name, kind: "pi", membership: () => "join", isDirect: () => false, level: () => "all" });
		expect(verdict).toBe("digest");
		for (const p of [a, b, c]) p.close();
	}, 30_000);

	it("row 3: @room pushes to every non-subagent member, and not to a subagent member", async () => {
		const a = await connectPeer(t, uniq("a"));
		const b = await connectPeer(t, uniq("b"));
		const cl = await connectPeer(t, uniq("claude"), "claude");
		const s = await connectPeer(t, uniq("sub"), "subagent");
		await a.req("send", { to: "#peers", text: "@room standup in five" });
		await b.pushed("standup in five");
		const pending = await cl.req<{ events: Pushed[] }>("pending");
		expect(pending.events.some((e) => e.body.includes("standup in five"))).toBe(true);
		await quiet();
		expect(s.pushes.some((x) => x.body.includes("standup in five"))).toBe(false);
		for (const p of [a, b, cl, s]) p.close();
	}, 30_000);

	it("row 4: a subagent gets a DM and an @mention of it, no room message and no @room; an invite to it is joined", async () => {
		const a = await connectPeer(t, uniq("a"));
		const s = await connectPeer(t, uniq("sub"), "subagent");
		await a.req("send", { to: "#peers", text: "plain room chatter" });
		await a.req("send", { to: "#peers", text: "@room everyone" });
		await a.req("send", { to: "#peers", text: `ping @${s.name} directly` });
		await a.req("send", { to: s.name, text: "a dm for the subagent" });
		await s.pushed("a dm for the subagent");
		await s.pushed("directly");
		await quiet();
		expect(s.pushes.some((x) => x.body.includes("plain room chatter") || x.body.includes("everyone"))).toBe(false);
		// Not even a digest: a subagent gets no room traffic (015/30).
		const chatter = { event_id: "$c", room_id: "!r", sender: a.userId, type: "m.room.message", origin_server_ts: 1, content: { msgtype: "m.text", body: "plain room chatter" } };
		const subagent = { userId: s.userId, peer: s.name, kind: "subagent" as const, membership: () => "join" as const, isDirect: () => false, level: () => "all" as const };
		expect(classify(chatter, "!r", subagent)).toBe("none");
		const room = await a.req<{ room_id: string }>("rooms", { action: "create", name: uniq("sub-room"), invite: [s.name] });
		const deadline = Date.now() + 10_000;
		let joined: string[] = [];
		while (Date.now() < deadline) {
			joined = (await asCall(t, "GET", "/_matrix/client/v3/joined_rooms", s.userId)).json.joined_rooms;
			if (joined.includes(room.room_id)) break;
			await Bun.sleep(50);
		}
		expect(joined).toContain(room.room_id);
		a.close();
		s.close();
	}, 30_000);

	it("row 5: an @mention of a non-member in a #room send invites them, and the invite is pushed", async () => {
		const a = await connectPeer(t, uniq("a"));
		const b = await connectPeer(t, uniq("b"));
		const name = uniq("feat-x");
		const created = await a.req<{ room: string; room_id: string }>("rooms", { action: "create", name });
		await a.req("send", { to: created.room, text: `@${b.name} have a look` });
		const invite = await b.pushed(`invited you to #${name}`);
		expect(invite.what).toBe("invite");
		expect(invite.sender).toBe(a.name);
		const members = await asCall(t, "GET", `/_matrix/client/v3/rooms/${q(created.room_id)}/state/m.room.member/${q(b.userId)}`, a.userId);
		expect(members.json.membership).toBe("invite");
		a.close();
		b.close();
	}, 30_000);
});

chatRows("delivery state", () => {
	it("row 7: chatd killed between a push and its ack delivers the event once more; read before the ack loses nothing", async () => {
		const a = await connectPeer(t, uniq("a"));
		const bName = uniq("b");
		const b1 = await connectPeer(t, bName);
		const sent = await a.req<{ room: string }>("send", { to: bName, text: "survive the restart" });
		await b1.pushed("survive the restart");
		const read = await b1.req<{ events: Pushed[] }>("read", { room: a.name });
		expect(read.events.map((e) => e.body)).toContain("survive the restart");
		await t.kill();
		await t.start();
		const b2 = await connectPeer(t, bName);
		const again = await b2.pushed("survive the restart");
		await quiet();
		expect(b2.pushes.filter((x) => x.body === "survive the restart")).toHaveLength(1);
		await b2.ack(...b2.pushes);
		const marker = await asCall(t, "GET", `/_matrix/client/v3/user/${q(b2.userId)}/rooms/${q(sent.room)}/account_data/dev.pi.pushed`, b2.userId);
		expect(marker.json.event_id).toBe(again.event_id);
		b2.close();
		await quiet(300);
		const b3 = await connectPeer(t, bName);
		await quiet();
		expect(b3.pushes.filter((x) => x.body === "survive the restart")).toEqual([]);
		b3.close();
	}, 60_000);

	it("acks come in delivery order within a room; an out-of-order ack names the expected event", async () => {
		const a = await connectPeer(t, uniq("a"));
		const b = await connectPeer(t, uniq("b"));
		await a.req("send", { to: b.name, text: "first" });
		await a.req("send", { to: b.name, text: "second" });
		const second = await b.pushed("second");
		const first = await b.pushed("first");
		const head = b.pushes.find((p) => p.room_id === second.room_id)!;
		await expect(b.ack(second)).rejects.toThrow(`expected ${head.event_id}`);
		await b.ack(...b.pushes.slice(0, b.pushes.indexOf(first) + 1));
		await b.ack(second);
		a.close();
		b.close();
	}, 30_000);
});

chatRows("rows 8–11: the owner, the tokens, the homeserver", () => {
	it("row 8: the owner's DM reaches the session from owner, and send to owner reaches @scott", async () => {
		const b = await connectPeer(t, uniq("b"));
		const created = await ownerCall(t, ownerToken, "POST", "/_matrix/client/v3/createRoom", {
			preset: "trusted_private_chat",
			is_direct: true,
			invite: [b.userId],
		});
		const room = created.json.room_id;
		await ownerCall(t, ownerToken, "PUT", `/_matrix/client/v3/rooms/${q(room)}/send/m.room.message/o1`, { msgtype: "m.text", body: "hello agent" });
		const got = await b.pushed("hello agent");
		expect(got.sender).toBe("owner");
		expect(got.direct).toBe(true);
		const sent = await b.req<{ room: string }>("send", { to: "owner", text: "hello owner" });
		expect(sent.room).toBe(room);
		const seen = await ownerCall(t, ownerToken, "GET", `/_matrix/client/v3/rooms/${q(room)}/messages?dir=b&limit=20`);
		expect(seen.json.chunk.some((e: MatrixEvent) => e.sender === b.userId && e.content.body === "hello owner")).toBe(true);
		b.close();
	}, 30_000);

	it("send to owner with no DM yet creates one with is_direct, recorded in the puppet's m.direct only", async () => {
		const b = await connectPeer(t, uniq("b"));
		const sent = await b.req<{ room: string }>("send", { to: "owner", text: "first contact" });
		expect((await mdirect(b.userId))[t.hs.owner.userId]).toEqual([sent.room]);
		const inv = await asCall(t, "GET", `/_matrix/client/v3/rooms/${q(sent.room)}/state/m.room.member/${q(t.hs.owner.userId)}`, b.userId);
		expect(inv.json.membership).toBe("invite");
		expect(inv.json.is_direct).toBe(true);
		b.close();
	}, 30_000);

	it("row 9: the appservice token is refused for @scott", async () => {
		const room = await peersRoom();
		const r = await asCall(t, "PUT", `/_matrix/client/v3/rooms/${q(room)}/send/m.room.message/x1`, t.hs.owner.userId, { msgtype: "m.text", body: "forged" });
		expect(r.status).toBeGreaterThanOrEqual(400);
		expect(r.json.errcode).toBe("M_EXCLUSIVE");
	}, 30_000);

	it("row 10: with the homeserver down, send fails with the reason and nothing is queued", async () => {
		const a = await connectPeer(t, uniq("a"));
		const b = await connectPeer(t, uniq("b"));
		await a.req("send", { to: b.name, text: "warm up the dm" });
		await b.pushed("warm up the dm");
		await t.hs.stop();
		try {
			await expect(a.req("send", { to: b.name, text: "while down" })).rejects.toThrow(/homeserver unreachable/);
		} finally {
			await t.hs.start();
		}
		await quiet(2_000);
		expect(b.pushes.some((x) => x.body === "while down")).toBe(false);
		a.close();
		b.close();
	}, 60_000);

	it("row 11: a wrong or missing hs_token is refused with 403 and processes nothing; no log line carries a token", async () => {
		const b = await connectPeer(t, uniq("b"));
		const a = await connectPeer(t, uniq("a"));
		const r = await a.req<{ room: string }>("send", { to: b.name, text: "real" });
		await b.pushed("real");
		const forged = {
			events: [
				{ event_id: `$forged${Date.now()}`, room_id: r.room, sender: a.userId, type: "m.room.message", origin_server_ts: Date.now(), content: { msgtype: "m.text", body: "forged txn" } },
			],
		};
		const base = `http://127.0.0.1:${t.hs.appservicePort}/_matrix/app/v1/transactions/`;
		const wrong = "0".repeat(48);
		const put = (url: string, headers: Record<string, string> = {}) =>
			fetch(url, { method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(forged) });
		expect((await put(`${base}t1`)).status).toBe(403);
		expect((await put(`${base}t2`, { authorization: `Bearer ${wrong}` })).status).toBe(403);
		expect((await put(`${base}t3?access_token=${wrong}`)).status).toBe(403);
		await quiet();
		expect(b.pushes.some((x) => x.body === "forged txn")).toBe(false);
		// The right token in the query is accepted, and the URL is not logged with it.
		const ok = await fetch(`${base}t4?access_token=${t.hs.hsToken}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [] }) });
		expect(ok.status).toBe(200);
		const log = t.log();
		expect(log).toContain("refused PUT /_matrix/app/v1/transactions/t3");
		for (const secret of [t.hs.hsToken, t.hs.asToken, wrong]) expect(log.includes(secret)).toBe(false);
		a.close();
		b.close();
	}, 30_000);
});

chatRows("row 12: names", () => {
	it("Foo, foo, _foo and __ map to distinct localparts, and peerName inverts localpart", () => {
		const parts = ["Foo", "foo", "_foo", "__"].map(localpart);
		expect(new Set(parts).size).toBe(4);
		expect(parts).toEqual(["pi-_foo", "pi-foo", "pi-__foo", "pi-____"]);
		const alphabet = "abcXYZ019._-";
		const names = new Set<string>(["a", "Z".repeat(64), "A_B", "x-y.z", "a__b", "AbC_dE"]);
		let seed = 7;
		while (names.size < 400) {
			seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
			let n = "abcXYZ019"[seed % 9];
			const len = seed % 64;
			for (let i = 0; i < len; i++) {
				seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
				n += alphabet[seed % alphabet.length];
			}
			names.add(n.slice(0, 64));
		}
		for (const n of names) {
			expect(isValidPeerName(n)).toBe(true);
			expect(peerName(localpart(n))).toBe(n);
		}
		expect(Math.max(...[...names].map((n) => localpart(n).length))).toBeLessThanOrEqual(131);
		expect(localpart("Z".repeat(64)).length).toBe(131);
	});

	it("a 65-character or out-of-alphabet name fails at hello, naming the rule; system is no client's name", async () => {
		for (const bad of ["x".repeat(65), "has space", "a/b", "_lead"]) {
			await expect(connectPeer(t, bad)).rejects.toThrow("1-64 chars of [A-Za-z0-9._-]");
		}
		await expect(connectPeer(t, "system")).rejects.toThrow("@pi-system");
	}, 30_000);
});

chatRows("row 14: #dm-mirror", () => {
	it("an agent DM appears once, naming both; a crash after the copy makes no second; the owner's DMs are not copied; no agent is a member; old copies are redacted", async () => {
		const mirror = (await asCall(t, "GET", `/_matrix/client/v3/directory/room/${q(`#dm-mirror:${t.hs.serverName}`)}`)).json.room_id;
		const copies = async (needle: string) =>
			(await roomMessages(mirror, sys())).filter((e) => e.type === "m.room.message" && String(e.content.body).includes(needle));

		const a = await connectPeer(t, uniq("a"));
		const b = await connectPeer(t, uniq("b"));
		const sent = await a.req<{ event_id: string; room: string }>("send", { to: b.name, text: "mirror me" });
		await b.pushed("mirror me");
		await quiet();
		const [copy] = await copies("mirror me");
		expect(String(copy.content.body)).toContain(`${a.name} → ${b.name}: mirror me`);
		expect(String(copy.content.body)).toContain(`https://matrix.to/#/${sent.room}/${sent.event_id}`);
		expect(await copies("mirror me")).toHaveLength(1);

		// Killed between the copy and its 200: the homeserver redelivers, the copy is not repeated.
		a.close();
		b.close();
		await t.restart({ TEST_EXIT_AFTER_MIRROR: "1" });
		const a2 = await connectPeer(t, a.name);
		await connectPeer(t, b.name);
		await a2.req("send", { to: b.name, text: "crash after copy" }).catch(() => {});
		const deadline = Date.now() + 10_000;
		while ((await copies("crash after copy")).length === 0 && Date.now() < deadline) await Bun.sleep(100);
		await t.restart({});
		const b3 = await connectPeer(t, b.name);
		await b3.pushed("crash after copy", 20_000);
		await quiet(1_500);
		expect(await copies("crash after copy")).toHaveLength(1);

		const owner = await ownerCall(t, ownerToken, "POST", "/_matrix/client/v3/createRoom", { preset: "trusted_private_chat", is_direct: true, invite: [b3.userId] });
		await ownerCall(t, ownerToken, "PUT", `/_matrix/client/v3/rooms/${q(owner.json.room_id)}/send/m.room.message/m1`, { msgtype: "m.text", body: "owner private" });
		await b3.pushed("owner private");
		await b3.req("send", { to: "owner", text: "agent to owner private" });
		await quiet();
		expect(await copies("private")).toEqual([]);

		const members = Object.keys((await asCall(t, "GET", `/_matrix/client/v3/rooms/${q(mirror)}/joined_members`, sys())).json.joined);
		expect(members.filter((m) => m !== sys() && m.startsWith("@pi-"))).toEqual([]);

		await t.restart({ TEST_NOW_OFFSET_MS: String(8 * 86_400_000) });
		expect(await t.control("sweep")).toMatch(/^swept [1-9]/);
		expect(await copies("mirror me")).toEqual([]);
		const original = await asCall(t, "GET", `/_matrix/client/v3/rooms/${q(sent.room)}/event/${q(sent.event_id)}`, b.userId);
		expect(original.json.content.body).toBe("mirror me");
		await t.restart({});
	}, 90_000);
});

chatRows("rows 15–20", () => {
	it("row 15: an m.room.encrypted event is not pushed, is logged, and the owner is told once per room", async () => {
		const b = await connectPeer(t, uniq("b"));
		const created = await ownerCall(t, ownerToken, "POST", "/_matrix/client/v3/createRoom", { preset: "trusted_private_chat", is_direct: true, invite: [b.userId] });
		const room = created.json.room_id;
		// chatd joins the DM for b; events before the join never reach the appservice.
		const deadline = Date.now() + 10_000;
		while (!(await asCall(t, "GET", "/_matrix/client/v3/joined_rooms", b.userId)).json.joined_rooms.includes(room)) {
			if (Date.now() > deadline) throw new Error("chatd did not join the DM");
			await Bun.sleep(50);
		}
		for (const id of ["e1", "e2"]) {
			await ownerCall(t, ownerToken, "PUT", `/_matrix/client/v3/rooms/${q(room)}/send/m.room.encrypted/${id}`, {
				algorithm: "m.megolm.v1.aes-sha2",
				ciphertext: "AwgAEn",
				device_id: "X",
				sender_key: "k",
				session_id: "s",
			});
		}
		await ownerCall(t, ownerToken, "PUT", `/_matrix/client/v3/rooms/${q(room)}/send/m.room.message/after`, { msgtype: "m.text", body: "plain after" });
		await b.pushed("plain after");
		expect(b.pushes.map((p) => p.body)).toEqual(["plain after"]);
		expect(t.log()).toContain(`encrypted event in ${room} not delivered`);
		expect((await systemToOwner()).filter((m) => m.includes(room))).toHaveLength(1);
		b.close();
	}, 30_000);

	it("row 16: a body @mention with m.mentions {} pushes; an unresolved @word pushes nothing", async () => {
		const b = await connectPeer(t, uniq("b"));
		const c = await connectPeer(t, uniq("c"));
		const room = await peersRoom();
		await ownerCall(t, ownerToken, "POST", `/_matrix/client/v3/join/${q(room)}`, {});
		await ownerCall(t, ownerToken, "PUT", `/_matrix/client/v3/rooms/${q(room)}/send/m.room.message/b1${Date.now()}`, {
			msgtype: "m.text",
			body: `@${b.name} can you look`,
			"m.mentions": {},
		});
		await ownerCall(t, ownerToken, "PUT", `/_matrix/client/v3/rooms/${q(room)}/send/m.room.message/b2${Date.now()}`, {
			msgtype: "m.text",
			body: `@${c.name}x typo`,
			"m.mentions": {},
		});
		const got = await b.pushed("can you look");
		expect(got.sender).toBe("owner");
		await quiet();
		expect(c.pushes.some((x) => x.body.includes("typo"))).toBe(false);
		b.close();
		c.close();
	}, 30_000);

	it("row 17: tail resolution: an exact name wins; an ambiguous tail lists both; no match lists the peers", async () => {
		const tail = crypto.randomUUID();
		const exact = await connectPeer(t, tail);
		const longer = await connectPeer(t, `x_${tail}`);
		const a = await connectPeer(t, uniq("a"));
		const r = await a.req<{ to: string }>("send", { to: tail, text: "exact" });
		expect(r.to).toBe(tail);
		const shared = crypto.randomUUID();
		const p1 = await connectPeer(t, `one-${shared}`);
		const p2 = await connectPeer(t, `two-${shared}`);
		const amb = a.req("send", { to: shared, text: "which" });
		await expect(amb).rejects.toThrow(`one-${shared}`);
		await expect(a.req("send", { to: shared, text: "which" })).rejects.toThrow(`two-${shared}`);
		await expect(a.req("send", { to: uniq("nobody"), text: "hi" })).rejects.toThrow(`Peers: `);
		await expect(a.req("send", { to: uniq("nobody"), text: "hi" })).rejects.toThrow(p1.name);
		for (const p of [exact, longer, a, p1, p2]) p.close();
	}, 30_000);

	it("row 18: a Claude registration with a dead pid shows offline at the next pass, and its watch ends; a second pi hello is refused", async () => {
		const sleeper = Bun.spawn(["sleep", "600"], { env: childEnv() });
		const name = uniq("claude");
		const cl = await connectPeer(t, name, "claude", { claudePid: sleeper.pid });
		const watcher = await t.client();
		await watcher.request("hello", { peer: name, kind: "claude", session: "s", cwd: "/w", claudePid: sleeper.pid });
		const watch = watcher.request("watch").then(
			() => "resolved",
			(e: Error) => e.message,
		);
		const a = await connectPeer(t, uniq("a"));
		expect((await a.req<{ name: string; online: boolean }[]>("who")).find((p) => p.name === name)?.online).toBe(true);
		sleeper.kill("SIGKILL");
		await sleeper.exited;
		await t.control("presence");
		expect(await watch).toContain("session is gone");
		expect((await a.req<{ name: string; online: boolean }[]>("who")).find((p) => p.name === name)?.online).toBe(false);
		const presence = await asCall(t, "GET", `/_matrix/client/v3/presence/${q(cl.userId)}/status`, a.userId);
		expect(presence.json.presence).toBe("offline");

		const piName = uniq("pi");
		const first = await connectPeer(t, piName);
		await expect(connectPeer(t, piName)).rejects.toThrow("already connected");
		first.close();
		a.close();
	}, 60_000);

	it("row 19: certificate watch: 19 days left DMs the owner once a day; 21 days does not; a failed check does", async () => {
		const day = 86_400_000;
		const certDms = async () => (await systemToOwner()).filter((m) => m.includes("certificate"));
		const before = (await certDms()).length;
		await t.restart({ TEST_CERT_NOT_AFTER: new Date(Date.now() + 21 * day).toISOString() });
		await t.control("cert");
		expect((await certDms()).length).toBe(before);
		await t.restart({ TEST_CERT_NOT_AFTER: new Date(Date.now() + 19 * day + 3_600_000).toISOString() });
		await t.control("cert");
		expect((await certDms()).length).toBe(before + 1);
		expect((await certDms())[0]).toContain("19 days left");
		await t.restart({ TEST_CERT_ERROR: "handshake failed (test)" });
		await t.control("cert");
		expect((await certDms())[0]).toContain("handshake failed (test)");
		expect((await certDms()).length).toBe(before + 2);
		await t.restart({});
	}, 60_000);

	it("row 20: a send to a #room the sender is not in fails; a send with no registration fails", async () => {
		const a = await connectPeer(t, uniq("a"));
		const b = await connectPeer(t, uniq("b"));
		const created = await a.req<{ room: string }>("rooms", { action: "create", name: uniq("private") });
		await expect(b.req("send", { to: created.room, text: "let me in" })).rejects.toThrow("is not in");
		const anon = await t.client();
		await expect(anon.request("send", { to: a.name, text: "who am i" })).rejects.toThrow("no registration");
		anon.close();
		a.close();
		b.close();
	}, 30_000);
});

chatRows("startup and configuration", () => {
	it("the socket is mode 0600; a second chatd on a live socket fails naming it", async () => {
		expect(statSync(t.socket).mode & 0o777).toBe(0o600);
		const proc = Bun.spawnSync(["bun", `${import.meta.dir}/../helpers/chatd-entry.ts`], {
			env: childEnv({ CHATD_HOMESERVER: t.hs.url, CHATD_SERVER_NAME: t.hs.serverName, CHATD_LISTEN: "127.0.0.1:1", CHATD_SOCKET: t.socket, CHATD_TOKENS: `${t.dir}/tokens`, CHATD_OWNER: t.hs.owner.userId }),
			timeout: 20_000,
		});
		expect(proc.exitCode).not.toBe(0);
		expect(proc.stderr.toString()).toContain(`something listens on ${t.socket}`);
		expect(existsSync(t.socket)).toBe(true);
	}, 30_000);

	it("no socket path without CHATD_SOCKET or XDG_RUNTIME_DIR; a token file without both tokens names its path", () => {
		expect(() => socketPath({})).toThrow("neither CHATD_SOCKET nor XDG_RUNTIME_DIR");
		expect(socketPath({ XDG_RUNTIME_DIR: "/run/user/1" })).toBe("/run/user/1/chatd.sock");
		expect(() => loadConfig({ CHATD_SOCKET: "/x", CHATD_TOKENS: "/nonexistent/tokens" })).toThrow("/nonexistent/tokens");
		const file = `${t.dir}/half-tokens`;
		require("node:fs").writeFileSync(file, "AS_TOKEN=x\n");
		expect(() => loadConfig({ CHATD_SOCKET: "/x", CHATD_TOKENS: file })).toThrow(`${file} has no HS_TOKEN`);
	});

	it("chatd's rooms carry no m.room.encryption", async () => {
		for (const alias of ["peers", "dm-mirror"]) {
			const room = (await asCall(t, "GET", `/_matrix/client/v3/directory/room/${q(`#${alias}:${t.hs.serverName}`)}`)).json.room_id;
			const enc = await asCall(t, "GET", `/_matrix/client/v3/rooms/${q(room)}/state/m.room.encryption/`, sys());
			expect(enc.status).toBe(404);
		}
	}, 30_000);

	it("puppets carry a readable display name and the session in profile fields", async () => {
		const named = await connectPeer(t, uniq("triage"));
		const cl = await connectPeer(t, uniq("claude"), "claude");
		const cl2 = await connectPeer(t, uniq("claude"), "claude");
		const prof = async (u: string) => (await asCall(t, "GET", `/_matrix/client/v3/profile/${q(u)}`, sys())).json;
		expect((await prof(named.userId)).displayname).toBe(named.name);
		const p1 = await prof(cl.userId);
		const p2 = await prof(cl2.userId);
		expect(p1["dev.pi.kind"]).toBe("claude");
		expect(p1["dev.pi.session"]).toBe(`${cl.name}-session`);
		expect(p1.displayname).not.toBe(p2.displayname);
		expect(String(p1.displayname)).toMatch(/claude/);
		for (const p of [named, cl, cl2]) p.close();
	}, 30_000);
});

describe("test isolation", () => {
	it("the preload points every session's chatd socket into the run's temp dir, not the live chatd", () => {
		const { realpathSync } = require("node:fs");
		const { tmpdir } = require("node:os");
		const socket = socketPath(process.env);
		expect(socket).toBe(process.env.CHATD_SOCKET as string);
		expect(socket.startsWith(`${realpathSync(tmpdir())}/`)).toBe(true);
		expect(existsSync(socket)).toBe(false);
	});
});
