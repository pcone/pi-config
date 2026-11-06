# WO-2026-085 — a checkpoint marker with no pending state panics, naming the state

### Metadata

- **work_order_id**: WO-2026-085
- **parent_plan_id**: review triage 2026-11-06 (review `notes/review-2026-11-06/pi-config.md`, MEDIUM "a checkpoint compaction with a marker and no pending state")
- **sequence_position**: 1 of 1
- **routed_to**: implement (executed by the orchestrator; ~20 turns)
- **invariant_exhaustiveness**: explicit — one arm, one row, one decision note.
- **priority**: normal
- **estimated_complexity**: small
- **review_policy**: skip — one branch replaced by a panic, one row rewritten, self-gated
- **turn_budget**: 20 turns, plus the orchestrator's full-suite gate.

### Q-A1 — ruled 2026-11-06: panic naming the state

**Question.** `extensions/checkpoint.ts:780-790` (`session_before_compact`) stores
`customInstructions.replace(CHECKPOINT_MARKER, "").trim()` as the compaction summary when
`pendingCheckpoint` is null. Decision 005 says the stored summary *is* the authored text followed by a
machine block, and only the pending checkpoint carries the facts that block needs. The state is
documented by no decision, no design doc and no comment beyond "the post-reload case", and
`session_start` clears both `pendingCheckpoint` and `compactRequested` (`:689-690`), so a plain reload
does not reach it. Row I4 of `tests/summary-ownership.test.ts` constructs the state directly and pins
the half-summary as intended.

**Owner ruling, 2026-11-06 (via the planning seat):** "Panic naming the state (Recommended)".

**Shape it settled:** the arm throws. The message names the state and the rule it would break:
a marker compaction with no pending checkpoint, where 005's stored summary would lack its machine
block. Row I4 is rewritten to pin the panic rather than the half-summary; it is the one row that
changes, and the owner ruling is why.

### Task

`extensions/checkpoint.ts`, replace the `if (!pending)` return with a throw naming the state. Rewrite
I4. Add the dated ruling note to `decisions/checkpoint/005-summary-ownership.md`.

### Prohibitions

1. **No other branch of the handler changes.** `git diff` on `checkpoint.ts` is the `!pending` arm
   only; the pending path's composition, the preserved-reads scan and the fileOps scan are untouched.
2. **The message names the state and the broken rule** — a reader who hits it learns what happened
   without this order: a marker compaction with no pending checkpoint, whose stored summary would lack
   the machine block decision 005 requires.
3. **Two test rows change, not one — this prohibition was wrong and is corrected here.** I4 pinned the
   half-summary and is rewritten; I2's yielding loop also dispatched marker shapes with nothing armed,
   so it saw the panic the ruling creates and now calls `queueCheckpoint` first (its subject — the fleet
   seat is bypassed — is unchanged, and its mutation now fails if the arming is removed). The blast
   radius of "this arm has two dependants" was not enumerated when the order was written; the ruling
   made the second one visible. Every other row in `tests/summary-ownership.test.ts` and in the
   four other `session_before_compact` suites passes unchanged.
4. **The fleet-bearing paths still yield**: a marker with a *pending* checkpoint composes text plus
   block; a non-marker instruction still goes to the fleet seat. `rg -n 'CHECKPOINT_MARKER' tests/summary-ownership.test.ts` rows I2/I3 stay green.
5. **005 carries the ruling**, in the record's own style, dated and attributed — a decision that shapes
   the design may not live only in this order.
