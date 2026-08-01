---
name: work-order-template
description: Work order schema for delegating implementation tasks to subagents (implement-flash, implement-pro). Load this skill when generating, reviewing, or filling out a work order — defines the required sections the orchestrator must populate and the fields the implementer reads.
---

# Work Order Template

## Instructions for the Orchestrator

You are generating a work order to dispatch to an implementation agent. Fill in every section below. If a section does not apply to the task, write `N/A` with a brief explanation rather than omitting it.

Your work order quality directly determines whether the implementer succeeds on the first pass. Be exhaustive. If you cannot fully specify all invariants, set `invariant_exhaustiveness: implicit` so the router sends the task to `implement-pro`.

---

## Work Order

### Metadata

- **work_order_id**: <unique identifier, e.g., WO-2026-007>
- **parent_plan_id**: <ID of the planning session this work order belongs to>
- **sequence_position**: <N of M work orders in the current plan>
- **routed_to**: implement-flash | implement-pro
- **invariant_exhaustiveness**: explicit | implicit
- **priority**: critical | normal | low
- **estimated_complexity**: trivial | moderate | complex
- **review_policy**: required | skip — default `required`. Set `skip` only for documentation-only changes or explicit justified exceptions (state the reason).
- **review_depth**: standard | thorough — `standard` (default) for explicit invariants, mechanical work. `thorough` for implicit invariants, error handling, critical priority, new API surface, or prior rejections. Mismatch between depth and spawned agent name = gate failure.

### Task Summary

**One-sentence description**: <what this work order accomplishes, in plain language>

**Goal**: <the specific outcome the implementer must produce — not the "how," the "what">

### Scope

**Files to modify** (list every file the implementer is expected to touch):
- `path/to/file.rs` — <what changes in this file>
- `path/to/other.rs` — <what changes in this file>

**Files to read (reference only, do not modify)**:
- `path/to/reference.rs` — <why the implementer needs to read this>
- `path/to/pattern.rs` — <existing code that demonstrates the convention to follow>

**Files NOT to modify** (explicit guardrails):
- `path/to/do_not_touch.rs` — <reason: e.g., "downstream pass depends on current IR shape">

**Out of scope**: <anything adjacent that might tempt the implementer but is not part of this work order>

### Implementation Specification

**Detailed requirements**: <step-by-step description of what to implement. Be specific about behavior, not just structure.>

**Required test boundary**: <the cheapest stable externally observable
entry point through which tests must exercise the behavior — public
API, CLI command, compiler driver, HTTP endpoint. For pure,
deterministic, inexpensive input/output transformers, end-to-end /
oracle / golden tests through this boundary are the primary
correctness evidence. Unit tests may supplement but do not replace
them. State the boundary explicitly; do not let the implementer
guess.>

**Behavior and failure matrix**: <the cases the implementation must
satisfy, organized as a non-overlapping matrix that the test reviewer
can audit row by row. Cover at minimum:

- Success paths the work order requests
- Validation, malformed, empty, boundary, and failure paths
- Retry, timeout, recovery, and partial-failure behavior (when relevant)
- Regressions for every issue fixed or discovered during implementation

Each row should name the case precisely. The implementer's tests and
the test reviewer's coverage matrix both target these rows.>

**Representation-level checks**: <only when applicable — IR shape,
generated code, optimization invariants, internal data-structure
checks. These supplement behavioral tests but do not replace them.
Specify which representations must hold and how the implementer
should assert them. Omit this subsection if the work order has no
representation-level concerns.>

**Integration contract**: <how this code connects to the rest of the
system — what calls it, what it calls, what interfaces it must
implement, what types it must produce/consume>

**Reference patterns**: <point to existing code in the repo that demonstrates the style/convention to follow. E.g., "follow the pattern in `passes/constant_folding.rs` for pass registration and visitor implementation">

### Invariants

List every invariant the implementer must preserve. This is the most critical section — invariants left unstated become silent bugs.

**Cross-file conventions**:
- <e.g., "All IR nodes must implement the `Visitable` trait">
- <e.g., "All passes return `Result<Module, CompileError>`">
- <e.g., "The pass registry must be updated when a new pass is added">

**Default values to preserve**:
- <e.g., "The default optimization level is O2, not O0">
- <e.g., "If no target triple is specified, default to x86_64-unknown-linux-gnu">

**Ordering assumptions**:
- <e.g., "Constant folding runs before dead code elimination">
- <e.g., "SSA construction must complete before any optimization pass runs">

**Error handling conventions**:
- <e.g., "Errors propagate via `?` operator, never panic in pass implementations">
- <e.g., "All user-facing errors must be wrapped in CompileError with source location">

**Unspecified invariants** (only if `invariant_exhaustiveness: implicit`):
- <e.g., "The work order references 'standard pass conventions' but does not enumerate them — the implementer must check `passes/mod.rs` for the full convention list">
- <e.g., "Error recovery behavior for malformed IR is not specified — follow the pattern in the existing passes">

