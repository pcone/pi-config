---
title: "Review tiers: standard (Mimo) vs thorough (GLM)"
type: decision
status: done
date: 2026-07-17
---

# Review tiers: standard (Mimo) vs thorough (GLM)

**What:** Review agents now come in two tiers — standard
(`review-code`, `review-plan`, `review-tests` on Mimo-V2.5-Pro)
and thorough (`review-code-deep`, `review-plan-deep`,
`review-tests-deep` on GLM-5.2). The orchestrator selects the
tier based on work order complexity and risk.

**Why:** In agentic sessions with 98% cache hit rate, cached token
cost dominates. GLM-5.2's cache read cost ($0.14/M) is ~39x
Mimo-V2.5-Pro's ($0.0036/M). For routine, low-risk reviews, the
thorough tier's quality advantage doesn't justify the cost. A
two-tier system lets the optimizer spend GLM budget where it
matters — complex cross-file work, error handling, and high-stakes
changes — while using Mimo for mechanical and single-file changes.

## Tier selection criteria

### Use thorough (`-deep`) when ANY of:

- `invariant_exhaustiveness: implicit`
- Error handling, retry logic, or recovery state machines involved
- `priority: critical` or on the critical path
- Prior review rounds had REJECT_AND_REWORK verdicts
- New API surface, routes, or public interfaces
- The orchestrator has uncertainty about file hint accuracy
- Type system or soundness-sensitive changes
- Changes where a subtle bug would be expensive to recover from

### Use standard (default) when ALL of:

- `invariant_exhaustiveness: explicit`
- Mechanical, boilerplate, or straightforward changes
- `priority: normal` or `low`
- No new API surface or public interfaces
- No error handling / recovery logic
- Config, docs, or test-only changes (when review is still required)

### Default: standard

When in doubt, start with standard. If the review surfaces concerns
that suggest deeper analysis needed, the orchestrator can re-dispatch
with thorough tier on the rework round. File count is not a useful
signal — a 3-file rename is trivial; a 1-file state machine is high
risk. Judge by invariant complexity and failure cost, not file count.

## Agent mapping

| Role | Standard (Mimo-V2.5-Pro) | Thorough (GLM-5.2) |
|---|---|---|
| Code review | `review-code` | `review-code-deep` |
| Plan review | `review-plan` | `review-plan-deep` |
| Test coverage | `review-tests` | `review-tests-deep` |

## Cost comparison

Assuming 98% cache hit rate, 90/10 input/output split:

| Model | Cache Read | Blended Cost |
|---|---|---|
| Mimo-V2.5-Pro | $0.0036/M | ~$0.012/M |
| GLM-5.2 | $0.14/M | ~$0.23/M |
| **Ratio** | **39x** | **19x** |

For a typical review session processing ~2M cached tokens:
- Standard: ~$0.024
- Thorough: ~$0.46
- Savings per standard review: ~$0.44

Across 50 reviews/month with 70% standard/30% thorough split:
- All thorough: ~$23
- Mixed: ~$7.50
- Savings: ~$15/month (67% reduction)

## Verification

The orchestrator must verify the correct tier was used when
checking `subagent_review_status`. The spawn record includes the
agent name; verify it matches the work order's `review_depth`:

- `review_depth: thorough` → spawn must be `review-code-deep` /
  `review-plan-deep` / `review-tests-deep`
- `review_depth: standard` (or omitted) → spawn must be
  `review-code` / `review-plan` / `review-tests`

A mismatch (e.g., work order says `thorough` but standard agent
was spawned) is a gate failure — refuse `complete` and re-dispatch
with the correct tier.

## Files changed

- `agents/review-code.md` — model changed to `xiaomi/mimo-v2.5-pro`
- `agents/review-plan.md` — model changed to `xiaomi/mimo-v2.5-pro`
- `agents/review-tests.md` — model changed to `xiaomi/mimo-v2.5-pro`
- `agents/review-code-deep.md` (new) — thorough code reviewer
- `agents/review-plan-deep.md` (new) — thorough plan reviewer
- `agents/review-tests-deep.md` (new) — thorough test reviewer
- `skills/work-order-template/SKILL.md` — `review_depth` metadata field
- `APPEND_SYSTEM.md` — tier verification in orchestrator gate

## Tradeoffs

- **Added complexity** — orchestrator must decide tier per work order.
  Mitigated by defaulting to standard; only explicit risk signals
  trigger thorough.
- **Quality variance** — Mimo may miss subtle issues GLM catches.
  Mitigated by reserving thorough for high-risk work where subtle
  bugs are most likely.
- **Agent proliferation** — 6 review agent files instead of 3.
  Acceptable because the files are nearly identical (only model and
  name differ); maintenance burden is low.

## Alternatives considered

- **Dynamic model override at spawn time.** Cleaner but requires
  subagent API changes. Rejected in favor of agent variants that
  work with current infrastructure.
- **Single model with prompt-based depth control.** Model quality
  is the bottleneck, not prompt length. A cheaper model with a
  longer "be thorough" prompt won't match GLM's reasoning.
- **Three tiers (cheap/standard/thorough).** Adds complexity
  without clear benefit. Two tiers capture the cost/quality
  tradeoff; a middle tier would be hard to justify.
