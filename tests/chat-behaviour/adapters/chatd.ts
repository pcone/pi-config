/**
 * `Bus` over chatd and a real Tuwunel: the pi extension in extensions/chat/
 * and the `chat` CLI in apps/chatd/cli.ts, against one homeserver and one
 * chatd per test file. Rows use fresh peer names, so nothing is reset on the
 * server between rows.
 */

import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import chat from "../../../extensions/chat/index.ts";
import {
	MAIL_ERROR_CHARS,
	MAIL_THROTTLE_MS,
	composeModelErrorMail,
	createModelErrorMail,
	modelHttpStatus,
	type ModelErrorMail,
} from "../../../extensions/chat/model-error-mail.ts";
import { pendingWaits } from "../../../extensions/lib/waits.ts";
import { localpart } from "../../../apps/chatd/names.ts";
import { type TestChatd, startChatdWithHomeserver } from "../../helpers/chatd.ts";
import { childEnv } from "../../helpers/subagent-env.ts";
import {
	type Adapter,
	type Bus,
	type ClaudePeer,
	type ConnectOptions,
	type MailHarness,
	type MailModule,
	type Peer,
	type PiPeer,
	type SendOptions,
	until,
} from "../bus.ts";
import { ClaudeProcess } from "../claude-process.ts";
import { startLiveSession } from "./live-session.ts";
import { makePiPeer } from "./pi-standin.ts";

const CLI = join(import.meta.dir, "..", "..", "..", "apps", "chatd", "cli.ts");
const EXTENSION = join(import.meta.dir, "..", "..", "..", "extensions", "chat", "index.ts");
const TOOLS = { send: "chat_send", who: "chat_who" } as const;

const mail: MailModule = {
	MAIL_ERROR_CHARS,
	MAIL_THROTTLE_MS,
	modelHttpStatus,
	composeModelErrorMail,
	async harness(options): Promise<MailHarness> {
		const warns: string[] = [];
		const clock = { now: Date.parse("2026-11-03T04:00:00Z") };
		const peers = options.peers;
		const inboxes = new Map<string, string[]>();
		// Stands in for `dev.pi.last_correspondent`, which chatd writes on ack and returns at hello.
		let persisted = options.correspondent;
		const build = (): ModelErrorMail =>
			createModelErrorMail({
				peerName: () => options.self,
				sessionId: () => options.sessionId,
				cwd: () => options.cwd,
				peers: () => peers,
				persistedCorrespondent: () => persisted,
				send: (to, text) => {
					for (const p of to) inboxes.set(p, [...(inboxes.get(p) ?? []), text]);
				},
				warn: (message) => warns.push(message),
				now: () => clock.now,
			});
		let module = build();
		return {
			warns,
			clock,
			peers,
			onAssistantMessage: (m) => module.onAssistantMessage(m),
			recordCorrespondent: (name) => {
				persisted = name;
				module.recordCorrespondent(name);
			},
			inbox: (peer) => inboxes.get(peer) ?? [],
			restart: () => {
				module = build();
			},
		};
	},
};

