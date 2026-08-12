#!/usr/bin/env node
/**
 * Regression test for decision 015 — the silence-based stage-2 progress-kill
 * timeout in extensions/subagent-async/index.ts.
 *
 * A child SILENT for `silenceTimeoutMs` (no tool calls AND no assistant
 * messages — no log output either) is auto-killed via the SHARED
 * subagent_kill SIGTERM→SIGKILL dispatch (dispatchKillSignals), a
 * `[Killed via progress-timeout]` marker is delivered so the parent's wait
 * resolves, and the session file is preserved for subagent_resume.
 * `silenceTimeoutMs: 0` (or negative) disables stage 2; an active child is
 * never killed, even past the wall-clock threshold; a child already
 * stopped/killed/completed (or removed from the running set) is a no-op.
 * The stage-1 stale-turn wake (SUBAGENT_STALE_TURN_MS = 5 min) is
 * untouched — stage 2 is strictly longer by default.
 *
 * This test cannot import index.ts — `typebox` and `@earendil-works/*`
 * resolve only under jiti at runtime. So, following the test-subject.cjs /
 * test-carry-uncommitted.cjs precedent, it mirrors the tracking/timer/kill
 * functions (KEEP IN SYNC contracts below) and exercises them through the
 * call-site shape with REAL ms-scale timers and a stubbed child process.
 * The unit boundary cannot verify real process kill + marker delivery —
 * the post-merge E2E battery (orchestrator-run) is the real gate.
 *
 * Run: node test-progress-kill-timeout.cjs
 */
"use strict";

const assert = require("node:assert");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Constants — KEEP IN SYNC with index.ts ────────────────────────────────
const SUBAGENT_STALE_TURN_MS = 5 * 60 * 1000; // 5 minutes (stage-1 wake, unchanged)
const SILENCE_TIMEOUT_DEFAULT_MS = 30 * 60 * 1000; // 30 minutes (stage-2 kill)
const HARD_KILL_DELAY_MS = 5000;
// Sleep guard (decision 015 fix) — KEEP IN SYNC with index.ts. Heartbeat
// cadence + jitter slack for detecting system sleep, and the module-level
// heartbeat bookkeeping the silence timer's just-woke guard reads.
const SLEEP_GUARD_HEARTBEAT_MS = 10 * 1000;
const SLEEP_GUARD_SLACK_MS = 3 * 1000;
let lastHeartbeatMs = 0;

// ── resolveSilenceTimeout — KEEP IN SYNC with index.ts ────────────────────
// Per-spawn resolution: undefined → 30-min default; 0/negative (and
// NaN/Infinity) → 0 (disabled). Per-spawn only — no global setting.
function resolveSilenceTimeout(param) {
	if (param === undefined) return SILENCE_TIMEOUT_DEFAULT_MS;
	return Number.isFinite(param) && param > 0 ? param : 0;
}

// ── bumpActivity — KEEP IN SYNC with index.ts ─────────────────────────────
// Index.ts calls this from: the closure-scoped `logEntry` helper (every log
// line written to the child's log), `appendRunningLogLine` (the tool-body
// mirror of logEntry), the tool_execution_start/end handlers, the
// tool_execution_update handler (streaming bash output), and the assistant
// message_end handler. One timestamp, updated on that union.
function bumpActivity(rs) {
	rs.lastActivityMs = Date.now();
}

