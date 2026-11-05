# WO-2026-078 — a child's abnormal terminal turn is delivered labelled, not silently as success

**Status: DISPATCHED (2026-11-05). Q-A1 ruled: mechanism A, classify and mark.**

### Metadata

- **work_order_id**: WO-2026-078
- **parent_plan_id**: planning-seat queue 2026-11-05 (item 3; opens the gap `decisions/checkpoint/006` left)
- **sequence_position**: 1 of 1
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit
- **priority**: normal
- **estimated_complexity**: moderate
- **review_policy**: required

### Task Summary

**Goal**: a subagent whose final assistant turn ended abnormally — `length`, `error`, `aborted`,
`pending`, `deferred`, or no reason at all — stops being indistinguishable from one that finished its
work, in the delivered message, the log footer, and the state read back from disk.

### Premise

The completion detector decides "done" from content shape alone:

```
extensions/subagent-async/index.ts:2338-2344  → if (!hasToolCalls && hasText) rs.isDone = true
```

`rs.messages` already holds the same message with its `stopReason` (`:2283`), and the terminal
`agent_end` event reaches the parent unmodified (`dist/modes/json-event.js`, `rpc-mode.js:266`) with no
branch (`rg -n 'agent_end|agent_settled' extensions/subagent-async/` → 0).

Probe: `rg -c 'stopReason' extensions/subagent-async/` → **0**. A hit means someone already classifies
and the premise is old.

Second half of the premise, which the loose version of this claim gets wrong: process-level kills are
visible today (exit code, `killedMarker`), and the disk classifier separates `Stopped`/`Killed` from
`Completed` (`extensions/lib/subagent-state.ts:243-268`). The loss is **turn-level**: an abnormal stop
that still produced text sets `isDone`, the parent closes stdin, pi exits 0, the footer says
`Completed`, the prefix is `[Subagent X finished]`, and `readSubagentState` says `complete`.
Independent second loss: the recovery path keeps the footer's turn count and discards its word and
exit code, then delivers with a hardcoded exit 0 (`index.ts:3382`, `:3393`).

### Q-A1 — ruled 2026-11-05: done, but labelled (mechanism A)

**Owner ruling (2026-11-05, via the planning seat): "Done, but labelled (Recommended)."** A final turn
whose `stopReason` is `length`/`error`/`aborted` is **delivered, classified and visibly marked** in the
result and the footer, so an orchestrator can see it and decide. **Rejected: gating completion** — no
truncated turn is refused as done, so a provider failure never stalls a child waiting for a retry path
that does not exist.

**The recovery path: in this order, because the labelled outcome needs it.** The ruling said to include
it "only if the labelled outcome needs it". It does: a recovered child has no terminal message to read,
so the footer word **is** its only classification input, and the path currently keeps the footer's turn
count while discarding its word and forcing exit 0 (`index.ts:3382`, `:3393`). Leaving it means a
recovered `Stopped (7 turns, exit 143)` child is delivered as finished — the same defect this order
fixes for live children, on the one path where the marker has nowhere else to come from. It stays
narrow: read the word and exit code the footer already carries, map them through the same union, deliver
the same prefix. No new vocabulary, no second mechanism.

**Design, fixed by the ruling:** one pure classifier reads the terminal assistant message's `stopReason`
plus `killedExplicitly` and the exit code, returning a small union (`finished | errored | overflowed |
aborted | killed`). It is called from the two places that already own the words — `deliverResult`'s
prefix (`:3142`) and the footer computation (`:2520`) — and the on-disk vocabulary is extended rather
than paralleled (`subagent-state.ts:243-268`). The child still ends and still delivers.

**Rejected alternatives (owner, 2026-11-05):** gating completion — reading `stopReason` in the
detector and refusing `rs.isDone`, steering the child to retry or report `blocked`/`partial` (the shape
the review gate and `owner_asks` gate use at `:2385-2430`). Not this order. It would also need a
retry-on-error path in the child, which does not exist.

### Rulings

- [`decisions/checkpoint/006`](../../pi-config/decisions/checkpoint/006-9925257-removals.md) (owner
  2026-11-05, "record as intended"): the `9925257` removals stay removed and are **not** restored.
  This order re-derives the classification against the current result shape; it does not restore
  `isAbnormalStop`.
- Author's choice: one classifier feeding both words, rather than reading `stopReason` at each site.
  This is what makes the rule hold on every path by structure instead of by enumerating paths.

**Rejected alternatives**: restoring `isAbnormalStop` verbatim — it reads a shape that no longer
exists and would classify nothing (`isAbnormalStop` lives only in `extensions/subagent/_index.ts.off`,
which is not loaded).

