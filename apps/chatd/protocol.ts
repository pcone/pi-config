/**
 * The socket protocol between chatd and its local clients (docs/design/chat.md
 * § Socket protocol): JSON lines. A request is `{id, verb, ...params}`; its
 * answer is `{id, ok: true, result}` or `{id, ok: false, error, code?}`.
 * chatd also sends `{push: Pushed}` to a pi or subagent connection.
 */

export type ClientKind = "pi" | "claude" | "subagent";

export interface Hello {
	peer: string;
	kind: ClientKind;
	/** The session id: the presence status and `dev.pi.session`. */
	session: string;
	/** A pi session's log file, when it has one: `dev.pi.session_file`. */
	sessionFile?: string;
	cwd: string;
	model?: string;
	claudePid?: number;
	/** False: attach to an existing registration only (every CLI subcommand but the registering hooks). */
	register?: boolean;
}

/** A pushed event as a client renders it. */
export interface Pushed {
	event_id: string;
	room_id: string;
	/** `#alias`, the room's name, or its id. */
	room: string;
	direct: boolean;
	/** A peer name, `owner`, `system`, or a foreign user id. */
	sender: string;
	what: "message" | "invite";
	body: string;
	expectReply: boolean;
	delivery: "steer" | "followUp";
	replyTo?: string;
	ts: number;
}

export interface HelloResult {
	peer: string;
	userId: string;
	displayName: string;
	/** `dev.pi.last_correspondent` on the puppet: the model-error mail's recipient (decision external-tools/008). */
	lastCorrespondent?: string;
	/** `dev.pi.autoreply` on the puppet; on unless the session turned it off. */
	autoreply: boolean;
}

export interface PeerEntry {
	name: string;
	kind: string;
	online: boolean;
	displayName: string;
	/** The session id (the presence status). */
	session: string;
	/** The session's log, when it has one. */
	sessionFile?: string;
	cwd: string;
	/** pi and subagent sessions: whether reply requests are answered automatically. */
	autoreply?: boolean;
}

/** Where a peer's work can be read: its session log, else its cwd. */
export function whereToRead(p: { sessionFile?: string; cwd?: string; session?: string }): string {
	return p.sessionFile || p.cwd || p.session || "";
}

/**
 * How a pushed event is labelled for a session, one rule for the pi injection
 * and the CLI's output: `[owner]`, `[peer:<name>]`, or `[… in #room]` for a
 * room message.
 */
export function mailLabel(p: Pushed): string {
	const who = p.sender === "owner" ? "owner" : `peer:${p.sender}`;
	return p.direct || p.what === "invite" ? `[${who}]` : `[${who} in ${p.room}]`;
}

export type WaitResult =
	| { outcome: "reply"; reply: Pushed; events: Pushed[] }
	| { outcome: "offline"; target: string }
	| { outcome: "checkin"; target: string; status: string };

export interface AckResult {
	acked: string[];
	/** Ids not pending: acked before (a retried batch, a lost answer) or never pushed. */
	already: string[];
}

/** Error codes a client branches on. */
export type ErrorCode = "offline" | "unknown-peer" | "watch-live" | "gone" | "refused" | "invalid" | "homeserver";

export class ChatError extends Error {
	constructor(
		message: string,
		readonly code: ErrorCode = "invalid",
	) {
		super(message);
	}
}

/** Waiting notification types a Notification hook forwards (015/34). */
export const WAITING_TYPES = ["permission_prompt", "idle_prompt", "elicitation_dialog"] as const;
