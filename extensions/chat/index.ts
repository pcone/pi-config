/**
 * chat — a pi session's door to the peers' Matrix chat, through chatd's local
 * socket (docs/design/chat.md).
 *
 * A pushed event (a DM, an @mention, an invite; chatd's `classify` decides) is
 * injected as a user message and acked after the injection: at-least-once, a
 * failed injection is retried and never acked past. A reply request pivots via
 * `followUp`, and the turn's final text is sent back once (auto-reply) unless
 * the session already answered. An unanswered reply request is a derived wait
 * (decision checkpoint/003) until it ends per 015/33. A model HTTP error mails
 * the last correspondent through `@pi-system` (decision external-tools/008).
 *
 * Identity: $PI_PEER_NAME, else the session's display name, else host-pid.
 * A subagent connects as kind `subagent` under its session id.
 */

import { hostname } from "node:os";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ChatClient } from "../../apps/chatd/client.ts";
import { socketPath } from "../../apps/chatd/config.ts";
import { isValidPeerName } from "../../apps/chatd/names.ts";
import type { HelloResult, PeerEntry, Pushed, WaitResult } from "../../apps/chatd/protocol.ts";
import { registerWaitSource } from "../lib/waits.ts";
import { subagentDepth } from "../subagent-async/rpc.ts";
import { createModelErrorMail } from "./model-error-mail.ts";

const RETRY_MS = 2_000;
const RECONNECT_MS = 30_000;
const PENDING_TTL_MS = 10 * 60 * 1000;

/** PI_PEER_NAME → the session's display name → host-pid. Only name-shaped values qualify. */
export function chatIdentity(env: NodeJS.ProcessEnv, sessionName: string | undefined): string {
	const explicit = env.PI_PEER_NAME?.trim();
	if (explicit && isValidPeerName(explicit)) return explicit;
	const name = sessionName?.trim();
	if (name && isValidPeerName(name)) return name;
	return `${hostname()}-${process.pid}`;
}

/** How a pushed event reads in the session. */
export function injectionText(p: Pushed): string {
	const who = p.sender === "owner" ? "owner" : `peer:${p.sender}`;
	const where = p.direct || p.what === "invite" ? "" : ` in ${p.room}`;
	return `[${who}${where}] ${p.body}`;
}