### Scope

**Invariants**:

- Normal completions are untouched: `stopReason: "stop"` with text still delivers `[Subagent X
  finished]`, the same footer, and `complete` from `readSubagentState`.
- `killedExplicitly` / `killedMarker` and its strings are untouched
  (`:3101-3109`; [`decisions/subagents/015`](../../pi-config/decisions/subagents/015-progress-kill-timeout.md) and
  [`043`](../../pi-config/decisions/subagents/043-owner-state-and-checkpoint-recoverability.md)).
- The `resolveOnStop` vs `deliverResult` mutual exclusion (`deliverCloseResult`, `:3122-3140`) is
  untouched.
- The review gate and `owner_asks` gate steer paths (`:2385-2430`) are untouched.
- The delivered message layout for a normal completion is byte-identical.
- The work-order record format (`wo_record.py`) is untouched.

**Files expected to change**: `extensions/subagent-async/index.ts` (classifier + the two word sites +
recovery), `extensions/lib/subagent-state.ts` (vocabulary extension), and one test file.

**Files NOT to modify**: `extensions/subagent/_index.ts.off` (dead reference copy — measure against it,
never edit it), `extensions/checkpoint.ts`, `extensions/peer-link/`, `decisions/checkpoint/006`.

**Out of scope**: retry-on-error inside a child (a prerequisite for the rejected gate, not for this
order), the planned `timeout` stop reason in [`decisions/subagents/001`](../../pi-config/decisions/subagents/001-progress-timeout.md)
(match its vocabulary when it lands; do not invent a second word), `subagent_stop`'s `[Aborted]` text at
`:4544` (it means something different — do not reuse its vocabulary).

### Prohibitions

- **No second vocabulary for the same idea.** The footer, the delivered prefix and
  `readSubagentState` must agree; a new word in one and not the others is the defect being fixed.
  Check: one row per word asserting all three sites.
- **No over-flagging.** A normal finish must not acquire an error word; the characterisation row pins
  it and passes before and after.
- **No restore.** `rg -n 'isAbnormalStop' extensions/*.ts extensions/subagent-async/` → 0 (the string
  survives only in `_index.ts.off` and in prose).
- **No unproven fallback.** An unknown or missing `stopReason` gets the meaning the design gives it,
  not "assume success". If the design does not say, stop and report.

### Behavior matrix

| row | case | assert | red under |
|---|---|---|---|
| N1 | `stopReason: "length"` with text | prefix is not `finished`; footer word and `readSubagentState` agree | drop the classifier |
| N2 | `stopReason: "error"` with non-empty text | as N1, and the delivered text is still the child's own | classify `error` as finished |
| N3 | `stopReason: "aborted"` while the process exits 0 via the parent's `stdin.end()` | as N1 (today `wasAborted` keys on exit code only) | key `aborted` on exit code |
| N4 | recovery: log footer `Stopped (N turns, exit 143)` | delivered prefix is not `finished`; the footer's word and exit code are not discarded | the hardcoded `deliverResult(pi, rs, 0, …)` at `:3393` |
| N4b | recovery: log footer `Completed (N turns, exit 0)` | still `finished` — the recovery path must not flag a normal child | flag everything on the recovery path |
| N5 | `stopReason: "stop"` with text only | `[Subagent X finished]`, `complete` — characterisation, green before and after | any over-broad classifier |
| N6 | `stopReason: "length"` with no text | today it is not `isDone` at all, so the watchdog/silence path owns it. Assert whichever end the implementation reaches, and say in the report which — this row documents a boundary, it is not a pinning row | — |

### Verification Criteria

- New file rows N1–N6, each red under its named mutation run alone (`bun test <file> -t '<row>'`), the
  file `cmp`-clean afterwards; N5 is the characterisation guard and is not counted as a pinning row.
- `bun test tests/subagent-async*.test.ts tests/subagent-state.test.ts` green; existing rows unedited.
  A row that must change means behaviour changed — stop and report.
- Full suite: the standing red set (credit rows, peer-link HTTP 402, the hermeticity cascade) is
  unchanged row-for-row; compare against the base commit's run, do not report the set as yours.
- No `tsc` in this repo: `bun build` on the extension plus a `pi` load smoke test.

### Context

Opens the gap recorded in `decisions/checkpoint/006` under "The open item". Its three factual
corrections and the scoping above (turn-level, not process-level; plus the recovery path) are the
order's starting facts — the record, not this draft, is the citation.

---

## Report on completion

Every completion report and landing for this order goes to `claude-8f90746f-e9aa-4dab-81ef-eb303ba0cb65`
by peer message. State commit hashes, not "landed".