// ── armSilenceTimer / fireSilenceKill — KEEP IN SYNC with index.ts ────────
// setTimeout chain mirroring the stage-1 watchdog: fires when the child has
// been silent for `silenceTimeoutMs`, re-arming from its own callback when
// activity slid the deadline. `silenceTimeoutMs <= 0` disables stage 2.
function armSilenceTimer(rs) {
	if (rs.silenceTimer) clearTimeout(rs.silenceTimer);
	if (rs.silenceTimeoutMs <= 0) { rs.silenceTimer = null; return; }
	// Just-woke window (sleep guard): if the heartbeat hasn't reconciled since
	// the process resumed, the silence measurement may still include suspension
	// we haven't discounted — re-arm after one heartbeat instead of firing on
	// an inflated gap. The heartbeat tick discounts and re-arms with a fix.
	if (Date.now() - lastHeartbeatMs > SLEEP_GUARD_HEARTBEAT_MS + SLEEP_GUARD_SLACK_MS) {
		rs.silenceTimer = setTimeout(() => { rs.silenceTimer = null; armSilenceTimer(rs); }, SLEEP_GUARD_HEARTBEAT_MS);
		return;
	}
	const silentFor = Date.now() - rs.lastActivityMs;
	const remaining = rs.silenceTimeoutMs - silentFor;
	if (remaining <= 0) {
		rs.silenceTimer = null;
		fireSilenceKill(rs);
		return;
	}
	rs.silenceTimer = setTimeout(() => {
		rs.silenceTimer = null;
		if (Date.now() - rs.lastActivityMs < rs.silenceTimeoutMs) {
			armSilenceTimer(rs);
			return;
		}
		fireSilenceKill(rs);
	}, remaining);
}

