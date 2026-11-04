# WO-drift-decision-record — decision record for the `9925257` removals (restated 2026-11-04)

**Status: LANDED 2026-11-05** (`decisions/checkpoint/006-9925257-removals.md`).

Restated by WO-2026-071 (`docs/investigations/pi-1.4-compaction-override-2026-11.md` §8). Two of
the three surfaces this draft originally carried are already fixed in `main`, so they leave scope:

- `README.md` now documents the two real tools (`checkpoint`, `checkpoint_fork`) with their actual
  parameters and states that a fork writes nothing to the old session (`README.md:67-69`).
- The `checkpoint_search` references are gone from `README.md` and `agents/` — probe:
  `rg -n checkpoint_search README.md agents/` → 0 hits. It survives only in the sanity-check
  investigation, as history.

What remains, and nothing else: the missing decision record for what `9925257` removed.

### Metadata

- **work_order_id**: assigned at dispatch (slug: drift-decision-record)
- **parent_plan_id**: checkpoint sanity-check §6 item 3
- **sequence_position**: last remaining item of that plan (its sibling drafts were retired by
  `decisions/checkpoint/004`)
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit
- **priority**: low
- **estimated_complexity**: trivial
- **review_policy**: skip — documentation-only (one decision record); no code, no tests, no doc
  surface outside `decisions/`

### Task Summary

**One-sentence description**: Record `9925257`'s feature removals as a decision record with
per-item dispositions.

**Goal**: `decisions/checkpoint/` gains the record; each removed feature is marked
`[RECORDED INTENTIONAL]` or `[RESTORE PENDING → <order>]` per the ruling.

### Premise

`9925257` (2026-07-10, stash recovery) removed `doCheckpoint`, `checkpoint-continue`/`-stop`,
`isAbnormalStop`, and the context strip that existed in `4611f42`, with no decision record
(sanity-check §5.8). Probes: `git show 4611f42 -- extensions/` exhibits them; `git show 9925257`
removes them; `rg -l 9925257 decisions/` → 0. If either fails, stop with `PREMISE FALSIFIED`.

### Preparatory refactor

**none** — documentation-only.

### Rulings

- **Q4 answered (owner, 2026-11-05, via the planning seat): "Record as intended".** No feature is
  restored. The record states "rebuilt, not restored" for the three capabilities `main` re-wrote
  after the removal, and keeps the `isAbnormalStop` crash-resume gap open as its own item.

### Scope

**Invariants**: no code or test changes; every claim cites a commit or doc section; the record
must not claim any restore happened; a superseded claim keeps its original text with a dated
note, not a rewrite.

**Files expected to change**:
- `decisions/checkpoint/006-9925257-removals.md` (next free number at dispatch — `005` went to
  the summary-ownership ruling on 2026-11-04, so re-read the directory before writing) — the
  drift record: what `9925257` was, what
  it removed (with `4611f42` as before-evidence), why no record existed at the time, the
  disposition table, and forward links to any restore orders.
- `decisions/checkpoint/README.md` — the index row.

**Files NOT to modify**: all code and tests; `README.md` and `agents/` (their drift is fixed);
`work-orders/WO-2026-031.md` (frozen history — its stale reference stays).

**Out of scope**: restoring any removed feature (a restore is a follow-up order allocated by the
ruling); removing the dead `StrippedAssistant` type (`extensions/checkpoint.ts` — code; park it as
a named follow-up inside the record).

### Implementation Specification

1. Write the record in `decisions/checkpoint/`'s existing format.
2. The disposition table lists the four removals; undecided items are `[RESTORE PENDING →
   unallocated]`, never dropped and never marked intentional without the ruling.
3. Verification: `rg -n "doCheckpoint|isAbnormalStop|checkpoint-continue|checkpoint-stop" decisions/checkpoint/` finds the new record; `git show 9925257 --stat` supports each claim.

### Verification Criteria

**Tests that must pass**: the full suite, unchanged (`env -u PI_SUBAGENT_ALLOWLIST -u
PI_SUBAGENT_DEPTH -u PI_IS_SUBAGENT bun test`) — docs-only, so the outcome must equal the base.

### Structural Risks

- [ ] **No unrequested changes**: one record plus one index row
- [ ] **Build config untouched**
- [ ] **No unsolicited features**: no code, including the dead type
- [ ] **No parallel path**: n/a (docs)

### Context

**Prior work orders**: WO-2026-055 (injection un-broken; README and `checkpoint_search` drift
cleaned), WO-2026-056 (fixed summary schema).

**Relevant decisions**: `decisions/checkpoint/004` (this plan's draft retirements);
sanity-check §5.8 (the drift inventory).

### Completion Report Format

Standard schema; `review_policy: skip`, so no review rounds. Include `deviations_from_spec` and
`notes_for_orchestrator` regardless.

---

### Landing stamp (2026-11-05)

**Landed by the orchestrator**, docs-only: `decisions/checkpoint/006-9925257-removals.md`, its index
row, this order's Q4 ruling, and the sanity check's Q4 status. `review_policy: skip` applied — no
code, no tests, no surface outside `decisions/` and retrievals of existing citations.

**One premise of this order is wrong and is corrected in the record.** §5.8 lists `isAbnormalStop`
among the features `9925257` removed; `git grep isAbnormalStop 9925257^` and `… 9925257` both return
nothing, and `git log -S'function isAbnormalStop'` names `1812a84` as the remover — the
stash-isolation commit that `9925257`'s own message identifies. So `1812a84`, not `9925257`, dropped
it, four months earlier. That does not change the disposition (the owner ruled record-as-intended for
all four) but it does change the story the record tells, which is the point of a drift record.

**Verification:** `rg -n "doCheckpoint|isAbnormalStop|checkpoint-continue|checkpoint-stop" decisions/checkpoint/`
finds the new record; no code or test file changed (`git diff --name-only` = 4 files, all docs).
Full suite at the tip equals the base red set.
