/**
 * `Bus` over the peer-link file mailbox: the pi extension in
 * extensions/peer-link/index.ts and the Claude CLI in external.ts, against a
 * fresh mailbox directory per row.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import peerLink from "../../../extensions/peer-link/index.ts";
import {
	ensureMailbox,
	listPeers,
	liveWatchPid,
	newEnvelope,
	readIncoming,
	sendEnvelope,
	writeHeartbeat,
	writeLastCorrespondent,
	type PeerInfo,
} from "../../../extensions/peer-link/mailbox.ts";
import {
	MAIL_ERROR_CHARS,
	MAIL_THROTTLE_MS,
	composeModelErrorMail,
	createModelErrorMail,
	modelHttpStatus,
	type ModelErrorMail,
} from "../../../extensions/peer-link/model-error-mail.ts";
import { pendingWaits } from "../../../extensions/lib/waits.ts";
import { childEnv } from "../../helpers/subagent-env.ts";
import { type Adapter, type Bus, type MailHarness, type MailModule, type MailPeer, type ClaudePeer, type ConnectOptions, type Injected, type Peer, type PiPeer, type SendOptions, until } from "../bus.ts";
import { ClaudeProcess } from "../claude-process.ts";
import { startLiveSession } from "./live-session.ts";
import { makePiPeer } from "./pi-standin.ts";

const CLI = join(import.meta.dir, "..", "..", "..", "extensions", "peer-link", "external.ts");
const EXTENSION = join(import.meta.dir, "..", "..", "..", "extensions", "peer-link", "index.ts");
const TOOLS = { send: "peer_send", who: "peer_list" } as const;

/** A Claude peer is a registered external peer here: listed, never online. */
function asPeerInfo(p: MailPeer): PeerInfo {
	return p.kind === "claude" ? { name: p.name, ts: Date.now(), external: true, online: false } : { name: p.name, ts: Date.now(), online: p.online };
}

const mail: MailModule = {
	MAIL_ERROR_CHARS,
	MAIL_THROTTLE_MS,
	modelHttpStatus,
	composeModelErrorMail,
	async harness(options): Promise<MailHarness> {
		const dir = mkdtempSync(join(tmpdir(), "bus-mail-"));
		ensureMailbox(dir, options.self);
		if (options.correspondent) writeLastCorrespondent(dir, options.self, options.correspondent);
		const warns: string[] = [];
		const clock = { now: Date.parse("2026-11-03T04:00:00Z") };
		const peers = options.peers;
		const build = (): ModelErrorMail =>
			createModelErrorMail({
				mailbox: () => dir,
				peerName: () => options.self,
				sessionId: () => options.sessionId,
				cwd: () => options.cwd,
				peers: () => peers.map(asPeerInfo),
				warn: (message) => warns.push(message),
				now: () => clock.now,
			});
		let module = build();
		return {
			warns,
			clock,
			peers,
			onAssistantMessage: (m) => module.onAssistantMessage(m),
			recordCorrespondent: (name) => module.recordCorrespondent(name),
			inbox: (peer) => readIncoming(dir, peer).map((e) => e.text),
			restart: () => {
				module = build();
			},
		};
	},
};

