# WO-2026-074 — every agent that reviews declares a kind

**Status: DISPATCH-BLOCKED (2026-11-05) on owner question Q-074-a below.** The mechanism is
settled; whether it may add a frontmatter value is not, and `agents/*.md` frontmatter is agent
surface rather than an integrator's call.

### Owner question Q-074-a (raised 2026-11-05)

**Ask:** may `reviewer_kind` gain a third value, `plan`, so `agents/review-plan.md` can declare
itself a reviewer? A `plan` token touches `ReviewerKind` and `RECOGNISED_REVIEWER_KINDS`
(`extensions/subagent-async/agents.ts:34`), one frontmatter line, and nothing else — but it is
still a widening of a closed vocabulary that agent authors read.

**Why a ruling is needed and a reviewer's approval is not.** Both candidate shapes *work*; they
differ in what the machine accepts afterwards. A verifier can prove a row passes either way, so
neither review nor a gate can choose between them.

**Option A — new `plan` value (recommended).** One union member, one set member, one frontmatter
line. The record gate already reads `reviewerKind !== undefined`, so `agents/implement.md` step 4
and the gate stay as they are. Gap it opens: `reviewParentRequirements` shares the same type, so an
implementer could then require a `plan` review before landing. Recommendation if A is chosen: no
requirement may name `plan`, and a row proves a `plan` spawn does not satisfy an `implementation`
requirement.

**Option B — a separate `owns_work_order: false` field.** Read only by the record gate. It leaves
`ReviewerKind` closed, which is its one advantage, at the cost of a second frontmatter concept for
a single distinction — the shape this repo keeps paying for (a rule that must be kept in step by
hand rather than by the type).

**Option C — reuse `implementation` for `review-plan`.** Rejected on the merits, not on cost: a
plan review would then satisfy `requires_parent_reviewers: [implementation]`, turning "a
post-implementation code review happened" into "something reviewed something".

**If no ruling,** the order stays blocked and the hole stays documented rather than patched: a
`review-plan` spawn carrying a `workOrderPath` records a dispatch it does not own.

### Metadata

- **work_order_id**: WO-2026-074
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit
- **estimated_complexity**: small
- **review_policy**: required

### Task Summary

WO-2026-070 gated the work-order dispatch on `agent.reviewerKind`. That gate is complete for the
set of agents that declare a kind, and incomplete for the set that reviews without one:
`agents/review-plan.md` declares no `reviewer_kind`, so a `review-plan` spawn carrying
`workOrderPath` still writes a false dispatch row. Latent today — nothing instructs passing the
path to a plan reviewer — and one line of prose away from live.

Close it by structure: an agent that reviews declares that it reviews.

### Premise

- `rg -c 'reviewer_kind' agents/*.md` → `review-code.md:1`, `review-tests.md:1`, nothing else.
- `extensions/subagent-async/agents.ts:12-14` documents the field as "a single-token declaration
  that this agent is a post-implementation reviewer", so the field's current scope may exclude
  `review-plan` **by design** — which is exactly why the record gate must not depend on it alone.
- `ReviewerKind` is a closed token set; adding to it touches the isolation default
  (`index.ts:3902`) and the reviewer tracker (`:3997`).

### Mechanism

The record gate must ask "does this spawn execute the order?", not "is this a post-implementation
reviewer?". Two candidate shapes — pick one, state which and why, and do not build both:

- **A. A phase-agnostic review marker.** Extend the frontmatter vocabulary so every reviewing
  agent declares `reviewer_kind` including `plan`, and make the record gate read
  `reviewerKind !== undefined` as it does today. Cost: a new `ReviewerKind` token, and a check
  that `requires_parent_reviewers` and the tracker do not start requiring plan reviews.
- **B. A separate ownership field** (`owns_work_order: false`) read by the gate. Cost: a second
  frontmatter concept for one distinction, which is the shape this repo keeps regretting.

Prefer A unless it disturbs the review gate's meaning. Whatever you choose, the census row in
`tests/work-record-ownership.test.ts` must cover **every** agent whose name or description marks
it as a reviewer — and a row must fail if a reviewer agent declares nothing, so adding a fourth
reviewer without a kind reds instead of silently escaping the gate.

### Acceptance rows

1. A `review-plan` spawn carrying `workOrderPath` writes no dispatch. Red today.
2. The census row fails when any agent that reviews declares no kind; prove it by removing the
   declaration from one reviewer and pasting the failure.
3. Every previously covered reviewer still writes nothing (the six rows from WO-2026-070 pass
   unchanged).
4. The implementer control row still writes exactly one dispatch.

### Prohibitions

- No name-based gate (`agent.name.startsWith("review-")`) — the point is to stop enumerating.
- No change to the record's content, columns or ordering.
- Do not change `requires_parent_reviewers` semantics for implementers; if A forces it, stop with
  `PLAN MISMATCH`.
- `models.json`, `settings.json`, `APPEND_SYSTEM.md.sec` in the live checkout are another
  session's uncommitted work.

### Docs

- `agents/review-plan.md` frontmatter (A) or the gate docstring (B).
- `decisions/work-order-records/001` is in **tfd**, not here — leave it to that repo's edit.

### Review

Hard cap 3 rounds. Gate at the merged tip by re-running the census row plus the six 070 rows, and
mutating the gate yourself to show both the plan-reviewer row and the census row go red.
