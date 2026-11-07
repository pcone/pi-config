# WO-2026-090 — a per-dispatch turn cap, and a stall tripwire that never kills

### Metadata

- **work_order_id**: WO-2026-090
- **parent_plan_id**: owner-approved turn cap 2026-11-07 ("I'd be good with baking this in to the harness")
- **sequence_position**: 1 of 2 (this order; a follow-up recalibrates defaults from the ledger)
- **routed_to**: implement
- **invariant_exhaustiveness**: implicit — the decision function's state space is the enumeration; §Rulings fixes the axes, the implementer names the remaining combinations.
- **priority**: normal
- **estimated_complexity**: complex
- **review_policy**: required
- **turn_budget**: planned **120** turns, cap **180** (class L: mechanism plus E2E rows). Report `planned / cap / actual` in the completion report. At 180 the wind-down fires and the run ends; a stop-report there is a success. Targeted rows only — never the full `bun test` (box-wide `flock` slot; the orchestrator gates it). Tell any reviewer you spawn the same.
- **base**: `15397c9` (`origin/main`)

### Task Summary

**One-sentence description**: the subagent harness enforces a per-dispatch turn cap with a bounded wind-down and a `turn_cap_reached` flag, and adds an advisory no-progress tripwire — both built on the kill, steer and flag machinery that already exists.

**Goal**: a runaway child ends by itself with a stop-report instead of being discovered late, and the numbers to calibrate future estimates come out of every dispatch.

### Premise

Verified at `15397c9`:

- **Turn counting already exists**: `rs.progress.turns++` on every assistant `message_end`
  (`extensions/subagent-async/index.ts:2237`).
- **A soft steer already exists**: at `TURN_NUDGE_SOFT = 450` (`:75`) the harness injects one
  `rpcSend(rs.stdin, {type:"prompt", streamingBehavior:"steer"})` (`:2266`); at `MAX_TURNS_HARD = 500`
  (`extensions/lib/subagent-state.ts:370`) it calls `dispatchKillSignals(rs, "turn-limit")` (`:2289`).
- **A stop routine already exists**: `subagent_stop` marks the session stopped, injects the wrap-up
  steer and waits (`:4518-4600`). Its steer send is inline and shape-identical to the 450 nudge's.
- **A result flag already exists**: `reviewCapReached` (decision 006) is persisted, returned by
  `subagent_review_status` and rendered in `formatProgress`.
- **The tools' params**: `SubagentParams` (`:3759`), `ResumeParams` (`:4226`), status via
  `formatProgress(rs)` (`:4131`).
- **The child's branch is known to the spawn path**: isolation creates `pi-subagent-<tail>`.

**Probe that would falsify the commit observation**: `git rev-parse <branch>` from the parent must
return the child's tip after a commit in a **linked worktree** — the isolation case. A ref-file read of
`<worktree>/.git/refs/heads/<branch>` cannot work there (`.git` is a file pointing at the gitdir; refs
live in the common dir), so the order specifies the command, not a file read. If `rev-parse` cannot see
the child's commit, stop: `PREMISE FALSIFIED`.

### Preparatory refactor

**Refactor commit 1.** Four sites send a steer to a child and three of them repeat the same guards
(`isDone`, `procExited`, `!stdin`, `stdin.destroyed`) and the same `debugLog`. Extract one
`steerChild(rs, message): boolean` in `extensions/subagent-async/index.ts` and call it from the 450
nudge, `subagent_stop`, and `steer` tool. Behaviour is identical; the existing rows
(`test-progress-kill-timeout.cjs`, `test-resume.cjs`, `test-completion-filter.cjs`) pin it and must pass
**unchanged**.

Without this, the cap adds a fourth copy of the guard block. The refactor is the precondition for the
change, not an optional tidy.

### Rulings

- **Owner 2026-11-07** (quoted by the planning seat): *"Add it (Recommended)"* — a no-progress
  tripwire: after N turns with no new commit on the child's branch, inject one steer telling it to stop
  and check whether its approach is working, then report or continue. **The steer never kills.** It is
  separate from the total cap, which stays generous as the runaway catcher.
