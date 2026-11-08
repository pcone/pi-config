/**
 * The child's wire protocol: RPC writes, the live-log line sink, the spawn argv
 * and env composition, the work-order review-policy grammar, and the /attach
 * guards that send user input down the same pipe.
 *
 * Split out of `index.ts` by WO-2026-095. Behaviour is unchanged. `bumpActivity`
 * lives here rather than with the silence timer: the protocol layer is what
 * observes activity, and the timer is what reads the timestamp.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { debugLog, findRunningByQuery, type RunningSubagent } from "./index.ts";

// ── Attach helpers ─────────────────────────────────────────────────────────

/**
 * Resolve an attach target from a user-supplied session-id string.
 * Encapsulates lookup + all guards: empty arg, not found, already done,
 * no writable stdin. Pure over the map + each rs's isDone/stdin state.
 */
export function resolveAttachTarget(
	runningMap: Map<string, RunningSubagent>,
	sid: string,
): { ok: true; rs: RunningSubagent } | { ok: false; reason: "empty" | "notFound" | "done" | "noStdin" } {
	if (!sid.trim()) return { ok: false, reason: "empty" };

	const rs = findRunningByQuery(runningMap, sid);
	if (!rs) return { ok: false, reason: "notFound" };
	if (rs.isDone) return { ok: false, reason: "done" };
	if (!rs.stdin || rs.stdin.destroyed) return { ok: false, reason: "noStdin" };
	return { ok: true, rs };
}

/**
 * Build the RPC prompt payload for attaching user input to a running
 * subagent. Pins the exact shape — missing streamingBehavior would throw
 * when the child is mid-turn.
 */
export function buildPromptPayload(text: string): { type: "prompt"; message: string; streamingBehavior: "steer" } {
	return { type: "prompt", message: text, streamingBehavior: "steer" };
}

/** Why a steer cannot reach the child, or null when it can. The one definition
 *  of "steerable": `rpcSend` alone is not enough (a destroyed stream can still
 *  read `destroyed: false` for a moment after the child exits), and a write
 *  into a dead pipe buffers silently while the caller reports success. */
export function steerBlockedReason(rs: RunningSubagent): "completed" | "process exited" | "stdin closed" | null {
	if (rs.isDone) return "completed";
	if (rs.procExited) return "process exited";
	if (!rs.stdin || rs.stdin.destroyed) return "stdin closed";
	return null;
}

/**
 * Send a steering prompt to a live child — the one steer path (decision 046).
 * Returns false when the child could not receive it; the caller decides what
 * that means for its own reporting (`steerBlockedReason` names the guard case,
 * and a false with no blocked reason is a write that could not land).
 */
export function steerChild(rs: RunningSubagent, message: string): boolean {
	const blocked = steerBlockedReason(rs);
	if (blocked) {
		debugLog(`steerChild: not delivered to ${rs.sessionId} (${blocked})`);
		return false;
	}
	if (!rpcSend(rs.stdin, buildPromptPayload(message))) {
		debugLog(`steerChild: rpcSend failed for ${rs.sessionId}`);
		return false;
	}
	return true;
}

// ── RPC communication ──────────────────────────────────────────────────────

export function rpcSend(stdin: NodeJS.WritableStream | null, command: Record<string, any>): boolean {
	// Returns false when the write cannot land (null, destroyed, or the
	// write throws) so callers can report the truth instead of "sent".
	// Note: destroyed may still be false briefly after the child exits —
	// callers must ALSO guard on rs.procExited before calling.
	if (!stdin || stdin.destroyed) return false;
	try {
		stdin.write(JSON.stringify(command) + "\n");
		return true;
	} catch {
		return false;
	}
}

