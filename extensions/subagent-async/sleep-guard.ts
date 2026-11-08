/**
 * Decision 015's two timers: the silence-based stage-2 auto-kill and the sleep
 * guard that keeps system sleep from being billed as child silence.
 *
 * Stage 1 — the stale-turn watchdog `bumpStaleWatchdog` (index.ts) — wakes the
 * caller after a stale turn; stage 2 kills a child that has been SILENT (no
 * tool calls and no assistant messages, per `lastActivityMs`) for
 * `silenceTimeoutMs`. The kill reuses the `subagent_kill` dispatch
 * (`dispatchKillSignals`) so there is exactly one SIGTERM→SIGKILL path, the
 * delivered marker is greppable as `[Killed via progress-timeout]`, and the
 * session file survives for `subagent_resume`.
 *
 * Split out of `index.ts` by WO-2026-095. Behaviour is unchanged.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	EXITED_FOOTER_WORD,
	OUTCOME_WORD,
	STOPPED_FOOTER_WORD,
	isKnownStopReason,
	outcomeFromExitCode,
	outcomeFromFooterWord,
	stopReasonOutcome,
	type SubagentOutcome,
} from "../lib/subagent-state.ts";
import { appendRunningLogLine } from "./rpc.ts";
import { getFinalOutput } from "./worktree.ts";
import { turnsUsed } from "./turn-cap.ts";
import {
	HARD_KILL_DELAY_MS,
	SLEEP_GUARD_HEARTBEAT_MS,
	SLEEP_GUARD_SLACK_MS,
	debugLog,
	liveSessionCtx,
	running,
	type RunningSubagent,
} from "./index.ts";

// Sleep guard state (decision 015 fix). One heartbeat for all running
// children; one caffeinate assertion for the running set's lifetime.
let heartbeatTimer: NodeJS.Timeout | null = null;
let lastHeartbeatMs = 0;
let caffeinateProc: ChildProcess | null = null;


// ── Sleep guard: caffeinate + sleep-aware silence accounting ──────────────
//
// macOS system sleep suspends pi and every subagent with it, but Date.now()
// advances across the suspension — so decision 015's silence budget billed
// sleep as child silence and killed healthy subagents on wake (observed
// 2026-08-08, recurrent through 2026-08-11/12: auto-kills firing 10–35 min
// overdue; pmset showed ~15-min Sleep-Service cycles on battery). Two guards:
//
//  (1) caffeinate -s -i holds a PreventSystemSleep assertion while any child
//      runs, so the machine doesn't sleep mid-task (AC; macOS won't honor it
//      indefinitely on battery). Lifecycle tracks the running set via
//      reconcileSleepGuards(), which updateFooter calls on every transition.
//  (2) a 10s heartbeat (heartbeatTick) detects suspension — a tick landing
//      >slack late means the process was asleep — and discounts the slept
//      interval from every child's lastActivityMs, then re-arms. The
//      just-woke guard in armSilenceTimer (above) keeps an overdue silence
//      timer from firing on an inflated gap before the heartbeat corrects it.
//
// Neither guard disables stage 2: a child silent while AWAKE (no tool calls,
// no log output, no tool_execution_update) is still killed at
// silenceTimeoutMs — the deadlock backstop decision 015 preserves.

/** Start the heartbeat + caffeinate when the first child dispatches; stop
 *  when the running set empties so the machine may sleep when idle.
 *  Idempotent — called from updateFooter on every running-map transition. */
export function reconcileSleepGuards(): void {
	if (running.size > 0 && !heartbeatTimer) startSleepGuards();
	else if (running.size === 0 && heartbeatTimer) stopSleepGuards();
}

function startSleepGuards(): void {
	lastHeartbeatMs = Date.now();
	heartbeatTimer = setInterval(heartbeatTick, SLEEP_GUARD_HEARTBEAT_MS);
	heartbeatTimer.unref();
	// Hold PreventSystemSleep (-s) + prevent idle sleep (-i) for the running
	// set's lifetime. -w <pi pid> frees cleanup: caffeinate exits when pi
	// exits. macOS only — the heartbeat covers platforms where this is a
	// no-op (and battery, where the assertion isn't honored long-term).
	if (process.platform === "darwin" && !caffeinateProc) {
		try {
			caffeinateProc = spawn("caffeinate", ["-s", "-i", "-w", String(process.pid)], { stdio: "ignore" });
			caffeinateProc.unref();
			caffeinateProc.on("error", () => { caffeinateProc = null; });
		} catch { caffeinateProc = null; }
	}
}