> If you cannot enumerate all invariants, you MUST set `invariant_exhaustiveness: implicit` above. Do not mark `explicit` unless you are confident every invariant is stated.

### Verification Criteria

The implementer must verify all of the following before reporting completion.

**Entry points that must work**:
- <e.g., "The HTTP endpoint at `/workflows/:key/runs` must return 200 for valid inputs">
- <e.g., "The CLI command `compiler --pass=constant-folding input.ll` must produce valid output">

**Input shapes that must be accepted**:
- <e.g., "The parser must accept both objects and arrays at the top level">
- <e.g., "The pass must handle modules with zero functions without crashing">

**Tests that must pass**:
- <e.g., "`cargo test passes::constant_folding` — all tests pass">
- <e.g., "Integration tests in `tests/end_to_end.rs` that exercise the new pass must pass">

**Test surface requirements**:
- <e.g., "Integration tests must call the actual `compile()` entry point, not internal pass functions directly">
- <e.g., "Tests must exercise the error path, not just the happy path">
- Tests must hit the **Required test boundary** declared above. If the
  implementer only writes internal-helper tests for a public-API
  change, the test reviewer will mark that INADEQUATE.
- For pure deterministic transformers with a cheap stable public
  boundary, end-to-end / oracle / golden tests are primary;
  unit tests are supplemental. State this explicitly when it
  applies.

**Build requirements**:
- <e.g., "`cargo build` succeeds with no warnings related to this change">
- <e.g., "Do not modify Cargo.toml unless adding a dependency that is explicitly required">

### Structural Risks

Known risk patterns for this task type. The implementer must explicitly check for these.

- [ ] **Route/path correctness**: Every endpoint, public function, or CLI command is at the path specified in the work order (not a variant or prefix of it)
- [ ] **Input validation scope**: Validation accepts every input shape the spec allows — no over-constraining types or rejecting valid inputs
- [ ] **Test surface**: Tests exercise the actual entry points (HTTP endpoints, public APIs, CLI commands), not internal functions called directly
- [ ] **Recovery logic**: If error handling or retry logic is involved, recovery paths do not execute work after a parent failure has occurred
- [ ] **No unrequested changes**: No files, routes, or structures modified beyond what the work order specifies
- [ ] **Build config untouched**: Build configuration (tsconfig, Cargo.toml, CMakeLists) not modified unless explicitly requested
- [ ] **No unsolicited features**: No features, refactors, or "improvements" added that were not requested in the work order

> The implementer must check every box above. If any check fails, the implementer must fix the issue before reporting completion or flag it in the completion report.

### Context

**Prior work orders completed in this plan** (to maintain trajectory coherence):
1. <WO-2026-005: Added IR node definitions> — <key state change: IR nodes now support `Visitable`>
2. <WO-2026-006: Updated pass registry> — <key state change: registry accepts new pass registrations>

**Upcoming work orders** (so the implementer doesn't break future work):
1. <WO-2026-008: Will add dead code elimination pass> — <implementer must not change the pass registration interface>

**Relevant decisions from planning session**:
- <e.g., "Decided to use visitor pattern rather than match-based traversal for all new passes">
- <e.g., "Decided to defer SSA validation to a separate pass, not inline it here">

### Escape Hatch (for implement-flash only)

If you are `implement-flash` and during your invariant enumeration step you discover that:
- The task involves implicit invariants you cannot resolve from the referenced files
- The task touches more files or has more cross-file dependencies than the scope indicates
- The structural risks checklist reveals failures you cannot fix without changing the work order's intent

**STOP. Do not guess. Report `invariant_exhaustiveness: implicit` in your completion report with a description of what you could not resolve. The orchestrator will re-route the task to `implement-pro`.**

### Completion Report Format

The implementer must produce a completion report in their final assistant message. All implementers use: status / invariant_exhaustiveness / files_modified / tests / structural_checks / deviations_from_spec / notes_for_orchestrator.

For code-changing work (`review_policy: required`), also include:
- **assumptions_made** — invariants assumed, not explicit in work order
- **unexpected_changes** — files touched outside scope, with justification
- **issues_encountered** — bugs found, workarounds applied
- **test_coverage** — one-line summary (per-case matrix is `review-tests`'s job)
- **adversarial_reviews** — both reviewer verdicts, session IDs, rounds used, remaining findings
- **review_cap_reached** — `true` if 3-round cap hit
- **accepted_notes** (optional) — low-severity notes intentionally not fixed, with rationale

See the agent's system prompt for exact schema. A `complete` status requires both reviewers APPROVED (or APPROVED_WITH_NOTES with notes resolved/accepted).

---

## Notes for the Orchestrator

- **Always set `invariant_exhaustiveness`**. Default to `implicit` if uncertain.
- **Always list files NOT to modify** when adjacent files could plausibly be touched — strongest signal against scope creep.
- **Use repo-relative paths everywhere.** Subagents run in isolated worktrees; absolute parent-repo paths bypass isolation.
- **Cross-reference AGENTS.md** for project-specific conventions.
- **Consider pre-dispatch simplification.** If the change looks larger than the goal warrants, route through `review-plan` first.