/**
 * Turn cap and stall tripwire (decision 046) — one assistant turn's accounting:
 * fold a commit observation into the stall counters, ask the pure decider in
 * `lib/subagent-state.ts`, then execute exactly the action it named.
 *
 * Split out of `index.ts` by WO-2026-095. Behaviour is unchanged; the steer and
 * log helpers, the kill dispatch and the child-facing texts come from the entry
 * point (and, after their own extraction, from `rpc.ts` / `sleep-guard.ts`).
 */

import { execFile } from "node:child_process";
import {
	TURN_CAP_GRACE,
	decideTurnAction,
	nextStallState,
	stallSampleDue,
	type CommitObservation,
	type PendingStallObservation,
	type TurnAction,
} from "../lib/subagent-state.ts";
import { STALL_STEER, TURN_CAP_WIND_DOWN_STEER, debugLog, dispatchKillSignals, type RunningSubagent } from "./index.ts";
import { appendRunningLogLine, steerChild } from "./rpc.ts";

// ── Turn cap and stall tripwire (decision 046) ─────────────────────────────

/** Turns used by this logical dispatch: this run's own count plus the runs it
 *  continues. The cap compares against this, so a resume continues the count
 *  the previous run recorded. */
export function turnsUsed(rs: RunningSubagent): number {
	return rs.turnsBefore + rs.progress.turns;
}

/** The cap as the parent sees it. `Infinity` is the disabled state. */
export function formatTurnCap(cap: number): string {
	return Number.isFinite(cap) ? String(cap) : "none (disabled)";
}

/**
 * The parent-facing budget line for a spawn/resume result: the cap, the turns
 * counted so far, and — when the run has no branch to watch — the fact that the
 * stall arm is skipped. Never reaches the child.
 */
export function turnBudgetLine(cap: number, turns: number, hasBranch: boolean): string {
	return (
		`turn_cap: ${formatTurnCap(cap)} | turns_used: ${turns}` +
		(hasBranch ? "" : " | stall_watch: none (no isolation branch)")
	);
}

/** How the commit observation runs its command. Injectable so the rows can
 *  drive a slow or scripted observation without a git repository. */
export type CommitRunner = (branch: string, cwd: string) => Promise<string>;

/** The production runner: one asynchronous `git rev-parse <branch>`. */
function gitRevParse(branch: string, cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			["rev-parse", branch],
			{ cwd, encoding: "utf-8", timeout: 5000 },
			(err, stdout) => {
				if (err) reject(err);
				else resolve(String(stdout).trim());
			},
		);
	});
}

/**
 * Observe the child's branch tip — a command, not a ref-file read: a linked
 * worktree's `.git` is a file pointing at the gitdir, so the refs live in the
 * common dir and no file under the worktree holds the branch tip (decision 046).
 *
 * Asynchronous, and never awaited on the turn path (owner ruling 2026-11-07:
 * the spawn is off the parent's event loop; the measurement was a 286 ms mean
 * block per turn under load). A run with no branch (non-isolated dispatch or a
 * resume) and a command the observation cannot resolve both report
 * `observed: false`, which skips the stall arm: a child with nothing to watch
 * must never be told it stalled.
 * Exported as an @internal test hook, like `turnCapStep`.
 */
export async function observeCommit(
	rs: RunningSubagent,
	run: CommitRunner = gitRevParse,
): Promise<CommitObservation> {
	if (!rs.isolationBranch) return { observed: false, changed: false };
	let tip: string;
	try {
		tip = await run(rs.isolationBranch, rs.parentCwd);
	} catch (e) {
		debugLog(`stall-watch: git rev-parse ${rs.isolationBranch} failed: ${e instanceof Error ? e.message : String(e)}`);
		return { observed: false, changed: false };
	}
	if (!tip) return { observed: false, changed: false };
	const changed = rs.stall.lastTip !== null && tip !== rs.stall.lastTip;
	rs.stall.lastTip = tip;
	return { observed: true, changed };
}

/**
 * Start this sample turn's observation, if the child has a branch to watch and
 * no observation is still outstanding. The result lands in `stall.pending` and
 * is folded by a later sample turn — nothing on the turn path waits for it.
 */
