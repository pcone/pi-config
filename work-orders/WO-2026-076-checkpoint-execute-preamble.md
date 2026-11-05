# WO-2026-076 — extract the two `checkpoint` tool `execute` preambles into one helper

### Metadata

- **work_order_id**: WO-2026-076
- **parent_plan_id**: planning-seat queue 2026-11-05 (structure-trend register, `extensions/checkpoint.ts` growth)
- **sequence_position**: 1 of 1
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit
- **priority**: normal
- **estimated_complexity**: moderate
- **review_policy**: required

### Task Summary

**One-sentence description**: Fold the duplicated validation → owner verdict → continuation → in-flight → git-capture preamble in `checkpoint`'s and `checkpoint_fork`'s `execute` bodies into one helper, with no change to either tool's result.

**Goal**: `extensions/checkpoint.ts` holds one implementation of the preamble instead of two, pinned by rows that fail if the two tools' shared behaviour diverges.

### Premise

The two `execute` bodies share a sequence — `validateSummaryFields`, `checkOwnerState`, `next`/`waits`/`continuation`/`relevantPaths`/`contextWindow`/`summaryFields`, `captureGitBinding` + `tokensBefore`, `listInFlightSubagents`, `composeSummary` — and differ only in three facts: the refusal verb ("compacted" vs "staged"), the fork's target-directory check inserted between validation and the owner verdict, and the cwd the git binding is captured from.

Probe: `rg -c -F 'validateSummaryFields(params.summary)' extensions/checkpoint.ts` → 2, and the same for each other element of the sequence (all 2). A count of 1, or a fourth difference found in the bodies, falsifies the premise — stop and report, since the extraction then has a contract this order does not describe.

Second probe, the coverage half: `rg -n 'archived or compacted|archived or staged' tests/` → **0**. The differing behaviour is unpinned today, so the characterization rows are step 0, not an optional extra.

### Preparatory refactor

This order **is** the refactor; there is no subsequent change. So it lands as two commits:

1. **Characterization rows, no production change.** Green at the parent commit. Rows C1–C6 below.
2. **The extraction.** Rows unchanged and green — an existing or new row that must change means behaviour changed, so stop and report it.

The rows in commit 1 are what make commit 2 reviewable: without them "same behaviour, different shape" is unverifiable.

### Rulings

- [`decisions/subagents/040`](../../pi-config/decisions/subagents/040-refactor-first.md) (repo convention, not an owner ruling): make the change easy, then make the easy change, behind characterization tests.
- [`decisions/subagents/024`](../../pi-config/decisions/subagents/024-structural-growth-checks.md) (repo convention): growth findings are strikes on the area, and a strike names the extraction that closes it.
- Register row in `docs/investigations/structure-trend.md` under `extensions/checkpoint.ts` growth: one open strike (WO-2026-073), whose named refactor is "the two `execute` preambles into one helper". The 2026-10-21 strike was resolved by WO-2026-057 and is spent, so this order **closes docket item 2 of the planning seat's queue**, not a second strike.
- Author's choice: a callback parameter for the fork's target-directory check rather than an inline branch inside the helper. The check is fork-specific and must keep its place between validation and the owner verdict.

**Rejected alternatives**: none recorded.

### Scope

**Invariants** (what must not change):

- **Both tools' returned text is byte-identical.** Every `responseLines` entry, its order, and its blank-line joining. The refusal text ("summary rejected — nothing was archived or compacted." / "…archived or staged.") keeps its verb per tool.
- **`pendingCheckpoint` keeps its exact shape.** `{ summary, next, continuation, waits, tokens, git, archivePath, cwd, contextWindow }` — no field added, renamed, reordered, or dropped. `session_before_compact` reads it.
- **Order of side effects inside each `execute`.** For `checkpoint`: validation → owner verdict → git capture → in-flight → archive. For `checkpoint_fork`: validation → target-directory check → owner verdict → git capture → in-flight → injection. A rejection must still write nothing and archive nothing.
- **The notify calls stay where they are**, with the same level and text (`safeNotify(ctx, ownerState.warning, "warning")`).
- **No new public surface**: no new tool, no new config key, no exported helper.

**Files expected to change**:

