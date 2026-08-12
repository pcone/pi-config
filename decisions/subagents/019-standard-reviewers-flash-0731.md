---
title: "Standard reviewers to DeepSeek V4 Flash 0731 — accept same-lab correlation for cost (reverses 016 model-diversity principle)"
type: decision
status: done
date: 2026-08-11
---

# Standard reviewers to DeepSeek V4 Flash 0731 — accept same-lab correlation for cost (reverses 016 model-diversity principle)

**What:** Standard reviewers (`review-code`, `review-tests`, `review-plan`) move from `openai/gpt-5.6-luna` to `deepseek/deepseek-v4-flash-0731`. The implementer is already on Flash 0731, so the routine review loop becomes same-lab: DeepSeek reviews DeepSeek. The deep tier (`review-*-deep`, GLM-5.2) is unchanged and remains the decorrelated path for high-risk work.

**Why:** Measured, not estimated: Luna was taking ~50% of OpenRouter spend while accounting for <1/5 of total token volume — reviewers stack 2× behind every code-changing task, so a 5× per-token premium on the reviewer seat dominated the bill for a tiny slice of the tokens. The cost was no longer justified. The principle this reverses (016: "implementer and reviewer must be DIFFERENT models — same-model review shares the generator's blind spots") was set when the anti-fabrication defense still leaned on a second model. Decision 017 already moved that defense off the model layer and onto mechanical checks: reviewer `file:line` claims are validated by interval arithmetic against the diff (never by an LLM), reviewers must quote the cited evidence per finding, and implementations get a patch-vs-spec audit (fabricated identifiers, out-of-scope hunks, test-only edits). Those guards are model-independent and survive the loss of decorrelation.

What is lost is the *reasoning-blind-spot* decorrelation — a subtle wrong assumption DeepSeek makes when writing is one it may also fail to catch when reviewing. Citation fabrication, the failure 016 was most worried about, is still caught mechanically.

**This is a conscious reversal of 016's model-diversity principle, not an oversight.** 016 stays on the record as the point-in-time capture of the earlier position.

**Alternatives considered:**
- Keep Luna — rejected: ~5× cost for the decorrelation margin, and the deep tier already provides a decorrelated path where it matters most (high-risk work).
- Different cheap decorrelated reviewer (e.g. MiMo V2.5 Pro, the pre-Luna choice) — rejected: MiMo's AA agentic index (29.1) and TPS (~55–63) are the weakest in the fleet; 016 moved off it for exactly that. No other model sits at Flash's price point with reviewer-grade quality.
- Promote the deep tier (GLM-5.2) from dormant insurance to the routine reviewer — rejected: GLM's 39× cache cost and verbosity are what made it the slow tier; routing all routine reviews through it reintroduces the wall-clock cost 016 cut.

**Tradeoffs:**
- Same-lab blind spots in the routine tier pass uncaught at the model layer — partially offset by the mechanical checks (017) and by the deep tier remaining available for manual escalation on flagged WOs.
- Flash 0731 carries prior tool-calling/hallucination flags (HF discussion #37, yage.ai audit) now sitting in the judge seat — the same seat 016 moved it *out* of. Mitigated by the prove-each-finding rule and mechanical citation validation; watch verdict quality on the next standard-gated tasks.
- The deep tier's value as "dormant insurance" rises: it is now the only decorrelated reviewer in the config. If it rots, the config has no fallback — keep it refreshed alongside the standard tier's prompt updates.

**Files changed:** `agents/review-code.md`, `agents/review-plan.md`, `agents/review-tests.md` (model lines), this decision, README index, supersession footnotes on 016 and 017, assignment row in `docs/model-role-scores.md`.

**Test coverage:** none changed — these are agent-config files with no executable tests. The review gate runs the swapped reviewers on the next code-changing WO; watch for verdict regressions per the tradeoffs above.