/**
 * Append a single text line to a running subagent's live log: persisted log
 * file, in-memory `logLines` buffer (drives the TUI widget), and any
 * connected socket viewers.
 *
 * Mirrors the closure-scoped `logEntry` helper inside `spawnSubagent` so
 * tool bodies registered in `export default function` (e.g. `subagent_kill`,
 * which must return before `proc.on("close")` fires) can write to the same
 * log surface without needing access to the closure. Append-only; the close
 * handler is still the single owner of footer/status rendering.
 */
export function appendRunningLogLine(rs: RunningSubagent, text: string): void {
	// Decision 015: same activity signal as the closure-scoped `logEntry`.
	bumpActivity(rs);
	try { fs.appendFileSync(rs.logPath, text + "\n"); } catch { /* */ }
	rs.logLines.push(text);
	rs.watchHandle?.requestRender();
	for (const client of rs.sockClients) {
		try { client.write(text + "\n"); } catch { rs.sockClients.delete(client); }
	}
}

interface RpcEvent {
	type: string;
	id?: string;
	message?: any;
	message_end?: any;
	// auto_retry_* payload (see pi docs/json.md RPC protocol)
	attempt?: number;
	maxAttempts?: number;
	delayMs?: number;
	errorMessage?: string;
	success?: boolean;
	finalError?: string;
}

/**
 * Build the argv array for spawning a subagent pi process.
 * Extracted so tests can assert flag composition without spawning.
 *
 * `appendSystemPrompts` is the ordered list of append-system-prompt source
 * paths: the shared global APPEND_SYSTEM.md first (so the role prompt has the
 * last word), then the agent-body temp file. Passing any
 * --append-system-prompt flag suppresses pi's own append discovery
 * (resource-loader.js: `discoverAppendSystemPromptFile` runs only when no
 * explicit append source is given), so the caller injects the global file
 * explicitly — see decisions/subagents/025-global-append-for-subagents.md.
 * Entries that are empty/undefined are skipped; a nonexistent path must NOT
 * be passed, because pi treats it as literal prompt text rather than a file.
 *
 * `sessionId` and `sessionFile` are mutually exclusive: a fresh spawn
 * passes its tracking id as `--session-id` so the child's pi session id
 * IS the handle (searchable in /resume, joinable via `pi --session
 * <id>`); a resume passes `--session <file>` to reopen the same session.
 */
export function buildSubagentArgs(config: {
	model: string;
	tools: string[];
	excludeTools: string[];
	sessionFile?: string;
	sessionId?: string;
	appendSystemPrompts?: string[];
}): string[] {
	const args: string[] = ["--mode", "rpc"];
	if (config.model) args.push("--model", config.model);
	if (config.tools && config.tools.length > 0) args.push("--tools", config.tools.join(","));
	if (config.excludeTools && config.excludeTools.length > 0) {
		args.push("--exclude-tools", config.excludeTools.join(","));
	}
	if (config.sessionFile && config.sessionId) {
		throw new Error("buildSubagentArgs: sessionFile and sessionId are mutually exclusive");
	}
	if (config.sessionFile) {
		args.push("--session", config.sessionFile);
	}
	if (config.sessionId) {
		args.push("--session-id", config.sessionId);
	}
	if (config.appendSystemPrompts) {
		for (const source of config.appendSystemPrompts) {
			if (source) args.push("--append-system-prompt", source);
		}
	}
	return args;
}

/**
 * Resolve the shared global APPEND_SYSTEM.md path for injection into a child.
 * Returns the path only when the file exists — pi treats a nonexistent
 * --append-system-prompt argument as literal prompt text, so a missing file
 * must produce NO argument. Exported so tests can pin path derivation from
 * getAgentDir() and the absence case.
 * See decisions/subagents/025-global-append-for-subagents.md.
 */
export function resolveGlobalAppendPrompt(
	exists: (path: string) => boolean = fs.existsSync,
): string | undefined {
	const candidate = path.join(getAgentDir(), "APPEND_SYSTEM.md");
	return exists(candidate) ? candidate : undefined;
}