- `extensions/checkpoint.ts` — one module-private `prepareCheckpoint(...)` (name your own if a better one fits the file's vocabulary) plus both `execute` bodies reduced to "call it, then do the tool-specific half".
- `tests/checkpoint-preamble.test.ts` — new file for rows C1–C6, **or** C1–C6 appended to `tests/e2e-checkpoint.test.ts` if the existing harness there already covers both tools. One file, not two.

**Files to read (reference only, do not modify)**:

- `extensions/lib/checkpoint-summary.ts` — `composeSummary`, `renderSummary`, `formatInFlightSection`; the helper composes, it does not change composition.
- `extensions/lib/checkpoint-meta.ts` — `captureGitBinding`, `tokensBefore`.
- `tests/checkpoint-waits.test.ts` — the `fork()` helper (drives `h.tools.get("checkpoint_fork").execute(...)` then `/go`); the reference shape for driving a tool through the harness.

**Files NOT to modify**:

- `extensions/lib/checkpoint-summary.ts`, `extensions/lib/checkpoint-meta.ts`, `extensions/lib/waits.ts` — the extraction is a call-site change; a helper there would be a second home for the sequence.
- `extensions/compaction-model.ts` and `extensions/subagent-async/` — untouched by this order; a diff in either means the extraction leaked.
- `decisions/checkpoint/{005,006}` — WO-2026-073's ruling and Q4's record are frozen; if the extraction appears to contradict them, stop and report.

**Out of scope**: the compaction hook's own `composeSummary` site (the `session_before_compact` path reads `pendingCheckpoint` and composes differently — leave it), the `[CHECKPOINT]` marker, the summary field schema, `auto-checkpoint.ts`.

### Prohibitions

Each check is what the completion report must show at the tip.

- **No change to either tool's response text** — rows C1/C2 (below) assert the full text of a success and a refusal for both tools; `git diff` shows no string literal moved into a variable with a changed value.
- **No new exported symbol** — `rg -n '^export' extensions/checkpoint.ts` count unchanged from the parent commit (state the number before and after).
- **No second copy of the sequence** — after the extraction, `rg -c -F 'validateSummaryFields(params.summary)' extensions/checkpoint.ts` → 1, and likewise for `checkOwnerState(params.nextSteps`, `resolveContinuation(params.continue`, `listInFlightSubagents({`. A count of 2 is a failed extraction, however the code is arranged.
- **No default verb** — the helper must not default `refusalVerb` or a "target check" to a no-op. Both parameters are required; a missing one is a compile error, not a silently different tool.
- **No behaviour on a state the design does not describe** — do not add a fallback arm for "neither verb". There are two tools; the helper takes the verb it is given.

### Implementation Specification

**Detailed requirements**:

1. Add one module-private async helper that, given `(params, ctx, options)`, performs: `validateSummaryFields` → optional fork target-directory check → `checkOwnerState` (+ warning notify) → derive `next`, `waits`, `continuation`, `relevantPaths`, `contextWindow`, `summaryFields` → `captureGitBinding` → `tokensBefore` → `listInFlightSubagents` → `composeSummary`. It returns either the prepared values or the tool-error result, discriminated by a field, not by `null`/`undefined`.
2. `options` carries exactly what the two sites differ in: the refusal verb, the cwd for git capture (or the ctx the caller already has, if the two are the same), and the fork's target check. Everything the two sites share is not an option.
3. Rewrite both `execute` bodies to: call the helper, return on the error arm, then run the tool-specific half unchanged (stash + respond for `checkpoint`; build injection, `setPendingGo`, respond for `checkpoint_fork`).
4. Add rows C1–C6 (commit 1, before any production change).

**Required test boundary**: the registered tools, driven through the harness —
`h.tools.get("checkpoint").execute(...)` and `h.tools.get("checkpoint_fork").execute(...)` as `tests/e2e-checkpoint.test.ts` and `tests/checkpoint-waits.test.ts` already do. Not the new helper: a row that calls `prepareCheckpoint` directly pins nothing about the tools' behaviour.

**Behavior and failure matrix** (rows C1–C6; each must fail without the extraction only where marked — C1–C4 exist to pin what the extraction must preserve, so their evidence is "green before, green after", and they are red under the *mutation* named):

| row | case | assert | mutation that reds it |
|---|---|---|---|
| C1 | `checkpoint` success result | exact joined text: "Checkpoint queued.", archive path lines, in-flight line, `Next: …`, wait description | swap the refusal verb into the success path |
| C2 | `checkpoint` invalid summary | exact text starts "summary rejected — nothing was archived or compacted."; nothing archived (no archive dir written) | change the verb to "staged" |
| C3 | `checkpoint_fork` invalid summary | exact text starts "summary rejected — nothing was archived or staged." | change the verb to "compacted" |
| C4 | `checkpoint_fork` target directory missing, summary also invalid | the **summary** refusal wins — arg shape is checked first, `newCwd` is not `stat`ed | reorder: target check before validation |
| C5 | in-flight section, both tools | one live in-flight entry appears in `pendingCheckpoint.summary` (checkpoint) and in the fork's archived summary, with the same formatting | drop `formatInFlightSection` from one path |
| C6 | owner-verdict warning, both tools | the warning notify fires **and** the tool still succeeds (the verdict does not short-circuit a warning) | return on `ownerState.warning` |

Add one more row if, while writing them, you find a shared behaviour the table does not name — and list it in the completion report.

**Representation-level checks**: `pendingCheckpoint`'s key set, asserted as `Object.keys(...).sort()` equality in C1, so a field added or renamed by the extraction is caught.

**Integration contract**: `pendingCheckpoint` → `session_before_compact` → `compact()` unchanged; `setPendingGo` → `/go` unchanged; the fork's `switchSession` path unchanged (rows in `tests/checkpoint-waits.test.ts` cover it — they must stay green with no edit).

**Reference patterns**: the two preamble halves as they stand are the body to fold; `tests/checkpoint-waits.test.ts:284` (`fork()`) and `tests/e2e-checkpoint.test.ts`'s `runCheckpoint` are the existing harness shapes to reuse rather than reinvent.

### Invariants

**Cross-file conventions**:
- One home per idea: the sequence lives in `checkpoint.ts`, not in `lib/` (a `lib/` helper would be a second home for tool preparation).
- Tool error results go through the existing `toolError(...)` helper; do not build a result object by hand.
- Notifies go through `safeNotify` with an explicit level.

**Default values to preserve**:
- `params.nextSteps ?? "Continue work"`, `params.relevantPaths ?? []`, `ctx.model?.contextWindow ?? 200_000` — unchanged values and unchanged sites.
- `tokens.after` stays `null` at prepare time; the compaction hook fills it.

**Ordering assumptions**:
- validation → (fork target check) → owner verdict → git capture → in-flight → archive/stash.
- `listInFlightSubagents` runs after the owner verdict, so a rejected call never lists in-flight children.

**Error handling conventions**:
- The archive failure stays a `safeNotify` warning that lets compaction continue.
- Neither tool ever throws to the caller for an expected rejection; both return `toolError`.

### Verification Criteria

**Entry points that must work**: both tools register and their `execute` returns the same shaped result as at the parent commit, driven through the harness.

**Input shapes that must be accepted**: `nextSteps` omitted, `relevantPaths` omitted, `continue: false`, a summary with an owner-question verdict, and `checkpoint_fork` with a valid `newCwd`.

**Tests that must pass** — full files, no skips, at both commits:
- `bun test tests/checkpoint-preamble.test.ts` (or the extended `e2e-checkpoint` file) — C1–C6.
- `bun test tests/e2e-checkpoint.test.ts tests/checkpoint-waits.test.ts tests/checkpoint-recoverability.test.ts tests/summary-ownership.test.ts` — green, **existing rows unedited**. A row that must change means behaviour changed: stop, report `PREMISE FALSIFIED` with the row and the diff.
- No typecheck step exists in this repo (no `tsc`); verify with `bun build` on the extension plus a `pi` load smoke test, and say which you ran.

**Test surface requirements**: rows drive the registered tools through the harness. Helper-level unit tests may supplement, never replace.

### Structural Risks

- [ ] **Route/path correctness**: the helper is called from both `execute` bodies, at the same point each one had the sequence inline.
- [ ] **Input validation scope**: no tool rejects an input it accepted at the parent commit; the field schema is untouched.
- [ ] **Test surface**: rows use `h.tools.get(...).execute(...)`, not `prepareCheckpoint` directly.
- [ ] **Recovery logic**: a rejection still writes nothing; an archive failure still lets compaction continue.
- [ ] **No unrequested changes**: no second file grows, no string reworded, no comment rewritten beyond what the extraction needs.
- [ ] **Build config untouched**: no `package.json`, `tsconfig`, or test config edit.
- [ ] **No unsolicited features**: no option the two sites do not both need.
- [ ] **No parallel path**: `rg` for the sequence returning 2 anywhere is this order failing its own premise.

### Context

**Prior work orders completed in this plan**:
1. WO-2026-073 — summary ownership: the fleet `compaction-model.ts` yielded on `[CHECKPOINT]` before any fleet call; `checkpoint.ts` 994 → 1150. This order is the refactor that landing's growth strike named.
2. WO-2026-075 — the fleet call forwards filtered `auth.headers` and `auth.env`. Untouched here.
3. WO-2026-074 — reviewers declare a kind. Untouched here.

**Upcoming work orders**: none scheduled in this area. If the extraction finds the compaction hook's compose site is a third copy of the sequence, report it rather than folding it here — the hook reads `pendingCheckpoint`, not params, so it is a different contract.

### Completion Report Format

The standard schema. For this order specifically:

- `tests` — each row's red-turning mutation, run alone (`bun test <file> -t '<row>'`), with the output showing `N pass / M fail` and the file `cmp`-clean after restore.
- `structural_checks` — each Prohibition above with its `rg` output at the tip, including the before/after counts for the `export` and sequence greps.
- `notes_for_orchestrator` — the row count, the helper's signature, and anything the matrix missed.

---

## Report on completion

Every completion report and landing for this order goes to `claude-8f90746f-e9aa-4dab-81ef-eb303ba0cb65` by peer message (external peer; it is read when its owner next prompts). State commit hashes, not "landed".

---

### Landing stamp (2026-11-05, merged `0ce2454`, gate commit `0c8f`-series)

**Landed.** The five duplicated steps — validate, owner verdict, continuation, git binding, in-flight —
live in one `prepareCheckpoint` helper; each tool keeps the half that differs. 1150 → 1231 lines in
`extensions/checkpoint.ts`, per-element duplication 2 → 1 (every cited `rg` → 1).

**Two commits, as the order's Preparatory refactor required:** `a633dcc` (seven characterisation rows,
no production change — `git show --stat` shows the test file only), `e14e145` (the extraction, rows
unedited). The order's step 2 evidence is that the seven rows were green against the un-extracted file
too.

