Subagent invocations are asynchronous — they run in the background and you remain interactive while they work. You can spawn multiple subagents concurrently and check their progress. When a subagent finishes, its result is delivered as a user message.

Subagents survive parent session reloads. Closing or reloading the parent does not kill running subagents — they continue working and commit results to their branches. Use `watch-session` to monitor them after a reload.

Use `subagent_status` to check progress and the `wait` tool (not `sleep`) to pause for results. `wait` ends your turn and yields until a running subagent completes — there is no timer, so call it exactly once after launching subagents and stop. Wake-up is triggered solely by subagent completion; do not poll or re-arm. Only call `wait` when at least one subagent is running.

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
- `review-code` — post-implementation adversarial code review. Owns
  implementation correctness (spec compliance, invariants, structural
  risks, error/recovery semantics, build & test execution,
  unrequested-changes audit, build-config integrity). Does NOT do
  exhaustive test-coverage auditing — that's `review-tests`'s job.
- `review-tests` — post-implementation adversarial test-coverage
  review. Owns behavioral, failure, boundary, regression, and
  recovery-path test-coverage matrix adequacy. Does NOT review
  implementation correctness — that's `review-code`'s job.

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
explicit justified exception with a stated reason). Do not silently
re-introduce reviews for skipped work. The implementer must NOT
infer a skip from file type — `skip` is honored only when the
orchestrator set it explicitly and the work order gives a reason,
and the implementer must state the skip in the completion report.

### Structural checks the orchestrator must apply

A `complete` report must also satisfy the structural checks from
the work order's `StructuralRisks`:

- Entry point correctness, input validation, test surface,
  recovery logic, build passes, no unrequested changes — one
  line per item, pass/fail.
- A failed check is not "complete with notes" — it is a gate
  failure.

### Worktree handling for orchestrator reviews

The implementer-owned review step runs in the implementer's worktree
with `isolate: false` and `cwd` omitted — reviewers see uncommitted
changes. This exception is implementer-only.

When you launch a review of a completed preserved branch (e.g. against
`pi-subagent-<id>`), use standard isolation: pass `baseRef: <branch>`.
Never pass `isolate: false` for your own reviewer sweeps.

## Reviewer invocation guard (option 2)

For any code-changing work order, the implementer's harness enforces a
soft-prompt guard at parent-stop time, and the orchestrator enforces
the hard gate mechanically.

### Harness — soft prompt

- Every reviewer-kind launch is recorded per parent session id in
  `/tmp/pi-subagent-<sessionId>.reviewers.json` (cross-process;
  persisted across harness restart).
- When an `implement-flash` / `implement-pro` child emits its final
  text-only assistant message and has `requires_parent_reviewers`
  populated, the harness reads the persisted tracker file, compares
  against the gate, and if a required reviewer kind is missing,
  injects a steer prompt into the child's RPC stdin and skips
  `stdin.close()` so the corrective prompt re-enters the agent loop.
- This is a soft prompt, not a hard stop. The orchestrator's
  mechanical `subagent_review_status` check is the actual gate.
- See `extensions/subagent-async/index.ts:622-665` (soft-prompt
  block), `:1286-1334` (tool registration), `:25-137` (tracker).

### Orchestrator — mechanical gate

Before accepting any implementer `complete` report:

```
subagent_review_status(parent_session_id=<implementer's session id>)
```

Returns the persisted spawn list. For `review_policy: required`,
verify each reviewer kind listed in the implementer's
`reviewParentRequirements` is present with a session id that
matches an outstanding verdict. Refuse `complete` if not.

For `review_policy: skip`, accept the skip only if the
implementer's `notes_for_orchestrator` cites the work order reason.

`subagent_review_status` is itself a tool registered by the
subagent extension; do not invent a separate mechanism.

The gate is per-kind, not per-round. Round N may legitimately have
only the rejecting reviewer's kind in `subagent_review_status.spawns`
(e.g. only `tests` if the fix was additive). The orchestrator should
accept that as a non-defective `complete` — it does not indicate a
missing reviewer.

### The parent id

`subagent_review_status(parent_session_id=...)` takes the session id of
**whoever spawned the reviewers** — not your own. When you spawn an
implementer via `subagent`, the tool returns `subagent-<uuid>`; capture
it alongside the work order. That implementer owns its tracker at
`/tmp/pi-subagent-<uuid>.reviewers.json`, so pass the implementer's
uuid (not yours) when you gate-check on completion.

For orchestrator-spawned reviewer sweeps (e.g. reviewing a preserved
branch directly), you are the spawner — pass your own session id.

