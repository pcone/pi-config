/**
 * extensions/chat/ against chatd and a real Tuwunel: how a pushed event reads
 * in the session, the subagent's account, and the one reconnect after a chatd
 * restart (WO-2026-107 § 3, rows 3, 6 and 8 on the pi side).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import chat from "../../extensions/chat/index.ts";
import { _testClearWaitSources, pendingWaits } from "../../extensions/lib/waits.ts";
import { injectedWith, until } from "../chat-behaviour/bus.ts";
import { makePiPeer, type PiStandin } from "../chat-behaviour/adapters/pi-standin.ts";
import { type TestChatd, startChatdWithHomeserver } from "../helpers/chatd.ts";
import { scrubSubagentEnv } from "../helpers/subagent-env.ts";
import { ownerLogin } from "../helpers/tuwunel.ts";
import { asCall, connectPeer, ownerCall, q, quiet, uniq } from "./harness.ts";

const restoreSubagentEnv = scrubSubagentEnv();
afterAll(restoreSubagentEnv);

let t: TestChatd;
let ownerToken: string;
const standins: PiStandin[] = [];
beforeAll(async () => {
	t = await startChatdWithHomeserver();
	ownerToken = await ownerLogin(t.hs);
}, 60_000);
afterAll(async () => {
	for (const s of standins) await s.shutdown();
	await t.dispose();
});

async function pi(name: string, env: Record<string, string> = {}) {
	const s = await makePiPeer({
		factory: (api: ExtensionAPI) => chat(api),
		envName: name,
		kind: "pi",
		options: {},
		env: { CHATD_SOCKET: t.socket, ...env },
		roles: { send: "chat_send", who: "chat_who" },
		selfName: async (tool) => ((await tool("who", {})).details as { self: string }).self,
		waits: () => pendingWaits({ branch: () => [], persist() {} }).filter((w) => w.kind === "peer"),
	});
	standins.push(s);
	return s.peer;
}

describe("injection", () => {
	it("row 8: the owner's DM reads [owner] …; a room mention reads [<who> in #room] …", async () => {
		const b = await pi(uniq("b"));
		const user = `@pi-${b.name}:${t.hs.serverName}`;
		const dm = (await ownerCall(t, ownerToken, "POST", "/_matrix/client/v3/createRoom", { preset: "trusted_private_chat", is_direct: true, invite: [user] })).json.room_id;
		await ownerCall(t, ownerToken, "PUT", `/_matrix/client/v3/rooms/${q(dm)}/send/m.room.message/x${Date.now()}`, { msgtype: "m.text", body: "from the phone" });
		expect((await injectedWith(b, "from the phone")).text).toBe("[owner] from the phone");
		const peers = (await asCall(t, "GET", `/_matrix/client/v3/directory/room/${q(`#peers:${t.hs.serverName}`)}`)).json.room_id;
		await ownerCall(t, ownerToken, "POST", `/_matrix/client/v3/join/${q(peers)}`, {});
		await ownerCall(t, ownerToken, "PUT", `/_matrix/client/v3/rooms/${q(peers)}/send/m.room.message/y${Date.now()}`, {
			msgtype: "m.text",
			body: `@${b.name} in the room`,
			"m.mentions": { user_ids: [user] },
		});
		expect((await injectedWith(b, "in the room")).text).toBe(`[owner in #peers] @${b.name} in the room`);
		const a = await connectPeer(t, uniq("a"));
		await a.req("send", { to: "#peers", text: `@${b.name} from a peer` });
		expect((await injectedWith(b, "from a peer")).text).toBe(`[peer:${a.name} in #peers] @${b.name} from a peer`);
		a.close();
	}, 30_000);

	it("send to owner reaches @scott", async () => {
		const b = await pi(uniq("b"));
		await b.tool("send", { to: "owner", message: "status for the owner" });
		const user = `@pi-${b.name}:${t.hs.serverName}`;
		const room = (await asCall(t, "GET", `/_matrix/client/v3/user/${q(user)}/account_data/m.direct`, user)).json[t.hs.owner.userId][0];
		const seen = await asCall(t, "GET", `/_matrix/client/v3/rooms/${q(room)}/messages?dir=b&limit=10`, user);
		const invite = await asCall(t, "GET", `/_matrix/client/v3/rooms/${q(room)}/state/m.room.member/${q(t.hs.owner.userId)}`, user);
		expect(invite.json.membership).toBe("invite");
		expect(seen.json.chunk.some((e: { content: { body?: string } }) => e.content.body === "status for the owner")).toBe(true);
	}, 30_000);
});

describe("a reply-wait asked in a room", () => {
	it("a reply sent there while chatd was down ends it after the reconnect: the relations listing finds it", async () => {
		_testClearWaitSources();
		const relay = await connectPeer(t, uniq("relay"));
		const alice = await pi(uniq("alice"));
		const sent = await alice.tool("send", { to: "#peers", message: "anyone know the release branch?", expectReply: true });
		const ask = sent.details as { event_id: string; room: string };
		expect(alice.waits()).toHaveLength(1);
		await relay.pushed("anyone know").catch(() => {});
		await t.kill();
		await asCall(t, "PUT", `/_matrix/client/v3/rooms/${q(ask.room)}/send/m.room.message/rel${Date.now()}`, relay.userId, {
			msgtype: "m.text",
			body: "release-2",
			"m.relates_to": { "m.in_reply_to": { event_id: ask.event_id } },
		});
		await t.start();
		await until(() => (alice.waits().length === 0 ? true : undefined), 30_000, "the room wait to end after the reconnect");
	}, 60_000);
});

describe("a subagent session", () => {
	it("connects as kind subagent under its name; @room does not reach it, a DM does", async () => {
		const s = await pi(uniq("sub"), { PI_SUBAGENT_DEPTH: "1" });
		const user = `@pi-${s.name}:${t.hs.serverName}`;
		const profile = (await asCall(t, "GET", `/_matrix/client/v3/profile/${q(user)}`, user)).json;
		expect(profile["dev.pi.kind"]).toBe("subagent");
		const a = await connectPeer(t, uniq("a"));
		await a.req("send", { to: "#peers", text: "@room all hands" });
		await a.req("send", { to: s.name, text: "just for you" });
		await injectedWith(s, "just for you");
		await quiet();
		expect(s.injected.some((m) => m.text.includes("all hands"))).toBe(false);
		a.close();
	}, 30_000);
});

describe("a chatd restart", () => {
	it("the extension reconnects once; mail after it is injected, and a reply sent while chatd was down ends the wait", async () => {
		_testClearWaitSources();
		const bob = await connectPeer(t, uniq("bob"));
		const alice = await pi(uniq("alice"));
		const sent = await alice.tool("send", { to: bob.name, message: "answer across the restart", expectReply: true });
		const ask = sent.details as { event_id: string; room: string };
		expect(alice.waits()).toHaveLength(1);
		await bob.pushed("answer across the restart");
		await t.kill();
		await asCall(t, "PUT", `/_matrix/client/v3/rooms/${q(ask.room)}/send/m.room.message/gap${Date.now()}`, bob.userId, {
			msgtype: "m.text",
			body: "sent in the gap",
			"m.relates_to": { "m.in_reply_to": { event_id: ask.event_id } },
		});
		await t.start();
		await until(() => (alice.waits().length === 0 ? true : undefined), 30_000, "the wait to end after the reconnect").catch((e) => {
			throw new Error(`${e.message}; notices: ${JSON.stringify(alice.notices)}; injected: ${JSON.stringify(alice.injected)}`);
		});
		await injectedWith(alice, "sent in the gap", 30_000);
		const bob2 = await connectPeer(t, bob.name);
		await bob2.req("send", { to: alice.name, text: "after the restart" });
		await injectedWith(alice, "after the restart");
		bob2.close();
	}, 60_000);
});
