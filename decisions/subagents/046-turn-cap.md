# 046 — A per-dispatch turn cap, and a no-progress tripwire that never kills

**Date:** 2026-11-07
**Status:** accepted — owner approved the cap ("I'd be good with baking this in to the harness") and the hidden number ("Hide it"), 2026-11-07
**Implements:** decision 002's soft-limit sketch (wind-down steer, then a hard stop)
**Work order:** WO-2026-090

## What

A dispatch carries a turn budget. At the cap the child gets one wind-down steer;
`TURN_CAP_GRACE` (10) turns later the harness kills it through the existing kill
dispatch, marked `[Killed via turn-cap]`. Independently, a child whose isolation
branch gains no commit for `STALL_TURNS` (30) turns gets one advisory steer. The
stall steer never kills, and it repeats only after a new stall (a commit clears
the counter and the flag).

Everything is decided by three pure functions in
`extensions/lib/subagent-state.ts`:

- `resolveTurnCap(raw)` — `undefined` → `TURN_CAP_DEFAULT` (150); `0` or negative
  → `Infinity` (disabled); above `MAX_TURNS_HARD` → throws naming both numbers.
- `decideTurnAction(state)` — the cap arm, then the stall arm; the cap outranks
  the stall so a run at its cap gets one message, not two.
- `nextStallState(prior, commitChanged)` — the commit-observation fold.

`turnCapStep(rs, commitChanged)` in `extensions/subagent-async/index.ts` builds the
state, calls the decider, and executes exactly the action it named. The
`message_end` site calls it once per assistant turn and re-derives nothing.

## Rulings this rests on

- **Owner 2026-11-07:** *"Add it (Recommended)"* — a no-progress tripwire that
  steers and never kills, separate from the total cap.
- **Owner 2026-11-07:** *"Hide it (Recommended)"* — the implementer never sees its
  cap number; it learns of the cap only from the wind-down, which therefore
  carries no digits and no interpolation.
- **Owner 2026-11-07:** *"keep an eye on the effect this is having on quality …
  we shouldn't accept a middling first pass at some work just because it brushed
  up against the turn limits."*
- Seat rulings: default 150, flat 10-turn grace, `N = 30` for the stall steer, no
  mid-run raise parameter, commits observed with one `git rev-parse <branch>` per
  turn rather than a ref-file read or a packed-ref fallback.

## Why

Nothing watched a runaway child. The soft 450-turn nudge exists, but it is a
single message at 450 and the kill at 500, so a run that should have wrapped up
at turn 60 burned 440 turns of a family of messages before anyone learned
anything. The cap makes the end of a run a stop-report the orchestrator can act
on, and it does so with the numbers the ledger needs.

The stall arm exists because the cap is deliberately generous: a run that is
stuck is not the same as a run that is long. Noticing "no commit for 30 turns" is
cheap evidence of stuckness and carries no risk — the steer is advisory, so a
long healthy run loses one message and nothing else.

## Rejected

- **Check the cap at the call site** (`if (turns >= cap)`) — a second place that
  knows the rule, and the state space has more than one axis (trip, grace,
  stall, commit). The pure decider makes every combination a row.
- **A timer for the grace** — the grace is counted in turns on the existing
  `message_end` path; a timer would be a second clock to reconcile with turn
  counting and would fire during a healthy long tool call.
- **Clamp a cap above `MAX_TURNS_HARD`** — the global hard kill fires first, so
  accepting the number would make the cap a lie about what stopped the run.
- **A ref-file read or `git rev-parse --packed-refs` fallback** — a linked
  worktree's `.git` is a file pointing at the gitdir; the branch lives in the
  common dir's refs. The command is the only shape that works for the isolation
  case at all, and a fallback would hide the fact that the first read was wrong.
- **Kill on a stall** — rejected by the owner ruling above; the stall steer is
  advisory and the cap remains the only turn-based killer.

## Consequences

- **A resume continues the turn count.** `turnsUsed` is cumulative across the
  runs of one logical dispatch, and the cap is the same absolute number, so a
  resume after a cap starts at or past its cap and gets the wind-down again on
  its first turn: a resume buys one more grace window, not a fresh budget. The
  follow-up recalibration order is the place to revisit that if the ledger says
  resume needs room.
- **A resume re-trips the flag.** `turn_cap_reached` is per run, so the resumed
  run's result carries it again when it reaches the cap.
- **The stall arm is skipped where there is no branch to watch.** A non-isolated
  dispatch and every resumed run report `stall_watch: none (no isolation branch)`
  in the spawn/resume result, and the observation reports *unobserved* rather
  than "unchanged": no stall accrues on nothing to watch, so no child is ever
  told it stalled on a branch it does not have.
- **One spawn per turn, synchronously.** `git rev-parse <branch>` costs a process
  spawn per assistant turn on the `message_end` path, so it blocks the extension's
  event loop (every concurrent child's stream, and the TUI) for its duration.
  Measured on this box: mean 6.6 ms, p95 7.2 ms quiet; mean 286 ms, p95 1329 ms
  under load, against a `true`-spawn control of 1.6 ms. The before/after
  ~60-turn E2E wall-time comparison was not run — the provider was returning
  HTTP 429 throughout, so a delta would have measured the provider — and the
  per-turn cost above is the bound this change adds.
- **An unobservable commit is a skip, not an accusation.** No branch, or a
  `git rev-parse` that cannot resolve one, reports *unobserved*: the counters
  clear and the stall steer never fires. The failure is logged under
  `PI_ASYNC_DEBUG` only — a broken probe must not tell a child it stalled, so
  nothing parent-visible is written. A turned-off advisory arm is the safe
  direction of that trade.
- **The synchronous observation has no named carrier yet.** An async
  `git rev-parse` needs the `message_end` handler restructured; no order carries
  that work, so it is stated here as a fact rather than deferred to a carrier
  that does not exist.
- **Two turn counters, on purpose.** The hard ceiling counts this run's turns
  (`rs.progress.turns`, which `outcomeFromExitCode` also reads); the cap counts
  the dispatch's turns, carried over on resume. On a resumed dispatch they can
  disagree, so "the hard ceiling wins at 500" holds for a fresh spawn; a resumed
  run past its cap is ended by the cap first.
- **`killedVia` gained a fourth value.** `turn-cap` joins `kill-tool`,
  `progress-timeout` and `turn-limit`; the marker table and the outcome
  classifier read it the same way they read the others.
- **`steerChild` is the one path for the harness-initiated steers.** Extracted
  first, in its own commit: the cap's wind-down would otherwise have been a
  fourth copy of the `isDone`/`procExited`/`stdin` guard block. It serves the 450
  nudge, `subagent_stop`, the `steer` tool and the two cap/stall arms.
  `steerBlockedReason` is the one definition of "steerable", which the
  `subagent_steer` tool also uses to name why a message was not delivered. The
  review-gate and owner-asks corrective sends still call `rpcSend` inline and
  carry no guard; they are not part of this refactor.

## Upheld by

- `tests/turn-cap.test.ts` — the decision rows (cap, grace, stall, refusal), the
  execution rows (one wind-down, the `turn-cap` kill, the stall steer, the
  status surface), the commit observation, and four real-dispatch rows.
- `extensions/subagent-async/test-progress-kill-timeout.cjs`, `test-resume.cjs`,
  `test-completion-filter.cjs`, `tests/subagent-id-resolution.test.ts` — the
  refactor and the untouched 450/500 pair.