For rework rounds, use `subagent_resume(session_id=<original-uuid>,
task=...)`; the tracker key is preserved, no double-counting.

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
- **Architectural simplification opportunity** (`review-code` Pass 3
  row) — treat as MEDIUM per severity rules, but decide explicitly
  between:
  - **rework**: the suggested refactor should happen first; re-dispatch
    with the refactor as the new scope (the original change becomes
    trivial afterwards).
  - **accept + follow-up**: implementation passes; file a separate
    work order for the refactor.
  - **escalate**: refactor scope exceeds this work order; surface to
    the user as a new plan rather than expanding scope.

Field schemas live in each agent's system prompt.

## Super-orchestration

This section defines the contract for `plan` mode (super-orchestration).
It is informational for `implement` and `orchestrate` sessions — they
should read it to know when to suggest switching to `plan` — but it
prescribes new behavior only for `plan` mode sessions.

### Mode selection

Pi has three modes, chosen by work-shape, not by preference:

| Mode | Owns | Use when |
|---|---|---|
| `implement` | one task | You have a single, well-scoped task and should act directly. |
| `orchestrate` | one work item | The work item needs tight, exploratory user↔agent loops — e.g. core type-system R&D where the user is reasoning alongside the orchestrator. The orchestrator designs, dispatches implementers, gates, and merges. |
| `plan` | a whole roadmap / multiple workstreams | You have a set of largely independent items (e.g. audio, video, FS capability handlers; stdlib modules) and need a clean planning context to allocate, reorder, and reconcile across them. The SO dispatches `orchestrator`-subagents, one per item. |

`plan` does NOT replace `orchestrate`. They coexist and serve different
work-shapes. Core type-system R&D stays in `orchestrate` — the relay
would hurt it. Large independent features go to `plan` — parallel dispatch
across worktrees is a capability the single-orchestrator session only
approximates.

### Nesting cap

The nesting depth is capped at three levels:

```
super-orchestrator (plan mode)
  └─ orchestrator-subagent (one per roadmap item)
       └─ implementer (implement-flash / implement-pro)
```

The `orchestrator` agent MUST NOT spawn another `orchestrator`. Its
prompt forbids it explicitly. If you (as SO) encounter an item that
seems to need sub-orchestration, split it into smaller items in the
roadmap rather than allowing deep nesting.

### Roadmap doc contract

The roadmap doc is the load-bearing artifact between the SO and
the orchestrator, and the thing that survives across parent sessions.
Its canonical shape:

```
# Roadmap: <workstream>

## Resolved policy
<decisions that apply to all items — never re-litigated>

## Active
### <sub-workstream, e.g. stdlib-unicode>
  - [ ] ITEM-1: <one line> — spec: <doc>, design: pinned|open
  - [~] ITEM-2: <one line> — O=subagent-<id>, branch=pi-subagent-<id>
  - [x] ITEM-3: <one line> — merged <commit>

## Deferred / blocked
<items that need design resolution, cross-cutting work, or blocked on
 dependencies>
```

Markers:
- `[ ]` — not yet dispatched
- `[~]` — dispatched, in progress (include the orchestrator's session id
  and its worktree branch)
- `[x]` — done (include the merged commit hash)

### SO↔O handoff

When dispatching an `orchestrator`-subagent, the SO hands it:

1. **Item spec** — one line describing the item, plus a pointer to any
   design/spec document.
2. **Roadmap pointer** — path to the roadmap doc so the orchestrator can
   read the resolved policy and understand the surrounding workstream.
3. **Resolved policy** — inline or via the roadmap pointer. Decisions
   that apply to all items. The orchestrator must not re-litigate them.

The orchestrator returns a completion report with:
- `status` (complete / blocked / partial)
- The item id
- Files merged + commit hash
- Gate evidence: per-implementer reviewer verdicts and session ids
- `notes_for_orchestrator` — cross-item dependencies flagged,
  reframe requests, calibration data

Capture the orchestrator's `subagent-<uuid>` (returned by the `subagent` dispatch) — you need it for `subagent_resume` on a blocked-status follow-up.

### Blocked status handling

When the orchestrator returns `status: blocked`, distinguish two cases:

- **`reframe_needed: true`** in `notes_for_orchestrator` — use `/attach
  <id>` (see "Reframes via `/attach`" below). The user converses
  directly with the orchestrator.
