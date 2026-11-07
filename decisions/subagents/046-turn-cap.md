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

The commit observation is **sampled every `STALL_SAMPLE_TURNS` (10) turns and
asynchronous**, and its result is folded on a later sample turn than the one that
started it (owner ruling 2026-11-07, below). A stall of N is therefore noticed
within one sample interval of N: the turn that starts an observation cannot act
on it, and the next turn that folds it can. The cap arm still decides every turn,
so the wind-down and the kill land on exact turn numbers.

Everything is decided by pure functions in `extensions/lib/subagent-state.ts`:

- `resolveTurnCap(raw)` — `undefined` → `TURN_CAP_DEFAULT` (150); `0` or negative
  → `Infinity` (disabled); above `MAX_TURNS_HARD` → throws naming both numbers.
- `decideTurnAction(state)` — the cap arm, then the stall arm; the cap outranks
  the stall so a run at its cap gets one message, not two.
- `nextStallState(prior, observation, elapsedTurns)` — the commit-observation
  fold. `elapsedTurns` is how many turns the observation settles (the sample
  interval), so the counter stays in turns at either sampling rate.
- `stallSampleDue(turn)` — the sample grid.

The stall arm's state is one value, `StallTracker` (in the same module): the
fold's three counters plus the last observed tip, the pending observation, the
last folded sample turn and the in-flight flag. The six parts always move
together, so they are one member on the run handle rather than six siblings that
a future change can half-update.

`turnCapTurn(rs, runner?)` in `extensions/subagent-async/index.ts` is the one
per-turn entry: it folds a completed observation if a sample turn finds one
waiting, starts this sample turn's observation without waiting for it, and hands
the state to `turnCapStep(rs, observation, elapsedTurns)`, which executes exactly
the action the decider named. The `message_end` site calls `turnCapTurn` once per
assistant turn and re-derives nothing.

## Rulings this rests on

- **Owner 2026-11-07:** *"Add it (Recommended)"* — a no-progress tripwire that
  steers and never kills, separate from the total cap.
- **Owner 2026-11-07:** *"Hide it (Recommended)"* — the implementer never sees its
  cap number; it learns of the cap only from the wind-down, which therefore
  carries no digits and no interpolation.
- **Owner 2026-11-07:** *"keep an eye on the effect this is having on quality …
  we shouldn't accept a middling first pass at some work just because it brushed
  up against the turn limits."*
- **Owner 2026-11-07** (quote): *"async + don't call every turn - every 10 is
  probably fine"* — the commit observation is asynchronous and sampled every
  `STALL_SAMPLE_TURNS` turns. It replaces the seat's one-spawn-per-turn sketch:
  the synchronous spawn blocked the parent's event loop every turn (measured
  286 ms mean, 1.3 s p95 under load), which no advisory check may do.
- Seat rulings: default 150, flat 10-turn grace, `N = 30` for the stall steer, no
  mid-run raise parameter, commits observed with `git rev-parse <branch>` rather
  than a ref-file read or a packed-ref fallback.
- **Owner 2026-11-07** (gate): accepted the two departures raised against
  WO-2026-090 — the E3 → E3/E3a/E3b reshape (narrowed further by the
  orchestrator's dispatch brief), and the internal test seams (`stallSteered`,
  `stallObserved`, `nextStallState`, `turnCapStep`, `observeCommit`, and their
  successors `turnCapTurn`, `stallSampleDue`, `stallPending`,
  `stallFoldedTurn`). The order's API block is recorded as under-specified: it
  named the decider's exports without fixing the observation's shape, which is
  what the seams exist to hold down.

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
- **One spawn every ten turns, off the turn path.** `git rev-parse <branch>` is
  `execFile`, not `execFileSync`, and only on a sample turn; the turn path never
  waits for it. Measured on this box, 100 consecutive calls from the repo root:
  `execFileSync` mean 9.7 ms / p95 11.5 ms, `execFile` mean 11.3 ms / p95 16.8 ms.
  A second run had `execFile` marginally faster, so the difference is noise at
  n=100: what settles it is not the duration but the path — the turn pays a
  promise allocation, never the spawn. The synchronous figure under load was
  mean 286 ms / p95 1329 ms per turn, which is what the ruling removed. The
  before/after ~60-turn E2E wall-time comparison was still not run — the provider
  returned HTTP 429 throughout the gate run, so a delta would have measured the
  provider. WO-2026-090's follow-up recalibration order (`sequence_position: 2`,
  unnumbered at this tip) carries that comparison.
- **A sampled observation is applied a sample later.** The counter is in turns,
  and a fold is charged the turns between sample turns, so a stall is measured
  one sample behind the child. Measured on `turnCapTurn` (S3, S6): a fresh run's
  first steer lands at turn 40, i.e. 40 commit-free turns; a stall that begins
  after a commit the sampler saw lands at 41-50 commit-free turns (commit at turn
  25 → steer at 70, 45 commit-free; commit at 10 → steer at 60, 50), or 40 when
  the observation at the commit's own sample turn catches it. The extra interval
  is the fold that sees the change: it resets the counter to zero (U7), so the
  count cannot include the turns between the commit and that fold.
  **This misses the dispatch brief's stated worst case of 39 commit-free turns**
  (S6 pins the measured 41-50). No fold timing closes the gap: the reset-to-zero
  fold is an acceptance row (U7), and folding on the arrival turn instead still
  leaves 41. Amending the bound is an owner question, not a gate call.
- **A steer can lag a commit the sampler has not seen.** A commit landing inside
  the last sample interval is invisible when the steer fires (measured: a commit
  at turn 30, with the steer at 40). The steer is advisory, so the cost is one
  message to a child that had just committed; the next sample resets the counter.
- **An observation that outlives its sample interval skips that sample.** The
  in-flight guard starts no second spawn, so a persistently slow `git` can push
  the steer past N plus one interval. The direction is safe — a missing
  observation is silence, never an accusation — and a sample is skipped only
  while a spawn is genuinely outstanding.
- **An unobservable commit is a skip, not an accusation.** No branch, or a
  `git rev-parse` that cannot resolve one, reports *unobserved*: the counters
  clear and the stall steer never fires, and one sample's failure is not a
  commit-free turn. The failure is logged under
  `PI_ASYNC_DEBUG` only — a broken probe must not tell a child it stalled, so
  nothing parent-visible is written. A turned-off advisory arm is the safe
  direction of that trade.
- **The synchronous observation is gone.** This run restructured the
  `message_end` handler: the turn entry is `turnCapTurn`, which folds a pending
  observation, starts this sample turn's spawn without waiting for it, and
  executes the action.
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
  status surface, the `turn_cap` refusal at the tool), the sampled observation
  rows (no spawn off the grid, a slow observation off the turn path, a stall
  caught within one interval, none of which reds without its mutation), the
  commit observation, and four real-dispatch rows.
- `extensions/subagent-async/test-progress-kill-timeout.cjs`, `test-resume.cjs`,
  `test-completion-filter.cjs`, `tests/subagent-id-resolution.test.ts` — the
  refactor and the untouched 450/500 pair.
