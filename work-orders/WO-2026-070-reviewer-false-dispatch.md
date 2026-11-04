# WO-2026-070 — a reviewer spawn must not write a work-order dispatch

### Metadata

- **work_order_id**: WO-2026-070
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit
- **estimated_complexity**: small
- **review_policy**: required

### Task Summary

A `subagent` spawn carrying `workOrderPath` writes a `dispatch` entry into the work order's
record. Reviewer spawns carry it too — `agents/implement.md` tells the implementer to "give the
work order's path", and implementers pass it as `workOrderPath` — so each reviewer writes a
second `dispatch` row naming **its own** session as implementer and the review prompt as task.
Two such false rows landed in a tfd record (`docs/reviews/` there), which is the evidence.

Make the record written by the spawn that owns the order, and by no other.

### Premise — verify before editing

- `extensions/subagent-async/index.ts:3955-3958` calls `openWorkRecord(cwd, params.workOrderPath,
  sessionId, params.task)` for **any** spawn with `workOrderPath`; `openWorkRecord` is at
  `:1399`. Reproduce first, in a fixture repo with a `wo_record.py` stub or the real script if it
  is reachable: one implementer spawn with `workOrderPath` whose brief makes it spawn one
  reviewer with `workOrderPath` produces **two** `dispatch` entries. Paste the record excerpt in
  the report. If it produces one, stop with `PREMISE FALSIFIED`.
- `agent.reviewerKind` is parsed from a reviewer's frontmatter (`reviewer_kind:` in
  `agents/review-code.md`, `agents/review-tests.md`, `agents/review-plan.md`) and is already used
  to skip the isolation default (`:3902`) and to write the reviewer tracker (`:3997`).

### Mechanism

**Ownership is a property of the spawned agent, not of the spawn call.** A reviewer never owns a
work order: its job is to review one. So:

1. `openWorkRecord` is called only when the spawn owns the order — `agent.reviewerKind` is
   undefined. A reviewer spawn carrying `workOrderPath` reads the order from its task text, as
   `agents/implement.md` already says to quote it, and writes no record. Log the skip under
   `PI_ASYNC_DEBUG`; do not warn, since the reviewer's spawn is the implementer's to get right,
   not the reviewer's.
2. `agents/implement.md` step 4 states the rule where the mistake is made: give the work order's
   path **in the reviewer's task text**, never as `workOrderPath` — a reviewer spawn that sets it
   would be recorded as its own dispatch.

Do **not** gate on spawn depth: a nested orchestrator at depth 1 legitimately dispatches
implementers that own their orders (decision 028). Do not gate on agent names; the frontmatter
field exists for this.

### Preparatory refactor

`none` — the gate is one condition at one call site, and the prompt line is one sentence.

### Acceptance rows

Each new row must fail on today's tree, run alone. State the mutation that reddens it.

1. **A reviewer spawn with `workOrderPath` writes no record.** Fixture: implementer spawn with
   `workOrderPath`, brief instructs one reviewer spawn with the same `workOrderPath`. Assert the
   record holds exactly one `dispatch` and its `--implementer` is the implementer's session id.
   Red today: two dispatches.
2. **Every reviewer agent in `agents/` is covered, not just the two that exist today.** Iterate
   the agents whose frontmatter declares `reviewer_kind` and assert the same for each (with a row
   that fails if the iteration finds fewer than 3, so a deleted frontmatter field cannot make the
   loop vacuous).
3. **An implementer spawn still writes exactly one dispatch, with its own session id and the
   order's blob.** Control row; green today; must stay green.
4. **A reviewer spawn without `workOrderPath` is unchanged** — no record, no note, no error.
5. **The prompt rule exists and is not vacuous**: `agents/implement.md` states that the reviewer's
   task carries the path and that `workOrderPath` is not passed to a reviewer spawn. Assert on
   the sentence's presence, and note in the report that a text row is a lower bound.

### Prohibitions

- No edit to `scripts/wo_record.py` or anything under `docs/reviews/` — that is tfd's repo. If the
  fixture needs a stub, build it in the test.
- No change to what a **record** contains: same columns, same ordering, same `wo_blob` source.
- No agent-name lists, no depth gating, no new config key or flag.
- `completeWorkRecord`'s reviewer-round recording (`:2559`) is out of scope: only the false
  `dispatch` write is.

### Docs to update

- `decisions/work-order-records/001` — states who writes a dispatch, and why a reviewer never does.
- `agents/implement.md` step 4 — the one sentence above.
- `README.md`, `docs/TODO.md` — only if they describe the record's writers.

### Review

Hard cap 3 rounds. Gate at the tip: re-run the five rows, and mutate your own gate (drop the
`reviewerKind` condition) to show row 1 and the iteration row go red.

---

### Landing stamp (2026-11-04, merged `d31204e`)

Reproduced first: two `dispatch` rows in the fixture record, the second naming the reviewer's
own session with the review prompt as body. Landed `562b749` + `2a0d520` — the gate
(`agent.reviewerKind` undefined), one sentence in `agents/implement.md` step 4, and six rows.
Three files, +293/−6.

**Two items the implementer raised as owner questions are mine to settle, and neither is one.**

- **The row-2 bound.** This order's premise claimed `reviewer_kind:` appears in
  `review-code.md`, `review-tests.md` **and** `review-plan.md`, and set the census guard at
  "fewer than 3". One `rg -c 'reviewer_kind' agents/*.md` falsifies it: two agents declare it, and
  `review-plan.md` never has. The bound was a count measurement, not a ruling, so it is a
  process-only count correction at the tip — the guard landed as a **kind census** (fails when a
  declared kind disappears or a third appears), which is the stronger shape anyway. Recorded here
  rather than escalated.
- **`decisions/work-order-records/001` is tfd's file**, not this repo's; this order named it in
  "Docs to update", which was my error. The record-design edit belongs in `~/Developer/tfd` and is
  split out, not dropped.

**Carried, with its carrier named:** `review-plan` declares no `reviewer_kind`, so a
`review-plan` spawn carrying `workOrderPath` would still write a false dispatch — latent today
because nothing instructs passing the path to a plan reviewer. The gate covers the set that
declares a kind, and that set can grow without the gate noticing, so
`work-orders/WO-2026-074-reviewers-declare-a-kind.md` carries the fix. The docstring at the gate
says so.

**Gate, re-run by me at the merged tip:** six rows 6/0; my own mutation (`const isReviewer =
false`) reds row 1 and the kind-census row; restored, `work-record-ownership` +
`work-record-capture` = 21 rows / 0 fail. Target set with the adjacent policy files: 51 rows, 0
fail. The full suite's reds are the standing live-credit set plus pcone/pi-config#15
(`subagent-model-inheritance` `sessionFile === undefined`), both present before this landing.