function stopSleepGuards(): void {
	if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
	if (caffeinateProc) { try { caffeinateProc.kill(); } catch { /* */ } caffeinateProc = null; }
}

/** Heartbeat: if this tick landed >slack late, the process was suspended
 *  (system sleep). Date.now() advanced across it but the children could not
 *  emit activity, so each silence budget is inflated by the suspension —
 *  discount it (bump lastActivityMs forward) and re-arm. Errs slightly toward
 *  over-discounting (forgives ~one heartbeat of legitimate silence per
 *  sleep), the safe direction: never kill healthy work for sleep. */
function heartbeatTick(): void {
	const now = Date.now();
	const elapsed = now - lastHeartbeatMs;
	lastHeartbeatMs = now;
	if (elapsed <= SLEEP_GUARD_HEARTBEAT_MS + SLEEP_GUARD_SLACK_MS) return;
	const oversleep = elapsed - SLEEP_GUARD_HEARTBEAT_MS;
	for (const rs of running.values()) {
		rs.lastActivityMs += oversleep;
		if (rs.silenceTimeoutMs > 0) armSilenceTimer(rs);
	}
}

/** Arm the stage-2 silence-kill timer for `rs`. Mirrors the stage-1
 *  watchdog's setTimeout chain: fires when the child has been silent for
 *  `silenceTimeoutMs` and re-arms from its own callback when activity has
 *  slid the deadline (activity merely bumps `lastActivityMs`; the callback
 *  re-checks staleness at fire time). `silenceTimeoutMs <= 0` disables
 *  stage 2 entirely. */
export function armSilenceTimer(rs: RunningSubagent): void {
	if (rs.silenceTimer) clearTimeout(rs.silenceTimer);
	if (rs.silenceTimeoutMs <= 0) { rs.silenceTimer = null; return; }
	// Just-woke window (sleep guard): if the heartbeat hasn't reconciled
	// since the process resumed, the wall-clock silence may still include
	// suspension we haven't discounted yet. Defer — re-arm after one
	// heartbeat interval instead of evaluating (and firing on) an inflated
	// gap. The heartbeat tick will discount the slept interval and call
	// armSilenceTimer again with a corrected budget.
	if (Date.now() - lastHeartbeatMs > SLEEP_GUARD_HEARTBEAT_MS + SLEEP_GUARD_SLACK_MS) {
		rs.silenceTimer = setTimeout(() => { rs.silenceTimer = null; armSilenceTimer(rs); }, SLEEP_GUARD_HEARTBEAT_MS);
		return;
	}
	const silentFor = Date.now() - rs.lastActivityMs;
	const remaining = rs.silenceTimeoutMs - silentFor;
	if (remaining <= 0) {
		// Already silent past the budget — fire immediately (guards inside).
		rs.silenceTimer = null;
		fireSilenceKill(rs);
		return;
	}
	rs.silenceTimer = setTimeout(() => {
		rs.silenceTimer = null;
		// Re-check staleness: activity may have landed while the timer was
		// pending (e.g. a log line between arm and fire). If so, slide the
		// deadline rather than killing an active child.
		if (Date.now() - rs.lastActivityMs < rs.silenceTimeoutMs) {
			armSilenceTimer(rs);
			return;
		}
		fireSilenceKill(rs);
	}, remaining);
}

/** Stage-2 auto-kill: the child has been silent for `silenceTimeoutMs`.
 *  Guards mirror the kill path's idempotency — an already stopped/killed/
 *  completed child (or one that left the running set) is a no-op, so the
 *  auto-kill never double-fires and never races an explicit stop/kill. */
function fireSilenceKill(rs: RunningSubagent): void {
	if (rs.isDone || rs.killedExplicitly || rs.stoppedExplicitly || !running.has(rs.sessionId)) return;
	// A child parked in a nested wait is expected-silent: the `wait` tool only
	// parks it when it has live children to block on, and those children's own
	// silence timers handle genuine hangs. Killing the parent here would
	// cascade to those children for no benefit, and wall-clock silence can't
	// distinguish "hung" from "frozen by system sleep" — observed 2026-08-08:
	// an implementer parked in wait was progress-timeout-killed on laptop
	// wake (its timers had frozen during sleep and fired overdue on resume),
	// taking its reviewers with it. The stage-1 watchdog already told the
	// caller this child is waiting ("[Subagent waiting]"), so skip stage 2 and
	// let the caller, or the children's timers, resolve it.
	if (rs.progress.currentActivity === "wait") return;
	dispatchKillSignals(rs, "progress-timeout");
}

