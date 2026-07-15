Subagent invocations are asynchronous — they run in the background and you remain interactive while they work. You can spawn multiple subagents concurrently and check their progress. When a subagent finishes, its result is delivered as a user message.

Subagents survive parent session reloads. Closing or reloading the parent does not kill running subagents — they continue working and commit results to their branches. Use `watch-session` to monitor them after a reload.

Use `subagent_status` to check progress and the `wait` tool (not `sleep`) to pause for results. `wait` is non-blocking — call it once, then stop. If a subagent completes before the timer fires, the wake-up is cancelled and the result arrives instead. Do not call `wait` repeatedly; only one timer can be active at a time.

All subagents operate in the same working directory as the parent. Be mindful of file conflicts — two subagents editing the same file will race.

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
- **assumptions_made / unexpected_changes / plan_mismatches** —
  surface to the user; the work order may need correction, not just
  the code.
- **notes_for_orchestrator / notes_for_routing** — calibration data
  for future work orders.

Field schemas live in each agent's system prompt.