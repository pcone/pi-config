---
title: "Parallel review gate (review-code + review-tests) for code-changing work"
type: decision
status: done
date: 2026-07-16
---

# Parallel review gate (review-code + review-tests) for code-changing work

**What:** A new `review-tests` agent joins `review-code` as a
mandatory parallel post-implementation reviewer for any
code-changing work order dispatched to `implement-flash` or
`implement-pro`. Both implementers run both reviewers (in
parallel, in the implementer's current worktree with
`isolate: false`) before reporting `complete`. The review/rework
loop is bounded to 3 rounds; non-convergence surfaces as
`partial` or `blocked`, never `complete`.

**Why:** `review-code` owned three jobs that compete for
attention — implementation correctness, structural verification,
and exhaustive test-coverage audit. The coverage audit was the
weakest of the three: it was the part most likely to be skimmed
under time pressure, and a passing build with a missing failure
test is exactly the failure mode the gate exists to catch. A
dedicated `review-tests` reviewer with boundary-first coverage
policy and a per-case matrix closes that gap.

`review-code` retains implementation correctness, structural
verification (including a basic sanity check that tests hit real
entry points), recovery-logic correctness, build/test execution,
and unrequested-changes auditing. Recovery-path **test**
coverage is explicitly deferred to `review-tests`.

The implementer runs both reviewers in its own worktree with
`isolate: false` and `cwd` omitted. This is the intentional
exception to the worktree-isolation default — see
`003-async-subagents.md`. Default isolation branches from HEAD and
the reviewers would see a stale snapshot without the
implementer's uncommitted changes.

## Review policy

Work orders carry a `review_policy` metadata field:

- **`required`** (default) — code, tests, configuration,
  APIs/routes, observable behavior. Both reviewers run.
- **`skip`** — documentation-only work, or an explicit justified
  exception (state the reason). The implementer does not silently
  skip; an orchestrator-set `skip` is a deliberate choice.

For `required` work, the completion report's `adversarial_reviews`
field must include both reviewer verdicts, session IDs, rounds used,
and remaining findings. A `complete` status requires both reviewers
to be `APPROVED` (or `APPROVED_WITH_NOTES` with all notes resolved
or listed under `accepted_notes` with rationale). Any
`REJECT_AND_REWORK`, any critical/high finding, any unmitigated
medium finding, any reviewer failure or timeout, or any missing
review → not complete.

## Boundary-first test policy

`review-tests` applies a generalized boundary-first policy:

- Use the cheapest stable externally observable boundary
  (public API, CLI, compiler driver).
- For pure, deterministic, inexpensive input/output transformers,
  end-to-end / oracle / golden tests through the public boundary
  are the primary correctness evidence. Unit tests supplement but
  do not replace them.
- Representation-level checks (IR / generated code / optimization
  shape) supplement behavioral tests but do not replace them.
- Internal-helper-only tests are `INADEQUATE` evidence for a
  public-API change.

If the project has its own expected-failure / not-yet-implemented
convention, `review-tests` uses it for unrelated bugs discovered
during test writing. The policy is generalized — generic agent
prompts do not hard-code any specific project's expected-failure
syntax. Project-specific rules are discovered at review time.

## Current-worktree review semantics

The implementer's `isolate: false` + omitted `cwd` flow depends on
two runtime guarantees:

1. `extensions/subagent-async/index.ts`: `cwd = params.cwd ?? ctx.cwd`
   — omitting `cwd` inherits the parent's working directory.
2. The runtime only creates a worktree when
   `params.isolate !== false`. With `isolate: false` + omitted
   `cwd`, the reviewer spawns in the implementer's `ctx.cwd`,
   which is the implementer's worktree root, with uncommitted
   changes visible.

The orchestrator follows the opposite convention for its own
post-completion reviews of preserved branches: use `baseRef` and
standard isolation. The implementer's `isolate: false` exception
is implementer-owned, not orchestrator-owned.

## Wait semantics

`wait` owns no timer — it ends the caller's turn and yields until
a subagent completes (verified in `extensions/subagent-async/index.ts`).
Wake-up is triggered solely by subagent completion; there is no
timer-expiry path. The implementer therefore issues `wait` once
for both reviewers and then loops: when a reviewer's result
arrives, it inspects `subagent_status` on the outstanding reviewer
and either issues another `wait` or uses `subagent_stop` if the
reviewer is genuinely stuck. "One completion means both are done"
is the wrong inference.

The previous design armed an N-second timer that, on expiry, woke
the caller with "no subagent completed" — which the caller
answered by re-arming the timer, burning tokens in a poll loop.
That timer was removed; the only wake-up is now subagent
completion.

## Bounded allowlist and reviewer read-only

Implementer `allowedSubagents` is bounded to
`scout-code, review-code, review-tests`. Reviewers have read-only
tools (`read, grep, find, ls, bash` for read-only inspection) and
no recursive subagent fan-out. This restores the controlled
nested-delegation channel that `WO-2026-008` closed by default,
for exactly these three read-only agents. The runtime's
`PI_SUBAGENT_ALLOWLIST` env-var gate (added in `WO-2026-008`) is
the structural enforcer.

## Review loop cap

Maximum 3 review rounds. After 3 unsuccessful rounds (same or
equivalent finding still flagged, or a new critical/high issue
has surfaced), the implementer reports `partial` or `blocked`
with the literal phrase `review loop did not converge` in
`notes_for_orchestrator`. The orchestrator surfaces this — it
never accepts a non-converged loop as `complete`.

## Files changed

- `agents/review-tests.md` (new) — adversarial test-coverage
  reviewer
- `agents/review-code.md` — ownership split: implementation
  correctness only; defer exhaustive coverage audit to
  `review-tests`
