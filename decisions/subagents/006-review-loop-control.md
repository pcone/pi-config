---
title: "Reviewer-driven re-review signal and round cap"
type: decision
status: done
date: 2026-07-18
---

# Reviewer-driven re-review signal and round cap

**What:** Reviewers now indicate `re_review_required` (yes/no) based
on fix complexity, not severity. The implementer checks this signal
after a rejection: if `no`, fix and return; if `yes`, re-run
reviewers. The 3-round cap is enforced with a clear
`review_cap_reached` flag in the completion report.

**Why:** The previous flow forced re-review on every rejection,
creating expensive loops even for trivial fixes (rename, add field).
The reviewer knows whether the fix is complex enough to warrant
verification — a mechanical fix doesn't need another round. Separately,
the round cap wasn't properly surfaced, making it hard for the
orchestrator to know when a session hit the limit.

## Re-review signal

### Reviewer output

Each reviewer now includes in their output:

```
### Re-review required
yes | no
```

Decision criteria (same for all reviewer types):
- **yes**: fix involves logic changes, multiple interacting parts,
  or room for subtle mistakes
- **no**: fix is mechanical, localized, or straightforward

### Implementer behavior

On `REJECT_AND_REWORK`:

1. Check `re_review_required` in the reviewer's output
2. Determine which case applies (see "Per-reviewer re-review targeting"
   below) based on the `re_review_required` value and the diff stat
3. Apply the per-reviewer rule from the selected case, always using
   `subagent_resume` for re-reviews (never fresh `subagent` calls)
4. Fix the issue and resume the appropriate reviewers per the case

The orchestrator decides if another round is needed for `no` cases.

## Round cap

### Implementer behavior

After 3 rounds:
- Report `complete` (if all issues resolved), `partial`, or `blocked`
- Set `review_cap_reached: true` in completion report
- Include literal phrase `review cap reached` in `notes_for_orchestrator`

### Orchestrator behavior

When `review_cap_reached: true`:
- Flag to user
- If all issues resolved → accept `complete` with note
- If critical/high remain → re-dispatch with explicit instructions
- If unclear → ask user

## Per-reviewer re-review targeting

The implementer now applies per-reviewer targeting instead of always
re-running both reviewers. Three cases cover the decision:

### Case A — rejecting reviewer says `re_review_required: yes`

Re-run both reviewers. Justification: complex fix, regression in any
domain is plausible. This is the existing behavior.

### Case B — rejecting reviewer says `re_review_required: no`

Re-run only the rejecting reviewer, plus any other reviewer who had
open LOW/MEDIUM notes the fix could have affected. Justification:
mechanical fixes don't regress other domains; other reviewers' prior
approvals still hold.

### Case C — fix is purely additive (tests/docs/decision records only,
no production code change)

Re-run only the rejecting reviewer, period. Justification:
`review-code` already approved; no production code change means
nothing for it to re-verify.

**Detection signal for Case C:**
```bash
git diff --stat HEAD~1 HEAD
```
If the diff stat shows only `tests/`, `*.md` under `decisions/`,
`*.cases` fixtures, and similar non-source paths, it's Case C.
If the diff shows any `codegen/src/`, `parser/src/`, `common/src/`,
or other production source paths, it's Case A or B. If the detection
is ambiguous (mixed production + non-production changes), default to
Case A (false-positive is cheap relative to false-negative).

### Schema note

The `re_review_required: yes|no` schema is unchanged — this is an
implementer-side interpretation tightening, not a schema break.

## Completion report schema

```yaml
adversarial_reviews:
  review-code:
    verdict: APPROVED|APPROVED_WITH_NOTES|REJECT_AND_REWORK
    session_id: subagent-...
    rounds: N
    re_review_required: true|false
    remaining_findings: [...] or none
  review-tests:
    verdict: ...
    session_id: ...
    rounds: N
    re_review_required: true|false
    remaining_findings: [...] or none
  rounds_total: N
review_cap_reached: true|false
```

## Session continuity

Re-reviews always use `subagent_resume` to continue the same
reviewer session, preserving context and the tracker chain.
This applies to:

1. **Implementer-initiated re-review** (`re_review_required: yes`)
   — implementer calls `subagent_resume(session_id=<reviewer-id>)`
   with the fix summary
2. **Orchestrator-initiated re-dispatch** (after cap or rejection)
   — orchestrator passes reviewer session IDs from
   `adversarial_reviews` so the implementer can resume

Fresh `subagent` calls are only used for the first review launch.
All subsequent rounds use `subagent_resume`.

## Harness changes

The harness (`extensions/subagent-async/index.ts`) now tracks review
rounds and respects the cap:

- **`REVIEW_ROUND_CAP = 3`** constant defines the maximum rounds
- **`TrackerState`** interface adds `reviewRounds: number` and
  `reviewCapReached: boolean`
- **`recordReviewerSpawn`** increments `reviewRounds` on each fresh
  spawn and sets `reviewCapReached` when cap is hit
- **Soft-prompt check** skips injection when `reviewCapReached` is
  true — the implementer can return with `review_cap_reached: true`
- **`subagent_review_status`** returns `reviewRounds` and
  `reviewCapReached` so the orchestrator can make informed decisions

Backward-compatible: files without `reviewRounds` are treated as
round 1 if spawns exist, round 0 otherwise.

## Files changed

- `extensions/subagent-async/index.ts` — round tracking in harness,
  soft-prompt skip on cap, `reviewRounds`/`reviewCapReached` in
  `subagent_review_status` output
- `agents/review-code.md` — added `re_review_required` output field
- `agents/review-code-deep.md` — same
- `agents/review-tests.md` — same
- `agents/review-tests-deep.md` — same
- `agents/review-plan.md` — same
- `agents/review-plan-deep.md` — same
- `agents/implement-flash.md` — check `re_review_required` before
  re-running reviewers; report `review_cap_reached` after 3 rounds
- `agents/implement-pro.md` — same
- `skills/work-order-template/SKILL.md` — `review_cap_reached` and
  `re_review_required` in completion report schema
- `APPEND_SYSTEM.md` — orchestrator handling for cap and re-review signal;
  guidance on passing reviewer session IDs for resume

## Tradeoffs

- **Reviewer judgment varies** — one reviewer's "mechanical" is
  another's "complex." Mitigated by the orchestrator's ability to
  force another round if needed.
- **Implementer might abuse `no`** — could fix complex issues and
  claim it was mechanical. Mitigated by the orchestrator's gate
  check and the ability to re-dispatch.

## Alternatives considered

- **Severity-gated re-review** (CRITICAL/HIGH → re-review,
  MEDIUM/LOW → don't). Rejected: severity doesn't correlate with
  fix complexity. A CRITICAL missing import is trivial to fix; a
  LOW logic issue might need careful verification.
- **Always re-review** (previous behavior). Rejected: expensive
  for trivial fixes, creates loops that waste compute.
- **Orchestrator decides** (no signal from reviewer). Rejected:
  the reviewer has the context to judge fix complexity; the
  orchestrator would have to re-read the findings to decide.
