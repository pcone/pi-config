# WO-2026-074 — every agent that reviews declares a kind

**Status: DISPATCHED 2026-11-05.** Q-074-a answered: **option A** (owner, 2026-11-05, via the
planning seat — "Go"; a second frontmatter field rejected).

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

**Answered (owner, 2026-11-05, via the planning seat): "Go".** Option A, and option B is rejected
outright — no second frontmatter field. The `plan` token is added, `agents/review-plan.md` declares
it, and the record gate covers every reviewer through `reviewerKind !== undefined` alone. The
recommendation attached to A stands as part of the ruling's shape: no `reviewParentRequirements`
entry may name `plan`, and a row proves a `plan` spawn does not satisfy an `implementation`
requirement.

**Before that ruling,** the order stayed blocked and the hole stays documented rather than patched: a
`review-plan` spawn carrying a `workOrderPath` records a dispatch it does not own.

### Owner question Q-074-b (raised 2026-11-05, by implement)

**Ask:** does a `plan` review spend one of an implementer's three review rounds? The tracker records
the spawn either way — that is what proves a plan review satisfies no requirement. The open half is
the counter: `recordReviewerSpawn` increments `reviewRounds`, and at 3 `reviewCapReached` suppresses
the missing-reviewer soft prompt.

**Why a ruling is needed.** Two reviews of the same commit reached opposite conclusions from the
same facts. `review-code` (round 1) read the order's prohibition — do not change
`requires_parent_reviewers` semantics for implementers — as forbidding a new kind from reaching the
cap that silences that requirement's nudge, and asked for the counter to count post-implementation
spawns only. `review-tests` (round 1) read `decisions/subagents/006:153` ("increments
`reviewRounds` on each fresh spawn", written when every recorded spawn was a post-implementation
review) as supplying the argument for the other direction, and asked for the direction to be ruled
rather than assumed, with a row pinning whichever way it resolved (so round 1's demand was a row,
not that round).
Neither document was written with a third reviewer kind in mind, so neither answers it.

**Landed pending the ruling (Q-074-b direction 1):** no round spent.
`isReviewRequirementKind` guards the increment, so the counter's trigger set is byte-for-byte the
pre-dispatch set, and a plan spawn is recorded in `spawns` without touching `reviewRounds`.
`tests/work-record-ownership.test.ts` pins both halves (plan spawn → rounds 0; then a `review-code`
spawn → rounds 1).

**If the owner prefers direction 2 (a plan review is a round):** delete the predicate guard in
`recordReviewerSpawn` (`extensions/subagent-async/index.ts`), flip the two `reviewRounds`
assertions in that row, and amend the `decisions/subagents/004` note with the ruling. Nothing else
depends on it.

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