- `agents/implement-flash.md` — `allowedSubagents`,
  `excludeTools`, post-implementation review protocol,
  completion-report fields
- `agents/implement-pro.md` — same as `implement-flash.md`
- `skills/work-order-template/SKILL.md` — `review_policy`
  metadata, `Required test boundary`, `Behavior and failure
  matrix`, `Representation-level checks`, completion-report
  schema additions
- `APPEND_SYSTEM.md` — bounded-review protocol, gate enforcement,
  worktree-handling rule for orchestrator-launched reviews

## Test coverage

- Manual structural check: frontmatter parses (list fields are
  comma-separated strings, per `extensions/subagent-async/agents.ts`).
- Manual `grep` check: `excludeTools` does not include
  `subagent`, `subagent_status`, `subagent_steer`, `subagent_stop`,
  or `wait` (implementer must keep those for review orchestration).
- Manual `grep` check: `allowedSubagents` is bounded to the three
  read-only agents.
- Existing e2e test (`tests/e2e-checkpoint.test.ts`) covers the
  checkpoint tool but not the subagent dispatch path; the
  review-gate is enforced by prompt text and the runtime's
  allowlist gate, not by an automated test in this repo.

## Tradeoffs

- **Compute cost increases** — every code-changing work order now
  spawns two reviewer sessions instead of one (or zero). For trivial
  one-file changes that are obviously correct, this is overhead.
  The 3-round cap and `review_policy: skip` for documentation-only
  work bound the worst case; mechanical implementation work that
  genuinely does not need review can still be marked `skip` by the
  orchestrator.
- **Latency decreases** — running reviewers in parallel is faster
  than serial, especially when one reviewer takes longer than the
  other.
- **Correlated blind spots decrease** — two reviewers with
  different checklists (one focused on code, one on test
  coverage) catch different things. The cost is acceptable because
  the failure mode they prevent (passing build, untested behavior)
  is expensive to discover later.
- **Implementer prompt grows** — both implementer prompts gain a
  substantial post-implementation review section and an expanded
  completion-report schema. This is a deliberate complexity trade
  in favor of gate strictness; the alternative (silent skip) makes
  the gate discretionary, which defeats its purpose.

## Alternatives considered

- **One unified reviewer (`review-code`) doing both jobs.**
  Rejected: under time pressure, the coverage audit is the part
  most likely to be skimmed. A dedicated agent with a per-case
  matrix checklist closes that gap.
- **Sequential review** (review-code, then review-tests). Rejected:
  higher latency for the same gate strictness.
- **Optional reviews gated by orchestrator decision per work
  order.** Rejected: makes the gate discretionary, which defeats
  its purpose. The default is `required`; the orchestrator sets
  `skip` explicitly when justified.
- **A `reviewer-orchestrator` that dispatches both reviewers.**
  Rejected: adds a layer that the implementer can already perform
  directly with two `subagent` calls. The implementer is the right
  owner because it has the context and the worktree.

## Reviewer invocation guard (amendment)

Implemented in `WO-2026-011`. Adds a soft-prompt guard at the
implementer's stop and a mechanical orchestrator check via
`subagent_review_status`.

- Soft prompt: `extensions/subagent-async/index.ts:622-665`. Skips
  `stdin.close()` so the corrective prompt re-enters the agent loop.
  Rationale: a hard stop would lose model state for the corrective
  path; the orchestrator's mechanical check is the actual gate.
- Persistent tracker: `/tmp/pi-subagent-<sessionId>.reviewers.json`.
  Cross-process; survives harness restart. The orchestrator reads
  it via `subagent_review_status` and the harness reads it via
  `readPersistedSpawns` for the soft-prompt check, so both
  mechanisms share one source of truth.
- `reviewer_kind` frontmatter: `implementation` for `review-code`,
  `tests` for `review-tests`. `requires_parent_reviewers` lists the
  reviewer kinds each implementer must spawn before stop; empty
  for reviewers (no recursion).
- Routing-feedback phrasing reform: reflexive
  "over-routed — implement-pro could have handled this" replaced
  with a conditional keyed to the work order's `routed_to` and the
  discovered `invariant_exhaustiveness` so the stock phrase is no
  longer reflexive.

Tradeoffs (extension):

- **Per-spawn disk write**: every reviewer spawn writes a JSON file.
  Negligible cost; tracked in `extensions/subagent-async/index.ts:73-87`.
- **Soft-prompt vs. hard-stop**: chose soft prompt to preserve model
  state. A misbehaving implementer could still self-correct rather
  than be killed, which is desirable for a gate whose primary job
  is to surface missing actions to the orchestrator, not to punish
  the agent.

### Orchestrator parent-id handling

The `parent_session_id` passed to `subagent_review_status` is the
implementer's child session id, **not** the orchestrator's. The
persisted tracker file
(`/tmp/pi-subagent-<sessionId>.reviewers.json`) is owned by the
process that actually issued the `subagent` tool calls to spawn the
reviewers — for implementer-spawned reviewers, that's the
implementer's RPC process.

The orchestrator captures the implementer's session id from the
`subagent` tool's response (the "Subagent started: ... (session:
subagent-<uuid>)" prefix) when dispatching the implementer, then
passes that id to `subagent_review_status` at completion time.
The worked example lives in `APPEND_SYSTEM.md` under
"Calling `subagent_review_status` correctly → Worked example".

This is a documentation-only fix — no harness change. It was
surfaced by `WO-2026-012` (smoke test of WO-2026-011), which
showed the orchestrator's natural read of its own session id
returned an empty spawn list, even though the implementer's
tracker file was correctly populated under its own id.