/** Shared kill dispatch — SIGTERM immediately, SIGKILL after
 *  HARD_KILL_DELAY_MS, idempotent, cancels the stale-turn watchdog and the
 *  stage-2 silence timer. Single implementation used by both the
 *  `subagent_kill` tool and the stage-2 progress-timeout auto-kill
 *  (decision 015) — never fork a second kill path. The close handler is
 *  the single owner of delivery; it reads `killedExplicitly`/`killedVia`
 *  and prepends the marker. Returns `alreadyDead` so callers can report
 *  dispatch status, and `noProcess` when the entry had no live process
 *  (recovered/pre-reload session) — callers must distinguish that from a
 *  raced exit. Exported as an @internal test hook so the kill paths can be
 *  exercised with stubbed procs. */
export function dispatchKillSignals(rs: RunningSubagent, via: "kill-tool" | "progress-timeout" | "turn-limit" | "turn-cap"): { alreadyDead: boolean; noProcess?: boolean } {
	// Order matters: set the flags BEFORE any proc access or signal so the
	// close handler observes them on entry — including the null-proc
	// (recovered/pre-reload) path below.
	rs.killedExplicitly = true;
	rs.killedVia = via;

	// Cancel the stalled-turn watchdog so a killed subagent doesn't get a
	// spurious [Subagent stalled] wake-up racing the close handler's
	// cleanup, and cancel the stage-2 silence timer so it cannot re-arm or
	// double-fire. The close handler also clears both timers in its own
	// cleanup section, but doing it here closes the race where a timer
	// fires between SIGTERM dispatch and the close handler reaching that
	// section — `bumpStaleWatchdog`'s guard `running.has(rs.sessionId)` is
	// not enough because the close handler runs `running.delete` AFTER the
	// cleanup phase.
	if (rs.staleTimer) { clearTimeout(rs.staleTimer); rs.staleTimer = null; }
	if (rs.silenceTimer) { clearTimeout(rs.silenceTimer); rs.silenceTimer = null; }

	const viaLabel = via === "kill-tool" ? "subagent_kill" : via;

	// Recovered/pre-reload sessions are reconstructed from disk with a null
	// proc (session_start re-attach — `proc: null` in that path); there is
	// no live process to signal. The flags are already set above (the close
	// handler and `killedMarker` depend on them), so log a distinct marker
	// and report `{ alreadyDead: true, noProcess: true }` — nothing to
	// signal. Never dereference `rs.proc` on this path, including the
	// SIGKILL fallback below.
	if (!rs.proc) {
		appendRunningLogLine(rs, `── Killed via ${viaLabel} — process handle unavailable (recovered/pre-reload session), marked killed, no signal sent ──`);
		return { alreadyDead: true, noProcess: true };
	}

	// Log a visible kill marker to /watch and the persisted log so the
	// orchestrator / user see the kill even if the close handler is
	// delayed. Mirrors the closure-scoped `logEntry` helper inside
	// `spawnSubagent`, since tool bodies do not share that closure.
	appendRunningLogLine(rs, `── Killed via ${viaLabel} (SIGTERM sent, SIGKILL in ${HARD_KILL_DELAY_MS / 1000}s if needed) ──`);

	const alreadyDead = rs.proc.killed || rs.proc.exitCode !== null;
	if (!alreadyDead) {
		try {
			rs.proc.kill("SIGTERM");
		} catch {
			// proc.kill can throw on an already-dead proc; the close
			// handler will still fire (or has already fired) and
			// deliver the result. Swallow.
		}
		setTimeout(() => {
			// Re-check `rs.proc` here rather than trusting the dispatch-time
			// check: the handle could be gone by the time the fallback fires.
			// Guarding the callback itself keeps every `rs.proc` dereference
			// behind a non-null check (WO-2026-043 verification requirement).
			if (rs.proc && !rs.proc.killed && rs.proc.exitCode === null) {
				try { rs.proc.kill("SIGKILL"); } catch { /* */ }
			}
		}, HARD_KILL_DELAY_MS);
	}
	return { alreadyDead };
}

/** The final assistant turn's terminal evidence, or null when this process
 *  holds no assistant message for the run (a recovered child, or one that died
 *  before its first turn). `stopReason: null` means the message carried none at
 *  all: pi's `AssistantMessage` always has one, and a turn that ended without it
 *  never settled, so it reads as an abnormal turn rather than as a normal end
 *  (WO-2026-078: "no reason at all"). */
function lastAssistantTurn(messages: any[]): { stopReason: string | null } | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role !== "assistant") continue;
		const reason = msg.stopReason;
		return { stopReason: typeof reason === "string" && reason.length > 0 ? reason : null };
	}
	return null;
}

