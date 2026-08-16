---
title: "Silence-based progress-kill timeout (activates decision 001)"
type: decision
status: done
date: 2026-08-04
---

# Silence-based progress-kill timeout (activates decision 001)

**What:** Two-stage hang handling in `extensions/subagent-async/index.ts`. Stage 1 (existing, unchanged): the 5-minute stale-turn watchdog wakes the parent when a child shows no activity — the parent can steer or extend. Stage 2 (new): a child silent for `silenceTimeoutMs` (no tool calls AND no assistant messages) is **automatically killed** via the existing SIGTERM→SIGKILL machinery (`subagent_kill` path), a `[Killed via progress-timeout]` marker is delivered so the parent's `wait` resolves, and the session file is preserved so `subagent_resume` can continue the work. New `silenceTimeoutMs` tool param: default 30 minutes; `0`/negative disables stage 2.

**Why:** Decision 001 (progress-based timeout) was planned 2026-07-14 and never built; the shipped guards deliberately avoid killing — the stale watchdog only wakes (`index.ts:29,1737-1759`), and `subagent_stop` waits up to 5 minutes for a natural exit. A hung child (deadlocked, blocked provider call, RPC stdin not being read) by definition never exits — **stop is useless on a hung child** (observed 2026-08-04): it's a guaranteed 5-minute loss before the kill fallback. Manual `subagent_kill` closes the loop only if the orchestrator notices, which is exactly the unreliable step automation should replace. Silence is the right trigger because it distinguishes hung from legitimately long: a healthy implementer ran 225 turns / 49 minutes on 2026-08-04 — a wall-clock cap would have killed it; silence-based detection does not.

**Alternatives considered:**
- Wall-clock cap (kill at N minutes regardless of activity) — rejected: kills healthy long-running sessions (the 49-min implementer).
- Turn-stagnation detection (same tool/error looping) — rejected: more state, harder to detect reliably, and silence already covers the dead cases.
- stop-first-then-kill on silence — rejected: stop's 5-minute natural-exit wait is pure loss on a child that cannot respond; stage 2 goes straight to the kill path.

**Tradeoffs:**
- A slow-but-healthy provider call exceeding 30 minutes of no output would be killed — mitigated by the `silenceTimeoutMs` param (extend or disable per spawn).
- Auto-kill discards in-flight work — mitigated: session file preserved, `subagent_resume` can continue from the same conversation.
- The 30-minute default is a judgment call (user, 2026-08-04); the 5-minute stage-1 wake gives four opportunities to intervene before stage 2 fires.

**Supersedes (partially):** decision 001 (progress-based timeout, `status: planned`) — implemented here in adapted form: silence-based trigger (no tool calls + no messages) instead of the generic "no output" check, and staged (wake first, kill later) instead of a single timeout.

**Files changed:** `extensions/subagent-async/index.ts` (silence tracking, stage-2 auto-kill, param), this decision, 001 footnote, index.

**Test coverage:** real-dispatch E2E mandatory (WO-2026-034/035 lesson). Matrix: silent child killed at `silenceTimeoutMs` with marker delivered; active child untouched past the threshold; `silenceTimeoutMs: 0` disables; stage-1 wake still fires at 5 min; killed session resumable via `subagent_resume`.

---

> **Amended (2026-08-12): system-sleep hardening.** The silence budget used
> wall-clock `Date.now()`, which advances while the machine sleeps but the
> child cannot emit activity — so macOS sleep billed suspension as child
> silence and stage 2 killed healthy subagents on wake. Observed recurrently:
> the 2026-08-08 wait-parked kill already in the code comments, plus
> 2026-08-11/12 auto-kills firing **10–35 min overdue** (a 30-min timer
> landing at 40 / 65 min of apparent silence = time the laptop spent asleep);
> `pmset -g log` showed continuous ~15-min Sleep-Service cycles on battery,
> and nothing in the stack held a `PreventSystemSleep` assertion. The manual
> `subagent_kill` count (≈209 vs ≈6 stage-2 fires) was downstream of the same
> cause — the orchestrator woke to stale-looking children and killed them.
>
> Three guards added in `extensions/subagent-async/index.ts` (tests in
> `test-progress-kill-timeout.cjs` rows g/h/i), none of which disable stage 2:
> 1. `caffeinate -s -i -w <pi pid>` runs while any child runs — prevents sleep
>   mid-task on AC (battery isn't honored long-term; guard 2 covers it).
> 2. A 10s heartbeat discounts slept intervals from every child's
>   `lastActivityMs`; `armSilenceTimer` also defers a kill while the heartbeat
>   is unreconciled (just-woke window) so an overdue timer can't fire on an
>   inflated gap before the heartbeat corrects it.
> 3. `tool_execution_update` (bash's 100ms-throttled streaming output) now
>   counts as activity — a long-but-healthy command printing progress stays
>   alive; a truly silent/deadlocked tool still hits the budget. This refines
>   the *Tradeoffs* clause: the deadlock backstop is preserved, but "silent"
>   now excludes tools actively streaming output.

> **Amended (2026-08-16): LLM-call streaming + provider retries count as
> activity (guard 4).** Observed 2026-08-16 (issue #1): a healthy implementer
> (49 turns, normal cadence) was killed by stage 2 at a live turn boundary —
> the entire 30-min silence window sat inside one provider call. The activity
> union counted tool lifecycle, streaming tool output, logs, and *completed*
> assistant messages, but not `message_update` deltas (streaming tokens) nor
> `auto_retry_*` events (provider retry/backoff); between a tool result and
> the next `message_end` a mid-LLM child emits none of the counted signals.
> The Tradeoffs clause above observed in the wild — on a machine that never
> slept (pmset: awake continuously since 08-12 17:11), so no earlier guard
> applied. Fix: raw event types are classified by a single
> `ACTIVITY_EVENT_TYPES` union (guard 3's tool events folded in) —
> `message_start`, `message_update`, `auto_retry_start`, `auto_retry_end`
> added. `auto_retry_*` also logs a line so degraded-provider kills are
> legible after the fact (the incident log showed nothing between the last
> tool result and the kill). Retry credit is bounded by pi's own
> `attempt`/`maxAttempts`: exhausted retries surface an error and end the
> turn, so counting them can't stretch silence forever. Stage-1 softening: a
> stall notice whose child showed activity in the last 60s now reads
> `[Subagent streaming]` instead of `[Subagent stalled]` — false stalls
> invited manual kills (the ≈209-manual-vs-≈6 asymmetry above). Residual
> exposure, accepted: a provider call stalled pre-first-token with no retry
> events still hits the budget — that is the deadlock backstop as designed;
> dispatchers under known degradation raise `silenceTimeoutMs` per spawn, and
> `subagent_resume` recovers a killed session. Stage 1's *wake* remains
> undeliverable to an idle parent (a `deliverAs: "steer"` message waits for a
> turn boundary an idle session never produces — issue #1 comment): pi-core
> delivery semantics, out of scope here. Tests:
> `test-progress-kill-timeout.cjs` rows (j)/(j2)/(j3) pin the classification
> union, streaming survival, and the preserved backstop; the post-merge E2E
> battery remains the real gate.
