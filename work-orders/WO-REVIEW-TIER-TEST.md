# Work Order: Review Tier Implementation Test

## Metadata
- **work_order_id**: WO-REVIEW-TIER-TEST
- **routed_to**: implement-pro
- **invariant_exhaustiveness**: explicit
- **priority**: normal
- **review_policy**: required
- **review_depth**: standard

## Task Summary
Implement a two-tier review system with standard (Mimo-V2.5-Pro) and thorough (GLM-5.2) review agents, with orchestrator-controlled selection based on work order risk signals.

## Files Modified
- `agents/review-code.md` — model changed to `xiaomi/mimo-v2.5-pro`
- `agents/review-plan.md` — model changed to `xiaomi/mimo-v2.5-pro`
- `agents/review-tests.md` — model changed to `xiaomi/mimo-v2.5-pro`
- `agents/review-code-deep.md` (new) — thorough code reviewer with `z-ai/glm-5.2`
- `agents/review-plan-deep.md` (new) — thorough plan reviewer with `z-ai/glm-5.2`
- `agents/review-tests-deep.md` (new) — thorough test reviewer with `z-ai/glm-5.2`
- `decisions/subagents/005-review-tiers.md` — decision record
- `decisions/subagents/README.md` — index updated
- `skills/work-order-template/SKILL.md` — `review_depth` field added
- `APPEND_SYSTEM.md` — tier verification gate, agent list updated
- `agents/implement-flash.md` — `allowedSubagents` includes `-deep` variants
- `agents/implement-pro.md` — same

## Invariants
- Standard agents use `xiaomi/mimo-v2.5-pro`, thorough agents use `z-ai/glm-5.2`
- `review_depth` field controls which tier implementer must spawn
- Orchestrator verifies agent name matches declared depth
- File count is not a tier selection signal

## Verification Criteria
- All 6 agent files exist with correct model in frontmatter
- `review_depth` field present in work-order-template
- APPEND_SYSTEM.md documents tier verification
- Decision record exists with selection criteria