/** Everything one run's terminal classification reads. */
interface TerminalFacts {
	/** The final assistant turn, or null when no assistant message reached this
	 *  process. */
	turn: { stopReason: string | null } | null;
	/** The log footer's word, on the recovered path only. */
	recoveredWord: string | null;
	killedExplicitly: boolean;
	turns: number;
	/** The process exit code; null when it left none (terminated by a signal,
	 *  which the footer writes as `exit ?`). */
	exitCode: number | null;
}

/** The outcome the final turn names, or null when the turn ended normally or
 *  there is no turn at all — then how the process ended decides. */
function turnOutcome(turn: { stopReason: string | null } | null): SubagentOutcome | null {
	if (!turn) return null;
	return turn.stopReason === null ? "aborted" : stopReasonOutcome(turn.stopReason);
}

/**
 * The single owner of the `SubagentOutcome` vocabulary, called by the two sites
 * that write its words — `deliverResult`'s prefix and the footer — so a run
 * cannot be finished in one place and errored in another (WO-2026-078 Q-A1:
 * classify and mark, never gate).
 */
function classifyOutcome(facts: TerminalFacts): SubagentOutcome {
	if (facts.killedExplicitly) return "killed";
	// A recovered run left no message here: its footer word is the terminal
	// evidence, and an `Exited`/`Stopped` word defers to the exit code below.
	const fromFooter = facts.recoveredWord ? outcomeFromFooterWord(facts.recoveredWord) : null;
	if (fromFooter) return fromFooter;
	const fromTurn = turnOutcome(facts.turn);
	if (fromTurn) return fromTurn;
	// No abnormal turn: how the process ended decides.
	return outcomeFromExitCode(facts.exitCode, facts.turns);
}

/** The outcome plus its two words for one live-handler run: the close handler
 *  writes `footer` and `deliverResult` writes `prefix`.
 *  @internal test hook so the outcome vocabulary can be exercised without
 *  spawning a real child process. */
export function terminalOutcome(rs: RunningSubagent, exitCode: number | null): {
	outcome: SubagentOutcome;
	footer: string;
	prefix: string;
} {
	const turn = lastAssistantTurn(rs.messages);
	// A reason the vocabulary does not name is a turn that did not complete, and
	// it must not pass quietly: name it where the parent reads the result, so a
	// new pi stop reason is visible until it gets its own word in the table.
	// Prepended because the delivered `Errors:` line shows only its first three
	// entries — appended, the note is dropped exactly where the run was messiest.
	if (turn?.stopReason && !isKnownStopReason(turn.stopReason)) {
		const note = `unknown stopReason "${turn.stopReason}" — classified aborted`;
		if (!rs.progress.errors.includes(note)) rs.progress.errors.unshift(note);
	}
	const outcome = classifyOutcome({
		turn,
		recoveredWord: rs.recoveredFooterWord,
		killedExplicitly: rs.killedExplicitly,
		turns: rs.progress.turns,
		exitCode,
	});
	const fromTurn = turnOutcome(turn);
	// The footer word follows the outcome, spelled the way the log has always
	// spelled it: `Completed` only for a completion, `Exited` for a clean exit
	// with no completion to report, and `Stopped` for an abort the exit code
	// decided (a signalled or non-zero exit with a normal turn). Those two are
	// outcome-less on purpose, so reading them back defers to the same exit code.
	const footer = outcome === "killed"
		? OUTCOME_WORD.killed.footer
		: outcome === "finished"
			? (rs.isDone ? OUTCOME_WORD.finished.footer : EXITED_FOOTER_WORD)
			: fromTurn ? OUTCOME_WORD[fromTurn].footer : STOPPED_FOOTER_WORD;
	return { outcome, footer, prefix: OUTCOME_WORD[outcome].prefix };
}

/** Marker prefix for a delivered kill result. Mirrors the `subagent_kill`
 *  marker; the stage-2 variant is greppable as `[Killed via progress-timeout]`,
 *  the turn-limit variant as `[Killed via turn-limit]` and decision 046's cap
 *  variant as `[Killed via turn-cap]`. */
function killedMarker(rs: RunningSubagent): string | null {
	if (!rs.killedExplicitly) return null;
	if (rs.killedVia === "progress-timeout")
		return "[Killed via progress-timeout — process terminated, work in this subagent is lost]";
	if (rs.killedVia === "turn-limit")
		return "[Killed via turn-limit — process terminated, work in this subagent is lost]";
	if (rs.killedVia === "turn-cap")
		return "[Killed via turn-cap — process terminated, work in this subagent is lost]";
	return "[Killed via subagent_kill — process terminated, work in this subagent is lost]";
}