- **Owner 2026-11-07**: *"Hide it (Recommended)"* — the implementer does not see its cap number; it
  learns of the cap only from the wind-down steer. Standing rule instead: commit at every green step.
  Orchestrator and seat see the cap and `turns_used`; reviewers see none of it.
- **Owner 2026-11-07**: *"keep an eye on the effect this is having on quality … we shouldn't accept a
  middling first pass at some work just because it brushed up against the turn limits."*
- **Owner 2026-11-07** (ledger): keeps `~/Developer/notes/turn-ledger.md` and will challenge estimates
  against it.
- **Planning seat 2026-11-07** (process calls): probe first on an unproven mechanism; resume by default
  after a cap; S/M/L size classes with caps `S 40 / M 120 / L 180`, recalibrated from the ledger's p90.
- **Planning seat 2026-11-07**: default `turn_cap` **150**, flat **10-turn grace**, cap carries over on
  resume, **no mid-run raise parameter**, flag also on `subagent_status`.
- **Planning seat 2026-11-07**: `N = 30` for the stall steer; observe commits with one
  `git rev-parse <branch>` per turn rather than a ref-file read or a packed-ref fallback — linked
  worktrees make the file read wrong by construction.

**Author's choices**: the pure decision function below (rather than inlining the conditions at the
event site); the flag shape mirroring `reviewCapReached`; `> MAX_TURNS_HARD` rejected rather than
clamped.

### Mechanism

**One pure decision function, one call site.** `extensions/lib/subagent-state.ts` gains:

```
export const TURN_CAP_DEFAULT = 150;
export const TURN_CAP_GRACE = 10;      // flat, in turns
export const STALL_TURNS = 30;         // commit-free turns before the advisory steer
export type TurnAction =
  | { kind: "none" }
  | { kind: "wind-down" }              // inject once, then grace
  | { kind: "kill" }                   // grace exhausted → dispatchKillSignals(rs, "turn-cap")
  | { kind: "stall-steer" };           // advisory, once per stall
export function resolveTurnCap(raw: number | undefined): number;   // 0/negative → Infinity; > MAX_TURNS_HARD throws naming both
export function decideTurnAction(state: TurnCapState): TurnAction;
```

`TurnCapState` carries `turns`, `cap`, `capTripped`, `stallTurns`, `commitChanged`. The event site
(`:2237` block) builds it and executes the action; it does not re-derive any condition.

**Cap arm.** At `turns >= cap`, once: set `turnCapReached`, inject the wind-down steer, start the grace
count. At `turns >= cap + TURN_CAP_GRACE`: `dispatchKillSignals(rs, "turn-cap")` — the 015 path, its
marker `[Killed via turn-cap]`, session file preserved. No new timer: the grace is counted in turns on
the existing `message_end` path.

**Stall arm.** Once per turn, `git rev-parse <branch>` (one spawn — see §Cost). Sha changed → reset
`stallTurns` and clear the stall-steer flag. Sha unchanged for `STALL_TURNS` → inject the stall steer
once. **It never kills**, and the counter resets on the next commit, so a long healthy run gets one
message per stall at most. A child with no branch (non-isolated dispatch) skips the arm and the result
says so.