function firstLine(text: string): string {
	const line = text.split("\n", 1)[0].trim();
	return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

interface Delivery {
	pushed: Pushed;
	delivered: boolean;
}

export default function (pi: ExtensionAPI) {
	const state = {
		peer: "",
		kind: "pi" as "pi" | "subagent",
		session: "",
		sessionId: "",
		cwd: "",
		model: undefined as string | undefined,
		autoreply: true,
		lastCorrespondent: undefined as string | undefined,
		/** Resolved once at session_start, so a reconnect dials the same chatd. */
		socket: "",
	};
	let client: ChatClient | undefined;
	let shuttingDown = false;
	let notify: (message: string, level: "info" | "warning" | "error") => void = (m) => console.warn(m);
	let retryTimer: ReturnType<typeof setTimeout> | undefined;

	/** Pushed events not yet acked, in arrival order. */
	const deliveries: Delivery[] = [];
	const seen = new Set<string>();
	/** Reply requests injected and not yet answered: event id → what was injected. */
	const pendingReplies = new Map<string, { pushed: Pushed; text: string; queuedAt: number }>();
	const replied = new Set<string>();
	/** This session's unanswered reply requests (derived waits). */
	const awaitingReply = new Map<string, { to: string; text: string; sentAt: number; room: string }>();

	registerWaitSource({
		id: "chat",
		collect: () =>
			[...awaitingReply.entries()].map(([id, sent]) => ({
				id: `peer:${id}`,
				kind: "peer" as const,
				reason: `reply from ${sent.to} "${firstLine(sent.text)}"`,
				since: sent.sentAt,
				source: "derived" as const,
			})),
	});

	const modelErrorMail = createModelErrorMail({
		peerName: () => state.peer,
		sessionId: () => state.sessionId,
		cwd: () => state.cwd,
		peers: async () => (await request<PeerEntry[]>("who")).map((p) => ({ name: p.name, online: p.online, kind: p.kind })),
		persistedCorrespondent: () => state.lastCorrespondent,
		send: async (to, text) => {
			await request("system_mail", { to, text });
		},
		warn: (message) => notify(message, "warning"),
	});

	function request<T>(verb: string, params: Record<string, unknown> = {}): Promise<T> {
		if (!client || client.closed) return Promise.reject(new Error("chat: not connected to chatd"));
		return client.request<T>(verb, params);
	}

	// ── connection ───────────────────────────────────────────────────────

	async function connect(): Promise<void> {
		const c = await ChatClient.connect(state.socket);
		c.onPush((p) => onPush(p));
		const hello = await c.request<HelloResult>("hello", {
			peer: state.peer,
			kind: state.kind,
			session: state.session,
			cwd: state.cwd,
			model: state.model,
		});
		state.lastCorrespondent = hello.lastCorrespondent;
		c.onClose(() => {
			if (client === c && !shuttingDown) void reconnect();
		});
		client = c;
		for (const [id, sent] of awaitingReply) void watchReply(id, sent.room);
	}

	/** chatd went away: reconnect once, within 30 s, and re-register the waits. */
	async function reconnect(): Promise<void> {
		client = undefined;
		const until = Date.now() + RECONNECT_MS;
		for (;;) {
			if (shuttingDown) return;
			try {
				await connect();
				return;
			} catch (err) {
				if (Date.now() > until) {
					notify(`chat: lost chatd and could not reconnect within 30 s: ${(err as Error).message}. Peer messages are not delivered until the session restarts.`, "error");
					return;
				}
				await Bun.sleep(500);
			}
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		try {
			shuttingDown = false;
			state.sessionId = ctx.sessionManager.getSessionId();
			state.socket = socketPath();
			state.peer = chatIdentity(process.env, ctx.sessionManager.getSessionName() ?? undefined);
			state.kind = subagentDepth(process.env) > 0 ? "subagent" : "pi";
			// The session log, where one exists: what a check-in and `who` point a peer at.
			state.session = ctx.sessionManager.getSessionFile() ?? "";
			state.cwd = ctx.cwd;
			state.model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			notify = (message, level) => ctx.ui.notify(message, level);
			await connect();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(`chat init failed: ${message}`, "error");
			throw new Error(`chat init failed: ${message}`, { cause: err });
		}
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		if (retryTimer) clearTimeout(retryTimer);
		retryTimer = undefined;
		client?.close();
		client = undefined;
	});

	// ── inbound ──────────────────────────────────────────────────────────

	function onPush(p: Pushed): void {
		if (seen.has(p.event_id)) return;
		seen.add(p.event_id);
		deliveries.push({ pushed: p, delivered: false });
		void deliver();
	}

	let delivering = false;
	let again = false;
	async function deliver(): Promise<void> {
		if (delivering) {
			again = true;
			return;
		}
		delivering = true;
		again = false;
		try {
			let failed = false;
			for (const d of deliveries) {
				if (d.delivered) continue;
				const text = injectionText(d.pushed);
				if (d.pushed.expectReply && !replied.has(d.pushed.event_id)) {
					pendingReplies.set(d.pushed.event_id, { pushed: d.pushed, text, queuedAt: Date.now() });
				}
				try {
					pi.sendUserMessage(text, { deliverAs: d.pushed.delivery });
					d.delivered = true;
					if (d.pushed.sender !== "system") modelErrorMail.recordCorrespondent(d.pushed.sender);
				} catch {
					pendingReplies.delete(d.pushed.event_id);
					failed = true;
				}
			}
			await ackDelivered();
			if (failed && !shuttingDown) {
				if (retryTimer) clearTimeout(retryTimer);
				retryTimer = setTimeout(() => {
					retryTimer = undefined;
					void deliver();
				}, RETRY_MS);
				retryTimer.unref?.();
			}
		} finally {
			delivering = false;
		}
		if (again) void deliver();
		const now = Date.now();
		for (const [id, p] of pendingReplies) if (now - p.queuedAt > PENDING_TTL_MS) pendingReplies.delete(id);
	}

	/** Ack, per room, the delivered prefix: acks come in delivery order, so an undelivered event holds back its room. */
	async function ackDelivered(): Promise<void> {
		const blocked = new Set<string>();
		const ack: Delivery[] = [];
		for (const d of deliveries) {
			if (blocked.has(d.pushed.room_id)) continue;
			if (!d.delivered) blocked.add(d.pushed.room_id);
			else ack.push(d);
		}
		if (ack.length === 0) return;
		try {
			await request("ack", { event_ids: ack.map((d) => d.pushed.event_id) });
			for (const d of ack) deliveries.splice(deliveries.indexOf(d), 1);
		} catch {
			// Unacked events are resent on the next connection; a duplicate beats a loss.
		}
	}

	// ── outbound ─────────────────────────────────────────────────────────

	/**
	 * The one outbound path. A send to a peer that asked is its reply
	 * (decision checkpoint/003): it answers the oldest open request from that
	 * peer, so no auto-reply follows.
	 */
	async function send(params: {
		to: string;
		text: string;
		expectReply?: boolean;
		followUp?: boolean;
		requireOnline?: boolean;
		replyTo?: string;
	}): Promise<{ event_id: string; room: string; to: string; online?: boolean }> {
		let replyTo = params.replyTo;
		if (replyTo === undefined) {
			for (const [id, p] of pendingReplies) {
				if (p.pushed.sender !== params.to) continue;
				pendingReplies.delete(id);
				replied.add(id);
				replyTo ??= id;
			}
		}
		const sent = await request<{ event_id: string; room: string; to: string; online?: boolean }>("send", {
			to: params.to,
			text: params.text,
			expectReply: params.expectReply === true,
			whenIdle: params.followUp === true,
			requireOnline: params.requireOnline === true,
			replyTo,
		});
		if (params.expectReply) {
			awaitingReply.set(sent.event_id, { to: sent.to, text: params.text, sentAt: Date.now(), room: sent.room });
			void watchReply(sent.event_id, sent.room);
		}
		return sent;
	}

	/** Hold the wait at chatd until its reply (015/33). A dropped connection re-registers it on reconnect. */
	async function watchReply(id: string, room: string): Promise<void> {
		try {
			const r = await request<WaitResult>("wait", { event_id: id, room });
			if (r.outcome === "reply") awaitingReply.delete(id);
		} catch {
			// The connection went; `connect` re-registers every open wait.
		}
	}

	// ── model errors ─────────────────────────────────────────────────────

	pi.on("message_end", async (event) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		await modelErrorMail.onAssistantMessage(message);
	});

	// ── automatic replies ────────────────────────────────────────────────

	pi.on("agent_settled", async (_event, ctx) => {
		if (pendingReplies.size === 0 || !state.autoreply) return;
		const branch = ctx.sessionManager.getBranch();
		const pending = [...pendingReplies.values()];
		const positions: Array<{ pushed: Pushed; idx: number }> = [];
		let searchFrom = 0;
		for (const p of pending) {
			const idx = findInjected(branch, p.text, searchFrom);
			if (idx >= 0) {
				positions.push({ pushed: p.pushed, idx });
				searchFrom = idx + 1;
			}
		}
		for (let i = 0; i < positions.length; i++) {
			const { pushed, idx } = positions[i];
			pendingReplies.delete(pushed.event_id);
			if (replied.has(pushed.event_id)) continue;
			const end = i + 1 < positions.length ? positions[i + 1].idx : branch.length;
			const replyText = assistantText(branch.slice(idx + 1, end));
			if (!replyText) continue;
			replied.add(pushed.event_id);
			try {
				await send({ to: pushed.sender, text: replyText, replyTo: pushed.event_id });
			} catch (err) {
				ctx.ui.notify(`chat: auto-reply to "${pushed.sender}" not sent: ${(err as Error).message}`, "warning");
			}
		}
	});

	function messageText(message: { content?: unknown }): string {
		const content = message.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
				.map((b) => b.text)
				.join("\n");
		}
		return "";
	}

	function findInjected(branch: SessionEntry[], text: string, from: number): number {
		for (let i = from; i < branch.length; i++) {
			const entry = branch[i];
			if (entry.type === "message" && entry.message.role === "user" && messageText(entry.message) === text) return i;
		}
		return -1;
	}

	function assistantText(entries: SessionEntry[]): string {
		return entries
			.filter((e) => e.type === "message" && e.message.role === "assistant")
			.map((e) => messageText((e as { message: { content?: unknown } }).message).trim())
			.filter(Boolean)
			.join("\n\n");
	}

	// ── tools ────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "chat_send",
		label: "Chat Send",
		description:
			"Send a chat message: a DM to a peer (a pi or Claude Code session, by name or UUID tail), to `owner` (the human), or to a `#room` you are in. " +
			"`@name` in the text mentions a peer (in a room, a non-member is invited); `@room` mentions every member. " +
			"Set expectReply to have the answer come back to this session. Use chat_who for names.",
		promptSnippet: "Message another session, the owner, or a chat room",
		promptGuidelines: [
			"Use chat_send to coordinate with another session or to answer the owner when his message came through chat ([owner] …).",
			"Set expectReply: true when this session needs the answer; it arrives as a user message prefixed with the sender.",
			"Write messages information-dense: lead with the ask, include the context the reader needs, skip salutations and recap.",
			"Keep a message to about 1,500 characters: verdict, shas, what changed, and any question with its recommendation. Every message is injected into the recipient's prompt.",
			"Put detail — tables, measurements, derivations, logs — in the record (seat file, investigation doc, notes file) and name the path in the message.",
			"Send one message per event; do not restate an earlier message.",
			"An owner question keeps its options and its recommendation — that part is not trimmed.",
		],
		parameters: Type.Object({
			to: Type.String({ description: "Peer name or UUID tail, `owner`, or `#room`. A name matching no peer fails, listing the peers." }),
			message: Type.String({ description: "Message text. Lead with the request; no salutations or filler." }),
			expectReply: Type.Optional(Type.Boolean({ description: "Have the answer sent back to this session (default false)." })),
			followUp: Type.Optional(
				Type.Boolean({ description: "Deliver when the peer is idle instead of at its next turn boundary (default false). Reply requests always wait for idle." }),
			),
			requireOnline: Type.Optional(Type.Boolean({ description: "Fail when the peer is offline instead of leaving it for its next connection." })),
			replyTo: Type.Optional(Type.String({ description: "The event id this message answers." })),
		}),
		async execute(_id, params) {
			let sent;
			try {
				sent = await send({
					to: params.to,
					text: params.message,
					expectReply: params.expectReply,
					followUp: params.followUp,
					requireOnline: params.requireOnline,
					replyTo: params.replyTo,
				});
			} catch (err) {
				throw new Error(`chat_send: ${(err as Error).message}`);
			}
			const status = sent.online === undefined ? "" : sent.online ? " (online)" : " (offline: it reads this when it next connects)";
			return {
				content: [{ type: "text", text: `Message sent to "${sent.to}"${status}.` }],
				details: { ...sent, expectReply: params.expectReply ?? false },
			};
		},
	});

	pi.registerTool({
		name: "chat_who",
		label: "Chat Who",
		description: "List the peers in #peers: name, kind, online, display name and session.",
		promptSnippet: "List peer sessions on the chat",
		parameters: Type.Object({}),
		async execute() {
			const peers = await request<PeerEntry[]>("who");
			const lines = peers.map((p) => `${p.online ? "●" : "○"} ${p.name} (${p.online ? "online" : "offline"}, ${p.kind}) "${p.displayName}"${p.status ? ` — ${p.status}` : ""}`);
			return {
				content: [{ type: "text", text: `self: ${state.peer}\n${lines.join("\n") || "no peers"}` }],
				details: { self: state.peer, peers },
			};
		},
	});

	pi.registerTool({
		name: "chat_read",
		label: "Chat Read",
		description: "Read recent messages of a room (`#room`), or of the DM with a peer or `owner`. Moves the read marker.",
		promptSnippet: "Read a chat room's recent messages",
		parameters: Type.Object({
			room: Type.String({ description: "`#room`, a peer name, or `owner`." }),
			since: Type.Optional(Type.String({ description: "Only messages after this event id." })),
			limit: Type.Optional(Type.Number({ description: "At most this many messages (default 20)." })),
		}),
		async execute(_id, params) {
			const r = await request<{ room: string; events: Pushed[] }>("read", params);
			const lines = r.events.map((e) => `${new Date(e.ts).toISOString()} ${e.sender}: ${e.body} [${e.event_id}]`);
			return { content: [{ type: "text", text: `${r.room} (${r.events.length}):\n${lines.join("\n")}` }], details: r };
		},
	});

	pi.registerTool({
		name: "chat_rooms",
		label: "Chat Rooms",
		description:
			"Chat rooms: `list` (joined rooms with topic, level and unread count; pending invites), `create` (name, topic, invite), `join`, `leave`, " +
			"or `level` (`all` messages, or `mentions` only) for a room you are in.",
		promptSnippet: "List, create, join, leave chat rooms, or set a room's notification level",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("create"), Type.Literal("join"), Type.Literal("leave"), Type.Literal("level")]),
			name: Type.Optional(Type.String({ description: "create: the room name, e.g. feat-chatd (015/19)." })),
			topic: Type.Optional(Type.String()),
			invite: Type.Optional(Type.Array(Type.String())),
			room: Type.Optional(Type.String({ description: "join, leave, level: `#room`." })),
			level: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("mentions")])),
		}),
		async execute(_id, params) {
			const r = await request<unknown>("rooms", params);
			return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }], details: r };
		},
	});

	// ── commands ─────────────────────────────────────────────────────────

	pi.registerCommand("chat-send", {
		description: "Send a chat message: /chat-send [--reply] [--followup] <to> <text>",
		handler: async (args, ctx) => {
			let expectReply = false;
			let followUp = false;
			let rest = args.trim();
			for (;;) {
				const head = rest.split(/\s+/, 1)[0];
				if (head === "--reply") expectReply = true;
				else if (head === "--followup") followUp = true;
				else break;
				rest = rest.slice(head.length).trim();
			}
			const match = rest.match(/^(\S+)\s+([\s\S]+)$/);
			if (!match) {
				ctx.ui.notify("Usage: /chat-send [--reply] [--followup] <to> <text>", "warning");
				return;
			}
			try {
				const sent = await send({ to: match[1], text: match[2].trim(), expectReply, followUp });
				ctx.ui.notify(`Sent to ${sent.to}${expectReply ? " (reply)" : ""}${followUp ? " (follow-up)" : ""}`, "info");
			} catch (err) {
				ctx.ui.notify((err as Error).message, "error");
			}
		},
	});

	pi.registerCommand("chat-autoreply", {
		description: "Toggle automatic replies to chat reply requests: /chat-autoreply [on|off]",
		handler: async (args, ctx: ExtensionContext) => {
			const value = args.trim().toLowerCase();
			if (value === "on") state.autoreply = true;
			else if (value === "off") state.autoreply = false;
			else if (value === "") state.autoreply = !state.autoreply;
			else {
				ctx.ui.notify("Usage: /chat-autoreply [on|off]", "warning");
				return;
			}
			ctx.ui.notify(`Auto-reply ${state.autoreply ? "ON" : "OFF"}`, "info");
		},
	});
}
