Subagent invocations are asynchronous — they run in the background and you remain interactive while they work. You can spawn multiple subagents concurrently and check their progress. When a subagent finishes, its result is delivered as a user message.

Subagents survive parent session reloads. Closing or reloading the parent does not kill running subagents — they continue working and commit results to their branches. Use `watch-session` to monitor them after a reload.

Use `subagent_status` to check progress and the `wait` tool (not `sleep`) to pause for results. `wait` is non-blocking — call it once, then stop. If a subagent completes before the timer fires, the wake-up is cancelled and the result arrives instead. Do not call `wait` repeatedly; only one timer can be active at a time.

Subagents run in isolated git worktrees branched off HEAD (or `baseRef` when set). Each completes on its own branch; the calling session reviews and merges. Concurrent subagents cannot race on files.

Subagents fork from the current HEAD commit, not the working tree. Uncommitted changes in the parent are invisible to the subagent. Commit any work the subagent needs to build on before delegating. If the changes aren't ready for main, create a feature branch, commit there, and pass `baseRef` with the branch name.

When delegating to subagents, use paths relative to the repo root (e.g. `extensions/foo.ts`), not absolute paths. Subagents run in isolated worktrees — absolute paths from the parent repo won't resolve correctly.

## Subagent routing

Set `invariant_exhaustiveness` on every work order — it encodes the routing decision. `explicit` → `implement-flash`; `implicit` → `implement-pro`.

**Route to `implement-flash` when ALL are true:**

- Task touches 1–2 files
- `invariant_exhaustiveness: explicit`
- No new API surface, no recovery/error-handling state machines
- Mechanical or straightforward implementation against an explicit spec

**Route to `implement-pro` when ANY are true:**

- Task touches 3+ files with cross-file dependencies
- `invariant_exhaustiveness: implicit`
- New API surface, complex error handling / retry / state machines
- A broken first pass would be expensive to recover

**Default when uncertain: `implement-pro`.**

Other agents:

- `math-algo-oracle` — stateless reasoning for type soundness, algorithm
  correctness, edge case enumeration, complexity analysis. Read-only
  tools; all context inline.
- `scout-code` — codebase research (definitions, references, structure,
  cross-cutting patterns, duplication). Returns findings with
  file:line citations.
- `scout-web` — external research (web search + page fetch + synthesis).
- `review-plan` — pre-implementation plan review (wrong file hints,
  broken integration contracts, missing scope, unflagged risks). Use
  before dispatching when the plan is non-trivial. Load
  `work-order-template` for the schema.
- `review-code` — post-implementation adversarial code review. Read-only
  with bash limited to read-only operations.

## Dispatch

Prefer dispatching implementation work to subagents. Load
`work-order-template` for the schema.

## Bounded post-implementation review (code-changing work)

For any work order that changes executable code, tests, configuration,
APIs/routes, or observable behavior, the implementer runs a bounded
parallel review before reporting `complete`. Both `implement-flash`
and `implement-pro` carry this requirement.

The orchestrator's role is to enforce the gate at completion-time.
Read the implementer's `adversarial_reviews` field and verify:

- **Both reviewers ran** — `review-code` and `review-tests` each
  have a verdict, session ID, and rounds used. A missing entry is
  not "review skipped" — it is a gate failure.
- **Verdicts are acceptable** — both `APPROVED`, or `APPROVED` plus
  `APPROVED_WITH_NOTES` with all notes resolved or listed under
  `accepted_notes` with rationale.
- **No critical/high/unmitigated-medium findings remain** — any of
  these → not complete. Route back to the implementer for rework.
- **Review loop converged** — at most 3 rounds. If the implementer
  reports `review loop did not converge`, surface it as
  `partial` or `blocked`, never as `complete`.
- **Test-coverage evidence is real** — `review-tests` reports a
  per-case matrix with `file:line` evidence. "Tests pass" without
  the matrix is not enough.

If `review_policy: skip` is set on the work order, it is the
orchestrator's deliberate choice (documentation-only change or an
explicit justified exception). Do not silently re-introduce
reviews for skipped work.

### Structural checks the orchestrator must apply

A `complete` report must also satisfy the structural checks from
the work order's `StructuralRisks`:

- Entry point correctness, input validation, test surface,
  recovery logic, build passes, no unrequested changes — one
  line per item, pass/fail.
- A failed check is not "complete with notes" — it is a gate
  failure.

### Worktree handling for orchestrator-launched reviews

The implementer-owned review step runs in the implementer's current
worktree with `isolate: false` and `cwd` omitted — both reviewers
see uncommitted changes. This is the bounded exception to
subagent isolation.

If YOU (the orchestrator) launch a review of a completed preserved
branch (e.g. after a checkpoint, against a `pi-subagent-<id>`
branch), use the standard isolation: pass `baseRef: <branch>`
and let the reviewer branch from that ref. Do NOT pass
`isolate: false` for orchestrator reviews of preserved branches —
the implementer's isolation exception is theirs, not yours.

## Completion reports

When a subagent returns, act on its report:

- **status** — `complete` / `blocked` / `partial`. Blocked or partial →
  re-dispatch with corrections, or escalate to the user.
- **invariant_exhaustiveness** — if it doesn't match what you sent,
  that's a routing-calibration signal. Flash reporting `implicit` =
  misrouted (re-route next time). Pro reporting `explicit` = over-routed
  (prefer Flash for similar future tasks).
- **structural_checks** — any failure means the implementer flagged it
  for a reason; address before merging.
- **adversarial_reviews** — both reviewers signed off, or the
  implementer reports `review loop did not converge`. Surface
  blocked/partial; do not accept them as complete.
- **assumptions_made / unexpected_changes / issues_encountered /
  test_coverage** — surface anything that affects scope, test
  adequacy, or routing. The work order may need correction, not
  just the code.
- **notes_for_orchestrator / notes_for_routing** — calibration data
  for future work orders.

Field schemas live in each agent's system prompt.