**Gate, run by me at the merged tip:** `checkpoint-preamble` 7/0, `checkpoint-waits` +
`checkpoint-meta` + `checkpoint-stale-ctx` 43/0 combined, `summary-ownership` 21/0, `auto-checkpoint`
31/0, `checkpoint-recoverability` 19/0. **Two mutations of mine red C1:** declare a `PendingCheckpoint`
member that nothing sets; add a second post-construction assignment to `pending`.

**Order defect, corrected at the tip rather than escalated.** This order's Representation-level check
demanded `Object.keys(...).sort()` on `pendingCheckpoint` *and*, in the Prohibitions, that no exported
symbol be added. Both cannot hold: the object is module-private, so the runtime form needs a test
accessor the Prohibition forbids. That contradiction is mine; the implementer found the only
satisfiable reading (parse the construction literal, refuse a spread, refuse a second construction
site) and correctly reported it as a departure instead of quietly choosing. **Ruling: the source-parse
form stands, and the alternative was rejected** — an export is production surface, which needs an ask
it does not have, and it buys nothing here.

The substitute had a hole worth closing, and closing it is the gate commit: the literal is not the
whole shape, because `session_before_compact` fills `injection` afterwards (`pending.injection =
injection`). A literal-only expectation would keep passing while the interface grew a second
post-construction member. C1 now pairs the literal's keys with the post-construction assignments
against `interface PendingCheckpoint`, and pins the assignment set to exactly `injection`.

