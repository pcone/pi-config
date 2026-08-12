/**
 * Friendly-name reverse lookup
 *
 * Resolves a footer friendly name (e.g. `arcane-phoenix-archmage`) back to a
 * full session id. The words encode only 18 of the UUID's 128 bits, so the
 * name is a fingerprint, not an identity — several sessions can share one
 * name (the archive currently holds ~11 two-way collisions per ~1,700
 * sessions, birthday-expected at 262k phrases). Disambiguation rule:
 *
 *   - exactly one match                    → it
 *   - several, but exactly one had its     → the recent one (assumed correct)
 *     last activity within the last 7 days
 *   - several, none or multiple recent     → surface the collision; in TUI the
 *     user picks from a list, otherwise the candidates are reported so the
 *     caller can pick by id
 *
 * "Last activity" is SessionInfo.modified (file mtime) — the same signal
 * /resume sorts by and the footer's staleness glyph uses.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { decodeSessionWords, encodeSessionId } from "./footer-session-id";

const RECENCY_MS = 7 * 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A session as seen by the resolver — a subset of SessionInfo. */
export interface FriendlySession {
	id: string;
	modified: Date;
	name?: string;
	cwd?: string;
	firstMessage?: string;
	path?: string;
}

export type ResolveResult =
	| { status: "found"; session: FriendlySession; note?: string; message: string }
	| { status: "ambiguous"; candidates: FriendlySession[]; note: string; message: string }
	| { status: "not_found"; message: string }
	| { status: "invalid"; message: string };