// ── heartbeatTick — KEEP IN SYNC with index.ts ─────────────────────────
// Detects process suspension: a tick landing >slack late means the process
// was asleep (system sleep). Date.now() advanced across it but the children
// could not emit activity, so each silence budget is inflated by the
// suspension — discount it (bump lastActivityMs forward) and re-arm.
function heartbeatTick() {
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

// Stage-2 guards mirror the kill path's idempotency — an already
// stopped/killed/completed child (or one that left the running set) is a
// no-op, so the auto-kill never double-fires and never races a stop/kill.
// A child parked in a nested wait (currentActivity === "wait") is also
// skipped — its silence is expected (it has live children to block on, and
// their own timers handle genuine hangs); killing it would cascade to those
// children, and wall-clock silence can't tell "hung" from "frozen by system
// sleep" (observed 2026-08-08: an implementer parked in wait was killed on
// laptop wake). The stage-1 watchdog still nudges the caller ("[Subagent
// waiting]"), so the caller can intervene if the children never resolve.
function fireSilenceKill(rs) {
	if (rs.isDone || rs.killedExplicitly || rs.stoppedExplicitly || !running.has(rs.sessionId)) return;
	if (rs.progress?.currentActivity === "wait") return;
	dispatchKillSignals(rs, "progress-timeout");
}

// ── dispatchKillSignals — KEEP IN SYNC with index.ts ──────────────────────
// Shared SIGTERM→SIGKILL dispatch used by both `subagent_kill` and stage 2 —
// the single kill path. Sets killedExplicitly/killedVia BEFORE proc.kill,
// cancels the stale-turn watchdog AND the silence timer, logs the kill
// marker, then SIGTERM with SIGKILL after HARD_KILL_DELAY_MS. The mirror
// stubs `rs.proc` (signals recorded into procKills) and the log surface
// (killLog); production uses the real child process + log file. Returns
// { alreadyDead } so the tool can report dispatch status.
function dispatchKillSignals(rs, via) {
	rs.killedExplicitly = true;
	rs.killedVia = via;
	if (rs.staleTimer) { clearTimeout(rs.staleTimer); rs.staleTimer = null; }
	if (rs.silenceTimer) { clearTimeout(rs.silenceTimer); rs.silenceTimer = null; }
	const viaLabel = via === "progress-timeout" ? "progress-timeout" : "subagent_kill";
	killLog.push(`── Killed via ${viaLabel} (SIGTERM sent, SIGKILL in ${HARD_KILL_DELAY_MS / 1000}s if needed) ──`);
	const alreadyDead = rs.proc.killed || rs.proc.exitCode !== null;
	if (!alreadyDead) {
		try { rs.proc.kill("SIGTERM"); } catch { /* */ }
		setTimeout(() => {
			if (!rs.proc.killed && rs.proc.exitCode === null) {
				try { rs.proc.kill("SIGKILL"); } catch { /* */ }
			}
		}, HARD_KILL_DELAY_MS);
	}
	return { alreadyDead };
}

// ── killedMarker — KEEP IN SYNC with index.ts ─────────────────────────────
// Marker prepended by the close handler (deliverResult / resolveOnStop).
// The stage-2 variant is greppable as `[Killed via progress-timeout]`.
function killedMarker(rs) {
	if (!rs.killedExplicitly) return null;
	return rs.killedVia === "progress-timeout"
		? "[Killed via progress-timeout — process terminated, work in this subagent is lost]"
		: "[Killed via subagent_kill — process terminated, work in this subagent is lost]";
}

// ── Test harness ───────────────────────────────────────────────────────────
// Mirror of the module-level `running` map; makeChild builds a
// RunningSubagent-shaped stub with a fake proc whose kill() records signals.
const running = new Map();
let killLog = [];
let procKills = [];

// Unique session ids per row so a timer left over from a previous row (e.g.
// row (d)'s re-arming chain) can never resolve to a later row's child — the
// fireSilenceKill `running.has` guard becomes a true miss, mirroring
// production where each spawn has a unique id.
let childSeq = 0;

function makeChild({ silenceTimeoutMs } = {}) {
	const sessionId = `child-${++childSeq}`;
	const rs = {
		sessionId,
		proc: {
			killed: false,
			exitCode: null,
			kill: (sig) => {
				procKills.push(sig);
				if (sig === "SIGKILL") rs.proc.killed = true;
			},
		},
		isDone: false,
		killedExplicitly: false,
		stoppedExplicitly: false,
		staleTimer: null,
		silenceTimer: null,
		silenceTimeoutMs: resolveSilenceTimeout(silenceTimeoutMs),
		lastActivityMs: Date.now(),
		killedVia: null,
		progress: { currentActivity: "starting..." },
	};
	running.set(sessionId, rs);
	return rs;
}

function reset() {
	// Defensive: clear any timers still registered under live entries before
	// dropping the map, so no row leaks timers into the next row.
	for (const rs of running.values()) {
		if (rs.silenceTimer) { clearTimeout(rs.silenceTimer); rs.silenceTimer = null; }
		if (rs.staleTimer) { clearTimeout(rs.staleTimer); rs.staleTimer = null; }
	}
	running.clear();
	killLog = [];
	procKills = [];
	lastHeartbeatMs = Date.now(); // fresh heartbeat each row so the just-woke guard doesn't defer
}

let passed = 0;
let failed = 0;

function test(name, fn) {
	return Promise.resolve(fn()).then(
		() => { console.log(`  ✅ ${name}`); passed++; },
		(e) => { console.log(`  ❌ ${name}`); console.log(`     ${e && e.message ? e.message : e}`); failed++; },
	);
}

function eq(actual, expected, msg) {
	assert.strictEqual(actual, expected, msg);
}

(async () => {
	// ── resolveSilenceTimeout pins (param resolution) ──────────────────
	await test("param undefined → 30-min default (1800000)", () => {
		eq(resolveSilenceTimeout(undefined), 1800000);
	});
	await test("param 0 → disabled (0)", () => {
		eq(resolveSilenceTimeout(0), 0);
	});
	await test("param negative → disabled (0)", () => {
		eq(resolveSilenceTimeout(-5), 0);
	});
	await test("param NaN/Infinity → disabled (0)", () => {
		eq(resolveSilenceTimeout(NaN), 0);
		eq(resolveSilenceTimeout(Infinity), 0);
	});
	await test("param positive → kept verbatim", () => {
		eq(resolveSilenceTimeout(5000), 5000);
	});

	// ── (a) silence tracking updates on log/tool/message signals ───────
	await test("(a) bumpActivity advances lastActivityMs on every signal class (log/tool/message)", async () => {
		reset();
		const rs = makeChild({ silenceTimeoutMs: 60_000 });
		const t0 = rs.lastActivityMs;
		await sleep(15);
		bumpActivity(rs); // any log line (logEntry / appendRunningLogLine)
		assert.ok(rs.lastActivityMs > t0, "log signal bumps lastActivityMs");
		await sleep(15);
		bumpActivity(rs); // tool_execution_start
		const t1 = rs.lastActivityMs;
		await sleep(15);
		bumpActivity(rs); // tool_execution_end / assistant message_end
		assert.ok(rs.lastActivityMs > t1, "tool/message signals bump lastActivityMs");
		eq(rs.killedExplicitly, false, "tracking alone never kills");
	});

	// ── (b) stage-2 fires at silenceTimeoutMs when silent ──────────────
	await test("(b) silent child auto-killed at silenceTimeoutMs, progress-timeout marker greppable", async () => {
		reset();
		const rs = makeChild({ silenceTimeoutMs: 80 });
		armSilenceTimer(rs);
		await sleep(300);
		eq(rs.killedExplicitly, true, "auto-kill fired");
		eq(rs.killedVia, "progress-timeout", "kill source recorded");
		assert.deepStrictEqual(procKills, ["SIGTERM"], "SIGTERM dispatched (SIGKILL grace pending)");
		eq(rs.silenceTimer, null, "timer cleared after firing");
		const marker = killedMarker(rs);
		assert.ok(marker && marker.includes("[Killed via progress-timeout"), `delivered marker greppable: ${marker}`);
		assert.ok(killLog.some((l) => l.includes("Killed via progress-timeout")), "kill log line carries the marker");
	});

	await test("(b2) armSilenceTimer immediate-fire when already silent past the budget (remaining <= 0)", async () => {
		reset();
		const rs = makeChild({ silenceTimeoutMs: 80 });
		rs.lastActivityMs = Date.now() - 5000; // silent for 5s >> 80ms budget
		armSilenceTimer(rs); // must fire synchronously, not schedule a timer
		eq(rs.killedExplicitly, true, "immediate-fire killed the already-silent child");
		eq(rs.killedVia, "progress-timeout", "kill source recorded");
		assert.deepStrictEqual(procKills, ["SIGTERM"], "SIGTERM dispatched without waiting");
		eq(rs.silenceTimer, null, "no timer armed on the immediate-fire path");
	});

	// ── (c) silenceTimeoutMs: 0 / negative disables ────────────────────
	await test("(c) silenceTimeoutMs 0 → stage-2 disabled, silent child survives", async () => {
		reset();
		const rs = makeChild({ silenceTimeoutMs: 0 });
		armSilenceTimer(rs);
		await sleep(300);
		eq(rs.killedExplicitly, false, "no auto-kill when disabled");
		eq(rs.silenceTimer, null, "no timer armed when disabled");
		assert.deepStrictEqual(procKills, [], "no signals dispatched");
	});
	await test("(c2) negative silenceTimeoutMs → disabled too", async () => {
		reset();
		const rs = makeChild({ silenceTimeoutMs: -100 });
		armSilenceTimer(rs);
		await sleep(300);
		eq(rs.killedExplicitly, false, "no auto-kill when negative");
		assert.deepStrictEqual(procKills, [], "no signals dispatched");
	});

	// ── (d) active child past the threshold never killed ───────────────
	await test("(d) active child past the wall-clock threshold is never killed", async () => {
		reset();
		const rs = makeChild({ silenceTimeoutMs: 80 });
		armSilenceTimer(rs);
		// 14 bumps × ~30ms = ~420ms of activity >> 5× the 80ms threshold.
		for (let i = 0; i < 14; i++) {
			await sleep(30);
			bumpActivity(rs);
		}
		eq(rs.killedExplicitly, false, "active child survives");
		eq(rs.killedVia, null, "no kill source recorded");
		assert.deepStrictEqual(procKills, [], "no signals dispatched");
	});

	// ── (e) stage-2 no-op after explicit kill/stop/completion ──────────
	await test("(e) stage-2 no-op after explicit subagent_kill (no double-fire)", async () => {
		reset();
		const rs = makeChild({ silenceTimeoutMs: 80 });
		armSilenceTimer(rs);
		dispatchKillSignals(rs, "kill-tool"); // simulate the tool having killed first
		const signalsAtKill = procKills.slice();
		eq(rs.silenceTimer, null, "kill dispatch cancelled the armed silence timer");
		await sleep(300);
		eq(rs.killedVia, "kill-tool", "kill source stays the tool's");
		assert.deepStrictEqual(procKills, signalsAtKill, "no double-fire from stage-2");
		const marker = killedMarker(rs);
		assert.ok(marker && marker.includes("[Killed via subagent_kill"), `tool marker preserved: ${marker}`);
	});
	await test("(e2) stage-2 no-op when child was explicitly stopped", async () => {
		reset();
		const rs = makeChild({ silenceTimeoutMs: 80 });
		rs.stoppedExplicitly = true; // subagent_stop in flight
		armSilenceTimer(rs);
		await sleep(300);
		eq(rs.killedExplicitly, false, "stop path not raced by stage-2");
		assert.deepStrictEqual(procKills, [], "no signals dispatched");
	});
	await test("(e3) stage-2 no-op when child already completed (isDone)", async () => {
		reset();
		const rs = makeChild({ silenceTimeoutMs: 80 });
		rs.isDone = true;
		armSilenceTimer(rs);
		await sleep(300);
		eq(rs.killedExplicitly, false, "completed child not killed");
	});
	await test("(e4) stage-2 no-op when child left the running set", async () => {
		reset();
		const rs = makeChild({ silenceTimeoutMs: 80 });
		running.delete(rs.sessionId); // close handler removed it
		armSilenceTimer(rs);
		await sleep(300);
		eq(rs.killedExplicitly, false, "finished child not killed");
	});

	// ── (f) nested-wait child is not progress-timeout-killed ───────────
	// Observed 2026-08-08: an implementer parked in wait (blocked on a
	// reviewer) was killed by the stage-2 silence timer on laptop wake — its
	// timers had frozen during sleep and fired overdue on resume, and the kill
	// cascaded to its reviewers. A wait-parked child's silence is expected;
	// stage 2 must skip it and leave resolution to the children's timers / the
	// caller (stage 1 already says "[Subagent waiting]").
	await test("(f) child parked in nested wait (currentActivity === \"wait\") survives stage-2 silence", async () => {
		reset();
		const rs = makeChild({ silenceTimeoutMs: 80 });
		rs.progress.currentActivity = "wait"; // parked on its own children
		armSilenceTimer(rs);
		await sleep(300); // well past the 80ms budget
		eq(rs.killedExplicitly, false, "wait-parked child not auto-killed");
		assert.deepStrictEqual(procKills, [], "no signals dispatched");
	});
	await test("(f2) child NOT in wait (mid-tool / mid-LLM) is still killed — guard doesn't over-broaden", async () => {
		reset();
		const rs = makeChild({ silenceTimeoutMs: 80 });
		rs.progress.currentActivity = "read codegen/src/types.rs"; // working, not parked
		armSilenceTimer(rs);
		await sleep(300);
		eq(rs.killedExplicitly, true, "non-wait silent child still auto-killed");
		eq(rs.killedVia, "progress-timeout", "kill source recorded");
		assert.deepStrictEqual(procKills, ["SIGTERM"], "SIGTERM dispatched");
	});

	// ── interaction: kill dispatch cancels both timers (no leak) ───────
	// ── (g) system-sleep recovery: heartbeatTick discounts oversleep ──
	// Observed 2026-08-08..08-12: macOS Sleep-Service cycles (~15 min on
	// battery) suspended pi mid-task; Date.now() advanced across the sleep
	// but children couldn't emit activity, so the silence budget billed sleep
	// as child silence and killed healthy subagents on wake (auto-kills fired
	// 10–35 min overdue). The heartbeat detects suspension (a tick landing
	// >slack late) and discounts the slept interval from lastActivityMs.
	await test("(g) heartbeatTick discounts oversleep from lastActivityMs when a tick lands late", () => {
		reset();
		const rs = makeChild({ silenceTimeoutMs: 60_000 });
		rs.lastActivityMs = Date.now() - 30_000; // 30s silent
		lastHeartbeatMs = Date.now() - 25_000;   // pretend ~25s suspension
		const before = rs.lastActivityMs;
		heartbeatTick(); // elapsed ~25s > 13s threshold → discount ≈ 15s
		const discount = rs.lastActivityMs - before;
		assert.ok(discount > 14_000 && discount < 16_000, `discount ≈ elapsed − heartbeat (≈15s), got ${discount}ms`);
	});
	await test("(g2) heartbeatTick is a no-op when the tick lands on time (no false discount)", () => {
		reset();
		const rs = makeChild({ silenceTimeoutMs: 60_000 });
		rs.lastActivityMs = Date.now() - 5_000;
		lastHeartbeatMs = Date.now() - 10_500; // 10.5s < 13s threshold → on time
		const before = rs.lastActivityMs;
		heartbeatTick();
		eq(rs.lastActivityMs, before, "no discount when tick is on time");
	});

	// ── (h) armSilenceTimer defers the kill in the just-woke window ────
	// Race fix: on wake an overdue silence timer can fire before the heartbeat
	// reconciles. The guard at the top of armSilenceTimer detects the stale
	// heartbeat and re-arms after one interval instead of evaluating — and
	// firing on — an inflated gap.
	await test("(h) armSilenceTimer defers the kill while the heartbeat is stale (just-woke window)", async () => {
		reset();
		const rs = makeChild({ silenceTimeoutMs: 80 });
		rs.lastActivityMs = Date.now() - 60_000; // would immediate-fire
		lastHeartbeatMs = Date.now() - 60_000;   // stale → just-woke
		armSilenceTimer(rs);
		eq(rs.killedExplicitly, false, "immediate-fire suppressed in just-woke window");
		assert.ok(rs.silenceTimer, "re-arm scheduled instead of firing");
	});

	// ── (i) tool_execution_update (streaming output) counts as activity ─
	// bash streams stdout/stderr via tool_execution_update (100ms throttle,
	// only on real new output). Handling it as activity keeps a long-but-
	// healthy command alive; a deadlocked (zero-output) tool stays quiet and
	// is still killed — the deadlock backstop decision 015 preserves.
	await test("(i) a child receiving periodic tool_execution_update bumps survives past the threshold", async () => {
		reset();
		const rs = makeChild({ silenceTimeoutMs: 80 });
		armSilenceTimer(rs);
		for (let i = 0; i < 14; i++) { // ~420ms of streaming updates >> 5× 80ms
			await sleep(30);
			bumpActivity(rs); // mirrors handling tool_execution_update
		}
		eq(rs.killedExplicitly, false, "child receiving streaming updates survives");
		assert.deepStrictEqual(procKills, [], "no signals dispatched");
	});
	await test("(i2) a tool that goes silent (no updates) is still killed — deadlock backstop preserved", async () => {
		reset();
		const rs = makeChild({ silenceTimeoutMs: 80 });
		lastHeartbeatMs = Date.now(); // awake, heartbeat fresh → guard passes
		armSilenceTimer(rs);
		await sleep(300); // no updates, no bumps
		eq(rs.killedExplicitly, true, "deadlocked silent child still auto-killed");
		eq(rs.killedVia, "progress-timeout", "kill source recorded");
	});

	await test("kill dispatch clears the armed silence timer AND stale watchdog", async () => {
		reset();
		const rs = makeChild({ silenceTimeoutMs: 10_000 });
		armSilenceTimer(rs);
		rs.staleTimer = setTimeout(() => {}, 60_000); // armed stage-1 watchdog
		assert.ok(rs.silenceTimer, "stage-2 timer armed");
		assert.ok(rs.staleTimer, "stage-1 watchdog armed");
		dispatchKillSignals(rs, "kill-tool");
		eq(rs.silenceTimer, null, "stage-2 timer cancelled by kill dispatch");
		eq(rs.staleTimer, null, "stage-1 watchdog cancelled by kill dispatch");
	});

	// ── Result ─────────────────────────────────────────────────────────
	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed === 0 ? 0 : 1);
})();