function scheduleStallObservation(rs: RunningSubagent, run?: CommitRunner): void {
	if (!rs.isolationBranch || rs.stall.inFlight || rs.stall.pending) return;
	const atTurn = turnsUsed(rs);
	rs.stall.inFlight = true;
	void observeCommit(rs, run)
		.then((obs) => {
			rs.stall.pending = { obs, atTurn };
		})
		// The flag means "a spawn is outstanding", so it clears whenever the
		// promise settles. A rejection here would surface as an unhandled
		// rejection — observeCommit turns its own failures into `observed: false`.
		.finally(() => {
			rs.stall.inFlight = false;
		});
}

/**
 * One assistant turn's turn accounting: fold a commit observation into the
 * stall counters, ask the pure decider, then execute exactly the action it
 * named. Nothing here re-derives a cap or stall condition — the decisions live
 * in extensions/lib/subagent-state.ts (decision 046), and this function is
 * exported only so the wiring can be driven without a long-lived child.
 *
 * `obs` is null on a turn with no observation to fold: the counters and the
 * decider then run on what is already known, which is every non-sample turn.
 */
export function turnCapStep(
	rs: RunningSubagent,
	obs: CommitObservation | null,
	elapsedTurns = 1,
): TurnAction {
	if (obs) {
		const fold = nextStallState(rs.stall, obs, elapsedTurns);
		rs.stall.stallTurns = fold.stallTurns;
		rs.stall.stallSteered = fold.stallSteered;
		rs.stall.stallObserved = fold.stallObserved;
	}
	const action = decideTurnAction({
		turns: turnsUsed(rs),
		cap: rs.turnCap,
		capTripped: rs.turnCapReached,
		stallTurns: rs.stall.stallTurns,
		stallSteered: rs.stall.stallSteered,
		stallObserved: rs.stall.stallObserved,
		commitChanged: obs?.changed ?? false,
	});

	switch (action.kind) {
		case "none":
			return action;
		case "wind-down":
			rs.turnCapReached = true;
			rs.progress.currentActivity = "turn cap reached, winding down";
			if (steerChild(rs, TURN_CAP_WIND_DOWN_STEER)) {
				appendRunningLogLine(
					rs,
					`[turn-cap] wind-down injected at ${turnsUsed(rs)} turns ` +
						`(cap ${formatTurnCap(rs.turnCap)}, grace ${TURN_CAP_GRACE})`,
				);
			} else {
				debugLog(`turn-cap: wind-down for ${rs.sessionId} not delivered (child gone)`);
			}
			return action;
		case "stall-steer":
			if (steerChild(rs, STALL_STEER)) {
				// Marked delivered only now, so a steer that could not land is
				// retried on the next turn instead of being lost silently.
				rs.stall.stallSteered = true;
				appendRunningLogLine(rs, `[stall] no new commit for ${rs.stall.stallTurns} turns — advisory steer injected`);
			}
			return action;
		case "kill":
			rs.progress.currentActivity = "turn cap and grace exhausted, stopping";
			rs.progress.errors.push(`Turn cap reached (${formatTurnCap(rs.turnCap)} + ${TURN_CAP_GRACE} grace)`);
			debugLog(`turn-cap: dispatching kill at ${turnsUsed(rs)} turns (cap ${rs.turnCap})`);
			dispatchKillSignals(rs, "turn-cap");
			return action;
	}
}

/**
 * One assistant turn on the `message_end` path: fold the previous sample's
 * observation if one is waiting, start this turn's observation when the sample
 * grid says so, then execute the turn's action. The observation is asynchronous
 * and its result is only ever applied on a later sample turn, so nothing here
 * blocks on a spawn (owner ruling 2026-11-07).
 *
 * A stall of `STALL_TURNS` is therefore noticed within one sample interval of
 * it: the turn that starts an observation cannot act on it, and the next one
 * that folds it can. The cap arm still decides every turn, which is what keeps
 * the grace and the kill at exact turn numbers.
 */
export function turnCapTurn(rs: RunningSubagent, run?: CommitRunner): TurnAction {
	const sampled = stallSampleDue(turnsUsed(rs));
	let pending: PendingStallObservation | null = null;
	if (sampled) {
		pending = rs.stall.pending;
		rs.stall.pending = null;
	}
	const elapsed = pending ? pending.atTurn - rs.stall.foldedTurn : 1;
	if (pending) rs.stall.foldedTurn = pending.atTurn;
	const action = turnCapStep(rs, pending?.obs ?? null, elapsed);
	// A killing turn has nothing left to watch, and its observation would land
	// on a handle nobody reads.
	if (sampled && action.kind !== "kill") scheduleStallObservation(rs, run);
	return action;
}