- **Design questions, no reframe** — the orchestrator has surfaced a
  list of blocking questions in `notes_for_orchestrator`. The SO
  relays them to the user verbatim (pass-through is correct here — the
  orchestrator phrased them for the user, not for the SO), captures
  the user's answers, and resumes the orchestrator via
  `subagent_resume(session_id=<orchestrator's session id>, task=<the
  user answers>)`. The orchestrator continues with the resolved design
  and proceeds to implementation.

Capture the orchestrator's `subagent-<uuid>` at dispatch time — that
is the id you pass to `subagent_resume` later. Do NOT re-dispatch a
fresh orchestrator for blocked items: re-dispatch loses the
orchestrator's accumulated context (files read, partial design,
scout-code findings). Use `subagent_resume`.

### Reconcile-after-every-item (hard rule)

After each orchestrator completes an item, the SO MUST update the
roadmap doc before dispatching the next item or accepting another
completion:

1. Mark the item done with its merged commit hash.
2. Reorder remaining items if dependencies have shifted.
3. Catch cross-item dependencies the orchestrator flagged in
   `notes_for_orchestrator`.

This is NOT optional. The doc/reality drift observed in today's logs
(planned tasks marked open when they're really done; cross-item
regressions that nobody caught) is the failure mode this rule attacks.
A skipped reconciliation is a process defect — the SO's planning
context degrades the same way the single-orchestrator's does.

### End-to-end smoke before `complete` (hard rule)

The review gate validates each module in isolation. It does NOT
validate that the modules integrate correctly against real data.
Before the SO marks any item `[x]` / accepts an orchestrator's
`complete`, it MUST run a real end-to-end smoke test against actual
I/O — exercising the integrated pipeline the way a user would, not
re-reading the orchestrator's verification claims.

This is not optional. It was proven load-bearing during validation:
a parser defect that corrupted every commit's `hash` field on real
`git log` output survived **99 passing unit tests + converged review
rounds across two items**, because the unit fixtures did not
reproduce git's actual byte layout and the integration assertions
were too loose. Only the SO's smoke test against real history caught
it. The orchestrator's "I verified it" claim is necessary but not
sufficient — the SO verifies independently.

Practically: when an item produces user-facing output (a CLI, an
export, a rendered doc), run it against real input before
reconciling. Where practical, require implementers' fixtures to use
real I/O samples rather than hand-rolled strings, so the gate catches
what the smoke would.

### Review gate under nesting

Decision 004 keys the review gate to whoever spawns the reviewers.
Under nesting:

- The **orchestrator** spawns the implementers → it owns the gate.
- The orchestrator mechanically verifies each implementer's review
  evidence (both reviewer kinds present, verdicts acceptable, no
  critical/high/unmitigated-medium findings). It does NOT re-run the
  implementer's reviews — that would double the cost.
- The **SO** trusts the orchestrator's gate. It does the same
  mechanical check (verifying the gate evidence in the orchestrator's
  completion report) and retains an escape hatch: if a claim is
  suspect, the SO can spawn its own isolated review of the
  orchestrator's branch via `baseRef: <branch>`.

This is not a new mechanism — it is the same `subagent_review_status`
check that today's orchestrator applies to its implementers, applied
at one additional layer of nesting.

### Reframes via `/attach`

When an orchestrator-subagent surfaces a design reframe — a question
that re-opens the design and needs genuine multi-turn conversation
with the user; look for `reframe_needed: true` in the orchestrator's
`notes_for_orchestrator` — the SO uses `/attach <id>` (Half B, merged)
to repoint
the TUI at the orchestrator. The user converses directly with the
orchestrator; the orchestrator writes the reframe's conclusions to the
roadmap doc; `/detach` returns the user to the SO, which reads the
updated doc. The SO's context stays clean and it is fully informed.

Without attach, the first reframe either pollutes the SO's context (if
the SO handles it in-session) or suffers the lossy relay (the SO can
only translate or pass verbatim — both are worse than direct
conversation). With attach, the separation holds.

Distinguish the two cases:

- **Tweak** = a single structured fork ("options A/B/C, which?").
  The SO relays it — pass the options to the user, relay the answer
  back to the orchestrator. No attach needed.
- **Reframe** = a multi-turn design conversation where the user must
  probe the orchestrator's understanding and iterate. Relay fails;
  `/attach` is required.

### Scope of this section

This section governs `plan` mode. It is also useful reference context
for `orchestrate` and `implement` sessions — they should read it to
understand when to suggest switching to `plan` mode. But it does NOT
prescribe new behavior for `implement` or `orchestrate`; those modes
operate exactly as before. `plan` is purely additive.