/** Close-handler delivery decision — the single owner of result delivery
 *  (decision 015 / WO-2026-043 contract). Exactly one path runs: a pending
 *  stop waiter (`resolveOnStop`) is resolved — with the kill marker
 *  prepended when the session was killed — and the waiter is nulled;
 *  otherwise the result is delivered as a user message via `deliverResult`.
 *  The two are mutually exclusive, which is what guarantees no double
 *  delivery. Returns which path ran so callers can log it. Exported as an
 *  @internal test hook so the mutual-exclusion contract can be exercised
 *  without spawning a real child process. */
export function deliverCloseResult(pi: ExtensionAPI, rs: RunningSubagent, code: number | null, commitNote?: string): "stop" | "deliver" {
	if (rs.resolveOnStop) {
		let stoppedText = getFinalOutput(rs.messages) + commitNote;
		// Kill marker keyed on the kill source (subagent_kill tool vs
		// decision 015 stage-2 progress-timeout auto-kill).
		const marker = killedMarker(rs);
		if (marker) {
			stoppedText = marker + "\n" + stoppedText;
		}
		rs.resolveOnStop(stoppedText);
		rs.resolveOnStop = null;
		return "stop";
	}
	deliverResult(pi, rs, code, commitNote);
	return "deliver";
}

/** Deliver the final result message to the parent — used by the
 *  close-handler `deliver` path (via `deliverCloseResult`) and by the
 *  recovered-session socket-close handler, which always delivers. Prepends
 *  the kill marker when `killedExplicitly` is set. Exported as an
 *  @internal test hook so the delivered-marker contract (WO-2026-043
 *  integration contract) can be exercised with a stub `ExtensionAPI`. */
export function deliverResult(pi: ExtensionAPI, rs: RunningSubagent, exitCode: number | null, isolationNote?: string): void {
	// No live session → the parent cannot receive the result. pi invalidates
	// its ExtensionAPI alongside the ctx, so `pi.sendUserMessage` would throw
	// from inside the child's close handler. Skip deliberately (not a
	// try/catch): the child's own session file and
	// /tmp/pi-subagent-<id>.log retain the full output.
	// See decisions/subagents/026-subagent-events-after-session-disposal.md.
	if (!liveSessionCtx) {
		debugLog(`deliverResult: no live session — dropping result for ${rs.sessionId} (output retained in ${rs.logPath})`);
		return;
	}
	const output = getFinalOutput(rs.messages) || "(no output)";

	// A kill (subagent_kill tool or decision 015 stage-2 progress-timeout)
	// supersedes the standard prefix — make the marker the first line of
	// the delivered message so the orchestrator sees what happened.
	const killedNote = killedMarker(rs);
	const prefix = killedNote ?? `[Subagent ${rs.agentName} ${terminalOutcome(rs, exitCode).prefix}]`;

	// Surface child stderr when the agent never made a turn. The most
	// common cause is a child `pi` that failed to start (broken extension,
	// missing binary, auth error, etc.) — without this, the orchestrator
	// sees only "exit 1, 0 turns" and has no signal for debugging.
	const stderrNote = rs.progress.turns === 0 && rs.stderrLines.length > 0
		? `Child stderr (${rs.stderrLines.length} line${rs.stderrLines.length === 1 ? "" : "s"}):\n\`\`\`\n${rs.stderrLines.slice(-30).join("\n")}\n\`\`\``
		: null;

	const message = [
		`${prefix} — session: ${rs.sessionId}`,
		`Task: ${rs.task.slice(0, 200)}${rs.task.length > 200 ? "..." : ""}`,
		`Turns: ${rs.progress.turns} | Files read: ${rs.progress.filesRead.size} | Files modified: ${rs.progress.filesModified.size}`,
		// Decision 046: the ledger reads the cap flag and the dispatch's turn
		// count off the delivered result. Both are parent-facing; the child never
		// sees either.
		rs.turnCapReached ? `turn_cap_reached: true | turns_used: ${turnsUsed(rs)}` : null,
		rs.progress.errors.length > 0
			? `Errors: ${rs.progress.errors.slice(0, 3).join("; ")}`
			: null,
		isolationNote || null,
		stderrNote,
		"---",
		output,
	]
		.filter(Boolean)
		.join("\n");

	pi.sendUserMessage(message, { deliverAs: "steer" });
}