**Visibility.** The wind-down and stall texts carry **no numbers** (no cap, no turn count, no "150 of
150"). `agents/implement.md` gains no number. The orchestrator doc carries the class caps. Reviewers
never see a budget. `turn_cap_reached`, `turns_used`, `turn_cap` appear in the spawn/resume tool result
and in `formatProgress` (so `subagent_status` shows them).

**Disabled / invalid.** `turn_cap: 0` or negative disables the cap (precedent: `silenceTimeoutMs: 0`,
decision 015). `turn_cap > MAX_TURNS_HARD` is **rejected** with an error naming both numbers: the global
kill would fire first and the cap would be a lie about what happened.

**Exact child-facing texts** (the only strings the child sees; no numbers in either):

- Wind-down:
  `[Turn limit] This run has reached its turn limit. Commit what is green, leave the rest as a clearly-marked WIP commit, then report: status partial or blocked, naming what is done, what is not, the evidence you have, and what you would do next. You will be stopped shortly if you have not exited. Do not thin tests, skip mutations or skip checks to finish.`
- Stall:
  `[No-progress check] No new commit for a long stretch of turns. Stop and check whether your current approach is working: if it is, carry on; if it is not, change approach or report what is blocking you.`

### Guidance text — exact, three files

**`APPEND_SYSTEM.md`, new paragraph under `## Subagents`:**

**A turn cap is a tripwire, not a finish line.** A dispatch may carry one. Reaching it ends the run with a stop-report, and a capped run lands nothing by itself: its work in progress is input to the next decision, never "done enough". Estimates have no baseline, so treat a cap as a flag that something may need a sanity check, not as a measurement. Do not thin tests, skip mutations, skip checks or shorten a review to fit under it — a stop-report is a successful outcome. Acceptance criteria never depend on turns used. Raising a cap mid-run, or re-dispatching after one, states a one-line reason to whoever set the original.

**`agents/implement.md`, new `### Commits and the turn limit` under "Your input contract"** (no numbers):

Commit at every green step. A green step is any point where the build and the rows you touched pass: make the commit, keep going. Work in progress on your branch is a deliverable, not a mess to hide.
- If the run reaches its turn limit you get one wind-down message. Commit what is green, leave the rest as a clearly-marked WIP commit, and report.
- Report `status: partial` (or `blocked`) naming what is done, what is not, the evidence you have (rows run, mutations, `rg` counts) and what you would do next. That report is the deliverable.
- Never thin a test, skip a mutation, skip a structural check or shorten a review to fit. If the work does not fit the run, say so.

**`agents/orchestrator.md`, new `### Dispatch budgets` under "3. Write work orders and dispatch implementers":**

Set `turn_cap` from the size class, not from a fresh guess: **S** (one file, no E2E rows) 40, **M** (multi-file, targeted rows) 120, **L** (mechanism plus E2E rows) 180. Recalibrate from the ledger's p90 per class as it fills; today's numbers are a handful of data points, not a baseline.
- **Probe first.** When an order's mechanism is unproven, run a short probe before the build run: the smallest dispatch that shows the mechanism works at all. A probe that comes back wrong costs a fraction of the build run it saves.
- **Resume by default after a cap.** Continue the same session with the next step; re-dispatch from scratch only with a stated reason, because a resume keeps the context the cap interrupted.
- Record **planned / cap / actual** turns in the completion report or the work order's stamp. An unmeasured number is worse than none.
- A capped run lands nothing by itself: its WIP is input to the next decision — continue, re-scope, or stop-report to the seat.
- Raising a cap mid-run, or re-dispatching after one, sends the seat a one-line reason.
- Acceptance criteria are independent of turns used. Never lower a bar to fit a cap.

### Scope

**Invariants** (must not change):
- The 450 soft nudge and the 500 hard kill are **unchanged for uncapped runs**; `TURN_NUDGE_SOFT` and
  `MAX_TURNS_HARD` keep their values and their texts.
- `dispatchKillSignals` remains the single kill dispatch. The grace arm calls it; nothing calls
  `proc.kill` directly.
- Reviewers' prompts carry no budget and no cap.
- The child-visible texts above are the only new text the child sees, and they contain no number.

**Files expected to change**: `extensions/lib/subagent-state.ts` (decision function + constants),
`extensions/subagent-async/index.ts` (steer helper, params, event-site wiring, flag plumbing),
`extensions/subagent-async/test-turn-cap.cjs` or `tests/turn-cap.test.ts` (rows — prefer the bun test
suite if the decision function imports cleanly), `APPEND_SYSTEM.md`, `agents/implement.md`,
`agents/orchestrator.md`, `decisions/subagents/046-turn-cap.md` (new), and a supersession note in
`decisions/subagents/002-rpc-soft-turn-limit.md` (its soft-limit sketch is what this implements).

**Out of scope**: recalibrating the class caps from the ledger (a follow-up order); the branch/worktree
housekeeping sweep.

### Prohibitions

1. **No second kill path.** The grace arm calls `dispatchKillSignals(rs, "turn-cap")`. `rg -n 'proc\.kill' extensions/subagent-async/index.ts` must show no new site beyond the existing ones.
2. **The cap number never reaches the child.** Both child-facing texts contain no digits beyond what is
   quoted above; `git grep -n 'TURN_CAP_DEFAULT\|turn_cap'` shows no interpolation into a steer text.
3. **`agents/implement.md` carries no number.** The S/M/L numbers live only in `agents/orchestrator.md`.
4. **No ref-file read, no packed-ref fallback.** One `git rev-parse <branch>` per turn. `rg -n 'refs/heads' extensions/subagent-async/index.ts` → no new site.
5. **No new timer.** The grace is counted in turns; `setTimeout`/`setInterval` count in the file does not grow.
6. **The 450/500 pair is untouched** (see invariants); their rows stay green.
7. **The decision function is pure** — no I/O, no clock, no `process`; the caller supplies every input.
8. **Refactor commit lands green with existing tests unchanged** before the change commit.

### Verification Criteria

```
bun test tests/turn-cap.test.ts            # or node extensions/subagent-async/test-turn-cap.cjs
bun test tests/subagent-id-resolution.test.ts
node extensions/subagent-async/test-progress-kill-timeout.cjs
node extensions/subagent-async/test-resume.cjs
node extensions/subagent-async/test-completion-filter.cjs
bun build --target node --outdir /tmp/wo090 extensions/subagent-async/index.ts
pi -ne -e extensions/subagent-async/index.ts --offline --mode rpc   # smoke: tools register, no throw
```

**Rows — unit** (`decideTurnAction` / `resolveTurnCap`), each named for its state:

| row | state | expected |
|---|---|---|
| U1 | `turns < cap` | `none` |
| U2 | `turns == cap`, not tripped | `wind-down` |
| U3 | `turns == cap + 1`, tripped | `none` (the steer is not repeated) |
| U4 | `turns == cap + 10`, tripped | `kill` |
| U5 | `resolveTurnCap(undefined)` / `(0)` / `(-5)` / `(600)` | `150` / `Infinity` / `Infinity` / throws naming 600 and 500 |
| U6 | `stallTurns == 30`, commit unchanged, not yet steered | `stall-steer` |
| U7 | `stallTurns == 29`; and 40 with the commit changed | `none`; and the counter resets |
| U8 | cap tripped while a stall is pending | `none` — one message per run, the cap's, not two |
| U9 | `cap + grace > MAX_TURNS_HARD` | the hard arm still wins at 500 (its reason, not `turn-cap`) |

**Rows — wiring** (real child dispatch; the orchestrator runs the full set at the gate, the implementer
runs E1 as its smoke):

| row | case | expected |
|---|---|---|
| E1 | capped child crosses the cap | wind-down delivered once, result carries `turn_cap_reached: true` and `turns_used`, `subagent_status` shows the flag |
| E2 | child ignores the wind-down | killed at `cap + 10` via `dispatchKillSignals`, `[Killed via turn-cap]` delivered, session file preserved and resumable |
| E3 | child in a **linked worktree** commits at ~turn 5 | `git rev-parse` sees the new sha, the stall counter resets (the seat's real-case row) |
| E4 | resume after a cap | turns continue from the recorded count, the cap carries over, a second trip flags again |

**Mutations**, each alone, file reverted between:

1. Drop the `capTripped` guard → U3 reds (steer repeats).
2. `>=` → `>` on the cap → U2 reds.
3. Kill at `cap + 9` → U4 reds.
4. Remove the reset-on-commit → U7 reds.
5. Accept `turn_cap > MAX_TURNS_HARD` → U5 reds.
6. Replace the grace arm's `dispatchKillSignals` with `rs.proc?.kill()` → E2 reds (marker missing,
   escape path not taken).
7. Put the cap number into the wind-down text → prohibition 2's grep reds.

A mutation that reds nothing means the row is not pinning what it claims; say so rather than moving the
expectation.

### Cost — measure, do not assert

Per turn this adds one `git rev-parse` spawn (~5 ms by the seat's estimate) against a turn of tens of
seconds, plus one pure function call. Measure both:

- **Per-turn spawn**: time 100 consecutive `git rev-parse <branch>` calls from the harness's own cwd,
  report the mean and the p95.
- **E2E wall time**: one ~60-turn dispatch before and after the change, two runs each, report means and
  spread.

Report the numbers as measured, including if the spawn cost is larger than 5 ms or the E2E delta is
inside the noise. A surprise here is a finding, not a failure.

### Stop reports

- **`PREMISE FALSIFIED`** — `git rev-parse <branch>` cannot see the child's commit from a linked
  worktree, or turn counting does not fire where `:2237` says it does.
- **`PLAN MISMATCH`** — the decision function cannot express a state the event site needs, or the
  steer helper's guards differ between the four call sites in a way one helper cannot carry.
- **`REFACTOR FIRST`** — the 450 nudge block and `subagent_stop` cannot share the steer helper without
  changing either's behaviour.

---

## Gate-back record — 2026-11-07

**Owner 2026-11-07**, on the commit observation: *"async + don't call every turn - every 10 is
probably fine"* → the observation samples every `STALL_SAMPLE_TURNS = 10` turns, is asynchronous, and
its result is folded on a later sample turn. Nothing synchronous remains on `message_end`
(`execFileSync` in the extension: 0).

**Owner 2026-11-07**, the stall bound, twice in one session: *"Amend to 49 (Recommended)"*, superseded
by *"Two intervals, (50) (Recommended)"* — **"A stall is caught at most two sample intervals after N
(worst case 50 commit-free turns at today's settings)."** 49 is unreachable: a commit landing on its
own sample turn misses that turn's `git rev-parse`, so it is first seen one interval later and folded
one after that (30 + 10 + 10). Measured by sweeping every commit turn against the production
`turnCapTurn`: max 50, at every multiple of ten. Both rulings are recorded in
`decisions/subagents/046-turn-cap.md` §Rulings.

**Departures accepted by the owner 2026-11-07**, both recorded in 046: the E3 → E3/E3a/E3b reshape
(narrowed by the orchestrator's dispatch brief, not by an owner record — the record says so), and the
internal test seams beyond this order's API block (`turnCapTurn`, `stallSampleDue`, `nextStallState`,
`CommitRunner`, `StallTracker`), with the block itself stamped under-specified.

**Suite defects the gate caught that the targeted rows could not:** every spawn site in
`tests/turn-cap.test.ts` omitted `env: childEnv()` (the hermeticity inventory row was red), the fake
`pi` lacked `sendUserMessage` so the close path threw in-suite only, and `E3` did real git work with
no explicit timeout, tripping bun's 5 s default under load.

**Not verified live:** `E2` (kill marker at cap+grace) and `E4` (resume carries the cap) — the
provider returned 429 / upstream-overloaded on every attempt across both runs. Their contracts are
pinned hermetically (W2 with its mutation, W5b, W9); the end-to-end marker delivery remains unrun.

**Budget: planned 120 / cap 180 (the first dispatch), then planned 60 / cap 100 (gate-back) /
actual 180 + ~95.** Neither run's cap was enforceable in its own harness — that is what this order
builds.

**Owner 2026-11-08 — E2 deleted.** *"Delete E2 (Recommended)"*. The row asserted a child that ignores
the wind-down is killed at cap + grace; no compliant child does that (the child read the conflict and
obeyed the harness: "the harness ended the run. Report tersely"), and one text-only message ends the run
regardless of intent, so the kill arm is reachable only by a child that emits tool calls on every turn
past the grace. Its cover is W2 plus mutation M6. Same ruling: a failing live row keeps its child
artifacts, a passing row deletes them — `cleanupOnPass()` is each live row's last statement, so a throw
skips it, and `afterEach` skips sids in `keepOnFailure`.

**E2/E4 re-run at `dd168e6`, 2026-11-08:** E4 passes (20 s, 8 expects — resume carries the cap and
re-trips it). E2 deleted by ruling.
