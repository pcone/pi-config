# Work Order: E2E Test — WO-declared review_policy: required wins over param (decision 014 battery, step 2)

**status**: done (E2E battery, 2026-08-04)

## Metadata

- **work_order_id**: WO-E2E-REQUIRED
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit
- **priority**: normal
- **estimated_complexity**: trivial
- **review_policy**: required — E2E battery test: validates that the WO's declared `required` wins over a `skip` tool param when `workOrderPath` is set
- **review_depth**: standard

## Task Summary

**Goal**: Create `tmp/e2e-required-test.md` (gitignored scratch — will NOT appear in the worktree commit) containing exactly `E2E-REQUIRED-PASSED`. Then run the full post-implementation review: launch BOTH `review-code` and `review-tests` per your standard protocol (`isolate: false`, both in one response, before `wait`). This work order declares `review_policy: required` — even if the orchestrator's tool call carried a `skip` param, the WO wins; do not skip.

## Scope

**Files to modify**: `tmp/e2e-required-test.md` (create — gitignored scratch; if it appears tracked in `git status`, wrong location)

**Out of scope**: everything else. The 5 modified-but-uncommitted files in the parent tree are unrelated — do not touch.

## Verification Criteria

- `tmp/e2e-required-test.md` contains exactly `E2E-REQUIRED-PASSED`.
- Both reviewers spawned (the harness gate must remain live — this is the WO-wins-over-param validation).
- Completion report includes both reviewer verdicts.

## Completion Report Format

Standard schema incl. `adversarial_reviews` (both reviewer sessions, verdicts, session IDs).
