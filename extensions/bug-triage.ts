/**
 * bug-triage peer — injects the bug-triage role into the one session
 * launched as the standing bug-triage peer.
 *
 * Trigger: the session's DISPLAY NAME is "bug-triage" (`pi --name
 * bug-triage`), and it's not a subagent. We trigger on the name, NOT on
 * PI_PEER_NAME, deliberately: an env var is ambient and outlives the
 * session — `export PI_PEER_NAME=bug-triage` then reusing the terminal
 * for an unrelated `pi` would quietly reactivate the role. `--name` is a
 * per-invocation CLI arg that can't leak into the shell, so the role
 * activates only for a session explicitly launched as the triage peer
 * (and reactivates correctly on `/resume` of that named session).
 *
 * The same `--name` also drives peer-link's mailbox identity — peer-link
 * falls back to the session display name when PI_PEER_NAME is unset — so
 * `pi --name bug-triage` is the complete launch: reporters `peer_send` to
 * "bug-triage" and it reaches this session, no env var needed. A stale
 * PI_PEER_NAME=bug-triage in the shell would hijack that mailbox identity
 * for an unrelated session, so we warn if it's set without the name.
 *
 * The role file agents/bug-triage.md is appended to the system prompt
 * (cache-stable, survives compaction) and a one-shot kick-off primes the
 * first turn. Non-triage sessions run trivial no-op handlers (a name
 * compare) — same pattern as modes.ts.
 *
 * Why a peer, not a 4th mode: see decisions/bug-triage/001-bug-triage-peer.md.
 */

import { readFileSync, statSync } from "node:fs";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ROLE_NAME = "bug-triage";
const ROLE_FILE = "agents/bug-triage.md";

/**
 * Pure: does this session carry the bug-triage role? Triggers on the
 * session display name (intentional, per-invocation), not PI_PEER_NAME
 * (ambient, can persist in the shell and silently reactivate). Subagents
 * are excluded. Exported for unit tests.
 */
export function isBugTriagePeer(env: NodeJS.ProcessEnv = process.env, sessionName?: string): boolean {
	if (env.PI_IS_SUBAGENT === "1") return false;
	return (sessionName ?? "").trim() === ROLE_NAME;
}

let cache: { mtimeMs: number; content: string } | undefined;

/** Read the role file, cached by mtime so edits apply live. undefined when missing/empty. */
function readRole(): string | undefined {
	const filePath = `${getAgentDir()}/${ROLE_FILE}`;
	let mtimeMs: number;
	try {
		mtimeMs = statSync(filePath).mtimeMs;
	} catch {
		cache = undefined;
		return undefined;
	}
	if (cache && cache.mtimeMs === mtimeMs) return cache.content || undefined;
	let content: string;
	try {
		content = readFileSync(filePath, "utf-8").trim();
	} catch {
		cache = undefined;
		return undefined;
	}
	cache = content ? { mtimeMs, content } : undefined;
	return content || undefined;
}

const KICKOFF = `## Role: bug-triage peer

You are the standing bug-triage peer. Await handoffs via peer_send (they arrive as [peer:<caller>] messages). For each: reproduce, pin with a failing .cases, root-cause, file a gh issue. Ping the caller back ONLY if the bug affects their in-flight work. Full role in your system prompt.`;

export default function bugTriageExt(pi: ExtensionAPI): void {
	let pendingKickoff = false;

	pi.on("session_start", async (_event, ctx) => {
		const active = isBugTriagePeer(process.env, pi.getSessionName());
		pendingKickoff = active;
		if (active) {
			ctx.ui.setStatus("role", ctx.ui.theme.fg("warning", `[${ROLE_NAME}]`));
			pi.events.emit("pi-config:startup-summary-item", {
				key: "bug-triage",
				order: 31,
				text: `[bug-triage] Standing peer. Awaiting handoffs via peer_send("${ROLE_NAME}", …).`,
			});
		} else if ((process.env.PI_PEER_NAME ?? "").trim() === ROLE_NAME) {
			// Stale PI_PEER_NAME in the shell: peer-link would give this unrelated
			// session the "bug-triage" mailbox identity (PI_PEER_NAME wins) and
			// hijack reporters' handoffs, while the role stays inactive (no --name).
			ctx.ui.notify(
				`PI_PEER_NAME is "${ROLE_NAME}" but this session isn't named "${ROLE_NAME}" — it would hijack the "bug-triage" mailbox. Launch the peer with --name (pi --name ${ROLE_NAME}), or unset the stale PI_PEER_NAME in your shell.`,
				"warning",
			);
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (!isBugTriagePeer(process.env, pi.getSessionName())) return;
		const role = readRole();
		const out: { systemPrompt?: string; message?: unknown } = {};
		if (role) out.systemPrompt = `${event.systemPrompt}\n\n${role}`;
		if (pendingKickoff) {
			out.message = { customType: "bug-triage-kickoff", content: KICKOFF, display: false };
			pendingKickoff = false;
		}
		return Object.keys(out).length ? out : undefined;
	});
}
