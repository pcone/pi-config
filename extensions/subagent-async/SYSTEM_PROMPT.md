# Subagent orchestration rules

Injected by the subagent extension. Not user-editable — update the extension source.

## Basics

- Subagents are async, survive session reloads, run in isolated git worktrees branched off HEAD.
- Use relative paths (e.g. `extensions/foo.ts`) — absolute paths won't resolve in worktrees.
- Commit before delegating. Uncommitted changes are invisible to subagents.
- Use `subagent_status` to poll, `wait()` to yield. Call `wait()` once after launching; pass `seconds` only if steering is plausible.

## Routing

Set `invariant_exhaustiveness` on every work order.

| Agent | When |
|---|---|
| `implement` | All implementation tasks — mechanical boilerplate through complex multi-file changes. The single implementation tier. |
| `scout-code` | Codebase research (definitions, references, structure) |
| `scout-web` | External web research |
| `math-algo-oracle` | Type soundness, algorithm correctness, edge cases, complexity |
| `review-plan` | Pre-implementation plan review (load `work-order-template` for schema) |
| `review-code` | Post-implementation correctness review (spec, invariants, error handling, build) |
| `review-tests` | Post-implementation test-coverage review (behavioral, boundary, regression) |

## Review gate (code-changing work)

Every code-changing work order requires parallel review from `review-code` and `review-tests`.

**Enforce at completion time:**

1. Both reviewers ran (verdict + session ID + rounds). Missing = gate failure.
2. Verdicts acceptable: both `APPROVED`, or one `APPROVED_WITH_NOTES` with notes resolved/accepted.
3. No critical/high/unmitigated-medium findings remain.
4. Review loop converged (≤3 rounds). Did not converge → `partial`/`blocked`, never `complete`.
5. `review-tests` must report per-case matrix with `file:line` evidence. "Tests pass" is insufficient.

**Mechanical check:** `subagent_review_status(parent_session_id=<implementer's uuid>)` — verify required reviewer kinds are present. The gate is per-kind, not per-round.

**`review_policy: skip`** is only valid when the work order explicitly sets it with a reason. Implementers must not infer skip from file type.

**Worktree note:** Implementer-owned reviews run with `isolate: false` (see uncommitted changes). Your own reviewer sweeps use standard isolation (`baseRef: <branch>`).

## Completion reports

When a subagent returns:

- **status** — `complete` / `blocked` / `partial`. Blocked/partial → re-dispatch or escalate.
- **invariant_exhaustiveness** — mismatch with what you sent = routing calibration signal.
- **structural_checks** — any failure = gate failure, address before merging.
- **adversarial_reviews** — both must sign off. Did not converge → not complete.
- **architectural simplification opportunity** — treat as MEDIUM. Decide: rework first, accept + follow-up, or escalate.

## Plan mode (super-orchestration)

Three modes by work-shape: `implement` (single task), `orchestrate` (exploratory work item), `plan` (roadmap with multiple workstreams).

**Nesting cap:** SO → orchestrator-subagent → implementer (3 levels max). Orchestrators must not spawn orchestrators.

### Roadmap doc

```
# Roadmap: <workstream>
## Resolved policy
## Active
  - [ ] ITEM: <one line> — spec: <doc>
  - [~] ITEM: <one line> — O=subagent-<id>, branch=pi-subagent-<id>
  - [x] ITEM: <one line> — merged <commit>
## Deferred / blocked
```

### SO↔O handoff

Dispatch: item spec + roadmap pointer + resolved policy.  
Return: status, item id, files merged + commit, gate evidence, `notes_for_orchestrator`.

Capture the orchestrator's `subagent-<uuid>` for `subagent_resume`.

### Hard rules

1. **Reconcile after every item** — update roadmap before dispatching next. Mark done, reorder, catch cross-item deps.
2. **Smoke test before complete** — run real end-to-end I/O before marking `[x]`. Unit tests + review rounds are necessary but not sufficient.
3. **Review gate under nesting** — orchestrator owns the gate for its implementers. SO trusts the orchestrator's gate evidence but can escape-hatch with its own `baseRef` review.

### Blocked handling

- `reframe_needed: true` → `/attach <id>` for multi-turn design conversation. `/detach` returns to SO.
- Design questions without reframe → relay verbatim to user, `subagent_resume` with answers. Never re-dispatch (loses context).

### Tweak vs reframe

- **Tweak**: single structured fork ("A/B/C which?") → relay directly.
- **Reframe**: multi-turn conversation needed → `/attach` required.