/**
 * Decision 028: nesting depth of the *current* process. The root session
 * is 0; each subagent spawn adds one. Used to cap orchestrator nesting
 * at one level. Malformed stamps fail closed (deny, never grant).
 */
export function subagentDepth(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.PI_SUBAGENT_DEPTH;
	if (raw === undefined || raw === "") return 0;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0) return MAX_ORCHESTRATOR_NESTING_DEPTH;
	return Math.floor(n);
}

/** Decision 028: the depth stamped on a child spawned by this process. */
export function nextSubagentDepth(env: NodeJS.ProcessEnv = process.env): number {
	return subagentDepth(env) + 1;
}

/** Decision 028: an orchestrator may nest once — depth 1 may spawn orchestrators, depth 2 may not. */
export const MAX_ORCHESTRATOR_NESTING_DEPTH = 2;

/**
 * Decision 028: refuse an `orchestrator` spawn from a process already at
 * the nesting cap. Returns the error text, or null when the dispatch is
 * allowed. Only orchestrators can spawn orchestrators, so no other agent
 * needs the depth cap.
 */
export function subagentNestingBlock(agentName: string, depth: number): string | null {
	if (agentName !== "orchestrator" || depth < MAX_ORCHESTRATOR_NESTING_DEPTH) return null;
	return (
		`Orchestrator nesting is capped at one level: this session is already at ` +
		`PI_SUBAGENT_DEPTH=${depth}, so it cannot dispatch another orchestrator. ` +
		`Delegate to implementers (or flatten the work into work orders).`
	);
}

export interface SubagentEnvConfig {
	sessionId: string;
	allowlist: string[] | undefined;
	worktreePath: string | null;
	parentCwdForCleanup: string;
	/** Shared per-clone cargo target dir for this dispatch. Null when the child
	 *  is not isolated: an unisolated child runs in the parent checkout, whose
	 *  own `target/` is the right place for its artifacts, and pointing it
	 *  elsewhere would build the tree a second time. */
	cargoTargetDir: string | null;
	depth: number;
}

/**
 * Build the env additions for a subagent pi process (spread over the
 * parent's process.env at spawn). Extracted so tests can assert the role
 * markers without spawning.
 */
export function buildSubagentEnv(config: SubagentEnvConfig): Record<string, string> {
	return {
		// Marker that this process is a subagent. The modes extension
		// (and any other extension that branches on orchestrator vs
		// worker role) reads this to skip orchestrator-specific prompts
		// like "you are the conductor." Set unconditionally so the
		// signal is present even when allowedSubagents is empty.
		PI_IS_SUBAGENT: "1",
		// Decision 028: this process's nesting depth (root session 0, +1 per
		// spawn). The subagent tool refuses orchestrator spawns at
		// depth >= MAX_ORCHESTRATOR_NESTING_DEPTH.
		PI_SUBAGENT_DEPTH: String(config.depth),
		...(config.allowlist && config.allowlist.length > 0
			? { PI_SUBAGENT_ALLOWLIST: config.allowlist.join(",") }
			: {}),
		// Path to the subagent's isolated git worktree. The worktree-guard
		// extension reads this and uses it to:
		//   1. Allow writes inside this worktree (the "own worktree" anchor)
		//   2. Block writes inside OTHER concurrent subagents' worktrees
		//      (paths under `~/Developer/wt/subagents/` that are not this one)
		// Empty string when no worktree isolation applies (`isolate: false`
		// reviewers, or subagents dispatched without worktree support);
		// the worktree-guard treats empty as a no-op for that guard.
		PI_SUBAGENT_WORKTREE: config.worktreePath ?? "",
		// Path to the parent repo's checkout. The worktree-guard blocks
		// writes inside this path so the child cannot contaminate the
		// orchestrator's working tree. Only meaningful when the child is
		// actually isolated (i.e. has its own worktree) — for unisolated
		// reviewers the child runs IN the parent cwd, so the parent-cwd
		// block would block them from their own working directory. Empty
		// in that case.
		PI_SUBAGENT_PARENT_CWD: config.worktreePath ? (config.parentCwdForCleanup ?? "") : "",
		// Decision 0NN: one target dir per clone, shared by its worktrees.
		// Registry-crate artifacts are reused across worktrees, and cargo's
		// target-dir lock serialises concurrent rustc runs — the memory peak
		// that pushes an 8 GB box into swap when several lanes build at once.
		...(config.cargoTargetDir ? { CARGO_TARGET_DIR: config.cargoTargetDir } : {}),
		// peer-link identity: the subagent's peer name is its session id, so
		// the same id steers it, resumes it, and addresses peer messages to
		// it. Always set — an inherited PI_PEER_NAME would make sibling
		// subagents collide on one mailbox identity.
		PI_PEER_NAME: config.sessionId,
	};
}

