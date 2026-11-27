/**
 * The push rule: one producer for "does this event reach this recipient now"
 * (docs/design/chat.md § classify). Every delivery path, live and backlog,
 * calls it; nothing queues an event `classify` did not push.
 */

import type { MatrixEvent } from "./matrix.ts";

export type Verdict = "push" | "digest" | "none";
export type PeerKind = "pi" | "claude" | "subagent" | "system";
export type Level = "all" | "mentions";

export interface Recipient {
	userId: string;
	/** The peer name, for the body-mention fallback. */
	peer: string;
	kind: PeerKind;
	/** Whether the room is in the recipient's `m.direct`. */
	isDirect(room: string): boolean;
	/** The recipient's notification level for the room. */
	level(room: string): Level;
}

function mentions(event: MatrixEvent): { userIds: string[]; room: boolean } {
	const m = event.content["m.mentions"] as { user_ids?: unknown; room?: unknown } | undefined;
	const userIds = Array.isArray(m?.user_ids) ? m.user_ids.filter((u): u is string => typeof u === "string") : [];
	return { userIds, room: m?.room === true };
}

function escape(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `@name` as a token: not inside a longer name or address. */
export function bodyMentions(body: string, token: string): boolean {
	return new RegExp(`(^|[^A-Za-z0-9._@-])${escape(token)}(?![A-Za-z0-9._-])`).test(body);
}

function mentioned(event: MatrixEvent, r: Recipient): boolean {
	const { userIds } = mentions(event);
	if (userIds.length > 0) return userIds.includes(r.userId);
	const body = typeof event.content.body === "string" ? event.content.body : "";
	return body.includes(r.userId) || bodyMentions(body, `@${r.peer}`);
}

export function classify(event: MatrixEvent, room: string, r: Recipient): Verdict {
	if (event.sender === r.userId) return "none";
	if (event.type === "m.room.encrypted") return "none";
	if (event.type === "m.room.member") {
		return event.state_key === r.userId && event.content.membership === "invite" ? "push" : "none";
	}
	// Room state and other non-message events carry no text for a session.
	if (event.type !== "m.room.message") return "none";
	if (r.isDirect(room)) return "push";
	if (mentioned(event, r)) return "push";
	if (mentions(event).room && r.kind !== "subagent") return "push";
	if (r.kind === "subagent") return "none";
	return r.level(room) === "all" ? "digest" : "none";
}