**Two more order defects, recorded not rewritten:** matrix row C1's named mutation (swap the refusal
verb into the success path) is inert, because the verb exists only in the refusal branches; and after
the fold, C5's and C6's per-path mutations are no longer expressible — they red both tools at once,
which is the extraction working as intended.

**Post-hoc, from the seat's 2026-11-05 ruling on WO-2026-077's Q-B1:** an edit to an existing test row,
or a contradiction between two of an order's own acceptance clauses, is now an owner question raised
*before* landing. This order's conflict was examined under that rule and left standing — it added no
surface and kept every row — so the correction here reads as a precedent the owner accepted rather
than one he ruled on. The rule now lives in `skills/work-order-template/SKILL.md` (`4174e35`).

**Accepted, not fixed:** the fork hoists its `ctx.sessionManager` reads above validation, so a throwing
read on a stale ctx would surface where a rejection path previously read nothing. Both reviewers rated
it LOW, no row covers that state, and making `gitCwd` a thunk is a mechanism change nobody asked for.

**Register state this landing leaves:** the strike WO-2026-073 opened is resolved by this extraction;
the area is not closed — the register row's reading is that closure needs two flagged landings, and
this one is the refactor rather than a third strike. `docs/investigations/structure-trend.md` needs a
snapshot for the chunk (1150 → 1231, +81), which the implementer correctly left out of the diff.