export function normalizeFriendlyName(input: string): string {
	return input
		.trim()
		.replace(/^[`"']|[`"']$/g, "")
		.toLowerCase();
}

function toFriendly(s: { id: string; modified: Date; name?: string; cwd?: string; firstMessage?: string; path?: string }): FriendlySession {
	return {
		id: s.id,
		modified: s.modified,
		name: s.name,
		cwd: s.cwd,
		firstMessage: s.firstMessage,
		path: s.path,
	};
}

/**
 * Resolve a friendly name to a session. Pure — no pi API, so it is testable
 * with plain objects. `now` is injectable for deterministic tests.
 */
export function resolveFriendlyName(
	input: string,
	sessions: readonly { id: string; modified: Date; name?: string; cwd?: string; firstMessage?: string; path?: string }[],
	now: Date = new Date(),
): ResolveResult {
	const name = normalizeFriendlyName(input);
	if (!name) return { status: "invalid", message: "No name given." };

	const matches = sessions
		.map(toFriendly)
		.filter((s) => encodeSessionId(s.id) === name)
		.sort((a, b) => b.modified.getTime() - a.modified.getTime());

	if (matches.length === 0) {
		if (UUID_RE.test(name)) {
			return {
				status: "invalid",
				message: `"${name}" is already a full session id — use it directly instead of looking it up by name.`,
			};
		}
		if (!decodeSessionWords(name)) {
			return {
				status: "invalid",
				message: `"${input}" is not a valid friendly name — the footer format is adjective-creature-class (e.g. "arcane-phoenix-archmage").`,
			};
		}
		return { status: "not_found", message: `No session has the friendly name "${name}".` };
	}

	if (matches.length === 1) {
		return { status: "found", session: matches[0], message: describe(matches[0], now, name) };
	}

	const cutoff = now.getTime() - RECENCY_MS;
	const recent = matches.filter((m) => m.modified.getTime() > cutoff);
	if (recent.length === 1) {
		const s = recent[0];
		return {
			status: "found",
			session: s,
			note: `${matches.length} sessions share "${name}"; assumed the one active within the last 7 days (${s.id}).`,
			message: `${describe(s, now, name)}\nNote: ${matches.length} sessions share this name; assumed the one active within the last 7 days.`,
		};
	}

	const note =
		recent.length === 0
			? `${matches.length} sessions share "${name}" and none were active within the last 7 days.`
			: `${matches.length} sessions share "${name}" and ${recent.length} were active within the last 7 days.`;
	return {
		status: "ambiguous",
		candidates: matches,
		note,
		message: `Ambiguous: ${note}\n${matches.map((c, i) => candidateLine(i, c, now)).join("\n")}`,
	};
}

function candidateLine(i: number, s: FriendlySession, now: Date): string {
	const where = s.cwd ? ` — ${s.cwd}` : "";
	const first = s.firstMessage ? ` — ${snippet(s.firstMessage)}` : "";
	return `${i + 1}. ${s.id} — last active ${relativeTime(s.modified, now)}${where}${first}`;
}

function describe(s: FriendlySession, now: Date, name: string): string {
	const where = s.cwd ? `\ncwd: ${s.cwd}` : "";
	const first = s.firstMessage ? `\nfirst message: ${snippet(s.firstMessage)}` : "";
	return `Resolved "${name}" → ${s.id}\nlast active: ${relativeTime(s.modified, now)} (${s.modified.toISOString().slice(0, 10)})${where}${first}`;
}

function snippet(text: string): string {
	const t = text.replace(/\s+/g, " ").trim();
	return t.length > 70 ? `${t.slice(0, 67)}…` : t;
}

function relativeTime(d: Date, now: Date): string {
	const ms = now.getTime() - d.getTime();
	if (ms < 60_000) return "just now";
	if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ago`;
	if (ms < 86400_000) return `${Math.floor(ms / 3600_000)}h ago`;
	if (ms < 7 * 86400_000) return `${Math.floor(ms / 86400_000)}d ago`;
	return d.toISOString().slice(0, 10);
}

export default function sessionName(pi: ExtensionAPI) {
	pi.registerTool({
		name: "session_by_name",
		label: "Session By Name",
		description:
			"Resolve a friendly session name (e.g. 'arcane-phoenix-archmage' — the three-word identifier in the footer) to its full session id, last activity, cwd, and first message. Use this when a session is referenced only by its friendly name and you need the id (for /resume, peer messaging, or locating its session file). If several sessions share the name, the one active within the last 7 days is assumed; otherwise the collision is surfaced for the user to pick.",
		promptSnippet: "Resolve a friendly session name to a full session id",
		parameters: Type.Object({
			friendlyName: Type.String({ description: "Friendly session name, e.g. 'arcane-phoenix-archmage'" }),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sessions = await SessionManager.listAll();
			const res = resolveFriendlyName(params.friendlyName, sessions);

			switch (res.status) {
				case "found":
					return {
						content: [{ type: "text", text: res.message }],
						details: { status: "found", session: res.session, note: res.note },
					};
				case "ambiguous": {
					const now = new Date();
					if (ctx.mode === "tui") {
						const picked = await ctx.ui.select(
							`Multiple sessions match "${params.friendlyName}"`,
							res.candidates.map((c, i) => `${i + 1}. ${c.id} — ${relativeTime(c.modified, now)}`),
						);
						const chosen = picked === undefined ? undefined : res.candidates[parseInt(picked, 10) - 1];
						if (!chosen) {
							return {
								content: [{ type: "text", text: `Selection cancelled — candidates were:\n${res.candidates.map((c, i) => candidateLine(i, c, now)).join("\n")}` }],
								details: { status: "ambiguous", candidates: res.candidates, note: res.note, picked: null },
							};
						}
						return {
							content: [{ type: "text", text: `Picked: ${describe(chosen, now, params.friendlyName)}` }],
							details: { status: "found", session: chosen, note: res.note },
						};
					}
					return {
						content: [{ type: "text", text: res.message }],
						details: { status: "ambiguous", candidates: res.candidates, note: res.note },
					};
				}
				default:
					return {
						content: [{ type: "text", text: res.message }],
						details: { status: res.status, message: res.message },
					};
			}
		},
	});

	pi.registerCommand("session-name", {
		description: "Resolve a friendly session name to its full session id: /session-name <adjective-creature-class>",
		handler: async (args, ctx) => {
			const sessions = await SessionManager.listAll();
			const res = resolveFriendlyName(args, sessions);
			if (res.status === "ambiguous" && ctx.mode === "tui") {
				const now = new Date();
				const picked = await ctx.ui.select(
					`Multiple sessions match "${args.trim()}"`,
					res.candidates.map((c, i) => `${i + 1}. ${c.id} — ${relativeTime(c.modified, now)}`),
				);
				if (picked) {
					const chosen = res.candidates[parseInt(picked, 10) - 1];
					ctx.ui.notify(describe(chosen, now, args.trim()), "info");
					return;
				}
			}
			ctx.ui.notify(res.message, res.status === "found" ? "info" : "warning");
		},
	});
}