export const peerLinkAdapter: Adapter = {
	name: "peer-link",
	mail,
	async setup(): Promise<Bus> {
		let mailbox = "";
		const prevMailbox = process.env.PI_PEER_MAILBOX;
		const pis: Array<{ peer: PiPeer; shutdown: () => Promise<void> }> = [];
		const claudes: ClaudeProcess[] = [];
		const lives: Array<{ cleanup(): Promise<void> }> = [];

		function freshMailbox(): void {
			if (mailbox) rmSync(mailbox, { recursive: true, force: true });
			mailbox = mkdtempSync(join(tmpdir(), "bus-peer-link-"));
			process.env.PI_PEER_MAILBOX = mailbox;
		}
		freshMailbox();

		async function connectPi(peer: string, kind: "pi" | "subagent", options: ConnectOptions): Promise<PiPeer> {
			const handle = await makePiPeer({
				factory: (api: ExtensionAPI) => peerLink(api),
				envName: options.noEnvName ? undefined : peer,
				kind,
				options,
				roles: TOOLS,
				selfName: async (tool) => ((await tool("who", {})).details as { self: string }).self,
				waits: () => pendingWaits({ branch: () => [], persist() {} }).filter((w) => w.kind === "peer"),
			});
			pis.push(handle);
			return handle.peer;
		}

		async function connectClaude(sessionId: string, options: ConnectOptions): Promise<ClaudePeer> {
			const proc = await ClaudeProcess.start(CLI, childEnv({ PI_PEER_MAILBOX: mailbox }));
			claudes.push(proc);
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
			const start = await peer.hook("session-start");
			if (start.code !== 0) throw new Error(`session-start failed: ${start.err}`);
			return peer;
		}

		const bus: Bus = {
			name: "peer-link",
			async connectLive(peer, tools) {
				const live = await startLiveSession({ name: peer, extensionPath: EXTENSION, tools: tools.map((t) => TOOLS[t]), env: {} });
				lives.push(live);
				return live;
			},
			toolName: (role) => TOOLS[role],
			async reset() {
				for (const l of lives.splice(0)) await l.cleanup();
				for (const p of pis.splice(0)) await p.shutdown();
				for (const c of claudes.splice(0)) c.dispose();
				freshMailbox();
			},
			connect: ((peer: string, kind: "pi" | "subagent" | "claude", options: ConnectOptions = {}) =>
				kind === "claude" ? connectClaude(peer, options) : connectPi(peer, kind, options)) as Bus["connect"],
			async send(from: Peer, to: string, text: string, options: SendOptions = {}) {
				if (options.replyTo !== undefined) {
					// peer_send cannot stamp `inReplyTo` (only the auto-reply does); the envelope
					// a relaying peer would write is written as the mailbox writes it.
					const env = newEnvelope(from.name, to, text, false, options.replyTo);
					sendEnvelope(mailbox, env);
					return { text: `sent to ${to}`, code: 0, id: env.id };
				}
				if (from.kind !== "claude") {
					const r = await from.tool("send", {
						to,
						message: text,
						expectReply: options.expectReply,
						followUp: options.followUp,
						requireOnline: options.requireOnline,
					});
					return { text: r.text, code: 0 };
				}
				const args = ["send", ...from.from];
				if (options.expectReply) args.push("--reply");
				if (options.requireOnline) args.push("--require-online");
				const r = await from.run([...args, to, text]);
				if (r.code !== 0) throw new Error(r.err || `send exited ${r.code}`);
				return { text: r.out, code: r.code };
			},
			async sentId(from, to) {
				// Readable while the target has not consumed it: rows use an offline target.
				const mine = readIncoming(mailbox, to).filter((e) => e.from === from.name);
				const last = mine.sort((a, b) => a.sentAt - b.sentAt).at(-1);
				if (!last) throw new Error(`no envelope from ${from.name} in ${to}'s inbox`);
				return last.id;
			},
			pushed: ((peer: Peer) => (peer.kind === "claude" ? peer.hook("prompt") : peer.injected)) as Bus["pushed"],
			wait: (from, to, text, minutes) => from.spawn(["send", ...from.from, "--wait", String(minutes), to, text]),
			watch: (peer) => peer.spawn(["watch", ...peer.from]),
			async untilOffline(name) {
				await until(async () => ((await bus.presence(name)) === "online" ? undefined : true), 15_000, `${name} offline`);
			},
			async untilWatching(peer) {
				await until(() => (liveWatchPid(mailbox, peer.name) === undefined ? undefined : true), 15_000, `a watch for ${peer.name}`);
			},
			async who(peer) {
				if (peer.kind !== "claude") return (await peer.tool("who", {})).text;
				const r = await peer.run(["list"]);
				if (r.code !== 0) throw new Error(r.err);
				return r.out;
			},
			async presence(name) {
				const p = listPeers(mailbox).find((x) => x.name === name);
				if (!p) return "absent";
				return p.online ? "online" : "offline";
			},
			async disconnect(peer) {
				if (peer.kind === "claude") {
					await peer.exit();
					return;
				}
				const i = pis.findIndex((p) => p.peer === peer);
				if (i >= 0) await pis.splice(i, 1)[0].shutdown();
				// Shutdown removes the heartbeat; an aged one is what "known, offline" is here.
				writeHeartbeat(mailbox, { name: peer.name, ts: Date.now() - 5 * 60_000 });
			},
			async restart() {
				// No daemon: the mailbox is the state.
			},
			async dispose() {
				await bus.reset();
				rmSync(mailbox, { recursive: true, force: true });
				if (prevMailbox === undefined) delete process.env.PI_PEER_MAILBOX;
				else process.env.PI_PEER_MAILBOX = prevMailbox;
			},
		};
		return bus;
	},
};

export type { Injected };