export const chatdAdapter: Adapter = {
	name: "chatd",
	mail,
	async setup(): Promise<Bus> {
		const t: TestChatd = await startChatdWithHomeserver();
		const pis: Array<{ peer: PiPeer; shutdown: () => Promise<void> }> = [];
		const claudes = new Map<ClaudePeer, ClaudeProcess>();
		const lives: Array<{ cleanup(): Promise<void> }> = [];

		async function presenceOf(name: string): Promise<"online" | "offline" | "absent"> {
			const user = `@${localpart(name)}:${t.hs.serverName}`;
			const r = await fetch(`${t.hs.url}/_matrix/client/v3/presence/${encodeURIComponent(user)}/status?user_id=${encodeURIComponent(`@pi-system:${t.hs.serverName}`)}`, {
				headers: { authorization: `Bearer ${t.hs.asToken}` },
			});
			if (r.status === 404) return "absent";
			const j = (await r.json()) as { presence?: string };
			return j.presence === "online" ? "online" : "offline";
		}

		async function connectPi(peer: string, kind: "pi" | "subagent", options: ConnectOptions): Promise<PiPeer> {
			const handle = await makePiPeer({
				factory: (api: ExtensionAPI) => chat(api),
				envName: options.noEnvName ? undefined : peer,
				kind,
				options,
				env: { CHATD_SOCKET: t.socket, ...(kind === "subagent" ? { PI_SUBAGENT_DEPTH: "1" } : {}) },
				roles: TOOLS,
				selfName: async (tool) => ((await tool("who", {})).details as { self: string }).self,
				waits: () => pendingWaits({ branch: () => [], persist() {} }).filter((w) => w.kind === "peer"),
			});
			pis.push(handle);
			await until(async () => ((await presenceOf(handle.peer.name)) === "online" ? true : undefined), 10_000, `${handle.peer.name} online`);
			return handle.peer;
		}

		async function connectClaude(sessionId: string, options: ConnectOptions): Promise<ClaudePeer> {
			const proc = await ClaudeProcess.start(CLI, childEnv({ CHATD_SOCKET: t.socket }));
			const name = `claude-${sessionId}`;
			const cwd = options.cwd ?? "/w";
			const peer: ClaudePeer = {
				kind: "claude",
				name,
				sessionId,
				from: ["--from", name],
				hook: (event, extra = {}) =>
					proc.run(["hook", event], JSON.stringify({ session_id: sessionId, cwd, hook_event_name: event, ...extra })),
				run: (args, stdin = "") => proc.run(args, stdin),
				spawn: (args) => proc.spawn(args),
				exit: () => proc.exit(),
			};
			claudes.set(peer, proc);
			const start = await peer.hook("session-start");
			if (start.code !== 0) throw new Error(`session-start failed: ${start.err}`);
			return peer;
		}

		const bus: Bus = {
			name: "chatd",
			connect: ((peer: string, kind: "pi" | "subagent" | "claude", options: ConnectOptions = {}) =>
				kind === "claude" ? connectClaude(peer, options) : connectPi(peer, kind, options)) as Bus["connect"],
			async connectLive(peer, tools) {
				const live = await startLiveSession({ name: peer, extensionPath: EXTENSION, tools: tools.map((x) => TOOLS[x]), env: { CHATD_SOCKET: t.socket } });
				lives.push(live);
				return live;
			},
			toolName: (role) => TOOLS[role],
			async reset() {
				for (const l of lives.splice(0)) await l.cleanup();
				for (const p of pis.splice(0)) await p.shutdown();
				for (const [peer, proc] of claudes) {
					if (proc.alive) await peer.hook("session-end");
					proc.dispose();
				}
				claudes.clear();
			},
			async send(from: Peer, to: string, text: string, options: SendOptions = {}) {
				if (from.kind !== "claude") {
					const r = await from.tool("send", {
						to,
						message: text,
						expectReply: options.expectReply,
						followUp: options.followUp,
						requireOnline: options.requireOnline,
						replyTo: options.replyTo,
					});
					return { text: r.text, code: 0, id: (r.details as { event_id: string }).event_id };
				}
				const args = ["send", ...from.from];
				if (options.expectReply) args.push("--reply");
				if (options.requireOnline) args.push("--require-online");
				const r = await from.run([...args, to, text]);
				if (r.code !== 0) throw new Error(r.err || `send exited ${r.code}`);
				return { text: r.out, code: r.code };
			},
			async sentId(from, to) {
				if (from.kind === "claude") throw new Error("sentId: rows ask a pi sender");
				const sent = lastSent.get(`${from.name}->${to}`);
				if (!sent) throw new Error(`no send from ${from.name} to ${to} recorded`);
				return sent;
			},
			pushed: ((peer: Peer) => (peer.kind === "claude" ? peer.hook("prompt") : peer.injected)) as Bus["pushed"],
			wait: (from, to, text, minutes) => from.spawn(["send", ...from.from, "--wait", String(minutes), to, text]),
			watch: (peer) => peer.spawn(["watch", ...peer.from]),
			async untilOffline(name) {
				await until(async () => ((await presenceOf(name)) === "online" ? undefined : true), 15_000, `${name} offline`);
			},
			async untilWatching(peer) {
				const proc = claudes.get(peer)!;
				await until(
					async () => {
						const c = await t.client();
						try {
							await c.request("hello", { peer: peer.name, kind: "claude", session: peer.sessionId, cwd: "/w", claudePid: proc.pid, register: false });
							const r = await c.request<{ watchLive: boolean }>("pending");
							return r.watchLive ? true : undefined;
						} finally {
							c.close();
						}
					},
					15_000,
					`a watch for ${peer.name}`,
				);
			},
			async who(peer) {
				if (peer.kind !== "claude") return (await peer.tool("who", {})).text;
				const r = await peer.run(["who", ...peer.from]);
				if (r.code !== 0) throw new Error(r.err);
				return r.out;
			},
			presence: presenceOf,
			async disconnect(peer) {
				if (peer.kind === "claude") {
					await peer.exit();
					await t.control("presence");
					return;
				}
				const i = pis.findIndex((p) => p.peer === peer);
				if (i >= 0) await pis.splice(i, 1)[0].shutdown();
				await bus.untilOffline(peer.name);
			},
			async restart() {
				await t.restart();
			},
			async dispose() {
				await bus.reset();
				await t.dispose();
			},
		};
		// Record each pi send's event id for `sentId`, by wrapping the stand-in's send role.
		const lastSent = new Map<string, string>();
		const rawSend = bus.send;
		bus.send = async (from, to, text, options) => {
			const r = await rawSend(from, to, text, options);
			if (r.id) lastSent.set(`${from.name}->${to}`, r.id);
			return r;
		};
		return bus;
	},
};
