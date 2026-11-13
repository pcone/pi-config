/**
 * The runner's process-wide state, in one registry on `globalThis`.
 *
 * pi can evaluate this extension twice in one process. jiti resolves a relative
 * import through the importing file's realpath, while pi's loader hands jiti the
 * configured path unresolved (`dist/core/extensions/loader.js:528`). Loaded through
 * a symlinked component of its own path, `index.ts`'s cycle re-entry (`index.ts` →
 * `worktree.ts` → `index.ts`) therefore lands on a second module record, and
 * every module-level binding exists twice.
 *
 * A duplicate evaluation must be harmless, so the state cannot live on module
 * identity. It lives here, keyed on `globalThis`: whichever evaluation sets a
 * value, the other one reads it. Same pattern as `extensions/go.ts`.
 *
 * Only `index.ts`'s module-level state belongs here. Its siblings are
 * single-instance by the same realpath collapse that duplicates `index.ts` — one
 * evaluation per pid, census in
 * `docs/investigations/subagent-wait-wake-2026-11.md` — so their timers and
 * `caffeinate` handle stay where they are.
 *
 * `liveSession` carries the id of the evaluation that set it. A duplicate's
 * `session_shutdown` must not clear a live ctx it never set: see
 * `setLiveSession`/`clearLiveSession` in `index.ts` and
 * `decisions/subagents/026-subagent-events-after-session-disposal.md`.
 */

import type { ReviewerKind } from "./agents.ts";
import type { RunningSubagent } from "./index.ts";

/** One reviewer (or plan) spawn under a parent, for the review-round count. */
export interface SpawnEntry {
	reviewerKind: ReviewerKind;
	childSessionId: string;
	childAgentName: string;
	spawnedAt: number;
}

/** A parent's reviewer spawns: the in-memory view of
 *  `/tmp/pi-subagent-<parentKey>.reviewers.json`. */
export interface TrackerState {
	spawns: SpawnEntry[];
	reviewRounds: number;
	reviewCapReached: boolean;
}

export interface RunnerState {
	/** Every child this process is running, keyed by subagent session id. */
	running: Map<string, RunningSubagent>;
	/** The live pi session's ctx and the evaluation that set it, or null when
	 *  no session is live. */
	liveSession: { ctx: any; owner: string } | null;
	/** The pending `wait(seconds)` timer, at most one per process. */
	activeWaitTimer: ReturnType<typeof setTimeout> | null;
	attachedSessionId: string | null;
	/** Captured from `/attach` for editor-internal notify. */
	attachCtx: any;
	parentReviewerSpawns: Map<string, TrackerState>;
}

const KEY = "__pi_subagent_async_runner_v1__";

/** The process's runner state, created on first call. */
export function runnerState(): RunnerState {
	const store = globalThis as Record<string, unknown>;
	return (store[KEY] ??= {
		running: new Map(),
		liveSession: null,
		activeWaitTimer: null,
		attachedSessionId: null,
		attachCtx: null,
		parentReviewerSpawns: new Map(),
	} as RunnerState) as RunnerState;
}
