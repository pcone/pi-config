/**
 * Async Subagent Extension — Non-blocking subagent execution via RPC mode.
 *
 * Subagents run in background pi processes using RPC mode. The parent
 * remains interactive and can check progress, steer, or stop subagents
 * at any time. Results are delivered as injected user messages.
 */

import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { CustomEditor, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { FLEET_MODEL_SPEC } from "../lib/fleet-model.ts";
import { registerWaitSource } from "../lib/waits.ts";
import { validateOwnerAsks } from "../lib/owner-row.ts";
import { cargoTargetDirFor, subagentWorktreePath } from "../lib/subagent-worktree.ts";
import {
	type CommandRunner,
	type BuildOutputReport,
	createReapBuildOutput,
	describeBuildOutput,
	disposeWorktreeBuildOutput,
} from "../lib/build-output-reaper.ts";
import { discoverSessions } from "../lib/subagent-discovery.ts";
import {
	formatReport as formatReaperReport,
	readReaperReport,
	reapCheckouts,
	summarizeReport as summarizeReaperReport,
	wtRoots,
} from "../lib/checkout-reaper.ts";
import {
	EXITED_FOOTER_WORD,
	OUTCOME_WORD,
	STOPPED_FOOTER_WORD,
	SUBAGENT_STALE_TURN_MS,
	decideRecoveryAdoption,
	defaultOwnerProbe,
	gatherSubagentDiskFacts,
	hasTerminalFooter,
	isKnownStopReason,
	isOwnerAlive,
	listInFlightSubagents,
	idMatchesQuery,
	listSubagentMetas,
	normalizeIdQuery,
	resolveSubagentMeta,
	MAX_TURNS_HARD,
	STALL_TURNS,
	TURN_CAP_DEFAULT,
	TURN_CAP_GRACE,
	decideTurnAction,
	nextStallState,
	outcomeFromExitCode,
	outcomeFromFooterWord,
	processStartToken,
	readSubagentState,
	readTerminalFooter,
	resolveTurnCap,
	resumeCallFor,
	selfStartToken,
	stallSampleDue,
	stopReasonOutcome,
	type OwnerProbe,
	type CommitObservation,
	type PendingStallObservation,
	type StallObservation,
	type StallTracker,
	type SubagentOutcome,
	type TurnAction,
	type TurnCapState,
} from "../lib/subagent-state.ts";

// The 027 ownership gate and the R3-3 state vocabulary live in
// ../lib/subagent-state.ts so checkpoint reads the same registry with the same
// predicate (R3-1). Re-exported here: these names are the module's public
// surface for the existing tests and importers.
export {
	SUBAGENT_STALE_TURN_MS,
	decideRecoveryAdoption,
	defaultOwnerProbe,
	idMatchesQuery,
	isOwnerAlive,
	normalizeIdQuery,
	processStartToken,
	resolveSubagentMeta,
	selfStartToken,
	type OwnerProbe,
	type RecoveryAdoption,
} from "../lib/subagent-state.ts";
import { matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";
import {
	type CarriedSnapshot,
	createWorktree,
	postDeliveryCleanup,
	preCommitSteps,
	removeWorktreeTree,
} from "./worktree.ts";
import {
	completeWorkRecord,
	openRecordContext,
	openWorkRecord,
	sessionFinalText,
	verifyWorkRecord,
	type WorkRecord,
} from "./records.ts";
import {
	type CommitRunner,
	formatTurnCap,
	observeCommit,
	turnBudgetLine,
	turnCapStep,
	turnCapTurn,
	turnsUsed,
} from "./turn-cap.ts";
import {
	buildSpawnMeta,
	describeUnknownSession,
	findRunningByQuery,
	readSessionCwd,
	reapFinishedWorktrees,
	recoverOrphanedSubagents,
	reportDeclaresOwnerAsks,
	resolveTrackerKey,
	validateResumeMeta,
	_testSetCargoHome,
	_testSetRecoveryScanDir,
	type RecoveryScanDeps,
	type SpawnMetaFields,
} from "./recovery.ts";
import { spawnSubagent } from "./spawn.ts";
import {
	AttachEditor,
	AttachLogViewer,
	LogViewer,
	notifyChildDetached,
	updateFooter,
} from "./ui.ts";
import {
	armSilenceTimer,
	deliverCloseResult,
	deliverResult,
	dispatchKillSignals,
	reconcileSleepGuards,
	stillRunning,
	terminalOutcome,
} from "./sleep-guard.ts";
import {
	type RpcEvent,
	appendRunningLogLine,
	buildPromptPayload,
	buildSubagentArgs,
	buildSubagentEnv,
	buildSubagentProcessEnv,
	bumpActivity,
	nextSubagentDepth,
	parseWorkOrderPolicy,
	resolveAttachTarget,
	resolveGlobalAppendPrompt,
	rpcSend,
	steerBlockedReason,
	steerChild,
	subagentDepth,
	subagentNestingBlock,
	taskDeclaresPolicySkip,
} from "./rpc.ts";

// WO-2026-095 split: worktree.ts owns the tree's lifecycle. Re-exported here so
// the entry point's existing importers (tests, the orchestrator tool) keep
// resolving, and nothing new is exported.
export {
	createWorktree,
	removeWorktreeTree,
	type RemovableWorktree,
	type RemovalDeps,
	type RemovalStage,
	type RemoveWorktreeOutcome,
	type WorktreeRemovalPolicy,
} from "./worktree.ts";

// WO-2026-095 split: records.ts owns the work-order record writes.
export {
	closeWorkRecord,
	commitRecordEntries,
	completeWorkRecord,
	openRecordContext,
	openWorkRecord,
	readSessionExchange,
	verifyWorkRecord,
	type CloseWorkRecordOptions,
	type PersistedWorkRecord,
	type RecordClose,
	type RecordEntryRef,
	type WorkRecord,
} from "./records.ts";

// WO-2026-095 split: turn-cap.ts owns decision 046's cap and stall tripwire.
export {
	observeCommit,
	turnCapStep,
	turnCapTurn,
	type CommitRunner,
} from "./turn-cap.ts";

// WO-2026-095 split: ui.ts owns the TUI surface and the footer.
export { notifyChildDetached, updateFooter } from "./ui.ts";

// WO-2026-095 split: sleep-guard.ts owns decision 015's timers and the delivery
// decision they feed.
export {
	deliverCloseResult,
	deliverResult,
	dispatchKillSignals,
	terminalOutcome,
} from "./sleep-guard.ts";

// WO-2026-095 split: recovery.ts owns the ownership gate and the session-start
// scan (adoption + the finished-worktree reap).
export {
	_testSetCargoHome,
	_testSetRecoveryScanDir,
	buildSpawnMeta,
	describeUnknownSession,
	findRunningByQuery,
	readSessionCwd,
	reapFinishedWorktrees,
	recoverOrphanedSubagents,
	reportDeclaresOwnerAsks,
	resolveTrackerKey,
	validateResumeMeta,
	type ReapResult,
	type RecoveryScanDeps,
	type SpawnMetaFields,
} from "./recovery.ts";

// WO-2026-095 split: rpc.ts owns the child's wire protocol and the attach guards.
export {
	MAX_ORCHESTRATOR_NESTING_DEPTH,
	buildSubagentArgs,
	buildSubagentEnv,
	buildSubagentProcessEnv,
	nextSubagentDepth,
	parseWorkOrderPolicy,
	resolveGlobalAppendPrompt,
	rpcSend,
	subagentDepth,
	subagentNestingBlock,
	taskDeclaresPolicySkip,
} from "./rpc.ts";

// ── Constants ───────────────────────────────────────────────────────────────

export const TURN_NUDGE_SOFT = 450; // warn once before the hard 500-turn kill

// Child-facing texts for the two turn-cap arm messages (decision 046). No
// number appears in either: the implementer learns of its cap only from the
// wind-down, and a ledger-calibrated number in the child's context would leak
// how much room it has left (owner ruling 2026-11-07, "hide it").
export const TURN_CAP_WIND_DOWN_STEER =
	"[Turn limit] This run has reached its turn limit. Commit what is green, leave the rest as a " +
	"clearly-marked WIP commit, then report: status partial or blocked, naming what is done, what is not, " +
	"the evidence you have, and what you would do next. You will be stopped shortly if you have not exited. " +
	"Do not thin tests, skip mutations or skip checks to finish.";
export const STALL_STEER =
	"[No-progress check] No new commit for a long stretch of turns. Stop and check whether your current " +
	"approach is working: if it is, carry on; if it is not, change approach or report what is blocking you.";
const STOP_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
export const HARD_KILL_DELAY_MS = 5000;
// Stalled-turn watchdog: if a subagent hasn't completed a turn in
// SUBAGENT_STALE_TURN_MS, wake the caller (do NOT kill the subagent)
// so it can inspect progress with subagent_status or stop it with
// subagent_stop. The watchdog resets on every assistant turn, so it
// only fires when the subagent is genuinely stuck.
// Decision 015 stage-2: a child SILENT for SILENCE_TIMEOUT_DEFAULT_MS (no
// activity in the decision-015 signal union — tools, LLM streaming, retries,
// logs; per `lastActivityMs` tracking) is
// auto-killed via the shared subagent_kill machinery (SIGTERM → SIGKILL),
// with a `[Killed via progress-timeout]` marker delivered so the parent's
// wait resolves and the session stays resumable. The default (30 min) is
// strictly longer than SUBAGENT_STALE_TURN_MS (5 min) — the stage-1 wake
// gives the caller four chances to intervene before stage 2 fires.
// 0/negative per-spawn (silenceTimeoutMs param) disables stage 2 entirely.
export const SILENCE_TIMEOUT_DEFAULT_MS = 30 * 60 * 1000; // 30 minutes
// Sleep guard (decision 015 fix): heartbeat cadence and jitter slack for
// detecting system sleep. A heartbeat tick landing >slack late means the
// process was suspended — discount the slept interval from each child's
// silence budget so sleep isn't billed as child silence.
export const SLEEP_GUARD_HEARTBEAT_MS = 10 * 1000;
export const SLEEP_GUARD_SLACK_MS = 3 * 1000;
// Decision 015 guards 3+4: the raw RPC event types that count as child
// activity. Tool lifecycle + streaming tool output (guard 3); LLM-call
// streaming + provider retry lifecycle (guard 4 — a child mid-LLM-call emits
// none of guard 3's signals, so without message_update one slow provider call
// spanning the silence window was killed at a live turn boundary, issue #1).
// The assistant message_end bump is role-gated at its call site and stays
// there; log lines bump via logEntry.
export const ACTIVITY_EVENT_TYPES: ReadonlySet<string> = new Set([
	"tool_execution_start",
	"tool_execution_end",
	"tool_execution_update",
	"message_start",
	"message_update",
	"auto_retry_start",
	"auto_retry_end",
]);
export function eventCountsAsActivity(type: string): boolean {
	return ACTIVITY_EVENT_TYPES.has(type);
}
// Stage-1 softening: activity within this window means the child is emitting
// (LLM deltas / retries arrive sub-second) — soften the stall notice instead
// of crying "stalled" mid-stream. False stalls invited manual kills of
// healthy children (decision 015 amendment 2026-08-12: ≈209 manual vs ≈6
// stage-2 kills).
const STALL_SOFTEN_ACTIVITY_MS = 60 * 1000;
const STARTUP_SUMMARY_EVENT = "pi-config:startup-summary-item";
const REVIEW_ROUND_CAP = 3;

/** Module-level debug flag — set once at load time. Used for timing instrumentation. */
export const PI_ASYNC_DEBUG = process.env.PI_ASYNC_DEBUG === "1";

// ── Reviewer-spawn tracker ────────────────────────────────────────────────
//
// Tracks which reviewer kinds each parent (the running pi process) has spawned.
// The orchestrator's `subagent_review_status` tool reads the persisted form of
// this map to mechanically verify that an implementer's declared
// `reviewParentRequirements` are met before forwarding `complete`. A `plan`
// spawn is recorded like any other kind but never satisfies a requirement and
// never counts as a review round: the soft-prompt check compares kind tokens
// exactly, and `plan` is not a requirement kind (WO-2026-074 Q-074-a).
//
// Two views of the same data:
//   - `parentReviewerSpawns`: in-memory `Map<parentSessionId, SpawnEntry[]>`,
//     used by the soft-prompt check at parent-stop time. Per-process; lost on
//     restart (documented; not a bug).
//   - `/tmp/pi-subagent-<parentSessionId>.reviewers.json`: durable file the
//     orchestrator reads via `subagent_review_status`. Persisted on every
//     spawn so cross-process visibility survives the harness restarting.
//
// When the parent is itself a subagent (e.g. implement running in RPC
// mode), `ctx.sessionManager.getSessionId()` returns the parent's session id;
// if unavailable, fall back to `pid:<process.pid>`. The fallback only matters
// in nested-orchestration scenarios; normal pi sessions always have a
// session id.

import { isReviewRequirementKind, type ReviewRequirementKind, type ReviewerKind } from "./agents.ts";

interface SpawnEntry {
	reviewerKind: ReviewerKind;
	childSessionId: string;
	childAgentName: string;
	spawnedAt: number;
}

interface TrackerState {
	spawns: SpawnEntry[];
	reviewRounds: number;
	reviewCapReached: boolean;
}

const parentReviewerSpawns = new Map<string, TrackerState>();

/** Stable key for tracker persistence and cross-process lookup. */
export function getParentTrackerKey(ctx: any): string {
	try {
		const id = ctx?.sessionManager?.getSessionId?.();
		if (typeof id === "string" && id.length > 0) return id;
	} catch { /* sessionManager not present — fall through */ }
	return `pid:${process.pid}`;
}

/** On-disk path for a parent's reviewer-spawn log (read by orchestrator tool). */
function reviewStatusPath(parentKey: string): string {
	// Sanitize: strip characters that would break a path. The session id is
	// generated by the parent process and is normally safe, but a malicious or
	// buggy upstream could produce anything. Keep this conservative.
	const safe = parentKey.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 200) || `pid_${process.pid}`;
	return `/tmp/pi-subagent-${safe}.reviewers.json`;
}

function recordReviewerSpawn(parentKey: string, entry: SpawnEntry): void {
	const state = parentReviewerSpawns.get(parentKey) ?? { spawns: [], reviewRounds: 0, reviewCapReached: false };
	state.spawns.push(entry);
	// A round is a post-implementation review. A `plan` spawn is recorded (the
	// orchestrator reads `spawns`) but consumes none of the 3 rounds: the cap
	// suppresses the missing-reviewer nudge, which a plan review must not weaken
	// (WO-2026-074 Q-074-a; decisions/subagents/006).
	if (isReviewRequirementKind(entry.reviewerKind)) state.reviewRounds++;
	if (state.reviewRounds >= REVIEW_ROUND_CAP) {
		state.reviewCapReached = true;
	}
	parentReviewerSpawns.set(parentKey, state);

	// Persist atomically: write to a temp file then rename. Avoids partial
	// reads if the orchestrator polls while we write.
	try {
		const target = reviewStatusPath(parentKey);
		const tmp = `${target}.tmp.${process.pid}`;
		fs.writeFileSync(tmp, JSON.stringify({
			parentSessionId: parentKey,
			updatedAt: Date.now(),
			spawns: state.spawns,
			reviewRounds: state.reviewRounds,
			reviewCapReached: state.reviewCapReached,
		}, null, 2));
		fs.renameSync(tmp, target);
	} catch (e) {
		debugLog(`recordReviewerSpawn: persist failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/**
 * Read the persisted spawn list for a given session id. Used by:
 *   1. The soft-prompt check at child-stop time (parent's harness reads the
 *      child's tracker file).
 *   2. The `subagent_review_status` tool (orchestrator's harness reads the
 *      implementer's tracker file).
 * Returns an empty TrackerState on any error (missing file, parse failure, IO error).
 * Never throws — this is a best-effort signal; gate enforcement belongs to the
 * orchestrator, not the harness.
 */
export function readPersistedSpawns(parentSessionId: string): TrackerState {
	try {
		const path = reviewStatusPath(parentSessionId);
		const raw = fs.readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw);
		const spawns = Array.isArray(parsed.spawns) ? parsed.spawns as SpawnEntry[] : [];
		const reviewRounds = typeof parsed.reviewRounds === "number" ? parsed.reviewRounds : spawns.length > 0 ? 1 : 0;
		const reviewCapReached = parsed.reviewCapReached === true;
		return { spawns, reviewRounds, reviewCapReached };
	} catch { /* missing or malformed — treat as empty */ }
	return { spawns: [], reviewRounds: 0, reviewCapReached: false };
}

/** Drop the in-memory entry when a parent ends (avoid growth across sessions). */
function clearParentTracker(parentKey: string): void {
	parentReviewerSpawns.delete(parentKey);
	// Note: we intentionally do NOT delete the on-disk file here — the
	// orchestrator may still want to read it after this parent has stopped.
	// A subsequent spawn from a new parent with the same key (unlikely but
	// possible with the pid fallback) will overwrite the file.
}

/**
 * Module-level debug logger. No-op unless PI_ASYNC_DEBUG=1 is set. Used by
 * tracker helpers and the spawn code (the spawn code previously had its own
 * closure-scoped debugLog; we keep one canonical helper at module scope so
 * tracker logic can log too).
 */
export function debugLog(msg: string): void {
	if (!PI_ASYNC_DEBUG) return;
	try { fs.appendFileSync("/tmp/pi-async-debug.log", `[${process.pid}] ${msg}\n`); } catch { /* */ }
}

// ── Meta-file helpers ──────────────────────────────────────────────────────
// Atomic read/write for /tmp/pi-subagent-<sid>.meta.json, matching the
// recordReviewerSpawn pattern (tmp + rename) to avoid torn reads.

export function metaPath(sessionId: string): string {
	return `/tmp/pi-subagent-${sessionId}.meta.json`;
}

/** Write a complete meta file atomically. */
export function writeMetaJson(sessionId: string, data: Record<string, any>): void {
	try {
		const target = metaPath(sessionId);
		const tmp = `${target}.tmp.${process.pid}`;
		fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
		fs.renameSync(tmp, target);
	} catch (e) {
		debugLog(`writeMetaJson: failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/** Read a meta file, returning null on any error (missing, malformed, etc.). */
export function readMetaJson(sessionId: string): Record<string, any> | null {
	try {
		const raw = fs.readFileSync(metaPath(sessionId), "utf-8");
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

/** Update an existing meta file by merging fields (read-modify-write, atomic). */
export function updateMetaJson(sessionId: string, updates: Record<string, any>): void {
	if (readMetaJson(sessionId) === null) {
		// No readable meta (missing or malformed): write the updates alone, as
		// before. Mirrored by test-resume.cjs — keep in sync.
		writeMetaJson(sessionId, updates);
		return;
	}
	updateMetaAt(metaPath(sessionId), updates);
}

/** Merge `updates` into the meta file at `file` (read-modify-write, atomic).
 *  Split out so the reap can write back into its injected registry directory. */
export function updateMetaAt(file: string, updates: Record<string, any>): void {
	try {
		const existing = JSON.parse(fs.readFileSync(file, "utf-8"));
		const merged = { ...existing, ...updates };
		const tmp = `${file}.tmp.${process.pid}`;
		fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
		fs.renameSync(tmp, file);
	} catch (e) {
		debugLog(`updateMetaAt: failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}

// ── Progress tracking ───────────────────────────────────────────────────────

interface SubagentProgress {
	turns: number;
	filesRead: Set<string>;
	filesModified: Set<string>;
	lastActions: string[]; // last 5 tool calls, newest last
	errors: string[];
	currentActivity: string;
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	latestCacheHitRate: number | undefined;
}

export interface RunningSubagent {
	proc: ChildProcess;
	sessionId: string;
	agentName: string;
	task: string;
	cwd: string;
	startedAt: number;
	progress: SubagentProgress;
	messages: any[]; // accumulated messages for final output
	stdin: NodeJS.WritableStream | null;
	resolveOnStop: ((finalMessage?: string) => void) | null; // set by stop tool
	isDone: boolean;
	// Set in proc.on("exit") — the earliest reliable signal that the child
	// process has died. The running-map entry only disappears in the later
	// close handler, so guards on the map alone leave a window where a
	// steer can be "sent" into a dead pipe. Check this (and stdin state)
	// before any stdin write.
	procExited: boolean;
	// Terminal footer word read from the log on the orphan-recovery path
	// (WO-2026-078). A recovered child left no assistant message in this
	// process, so the word its dead session already wrote is the only terminal
	// evidence there is. Null for a run this process spawned.
	recoveredFooterWord: string | null;
	// Set by the `subagent_kill` tool before it dispatches SIGTERM/SIGKILL
	// so the close handler can label the footer "Killed" and prepend a
	// `[Killed via subagent_kill ...]` marker to the delivered result.
	// Set BEFORE `proc.kill(...)` so the close handler observes it; tool is
	// idempotent on the second call (no-op when already true). Not set by
	// `subagent_stop` — that path uses the regular `Stopped` footer and
	// resolves the waiter directly without delivering as a user message.
	killedExplicitly: boolean;
	// Set by the `subagent_stop` tool BEFORE it dispatches the wrap-up
	// steer so the review-gate soft-prompt block (msg_end handler) can tell
	// the final text-only message that follows a stop apart from a normal
	// completion. An explicit stop means "wrap up and report, do not start
	// new work" — so the post-implementation review soft-prompt (which
	// would re-enter the agent loop to launch reviewers) is suppressed and
	// the subagent is allowed to exit cleanly. The orchestrator's
	// mechanical `subagent_review_status` gate is report-driven (it keys
	// off an implementer `complete` report, not a `subagent_stop` result),
	// so a stopped result is never gated on either.
	stoppedExplicitly: boolean;
	turnNudged: boolean; // one-shot flag: soft 450-turn wrap-up nudge already sent
	// Decision 046: the per-dispatch turn cap. Resolved through resolveTurnCap
	// at spawn/resume (0 disables → Infinity); the decision itself lives in
	// extensions/lib/subagent-state.ts, never at this file's call sites.
	turnCap: number;
	// Turns used by the earlier runs of this same logical dispatch (0 for a fresh
	// spawn, the recorded count on a resume). The cap compares against
	// turnsUsed() — see the helper.
	turnsBefore: number;
	// The wind-down steer was injected; the grace is running. Not persisted: a
	// resume re-trips it (decision 046).
	turnCapReached: boolean;
	// The whole stall arm — the fold's counters, the last observed tip, and the
	// sampled observation's bookkeeping. One value: they always move together.
	stall: StallTracker;
	logPath: string;   // live human-readable event log
	logLines: string[];     // in-memory buffer for live TUI widget
	stderrLines: string[];  // captured stderr from the child pi process;
	                        // surfaced in the delivered result when the
	                        // child exits before completing any turn so
	                        // the orchestrator can see *why* it failed
	                        // instead of just "exit 1, 0 turns".
	watchHandle: any;       // setWidget handle for live updates
	sockPath: string;       // Unix socket path for external viewers
	sockServer: net.Server; // socket server
	sockClients: Set<net.Socket>; // connected viewers
	// Reviewer invocation guard: the parent agent's declared requirements.
	// Empty / undefined means "no gate applies" (the soft-prompt check is a no-op).
	reviewParentRequirements?: ReviewRequirementKind[];
	// R4 owner-asks gate: set when the agent's report schema declares the
	// `owner_asks` field, so its completion report is refused unless the field is
	// well-formed. Derived from the agent prompt, never a name list.
	ownerAsksRequired?: boolean;
	workRecord?: WorkRecord; // set when the spawn passed workOrderPath (decisions/work-order-records/001)
	recordNotes?: string[]; // record writes skipped for want of material, surfaced in status and the delivered result
	// Record writes and close-time checks that failed (WO-2026-094 M3). Loud, not a note: the record is
	// what survives of the dispatch, so a lost entry has to be visible in the status line.
	recordFailures?: string[];
	// Worktree isolation
	worktreePath: string | null;
	isolationBranch: string | null;
	parentHeadCommit: string | null;
	parentCwd: string;
	// Snapshot of the parent's state carried into the worktree (WO-2026-035).
	// preCommitSteps compares the worktree against it to skip committing files
	// the subagent never touched. In-memory only: if the parent restarts and
	// orphans the subagent, this is lost and the filter degrades to committing
	// everything staged (best-effort). Null when no carry happened
	// (carryUncommitted:false / baseRef / no worktree).
	carried: CarriedSnapshot | null;
	// Cached parent tracker key (session id or `pid:<pid>` fallback) for the
	// soft-prompt guard and the cross-process persisted status file. Computed
	// at spawn time when ctx is available; reused at stop time when ctx is
	// out of scope inside the message_end handler.
	parentTrackerKey: string;
	// Cumulative token/cost usage stats for the subagent
	usageStats: UsageStats;
	// Captured from the child's RPC get_state response; set once after spawn.
	// Used by subagent_resume to locate the session file for later continuation.
	sessionFile?: string;
	piSessionId?: string;
	// Stalled-turn watchdog timer. Resets on every assistant message_end
	// and on tool_execution_end; fires a wake-up steer message after
	// SUBAGENT_STALE_TURN_MS.
	staleTimer: NodeJS.Timeout | null;
	// Count of tool calls currently in flight (tool_execution_start increments,
	// tool_execution_end decrements). Lets the stalled-turn watchdog tell a
	// genuinely-idle child from one mid-way through a long tool call (build,
	// grep, deep read) that hasn't produced an assistant message yet — the
	// latter gets a softened "working" notice instead of a "stalled" alarm.
	toolInFlight: number;
	// Decision 015 stage-2: last-activity timestamp — updated on any log
	// line written to the child's log, tool_execution_start/end, and
	// assistant message_end. The silence-kill timer compares this to
	// silenceTimeoutMs to tell a hung child from a slow-but-healthy one.
	lastActivityMs: number;
	// Stage-2 silence-kill timer handle. Cleaned up in the same teardown as
	// the stage-1 watchdog (close handler + kill dispatch). Null when
	// disabled or not armed.
	silenceTimer: NodeJS.Timeout | null;
	// Resolved stage-2 timeout for this child (undefined → 30-min default;
	// 0/negative/NaN → disabled). Per-spawn; no global setting.
	silenceTimeoutMs: number;
	// Kill source for the delivered marker: "kill-tool" (subagent_kill),
	// "progress-timeout" (stage-2 auto-kill), "turn-limit" (the MAX_TURNS_HARD
	// stop), or "turn-cap" (decision 046's cap + grace exhausted). Null until
	// killedExplicitly.
	killedVia: "kill-tool" | "progress-timeout" | "turn-limit" | "turn-cap" | null;
}

export const running = new Map<string, RunningSubagent>();
/** @internal test hook — allows tests to inject entries into the running map. */
export const _testRunning = running;

// ── Live-session ctx ───────────────────────────────────────────────────────
//
// The ctx of the currently-live pi session, or null when no session is live
// (print-mode dispose, reload, quit). Async subagent callbacks — the child's
// socket `data` handler, its process close handler, stale-turn timers —
// outlive the turn that spawned them, so they must never use a captured
// spawn-time ctx: pi invalidates it when the session ends and any `ctx.ui`
// access then throws "This extension ctx is stale after session replacement
// or reload", which crashes the process from inside a socket handler. Set in
// `session_start`; cleared in `session_shutdown`, which pi emits BEFORE
// `ExtensionRunner.invalidate` — see
// decisions/subagents/026-subagent-events-after-session-disposal.md.
export let liveSessionCtx: any = null;

/** @internal test hook — the live-session ctx (null when no session is live). */
export function _testLiveSessionCtx(): any {
	return liveSessionCtx;
}

/** @internal test hook — set/clear the live-session ctx without a real pi
 *  session. Mirrors the `session_start`/`session_shutdown` lifecycle for
 *  tests that exercise delivery against a live session. */
export function _testSetLiveSessionCtx(ctx: any): void {
	liveSessionCtx = ctx;
}

// Active wait timer — set when `wait` is called with the optional `seconds`
// parameter. We hold a single module-level handle because at most one wait
// can be active at a time (the tool terminates the turn, so the next call
// only happens after a wake-up). The timer fires a wake-up steer message
// after N seconds if no subagent has completed; we cancel it from the
// subagent close handler so a completing subagent doesn't get followed
// by a redundant "still running" wakeup.
let activeWaitTimer: NodeJS.Timeout | null = null;

export function clearActiveWait(): void {
	if (activeWaitTimer) {
		clearTimeout(activeWaitTimer);
		activeWaitTimer = null;
	}
}

/**
 * Resolve a session id to a RunningSubagent by exact match first, then
 * partial match via resolveSubagentMeta. Returns the RunningSubagent if
 * found, null otherwise.
 * @throws {Error} If resolveSubagentMeta finds multiple meta files matching
 *   the partial suffix (ambiguous match). The caller should let this
 *   propagate — the pi tool framework surfaces it as an informative error
 *   response telling the user to use a longer suffix.
 */
export function resolveRunningSession(sessionId: string): RunningSubagent | null {
	const exact = running.get(sessionId);
	if (exact) return exact;
	const r = resolveSubagentMeta(sessionId);
	if (!r) return null;
	return running.get(r.sid) ?? null;
}

// ── Attach state ────────────────────────────────────────────────────────────

export let attachedSessionId: string | null = null;
export let _attachCtx: any = null; // captured from /attach command for editor-internal notify

/** @internal test hook — set/clear the attach state without driving /attach. */
export function _testSetAttachState(sessionId: string | null, ctx: any = null): void {
	attachedSessionId = sessionId;
	_attachCtx = ctx;
}

/** @internal test hook — the currently attached session id (null when detached). */
export function _testAttachSessionId(): string | null {
	return attachedSessionId;
}

export function newProgress(): SubagentProgress {
	return {
		turns: 0,
		filesRead: new Set(),
		filesModified: new Set(),
		lastActions: [],
		errors: [],
		currentActivity: "starting...",
	};
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Run a git command and collect output. */
export function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return new Promise((resolve) => {
		const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
		proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
		proc.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
		proc.on("error", () => resolve({ stdout, stderr, exitCode: 1 }));
	});
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

export function extractFilesFromArgs(toolName: string, args: Record<string, any>): { read?: string; write?: string } {
	const result: { read?: string; write?: string } = {};
	const filePath = args.file_path || args.path;
	if (!filePath) return result;

	switch (toolName) {
		case "read":
			result.read = filePath;
			break;
		case "write":
		case "edit":
			result.write = filePath;
			break;
	}
	return result;
}


function formatProgress(rs: RunningSubagent): string {
	const p = rs.progress;
	const elapsed = Math.round((Date.now() - rs.startedAt) / 1000);
	const mins = Math.floor(elapsed / 60);
	const secs = elapsed % 60;
	const state = rs.isDone
		? "[completed — result delivered]"
		: rs.procExited
			? "[process exited — result pending delivery]"
			: null;
	return [
		`Agent: ${rs.agentName}`,
		`Session: ${rs.sessionId}`,
		state,
		`Turns: ${turnsUsed(rs)}`,
		`Turn cap: ${formatTurnCap(rs.turnCap)}`,
		rs.turnCapReached ? "Turn cap reached: true" : null,
		`Elapsed: ${mins}m ${secs}s`,
		`Activity: ${p.currentActivity}`,
		p.filesRead.size > 0 ? `Files read: ${p.filesRead.size}` : null,
		p.filesModified.size > 0 ? `Files modified: ${p.filesModified.size}` : null,
		p.errors.length > 0 ? `Errors: ${p.errors.length}` : null,
		rs.recordNotes?.length ? `Work-order record: ${rs.recordNotes.join("; ")}` : null,
		rs.recordFailures?.length ? `RECORD FAILURE: ${rs.recordFailures.join("; ")}` : null,
	]
		.filter(Boolean)
		.join(" | ");
}

// ── Model resolution (decision 031) ─────────────────────────────────────────

/** The one seat that always tracks its caller's model. */
const INHERITING_AGENT = "orchestrator";

/** pi's thinking levels (`docs/extensions.md` → pi.getThinkingLevel). A model
 *  spec's `:suffix` is a level only when it names one — otherwise it belongs to
 *  the model id (`:free` is a real OpenRouter tag). */
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Split `provider/id[:level]` into the bare spec and its level. */
function splitModelSpec(spec: string): { id: string; level?: string } {
	const i = spec.lastIndexOf(":");
	if (i > 0 && THINKING_LEVELS.has(spec.slice(i + 1))) {
		return { id: spec.slice(0, i), level: spec.slice(i + 1) };
	}
	return { id: spec };
}

/**
 * The model a child process is spawned with. Single source of truth: the spawn
 * args and the `meta.json` record both consume this result, so they cannot
 * disagree about what a child ran on.
 *
 * - The orchestrator seat always tracks its caller (decision 031): the child
 *   runs on the caller's model at the seat's own audited level. On today's
 *   single-slug fleet that resolves to the same model the seat pinned anyway;
 *   it bites when the caller runs something else (Opus, MiMo, …). With no
 *   caller model it falls back to the seat's model — never to "no model".
 *   `inheritParentModel` cannot opt this seat out: the orchestrator branch is
 *   evaluated before the inherit branch, so an explicit `true` is ignored too
 *   and the seat's model is used when there is no caller model.
 * - `inheritParentModel` is the per-spawn opt-in for every other seat; the
 *   caller's model passes through unsubstituted (decisions 020/022).
 * - Resume keeps the recorded model verbatim (decision 022 site 2) —
 *   re-deriving it would silently switch a resumed child's model.
 * - Otherwise the agent frontmatter model wins, the fleet spec when the seat
 *   pins none (decision 022). The spec is provider-qualified
 *   (`opencode-go/deepseek-v4.1-flash`), never the bare id: a bare id resolves
 *   against the session default provider and wanders onto unpinned routes
 *   (owner ruling 2026-10-22).
 *
 * `undefined` means no `--model` flag at all (pi picks its own default).
 * Exported for tests (@for-testing-only): the precedence is the contract.
 */
export function resolveChildModel(opts: {
	agentName: string;
	agentModel?: string;
	parentModel?: string;
	inheritParentModel?: boolean;
	isResume?: boolean;
}): string | undefined {
	if (opts.isResume) return opts.agentModel ?? FLEET_MODEL_SPEC;
	if (opts.agentName === INHERITING_AGENT) {
		if (!opts.parentModel) return opts.agentModel ?? FLEET_MODEL_SPEC;
		const level = opts.agentModel ? splitModelSpec(opts.agentModel).level : undefined;
		return level ? `${opts.parentModel}:${level}` : opts.parentModel;
	}
	if (opts.inheritParentModel) return opts.parentModel;
	return opts.agentModel ?? FLEET_MODEL_SPEC;
}

// ── Detach ──────────────────────────────────────────────────────────────────

/**
 * Internal detach routine. Restores the default editor, clears the attach
 * widget, resets module state, and updates the footer. Idempotent — safe to
 * call when not attached (no-op).
 *
 * Post-turn callers (auto-detach in the child's message_end / close handlers)
 * may run after the spawning session ended, so this NEVER touches a captured
 * spawn-time ctx — it routes UI restore/clear through the live-session ctx and
 * skips the UI work when there is none. Module attach state is always reset so
 * a later session doesn't inherit a stale attach target.
 *
 * Exported as an @internal test hook so the no-live-session guard can be
 * exercised directly.
 */
export function detach(): void {
	if (attachedSessionId === null) return;
	const ctx = liveSessionCtx;
	if (ctx) {
		ctx.ui.setEditorComponent(undefined);
		ctx.ui.setWidget("subagent-attach", undefined);
		ctx.ui.setStatus("subagent-attach", undefined);
	}
	attachedSessionId = null;
	_attachCtx = null;
	updateFooter();
}

// ── Tool action formatting ─────────────────────────────────────────────────

export function formatToolAction(toolName: string, args: Record<string, any>): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};
	const filePath = (args.file_path || args.path || "") as string;
	const short = filePath ? shortenPath(filePath) : "";

	switch (toolName) {
		case "read": return `read ${short}`;
		case "write": return `write ${short}`;
		case "edit": return `edit ${short}`;
		case "bash": {
			const cmd = (args.command as string) || "...";
			return `bash ${cmd.length > 40 ? cmd.slice(0, 40) + "..." : cmd}`;
		}
		case "grep": return `grep ${args.pattern || "..."}`;
		case "find": return `find ${args.pattern || "..."}`;
		case "subagent": return `subagent ${args.agent || "..."}`;
		case "checkpoint": return "checkpoint";
		default: return toolName;
	}
}

/** Arm the stalled-turn watchdog for `rs`. Each assistant turn resets
 *  it via bumpStaleWatchdog; if it fires, a wake-up is delivered to the
 *  caller without killing the subagent — they decide whether to
 *  continue, inspect, or stop. The wake-up is skipped when no live session
 *  exists (the timer can outlive the spawning session; `pi` is invalidated
 *  with the ctx). Exported as an @internal test hook. */
export function bumpStaleWatchdog(pi: ExtensionAPI, rs: RunningSubagent): void {
	if (rs.staleTimer) clearTimeout(rs.staleTimer);
	rs.staleTimer = setTimeout(() => {
		rs.staleTimer = null;
		// Skip if the subagent already finished between the timer fire
		// and our callback running — completion delivers its own message.
		if (rs.isDone || !running.has(rs.sessionId)) return;
		// Post-turn async path: the spawning session may have ended while the
		// child ran. pi invalidates its ExtensionAPI alongside the ctx, so
		// `pi.sendUserMessage` below would throw uncaught from this timer.
		// No live session → no receiver for a stall wake-up; skip.
		if (!liveSessionCtx) {
			debugLog(`stale-watchdog: no live session — skipping wake-up for ${rs.sessionId}`);
			return;
		}
		// If the subagent is parked in a nested wait (it dispatched a child
		// and is blocked on it), the stall is expected — soften the message
		// so the caller doesn't reach for subagent_stop prematurely. The
		// signal: its last tool call was `wait`, so currentActivity === "wait"
		// (formatToolAction falls through to the literal tool name).
		if (rs.progress.currentActivity === "wait") {
			pi.sendUserMessage(
				`[Subagent waiting] ${rs.agentName} (${rs.sessionId.slice(-8)}) has not advanced a turn in ${SUBAGENT_STALE_TURN_MS / 60000} minutes, but appears parked in a nested wait (dispatched a child and is blocked on it). This is usually expected — use subagent_status to inspect; use subagent_stop only if it seems genuinely stuck.`,
				{ deliverAs: "steer" },
			);
			return;
		}
		// A tool call is mid-execution (no RPC progress event arrives mid-tool,
		// so the turn legitimately hasn't produced an assistant message yet).
		// Soften the message so the caller doesn't mistake a healthy long
		// build/grep/read for a hang — observed false "stalled" warnings tripped
		// mid-bash-command (2026-08-08). The stage-2 silence timer (30 min) is
		// still the backstop if the tool genuinely deadlocks.
		if (rs.toolInFlight > 0) {
			pi.sendUserMessage(
				`[Subagent working] ${rs.agentName} (${rs.sessionId.slice(-8)}) has not advanced a turn in ${SUBAGENT_STALE_TURN_MS / 60000} minutes, but a tool call is still in flight. This is usually expected — use subagent_status to inspect; use subagent_stop only if it seems genuinely stuck.`,
				{ deliverAs: "steer" },
			);
			return;
		}
		// Activity within the softening window means the child is emitting —
		// LLM deltas and retry events arrive sub-second when a provider call
		// is grinding. The turn hasn't completed, but the child is
		// demonstrably alive; crying "stalled" here invited manual kills of
		// healthy children (issue #1 family).
		if (Date.now() - rs.lastActivityMs < STALL_SOFTEN_ACTIVITY_MS) {
			pi.sendUserMessage(
				`[Subagent streaming] ${rs.agentName} (${rs.sessionId.slice(-8)}) has not completed a turn in ${SUBAGENT_STALE_TURN_MS / 60000} minutes, but is still emitting activity (LLM response streaming or provider retries). This is usually expected under degraded provider latency — use subagent_status to inspect; use subagent_stop only if it seems genuinely stuck.`,
				{ deliverAs: "steer" },
			);
			return;
		}
		pi.sendUserMessage(
			`[Subagent stalled] ${rs.agentName} (${rs.sessionId.slice(-8)}) has not advanced a turn in ${SUBAGENT_STALE_TURN_MS / 60000} minutes. The subagent is still running — use subagent_status to inspect progress or subagent_stop to terminate.`,
			{ deliverAs: "steer" },
		);
	}, SUBAGENT_STALE_TURN_MS);
}

// ── Extension entry point ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// A running child is a wait: the parent has a result it must gate before it
	// starts anything else (decision checkpoint/003). Derived, never persisted —
	// the registry already records the child, and a child that ends stops being
	// a wait without anyone clearing it. An orphaned child is not a wait: its
	// owner is gone, so nothing will deliver its result; it is resumable work
	// the checkpoint already names, and acting on it is work, not waiting.
	registerWaitSource({
		id: "subagent-async",
		collect: ({ sessionId }) =>
			listInFlightSubagents({ selfSessionId: sessionId })
				.filter((child) => child.state === "running")
				.map((child) => ({
					id: `subagent:${child.sid}`,
					kind: "subagent" as const,
					reason: `${child.agentName ?? "subagent"} ${child.sid.slice(-8)} is still running`,
					since: child.startedAt,
					source: "derived" as const,
				})),
	});

	// ── Session lifecycle ──────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		// Track the live-session ctx before anything else can touch the UI.
		// Every post-turn async path (footer, delivery, child-end notify,
		// attach cleanup) reads this instead of a captured spawn-time ctx.
		liveSessionCtx = ctx;
		try {
			const agents = discoverAgents(ctx.cwd, "user").agents;
			const agentNames = agents.map((agent) => agent.name).sort();
			const text = `[Subagents] ${agentNames.length} available: ${agentNames.join(", ") || "none"}`;
			pi.events.emit(STARTUP_SUMMARY_EVENT, { key: "subagents", order: 20, text });
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			const text = `[Subagents] Unable to list available subagents: ${detail}`;
			pi.events.emit(STARTUP_SUMMARY_EVENT, { key: "subagents", order: 20, text });
		}

		// Re-attach to orphaned subagents from a previous session.
		// Decision 027: the scan gates adoption on the spawning process's
		// recorded identity, so a live foreign session's children are left
		// alone. See `recoverOrphanedSubagents`.
		try { recoverOrphanedSubagents(pi, ctx); } catch { /* best-effort */ }
		// A child session runs this handler too: one pass per child would cost
		// N passes and each would overwrite the report the parent announced.
		// The parent's own session start is the pass.
		if (!process.env.PI_SUBAGENT_DEPTH) {
			// The reaper (WO-2026-092): every checkout under `~/Developer/wt`. 027's
			// subtree goes first — its gates are its own — and the general pass takes
			// its verdicts and the worktree paths its metas named, so the same tree is
			// never decided twice. The last pass's report is announced now; this one
			// replaces it and speaks up only when it removed something.
			const wt = wtRoots();
			const previous = readReaperReport(wt.root);
			if (previous) {
				pi.events.emit(STARTUP_SUMMARY_EVENT, { key: "reaper", order: 25, text: summarizeReaperReport(previous) });
			}
			const subagentMetaPaths = new Set<string>();
			let subagentScopeFailed = false;
			const scopeCauses: string[] = [];
			/** The first cause, plus how many others there were: a torn file must not
			 *  hide the processing throw behind it. */
			const scopeDetail = (): string | undefined =>
				scopeCauses.length === 0
					? undefined
					: scopeCauses.length === 1
						? scopeCauses[0]
						: `${scopeCauses[0]}; ${scopeCauses.length - 1} more`;
			reapFinishedWorktrees(pi, ctx, {
				subagentMetaPaths,
				onScopeFailed: ({ error }) => {
					scopeCauses.push(error);
					// One meta's processing threw, or the list could not be read: those
					// trees are ungoverned, so the general pass reports them and judges
					// none of them (WO-2026-092, R10; decision 051).
					subagentScopeFailed = true;
				},
			})
				.catch((e) => {
					// The reap failed outside any meta's turn (its bound pass, say): no
					// verdicts at all, so the whole subtree is ungoverned.
					subagentScopeFailed = true;
					scopeCauses.push(e instanceof Error ? e.message : String(e));
					debugLog(`reap: unhandled: ${e instanceof Error ? e.message : String(e)}`);
					return [];
				})
				.then((subagentResults) =>
					reapCheckouts({
						root: wt.root,
						subagentBase: wt.subagentBase,
						subagentResults,
						subagentMetaPaths,
						subagentScopeFailed,
						subagentScopeDetail: scopeDetail(),
						removeWorktree: (deps, rs, policy) => removeWorktreeTree(deps, rs, policy),
					}),
				)
				.then(({ report }) => {
					if (report.removed.length === 0) return;
					const lines = report.removed.map((row) => `${row.path}${row.removed?.orphaned ? " (orphaned)" : ""}`);
					const text = `[Reaper] removed ${report.removed.length}: ${lines.slice(0, 6).join(", ")}${lines.length > 6 ? `, +${lines.length - 6} more` : ""} — /reaper`;
					debugLog(text);
					if (ctx.hasUI) ctx.ui.notify(text, "info");
				})
				.catch((e) => {
					debugLog(`reaper: unhandled: ${e instanceof Error ? e.message : String(e)}`);
				});
		}
	});

	pi.on("session_shutdown", () => {
		// Clear the live-session ctx. pi emits this BEFORE invalidating the
		// extension runner, so async child callbacks that observe a null ctx
		// skip UI/delivery instead of throwing on a stale ctx.
		liveSessionCtx = null;
		// Don't kill subagents — they survive parent reloads/restarts.
		// Their work commits to branches and is recoverable via git merge.
		// Socket servers and log files persist at /tmp/pi-subagent-<sid>.*
	});

	// ── /subagents command ──────────────────────────────────────────────

	pi.registerCommand("subagents", {
		description: "List running async subagents",
		handler: async (_args, ctx) => {
			if (running.size === 0) {
				ctx.ui.notify("No subagents running.");
				return;
			}
			const lines = Array.from(running.values()).map((rs) => formatProgress(rs));
			ctx.ui.notify(lines.join("\n\n"));
		},
	});

	pi.registerCommand("reaper", {
		description: "What the wt/ checkout reaper kept and why (the report at ~/Developer/wt/.reaper-report.json)",
		handler: async (_args, ctx) => {
			const report = readReaperReport(wtRoots().root);
			if (!report) {
				ctx.ui.notify("No reaper report yet — it is written at session start, and names every checkout it kept.", "info");
				return;
			}
			ctx.ui.notify(formatReaperReport(report), "info");
		},
	});

	pi.registerCommand("watch", {
		description: "Show a live log panel for a running subagent. Usage: /watch <session-id> or /watch off",
		handler: async (args, ctx) => {
			const sid = args.trim();

			// Turn off current watch if "off" or empty
			if (!sid || sid === "off") {
				ctx.ui.setWidget("subagent-watch", undefined);
				ctx.ui.notify("Watch cleared.");
				return;
			}

			// Match by full session ID, bare tail, or `subagent-`-prefixed tail
			const rs = findRunningByQuery(running, sid);
			if (!rs) {
				ctx.ui.notify(`No running subagent matching "${sid}".`);
				return;
			}

			// Build the widget
			const viewer = new LogViewer(
				rs.logLines,
				rs.agentName,
				rs.sessionId,
				() => rs.usageStats,
			);
			rs.watchHandle = ctx.ui.setWidget("subagent-watch", () => viewer, { placement: "belowEditor" });

			ctx.ui.notify(`Watching ${rs.agentName} (${rs.sessionId}). Use /watch off to close.`);
		},
	});

	// ── /attach ──────────────────────────────────────────────────────────

	pi.registerCommand("attach", {
		description: "Attach to a running async subagent to converse directly. Usage: /attach <session-id>",
		handler: async (args, ctx) => {
			const sid = args.trim();

			// Empty arg while attached → convenience detach
			if (!sid) {
				if (attachedSessionId !== null) {
					detach();
					ctx.ui.notify("Detached.", "info");
					return;
				}
				ctx.ui.notify("Usage: /attach <session-id>", "info");
				return;
			}

			// Resolve target — all guards are in the pure helper
			const result = resolveAttachTarget(running, sid);
			if (!result.ok) {
				const msgs: Record<string, string> = {
					empty: "Usage: /attach <session-id>",
					notFound: `No running session matches "${sid}".`,
					done: `Session "${sid}" has completed; nothing to attach to.`,
					noStdin: `Session "${sid}" is not accepting input.`,
				};
				const level = result.reason === "notFound" || result.reason === "done" || result.reason === "noStdin"
					? "warning" : "info";
				ctx.ui.notify(msgs[result.reason], level);
				return;
			}

			const rs = result.rs;

			// Capture ctx for editor-internal use (escape-detach, notify)
			_attachCtx = ctx;

			// Already attached to the same session — no-op
			if (attachedSessionId === rs.sessionId) {
				ctx.ui.notify(`Already attached to ${rs.sessionId.slice(-8)}.`, "info");
				return;
			}

			// Switching target (already attached to a different session)
			const wasAttached = attachedSessionId !== null;
			attachedSessionId = rs.sessionId;

			if (wasAttached) {
				ctx.ui.notify(`Switched attach target → ${rs.sessionId.slice(-8)}`, "info");
			}

			// Install the attach stream widget (only if not already attached;
			// the widget resolves its target dynamically so switching works
			// without re-installing).
			if (!wasAttached) {
				const attachViewer = new AttachLogViewer();
				ctx.ui.setWidget("subagent-attach", () => attachViewer, { placement: "belowEditor" });
			}

			// Install the AttachEditor (only if not already attached; setEditorComponent
			// creates a fresh editor each call and would lose in-progress text).
			if (!wasAttached) {
				ctx.ui.setEditorComponent((tui, theme, kb) => new AttachEditor(tui, theme, kb));
			}

			// Update footer / status line
			ctx.ui.setStatus("subagent-attach", `▸ attached: ${rs.agentName} (${rs.sessionId.slice(-8)})`);

			if (!wasAttached) {
				ctx.ui.notify(
					`Attached to ${rs.agentName} (${rs.sessionId.slice(-8)}). Type /detach or Escape to return.`,
					"info",
				);
			}
		},
	});

	// ── /detach ──────────────────────────────────────────────────────────

	pi.registerCommand("detach", {
		description: "Detach from the foregrounded subagent and return to the parent session.",
		handler: async (_args, ctx) => {
			if (attachedSessionId === null) {
				ctx.ui.notify("Not currently attached.", "info");
				return;
			}
			detach();
			ctx.ui.notify("Detached.", "info");
		},
	});

	// ── Tools ───────────────────────────────────────────────────────────

	const SubagentParams = Type.Object({
		agent: Type.String({ description: "Name of the agent to invoke" }),
		task: Type.String({ description: "Task to delegate" }),
		cwd: Type.Optional(Type.String({ description: "Working directory for the subagent process" })),
		inheritParentModel: Type.Optional(
			Type.Boolean({
				description:
					"Use the parent session's active model instead of the agent default. The orchestrator agent always inherits the caller's model regardless of this flag; it is how every other agent opts in.",
				default: false,
			}),
		),
		isolate: Type.Optional(
			Type.Boolean({
				description: "Run in an isolated git worktree to avoid file conflicts with concurrent subagents. Default: true. When true, a git worktree is created on a branch off the parent HEAD. On completion, uncommitted changes are auto-committed to that branch, the worktree is removed, and the branch remains for the calling session to inspect and merge.",
				default: true,
			}),
		),
		carryUncommitted: Type.Optional(
			Type.Boolean({
				description: "Carry the parent's uncommitted working-tree state (untracked, modified, staged, deleted files) into the isolated worktree at creation, so the subagent sees what the orchestrator prepared. Default: true. Ignored when baseRef is set — the worktree then branches from that ref's tree. Set false to reproduce HEAD-only behavior.",
				default: true,
			}),
		),
		baseRef: Type.Optional(
			Type.String({
				description: "Git ref (commit hash, branch, or tag) to fork the worktree from. Defaults to HEAD if omitted. Use this when changes are on a feature branch that isn't ready for main — pass the branch name or ref. If changes are only in the working tree, create a feature branch, commit them, and pass that branch.",
			}),
		),
		review_policy: Type.Optional(
			Type.Union([Type.Literal("required"), Type.Literal("skip")], {
				description: "Mirrors the work-order `review_policy` field. Pass `skip` to suppress the harness's post-implementation review guard for this spawn (use for trivial changes where the orchestrator will review the diff directly, or for ad-hoc dispatches without a formal work order). Default: `required`.",
			}),
		),
		workOrderPath: Type.Optional(
			Type.String({
				description: "Repo-relative path to the work order this task executes (e.g. `work-orders/WO-2026-037.md`). When set, the harness reads the work order from the parent checkout at spawn time and derives the review-gate decision from its declared `review_policy` — the WO is the single source of truth. The spawn hard-fails with a loud error if the file is missing or unreadable.",
			}),
		),
		silenceTimeoutMs: Type.Optional(
			Type.Number({
				description: "Kill the subagent if it makes no progress (no tool calls and no assistant messages) for this many milliseconds. Default 1800000 (30 min). 0 or negative disables the auto-kill. Stage-1 wake-up warnings are unaffected.",
				default: 1800000,
			}),
		),
		turn_cap: Type.Optional(
			Type.Number({
				description: `Turns this dispatch may run before the harness ends it: at the cap the child gets one wind-down steer carrying no number, then a flat ${TURN_CAP_GRACE}-turn grace, then it is killed through the shared kill path. Default ${TURN_CAP_DEFAULT}. 0 or negative disables the cap. Above ${MAX_TURNS_HARD} is rejected — the global hard kill would fire first.`,
				default: TURN_CAP_DEFAULT,
			}),
		),
	});

	const StatusParams = Type.Object({
		session_id: Type.String({ description: "Session ID of the running subagent (full id, or its last 8+ characters)" }),
	});

	const SteerParams = Type.Object({
		session_id: Type.String({ description: "Session ID of the running subagent (full id, or its last 8+ characters)" }),
		message: Type.String({ description: "Steering message to inject" }),
	});

	const StopParams = Type.Object({
		session_id: Type.String({ description: "Session ID of the running subagent (full id, or its last 8+ characters)" }),
		final_message: Type.Optional(
			Type.String({ description: "Final steering message before stopping" }),
		),
	});

	const KillParams = Type.Object({
		session_id: Type.String({ description: "Session ID of the running subagent to hard-kill (full id, or its last 8+ characters)" }),
	});

	// If the EFFECTIVE review policy is "skip" — from the referenced work
	// order when `workOrderPath` is set (decision 014), else from the
	// `review_policy` tool param — but the task does not already declare it
	// with the bold line, append one so the implementer's own agent-level
	// reasoning (Gate B) matches the harness's gate suppression (Gate A).
	// Single source of truth: the work order, when `workOrderPath` is set;
	// else the tool arg. When the WO declares `required`, nothing is injected
	// even if the param says `skip` — the WO wins.
	function maybeInjectReviewPolicySkip(task: string, reviewPolicy: "required" | "skip" | undefined): string {
		if (reviewPolicy !== "skip") return task;
		if (taskDeclaresPolicySkip(task)) return task;
		const skipLine = "\n\n- **review_policy**: skip (set by orchestrator on the subagent call — do not spawn reviewers; orchestrator will review the diff directly)";
		return task + skipLine;
	}

	// ── subagent ───────────────────────────────────────────────────────

	pi.registerTool({
		name: "subagent",
		label: "Subagent (async)",
		description:
			"Spawn a subagent that runs in the background. The parent remains interactive. " +
			"Use subagent_status to check progress, subagent_steer to inject guidance, " +
			"and subagent_stop to tell it to wrap up. Results are delivered as a user message when the subagent finishes. " +
			"After a subagent finishes, use `subagent_resume` with the same session_id to continue the same conversation instead of starting fresh.",
		parameters: SubagentParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// One id everywhere: the handle is passed to the child as
			// --session-id, so it is also the subagent's pi session id —
			// searchable in /resume and joinable via `pi --session-id <id>`.
			const sessionId = `subagent-${randomUUID()}`;
			const cwd = params.cwd ?? ctx.cwd;

			// Decision 046: the per-dispatch turn cap. Resolved before any worktree
			// or process exists, so an invalid cap spawns nothing — and a cap whose
			// grace would overrun the global hard kill is refused rather than
			// accepted as a cap that misreports what stopped the run.
			let resolvedTurnCap: number;
			try {
				resolvedTurnCap = resolveTurnCap(params.turn_cap);
			} catch (e) {
				return {
					content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
					isError: true,
				};
			}

			const agents = discoverAgents(cwd, "user").agents;
			const agent = agents.find((a) => a.name === params.agent);
			if (!agent) {
				const available = agents.map((a) => a.name).join(", ") || "none";
				return {
					content: [{ type: "text", text: `Unknown agent: "${params.agent}". Available: ${available}` }],
				};
			}

			// Check if the parent restricted sub-spawning via PI_SUBAGENT_ALLOWLIST
			const allowlist = process.env.PI_SUBAGENT_ALLOWLIST;
			if (allowlist) {
				const allowed = new Set(
					allowlist.split(",").map((a: string) => a.trim()).filter(Boolean),
				);
				if (!allowed.has(agent.name)) {
					const requested = agent.name;
					const allowedList = [...allowed].sort().join(", ") || "(empty)";
					return {
						content: [{
							type: "text",
							text:
								`Agent "${requested}" is not in this subagent's allowlist ` +
								`(${allowedList}). The parent's \`allowedSubagents\` field ` +
								`restricted sub-spawning to that set.`,
						}],
					};
				}
			}

			// Decision 028: cap orchestrator nesting at one level. A process
			// at depth >= 2 is a nested orchestrator; refuse to deepen the
			// tree rather than letting a role-confusion bug nest silently.
			const nestingBlock = subagentNestingBlock(agent.name, subagentDepth());
			if (nestingBlock) {
				return { content: [{ type: "text", text: nestingBlock }] };
			}

			// Check if session is already running
			if (running.has(sessionId)) {
				return {
					content: [{ type: "text", text: `Subagent ${sessionId} is already running.` }],
				};
			}

			// Decision 014 (workOrderPath): read + parse the referenced work
			// order from the parent checkout at spawn, BEFORE any worktree is
			// created, so a missing/unreadable WO hard-fails the spawn with a
			// loud error (no spawn, no worktree) instead of silently falling
			// back. The parsed `review_policy` is the single source of truth
			// for the review gate — it wins over the tool param on disagreement.
			let workOrderPolicy: "required" | "skip" | undefined;
			if (params.workOrderPath) {
				const woPath = path.join(cwd, params.workOrderPath);
				let woText: string;
				try {
					woText = fs.readFileSync(woPath, "utf8");
				} catch {
					return {
						content: [{
							type: "text",
							text:
								`workOrderPath file not found: ${params.workOrderPath} (resolved to ${woPath}). ` +
								`Spawn aborted — pass a valid repo-relative path or omit workOrderPath.`,
						}],
					};
				}
				workOrderPolicy = parseWorkOrderPolicy(woText);
			}
			// Effective review policy — computed once here, shared by the gate
			// decision inside spawnSubagent (RS record) and the skip injection
			// below: the WO wins when present, else the tool param.
			const effectiveReviewPolicy = workOrderPolicy ?? params.review_policy;

			const parentModel = (() => {
				try { const m = ctx.getModel?.(); if (m?.provider && m?.id) return `${m.provider}/${m.id}`; } catch { /* */ }
				return undefined;
			})();

			// Decision 031: the orchestrator seat always tracks its caller's model;
			// every other seat keeps its frontmatter model unless the spawn opts in
			// via inheritParentModel (decision 020). Resolved once — the spawn call
			// below and the meta.json record consume this same value.
			const childModel = resolveChildModel({
				agentName: agent.name,
				agentModel: agent.model,
				parentModel,
				inheritParentModel: params.inheritParentModel ?? false,
			});

			// Worktree isolation (default: true)
			let effectiveCwd = cwd;
			let worktreePath: string | null = null;
			let isolationBranch: string | null = null;
			let parentHeadCommit: string | null = null;
			let carriedSnapshot: CarriedSnapshot | undefined;
			let cargoTargetDir: string | null = null;
			let isolationStatus = "";
			let taskForAgent = params.task;

			// Reviewers default to sharing the caller's worktree — they need
			// to see the implementer's uncommitted changes. But if the caller
			// explicitly passes baseRef (a specific branch/commit), the reviewer
			// gets its own worktree branched from that ref.
			if (agent.reviewerKind && params.isolate === undefined && !params.baseRef) {
				params.isolate = false;
			}

			if (params.isolate !== false) {
				const wt = await createWorktree(cwd, sessionId, params.baseRef, params.carryUncommitted ?? true);
				if (wt) {
					effectiveCwd = wt.worktreePath;
					worktreePath = wt.worktreePath;
					isolationBranch = wt.branchName;
					parentHeadCommit = wt.parentHeadCommit;
					carriedSnapshot = wt.carried;
					cargoTargetDir = wt.cargoTargetDir;
					isolationStatus = `\nIsolated in worktree \`${wt.branchName}\` (off \`${wt.parentHeadCommit.slice(0, 8)}\`)`;
					taskForAgent =
						`## Worktree isolation\n` +
						`You are running inside an isolated git worktree at \`${wt.worktreePath}\`, branched from \`${wt.parentHeadCommit.slice(0, 12)}\`. ` +
						`Your cwd is the worktree root. Edits go to the worktree branch; the harness auto-commits uncommitted changes, removes the worktree, and keeps the branch for review.\n\n` +
						`If the task lists paths like \`/Users/<owner>/<parent-repo>/foo/bar.rs\`, strip the parent prefix and use \`foo/bar.rs\` as a repo-relative path. Never \`cd\` to an absolute parent-repo path — that bypasses isolation.\n\n` +
						params.task;
				} else {
					isolationStatus = "\n(Worktree isolation unavailable — not a git repo or creation failed.)";
				}
			}

			const rs = await spawnSubagent(
				pi,
				ctx,
				agent,
				params.task, // clean task identity (commit subject / display)
				effectiveCwd,
				sessionId,
				childModel,
				worktreePath,
				isolationBranch,
				parentHeadCommit,
				cwd,
				cargoTargetDir,
				undefined, // resumeSessionFile
				params.review_policy,
				// Full delivery payload: worktree-isolation preamble + (possibly
				// review-policy-annotated) task. Reaches the child only.
				// Injection keys on the EFFECTIVE policy (WO wins over the param).
				maybeInjectReviewPolicySkip(taskForAgent, effectiveReviewPolicy),
				carriedSnapshot, // completion-filter snapshot (WO-2026-035)
				workOrderPolicy, // decision 014: parsed WO review_policy (undefined when no WO)
				params.silenceTimeoutMs, // decision 015: stage-2 silence-kill timeout (undefined → 30-min default)
				resolvedTurnCap, // decision 046: per-dispatch turn cap
				0, // decision 046: a fresh spawn starts the dispatch's turn count at zero
			);

			running.set(sessionId, rs);

			// Work-order record: the dispatch belongs to the spawn that OWNS the order, which is a
			// property of the spawned agent. A reviewer never owns one — it reviews one — so its
			// spawn reads the order from its task text and writes no record. (Record design:
			// decisions/work-order-records/001, tfd.) The record's cwd is the tree that will be
			// committed: the isolation worktree when this spawn got one, else the spawner's own repo
			// root, whose commit carries it (WO-2026-094 M1). A failed write is reported as a record
			// failure with the result; it never fails the spawn.
			const isReviewer = agent.reviewerKind !== undefined;
			if (params.workOrderPath && isReviewer) {
				debugLog(`work-order record: no dispatch for ${agent.name} (reviewer_kind=${agent.reviewerKind}); a reviewer never owns an order`);
			}
			const dispatch = params.workOrderPath && !isReviewer
				? openWorkRecord(worktreePath ?? cwd, params.workOrderPath, sessionId, params.task)
				: { failures: [] };
			rs.workRecord = dispatch.record;
			rs.recordFailures = dispatch.failures;

		// Write metadata for recovery on session reload. Includes the full
		// agent config so subagent_resume can reproduce the original
		// configuration faithfully (storing the resolved model and system
		// prompt avoids drift if the user edits the agent definition between
		// spawn and resume). Uses atomic write (tmp + rename) to avoid torn
		// reads.
		// Site 2 (decision 022): meta.json records the resolved model (suffix
		// included) so resume reproduces exactly what ran.
		// Decision 027: record the spawning process's identity so the
		// session_start recovery scan can tell a genuine orphan (owner gone)
		// from another live session's child (owner alive) — and so a recycled
		// pid is not mistaken for the original owner (ownerStartToken).
		writeMetaJson(sessionId, buildSpawnMeta({
			agentName: agent.name,
			task: params.task,
			cwd,
			startedAt: rs.startedAt,
			worktreePath,
			isolationBranch,
			parentHeadCommit,
			parentCwd: cwd,
			tools: agent.tools ?? [],
			model: childModel,
			systemPrompt: agent.systemPrompt,
			allowedSubagents: agent.allowedSubagents ?? [],
			excludeTools: agent.excludeTools ?? [],
			workRecord: dispatch.record, // the meta keeps `cwd`/`woId`; a resume starts a fresh write list
			// Stored in the spawn's own input convention (`0` = disabled) so a
			// resume hands it straight back to `resolveTurnCap`.
			turnCap: Number.isFinite(resolvedTurnCap) ? resolvedTurnCap : 0,
		}, { pid: process.pid, startToken: selfStartToken(), sessionId: ctx.sessionManager.getSessionId() }));

			// Reviewer-spawn tracker: if the spawned agent is a declared reviewer
			// (reviewerKind set in frontmatter), record this spawn under the
			// parent's key. The orchestrator reads this via `subagent_review_status`
			// to mechanically verify the gate. Recording happens AFTER the spawn
			// succeeds and BEFORE the result returns to the caller, so a child
			// session that hasn't yet been recorded is "not yet spawned" per the
			// work-order ordering invariant. Every kind is recorded, `plan`
			// included — that entry is what proves a plan review leaves an
			// `implementation` requirement unmet (WO-2026-074 Q-074-a).
			if (agent.reviewerKind) {
				try {
					const parentKey = getParentTrackerKey(ctx);
					recordReviewerSpawn(parentKey, {
						reviewerKind: agent.reviewerKind,
						childSessionId: sessionId,
						childAgentName: agent.name,
						spawnedAt: Date.now(),
					});
					debugLog(`tracker: recorded ${agent.reviewerKind} spawn for parent=${parentKey} child=${sessionId}`);
				} catch (e) {
					debugLog(`tracker: record failed: ${e instanceof Error ? e.message : String(e)}`);
				}
			}

			updateFooter();

			return {
				content: [
					{
						type: "text",
						text: [
							`Subagent started: ${agent.name} (session: ${sessionId})${isolationStatus}`,
							`Task: ${params.task.slice(0, 200)}${params.task.length > 200 ? "..." : ""}`,
							turnBudgetLine(resolvedTurnCap, 0, isolationBranch !== null),
							...dispatch.failures.map((f) => `RECORD FAILURE: ${f}`),
							"",
							"The session id is the subagent's real pi session id — search it in /resume",
							"or join it from a terminal with `pi --session <id>`.",
							"It is also its peer-link name: message it anytime with peer_send (to: the session id).",
							"",
							"Watch live:",
							"```bash",
							`tail -f /tmp/pi-subagent-${sessionId}.log`,
							"```",
							"Or in-pi: /watch " + sessionId.slice(-8),
							"Or from another terminal: nc -U /tmp/pi-subagent-" + sessionId + ".sock",
							"Use /subagents to check progress.",
						].join("\n"),
					},
				],
			};
		},
	});

	// ── subagent_status ────────────────────────────────────────────────

	pi.registerTool({
		name: "subagent_status",
		label: "Subagent Status",
		description: "Check the progress of a running async subagent.",
		parameters: StatusParams,
		async execute(_toolCallId, params) {
			const rs = resolveRunningSession(params.session_id);
			if (!rs) {
				return {
					content: [
						{
							type: "text",
							text: describeUnknownSession(params.session_id),
						},
					],
				};
			}

			return {
				content: [{ type: "text", text: `State: running — attached to this session's tracker.\n${formatProgress(rs)}` }],
			};
		},
	});

	// ── subagent_review_status ──────────────────────────────────────────
	// Read-only tool that returns the persisted reviewer-spawn tracker for a
	// given parent session id. The orchestrator calls this mechanically after
	// any implementer completion report lands; see `decisions/subagents/
	// 004-parallel-review-gate.md` (Reviewer invocation guard).
	//
	// Returns a JSON object safe to surface in the parent prompt:
	//   {
	//     "parentSessionId": "...",
	//     "updatedAt": 1234,
	//     "kindsPresent": ["implementation", "tests"],
	//     "kindsMissing": [],
	//     "spawns": [ { "reviewerKind": "implementation", "childSessionId": "subagent-...", "childAgentName": "review-code", "spawnedAt": 1234 } ]
	//   }
	// `parentSessionId` is required; the tool reads from
	// `/tmp/pi-subagent-<safe-id>.reviewers.json` (written by the parent's
	// harness on each spawn). If the file is missing or unreadable, returns
	// an empty spawns list — never throws.
	const ReviewStatusParams = Type.Object({
		parent_session_id: Type.Optional(Type.String({
			description: "Session id of the parent whose reviewer spawns you want to inspect (e.g. the implementer's session id). Defaults to the caller's own session id.",
		})),
	});

	pi.registerTool({
		name: "subagent_review_status",
		label: "Subagent Review Status",
		description:
			"Read-only tool. Returns the list of reviewer kinds " +
			"that a given parent session has spawned, with each child session id. " +
			"Use after an implementer's completion report to mechanically verify that " +
			"every reviewer kind the implementer declared in `requires_parent_reviewers` " +
			"has actually been launched. The orchestrator's parallel-review gate uses " +
			"this to refuse `complete` until the implementer's tracker shows all required " +
			"kinds. Output is a JSON object with `parentSessionId`, `updatedAt`, " +
			"`kindsPresent`, `kindsMissing` (relative to no requirement list — always empty), " +
			"`reviewRounds`, `reviewCapReached`, and `spawns` (one entry per spawn).",
		parameters: ReviewStatusParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const resolvedId = params.parent_session_id ?? getParentTrackerKey(ctx);
			const parentSessionId = resolveTrackerKey(resolvedId);
			const trackerState = readPersistedSpawns(parentSessionId);
			// updatedAt is informational; recompute from file mtime if available
			let updatedAt: number | null = null;
			try {
				const path = reviewStatusPath(parentSessionId);
				const stat = fs.statSync(path);
				updatedAt = stat.mtimeMs;
			} catch { /* missing file — updatedAt stays null */ }
			const kindsPresent = Array.from(new Set(trackerState.spawns.map((s) => s.reviewerKind))).sort();
			const payload = {
				parentSessionId,
				updatedAt,
				kindsPresent,
				kindsMissing: [], // populated by orchestrator if it knows the requirement set
				reviewRounds: trackerState.reviewRounds,
				reviewCapReached: trackerState.reviewCapReached,
				spawns: trackerState.spawns,
			};
			return {
				content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
			};
		},
	});

	// ── subagent_resume ───────────────────────────────────────────────
	// Resumes a previously-completed subagent session by spawning a new
	// RPC process that loads the existing session JSONL and continues
	// from where the previous run stopped. Preserves the original agent
	// config (tools, model, system prompt) from the spawn-time meta file.

	/**
	 * Build an AgentConfig from persisted meta fields. Uses the stored
	 * resolved model and full system prompt so resume reproduces the
	 * original config exactly (no drift from user editing agent files).
	 */
	function buildAgentConfigFromMeta(meta: Record<string, any>): AgentConfig {
		return {
			name: meta.agentName || "?",
			description: "",
			systemPrompt: meta.systemPrompt || "",
			tools: Array.isArray(meta.tools) ? meta.tools : [],
			model: meta.model,
			source: "user",
			filePath: "",
			allowedSubagents: Array.isArray(meta.allowedSubagents) ? meta.allowedSubagents : undefined,
			excludeTools: Array.isArray(meta.excludeTools) ? meta.excludeTools : undefined,
		};
	}

	const ResumeParams = Type.Object({
		session_id: Type.String({
			minLength: 1,
			description:
				"Session ID of a previously completed subagent to resume " +
				"(full 'subagent-<UUID>' or last 8+ chars).",
		}),
		task: Type.String({
			description: "Follow-up task to send to the resumed session.",
		}),
		cwd: Type.Optional(
			Type.String({
				description:
					"Working directory; defaults to the original subagent's recorded parentCwd.",
			}),
		),
	});

	pi.registerTool({
		name: "subagent_resume",
		label: "Subagent Resume",
		description:
			"Resume a previously-completed subagent session with a follow-up prompt. " +
			"Spawns a new RPC process that loads the existing session file and continues " +
			"from where the previous run stopped, preserving conversation history and " +
			"model state. The resumed session runs in the original recorded parent cwd " +
			"and does NOT re-establish the original isolation worktree. " +
			"Use this to send a follow-up question or corrective prompt to a reviewer " +
			"that has already finished, without re-seeding the full context.",
		parameters: ResumeParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// 1. Resolve the meta file by full or partial session id
			let sid: string;
			let resolvedMeta: Record<string, any>;
			try {
				const r = resolveSubagentMeta(params.session_id);
				if (!r) {
					const v = validateResumeMeta(null, params.session_id);
					return {
						content: [{ type: "text", text: v.ok ? "" : v.error }],
						isError: (v as any).isError,
					};
				}
				sid = r.sid;
				resolvedMeta = r.meta;

				// 2. Validate meta fields (sessionFile present, file on disk)
				const validation = validateResumeMeta(resolvedMeta, sid);
				if (!validation.ok) {
					return {
						content: [{ type: "text", text: validation.error }],
						isError: validation.isError,
					};
				}
			} catch (e: any) {
				return {
					content: [{ type: "text", text: e.message }],
					isError: true,
				};
			}

	
			// 3. Validate no running subagent with the same id
			if (running.has(sid)) {
				return {
					content: [{
						type: "text",
						text: `Subagent "${sid}" is already running.`,
					}],
					isError: true,
				};
			}

			// 4. Build a synthetic AgentConfig from the persisted meta fields.
			const syntheticAgent = buildAgentConfigFromMeta(resolvedMeta);
			const cwd = params.cwd ?? (resolvedMeta.parentCwd || ctx.cwd);

			// 5. Spawn the resumed RPC process under the SAME subagent-<UUID> key.
			// No worktree isolation — resumed sessions run in the recorded parentCwd.
			// Decision 046: the cap and the turn count carry over. The cap is read
			// back in its own input convention, so a meta without a recorded cap (a
			// resume of a session spawned before this decision) resolves to the
			// default rather than to "uncapped".
			const resumeTurnCap = resolveTurnCap(resolvedMeta.turnCap);
			// Absent on a meta written before decision 046: that run counted from zero.
			const resumeTurnsBefore = resolvedMeta.turnsUsed ?? 0;
			const rs = await spawnSubagent(
				pi,
				ctx,
				syntheticAgent,
				params.task,
				cwd,
				sid,
				// Resume reproduces the recorded model verbatim (decision 022
				// site 2) — no inheritance here, not even for an orchestrator.
				resolveChildModel({
					agentName: syntheticAgent.name,
					agentModel: resolvedMeta.model,
					inheritParentModel: false,
					isResume: true,
				}),
				null, // worktreePath
				null, // isolationBranch
				null, // parentHeadCommit
				cwd,
				null, // cargoTargetDir — resumed runs are not isolated
				resolvedMeta.sessionFile, // resumeSessionFile
				undefined, // reviewPolicy — a resume keeps the recorded gate
				undefined, // promptMessage — the follow-up task is the whole prompt
				undefined, // carriedSnapshot
				undefined, // workOrderPolicy
				undefined, // silenceTimeoutMs — a resumed run takes the 30-min default
				resumeTurnCap, // decision 046: the recorded cap, carried over
				resumeTurnsBefore, // decision 046: continue the recorded turn count
			);
			// The resumed run completes the same work-order record (decisions/work-order-records/001).
			// A resume is not isolated — its commits land in `cwd` — so that is the tree its record
			// writes go to, whatever tree the original spawn used (WO-2026-094 M1). The dispatch it
			// must already hold is checked with them: the original spawn wrote that entry into the
			// tree IT committed, so a record split across two trees is reported at this close
			// instead of being appended to silently (WO-2026-094 Q-094-a).
			rs.workRecord = resolvedMeta.workRecord
				? openRecordContext({ cwd, woId: resolvedMeta.workRecord.woId }, [{ kind: "dispatch", keys: { implementer: sid } }])
				: undefined;

			running.set(sid, rs);
			updateFooter();

			// 6. DO NOT record a new reviewer-spawn tracker entry. The original
			// spawn already recorded it; resume continues the same logical session.

			return {
				content: [
					{
						type: "text",
						text: [
							`Subagent resumed: ${syntheticAgent.name} (session: ${sid})`,
							`Task: ${params.task.slice(0, 200)}${params.task.length > 200 ? "..." : ""}`,
							turnBudgetLine(resumeTurnCap, resumeTurnsBefore, false),
							"",
							"Watch live:",
							"```bash",
							`tail -f /tmp/pi-subagent-${sid}.log`,
							"```",
							"Or in-pi: /watch " + sid.slice(-8),
							"Or from another terminal: nc -U /tmp/pi-subagent-" + sid + ".sock",
							"Use /subagents to check progress.",
						].join("\n"),
					},
				],
			};
		},
	});

	// ── wait ──────────────────────────────────────────────────────────
	// Why is `wait` a tool at all, instead of just instructing the model
	// "stop after launching a subagent"? Some models have a lot of
	// trouble reliably stopping their turn on their own once they've
	// spawned one — they tend to keep generating, call
	// subagent_status repeatedly, or otherwise spin. Making `wait` a
	// named tool invocation gives them a concrete affordance to reach
	// for: "I have nothing else to do; end the turn and wake me when a
	// subagent finishes." The `terminate: true` below is what actually
	// ends the turn; the tool is just the well-named hook.

	// `wait` ends the current turn and yields until a running subagent
	// completes. By default it owns no timer — wake-up is triggered
	// solely by subagent completion (delivered as a steer message by
	// the close handler). The optional `seconds` parameter arms a
	// wake-up timer that fires after N seconds if no subagent has
	// completed by then; the timer is cancelled when a subagent
	// completes, so completion never triggers a redundant "still
	// running" wakeup. Only use the timer when you have a concrete
	// concern that the subagent may need steering — if you're
	// confident in its direction, call `wait` with no argument and
	// you'll be woken exactly when it finishes. `wait` is not a
	// sleep or general timer.

	const WaitParams = Type.Object({
		seconds: Type.Optional(
			Type.Number({
				description:
					"Optional wake-up timer in seconds (1-600). If provided, you will be woken up after this many seconds if no subagent has completed by then — only use this when you have a specific concern the subagent may need steering. If you trust the subagent's direction, omit this and call wait() with no argument; you'll be woken when it finishes, with no token cost in the meantime. The timer is cancelled automatically when a subagent completes, so the two wake-ups never collide.",
				minimum: 1,
				maximum: 600,
			}),
		),
	});

	pi.registerTool({
		name: "wait",
		label: "Wait",
		description: "End the current turn and yield until a running subagent completes and delivers its result. With no argument, wake-up is triggered solely by subagent completion — call this exactly once after launching subagents and stop; do not poll. With the optional `seconds` argument, a wake-up timer is armed: you will also be woken if N seconds pass with no subagent completed (only use this when you have a specific concern the subagent may need steering; if you trust the direction, omit `seconds` and you'll be woken when it finishes with no token cost in between). The two wake-ups never collide — a completing subagent cancels the timer. Only call this when at least one subagent is running; with nothing running there is nothing to wake you. This is not a sleep or general timer.",
		parameters: WaitParams,
		async execute(_toolCallId, params) {
			if (running.size === 0) {
				return {
					content: [{ type: "text", text: "No running subagents — nothing to wait for. Launch a subagent first, or continue your work." }],
				};
			}
			const names = [...running.values()].map((rs) => `${rs.agentName} (${rs.sessionId.slice(-8)})`);

			// No timer requested — default behavior: terminate and wait for
			// subagent completion only.
			if (params.seconds === undefined) {
				return {
					content: [{ type: "text", text: `Waiting for ${running.size} running subagent${running.size === 1 ? "" : "s"}: ${names.join(", ")}. I will be woken when one completes.` }],
					terminate: true,
				};
			}

			// Timer requested. Replace any existing timer (defensive — the
			// tool terminates the turn, so a second call only happens after a
			// wake-up, but clean up just in case).
			clearActiveWait();

			const seconds = params.seconds;
			activeWaitTimer = setTimeout(() => {
				activeWaitTimer = null;
				// Skip if a subagent completed in the race window between
				// timer arm and timer fire — the close handler clears
				// activeWaitTimer and delivers the result as a steer, so a
				// "still running" message on top of that would be noise. The
				// close handler's clearTimeout cancels us, but checking
				// running.size here is belt-and-braces in case the callback
				// was already queued.
				if (running.size === 0) return;
				// Post-turn async path: the spawning session may have ended while
				// the timer was pending. pi invalidates its ExtensionAPI alongside
				// the ctx, so `pi.sendUserMessage` below would throw uncaught from
				// this timer. No live session → no receiver for a wait wake-up.
				if (!liveSessionCtx) {
					debugLog(`wait-timer: no live session — skipping wake-up`);
					return;
				}
				const liveNames = [...running.values()].map((rs) => `${rs.agentName} (${rs.sessionId.slice(-8)})`);
				pi.sendUserMessage(
					`[wait timer] ${seconds}s elapsed — ${running.size} subagent${running.size === 1 ? "" : "s"} still running: ${liveNames.join(", ")}. If concerned about direction, use subagent_status to inspect or subagent_steer to redirect. If you trust the work, call wait() again with no argument to keep waiting.`,
					{ deliverAs: "steer" },
				);
			}, seconds * 1000);

			return {
				content: [{ type: "text", text: `Waiting for ${running.size} running subagent${running.size === 1 ? "" : "s"}: ${names.join(", ")}. I will be woken either when one completes or after ${seconds}s if still running.` }],
				terminate: true,
			};
		},
	});

	// ── subagent_steer ─────────────────────────────────────────────────

	pi.registerTool({
		name: "subagent_steer",
		label: "Subagent Steer",
		description: "Inject a steering message into a running async subagent. The message is delivered before the subagent's next LLM call.",
		parameters: SteerParams,
		async execute(_toolCallId, params) {
			const rs = resolveRunningSession(params.session_id);
			if (!rs) {
				return {
					content: [
						{
							type: "text",
							text: describeUnknownSession(params.session_id),
						},
					],
				};
			}

			// A stopped session must not be "steered" — a write into a dead
			// child's pipe would buffer and be silently lost while the tool
			// reported success. Reflect the true state instead.
			if (!steerChild(rs, params.message)) {
				const blocked = steerBlockedReason(rs);
				const text = blocked === null
					// No guard tripped, so the write itself could not land.
					? `Steering message NOT delivered to ${rs.agentName} (${params.session_id}) — stdin closed (session may have just stopped): "${params.message}"`
					: `Subagent ${rs.agentName} (${params.session_id}) is no longer running (${blocked}) — steering message not delivered: "${params.message}"`;
				return { content: [{ type: "text", text }] };
			}

			return {
				content: [
					{
						type: "text",
						text: `Steering message sent to ${rs.agentName} (${params.session_id}): "${params.message}"`,
					},
				],
			};
		},
	});

	// ── subagent_stop ──────────────────────────────────────────────────

	pi.registerTool({
		name: "subagent_stop",
		label: "Subagent Stop",
		description: "Tell a running async subagent to wrap up and return a summary. Waits up to 5 minutes for the subagent to finish.",
		parameters: StopParams,
		async execute(_toolCallId, params, signal) {
			const rs = resolveRunningSession(params.session_id);
			if (!rs) {
				return {
					content: [
						{
							type: "text",
							text: describeUnknownSession(params.session_id),
						},
					],
				};
			}

			// Mark this session as explicitly stopped BEFORE the wrap-up steer
			// ships. The subagent's final text-only message (produced in
			// response to the steer below) otherwise trips the review-gate
			// soft-prompt in the msg_end handler, which would re-enter the
			// agent loop to launch reviewers — the opposite of "wrap up".
			// An explicit stop means "report only"; the review machinery is
			// bypassed for this session.
			rs.stoppedExplicitly = true;

			// Send final steer if provided — but only while the child can
			// still receive it. If it has already exited (or is mid-exit),
			// skip the steer; the wait below resolves via the close handler
			// regardless.
			const finalMsg = params.final_message || "Wrap up your current work and return a summary. Do not start new tasks.";
			if (!steerChild(rs, finalMsg)) {
				debugLog(`subagent_stop: wrap-up steer skipped for ${params.session_id} (session already stopped)`);
			}

		// Wait for subagent to finish, with timeout
			// The worker won't exit on its own (RPC mode keeps it alive).
			// We rely on the isDone detection (text-only message) to close
			// stdin, which triggers process exit → close handler → resolveOnStop.
			// Fallback: force-kill after a generous timeout.
			const result = await new Promise<string>((resolve) => {
				let resolved = false;
				const finish = (text: string) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(fallbackTimeout);
					if (signal) {
						try { signal.removeEventListener("abort", onAbort); } catch { /* */ }
					}
					resolve(text);
				};

				// Fallback: force-kill the process if it doesn't finish naturally.
				// Guarded for recovered/pre-reload sessions (proc === null):
				// nothing to signal — skip the signals; the waiter still
				// resolves via finish() so the stop tool returns.
				const fallbackTimeout = setTimeout(() => {
					if (rs.proc) {
						rs.proc.kill("SIGTERM");
						setTimeout(() => {
							if (stillRunning(rs.proc)) rs.proc.kill("SIGKILL");
							finish("[Force-stopped after timeout]");
						}, HARD_KILL_DELAY_MS);
					} else {
						finish("[Force-stopped after timeout]");
					}
				}, STOP_TIMEOUT_MS);

				rs.resolveOnStop = (finalOutput?: string) => {
					finish(finalOutput || "(no output)");
				};

				// If already done (subagent finished before we set resolveOnStop),
				// close stdin now to trigger exit.
				if (rs.isDone && rs.stdin && !rs.stdin.destroyed) {
					rs.stdin.end();
				}

				const onAbort = () => finish("[Aborted]");
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
			});

			return {
				content: [
					{
						type: "text",
						text: `${rs.agentName} (${params.session_id}) stopped.\n\n${result}`,
					},
				],
			};
		},
	});

	// ── subagent_kill ──────────────────────────────────────────────────
	// Hard-kill tool: dispatch SIGTERM immediately, schedule SIGKILL after
	// HARD_KILL_DELAY_MS, and return without waiting for the close handler.
	// The close handler is the single owner of delivery; it reads the
	// `killedExplicitly`/`killedVia` flags set here and prepends a marker to
	// the delivered message so the orchestrator sees what happened.
	// Idempotent on the second call (no-op when the flag is already true).
	// Shares the dispatch with decision 015's stage-2 progress-timeout
	// auto-kill (dispatchKillSignals) — exactly one SIGTERM→SIGKILL path.

	pi.registerTool({
		name: "subagent_kill",
		label: "Subagent Kill",
		description:
			"Hard-kill a stuck subagent by terminating its underlying `pi` process. Use this when `subagent_stop` has not worked because the subagent is genuinely stuck and no longer reading its RPC stdin (e.g. deadlocked, infinite loop, blocked provider call). Sends SIGTERM, then SIGKILL after a short grace period if the child is still alive. The result is delivered as a user message with a clear marker so the orchestrator can see the kill happened. This is destructive — any in-flight work in the subagent is lost. Prefer `subagent_stop` when the subagent is responsive.",
		parameters: KillParams,
		async execute(_toolCallId, params) {
			const rs = resolveRunningSession(params.session_id);
			if (!rs) {
				return {
					content: [
						{
							type: "text",
							text: describeUnknownSession(params.session_id),
						},
					],
				};
			}

			// Idempotency: a second `subagent_kill` on the same session is a
			// no-op. Returning a short message keeps the orchestrator's log
			// legible without re-firing signals. (The stage-2 auto-kill sets
			// the same flag, so a kill-after-timeout is also a no-op here.)
			if (rs.killedExplicitly) {
				return {
					content: [
						{
							type: "text",
							text: `${rs.agentName} (${params.session_id}) already killed — signals skipped. Result will be delivered via the close handler.`,
						},
					],
				};
			}

			// Shared kill dispatch (decision 015): sets killedExplicitly +
			// killedVia BEFORE any proc access so the close handler observes
			// them on entry, cancels the stale-turn watchdog AND the stage-2
			// silence timer, logs the kill marker, and SIGTERM→SIGKILLs. For a
			// recovered/pre-reload session there is no live process to signal
			// (`noProcess`) — the flags are still set so the close handler
			// prepends the marker, and no signal is attempted.
			const { alreadyDead, noProcess } = dispatchKillSignals(rs, "kill-tool");

			const statusText = noProcess
				? `${rs.agentName} (${params.session_id}) marked killed — no live process existed to signal (recovered/pre-reload session). Result will be delivered via the close handler.`
				: alreadyDead
					? `${rs.agentName} (${params.session_id}) already dead — kill signals skipped. Result will be delivered via the close handler.`
					: `${rs.agentName} (${params.session_id}) sent SIGTERM (SIGKILL will follow in ${HARD_KILL_DELAY_MS / 1000}s if still alive). Result will be delivered via the close handler.`;

			return {
				content: [
					{
						type: "text",
						text: statusText,
					},
				],
			};
		},
	});
}