/**
 * Full env for a spawned subagent: the parent's env with the subagent
 * additions layered over it. The additions win (spread order), so an
 * inherited PI_SUBAGENT_DEPTH can never survive into the child — the
 * child's own stamped depth is authoritative. This is the spawn site's
 * env builder and computes the depth itself, so no caller can forget
 * the increment.
 */
export function buildSubagentProcessEnv(
	config: Omit<SubagentEnvConfig, "depth">,
	parentEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	return { ...parentEnv, ...buildSubagentEnv({ ...config, depth: nextSubagentDepth(parentEnv) }) };
}

// Decision 014 (+ 2026-10-07 ruling): one grammar for the work order's
// declared `review_policy`. Two encodings, in priority order:
//   1. the bold line — `**review_policy**: skip`. The leading bullet is
//      OPTIONAL: a bare bold line is how a human writes a metadata block, and
//      before the ruling it matched no form and was silently read as
//      `required` — inert, which defeats decision 014 making the WO the single
//      source of truth (the same class as the frontmatter gap fixed
//      2026-08-26, and observed for real in another repo's work orders).
//   2. YAML frontmatter  — `review_policy: skip`, for work orders written that
//      way. The bold line wins when both are present.
//
// First-word-after-colon semantics in both forms: `skip` → skip; anything else
// — `required`, the template literal `required | skip`, or no declaration at
// all — → required. Trailing rationale after the first token is ignored, so
// `skip — because ...` still reads as skip. Deliberately NOT a substring match
// for `skip`.
const POLICY_BOLD_RE = /^\s*(?:-\s*)?\*\*review_policy\*\*:\s*(\S+)/m;
// YAML frontmatter is work-order scope only — a task string never carries it.
const POLICY_YAML_RE = /^review_policy:\s*(\S+)/m;

export function parseWorkOrderPolicy(woText: string): "required" | "skip" {
	const m = woText.match(POLICY_BOLD_RE) ?? woText.match(POLICY_YAML_RE);
	return m?.[1] === "skip" ? "skip" : "required";
}

/** Does this dispatch's task text declare `skip`? The bold line only — YAML
 *  frontmatter is a work-order spelling, not something a task string carries —
 *  with the same first-word semantics as `parseWorkOrderPolicy`. The gate's
 *  WO-less fallback and the skip-bullet injection share this one detector.
 *  @for-testing-only — exported to pin the task-text scope. */
export function taskDeclaresPolicySkip(task: string): boolean {
	return POLICY_BOLD_RE.exec(task)?.[1] === "skip";
}
/** Record a progress signal from the child — tool lifecycle, streaming tool
 *  output, LLM-call streaming + provider retries (the ACTIVITY_EVENT_TYPES
 *  union), assistant message_end, or any log output. The stage-2
 *  silence-kill timer reads this timestamp to tell a hung child from a
 *  slow-but-healthy one. */
export function bumpActivity(rs: RunningSubagent): void {
	rs.lastActivityMs = Date.now();
}
