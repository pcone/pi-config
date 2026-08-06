---
title: "Fleet speed experiment — standard reviewers to GPT-5.6 Luna, implementer stays Flash (model-diverse review loop)"
type: decision
status: done
date: 2026-08-04
---

# Fleet speed experiment — standard reviewers to GPT-5.6 Luna, implementer stays Flash (model-diverse review loop)

**What:** Standard reviewers (`review-code`, `review-tests`, `review-plan`) move from `xiaomi/mimo-v2.5-pro` to `openai/gpt-5.6-luna`. Implementer stays on `deepseek/deepseek-v4-flash-0731`. Orchestrator stays on `zai/glm-5.2`. One-commit rollback path (revert restores the three model lines).

**Why:** Speed experiment with a strictly dominant swap. MiMo V2.5 Pro is the weakest speed/capability combo in the fleet (AA agentic index 29.1, ~55–63 t/s, 3.16s TTFT) and Luna dominates it on every axis: TPS (~178 vs ~55–63), price ($0.10/$0.60 vs $0.435/$0.87 — cheaper input AND output, plus $0.01/M cache reads for the cache-heavy review loop), and quality (AA agentic 45.6 vs 29.1; coding 71.4). Review sessions stack behind every task (2 per task), so reviewer TPS is the direct wall-clock multiplier on task turnaround.

**Model-diversity principle (user, 2026-08-04):** implementer and reviewer must be DIFFERENT models — same-model review shares the generator's blind spots and defeats adversarial review. Split: Flash writes (output-heavy role where its $0.18/M output keeps cost low; its flagged tool-calling/hallucination reports are less poisonous in the writer seat, where work gets caught downstream), Luna judges (read-heavy where its cache-read price and higher coding/agentic scores fit; fabricated-finding risk is the expensive failure in the judge seat and Luna has no reliability flags).

**Orchestrator stays GLM-5.2 (hallucination-first):** AA-Omniscience puts GLM-5.2 at the LOWEST hallucination rate of all candidates (28.1%; Claude Sonnet 5 37.3%, Kimi K3 51%, Gemini 3.5 Flash 61%, DeepSeek V4 Pro 94%). The orchestrator's worst failure is confidently-wrong routing, so calibration beats speed here. The "GLM feels slow" complaint is verbosity, not decode speed (~156 t/s): 43K output tokens/task, ~86% reasoning. **Follow-up (not this WO):** reasoning-effort cap for the orchestrator if the Z.ai subscription exposes it.

**Alternatives considered:**
- Luna implementer + Flash reviewers — rejected: implementer is output-heavy (Luna output 3.3× Flash's), reviewers are cache-read-heavy (Luna cache-read is cheaper than Flash's); plus Flash's hallucination flag is worse in the judge seat.
- Both to Luna — rejected by user: breaks model diversity in the review loop.
- MiMo → DeepSeek V4 Flash for reviewers — viable but Flash has real tool-calling reliability reports (HF discussion #37, yage.ai audit) and its cache-read ($0.018/M) is pricier than Luna's ($0.01/M); Luna is the better judge.
- Orchestrator to Kimi K3 (best agentic) — rejected: 51% hallucination rate is exactly the forbidden failure mode; slow (38–62 t/s).
- Orchestrator to Gemini 3.6 Flash (fastest) — rejected: family calibration poor (3.5 Flash 61%), reasoning-first TTFT 12.3s.

**Tradeoffs:**
- Luna is a newer, less battle-tested model in this exact role — mitigated by the experiment framing (watch list below) and one-commit rollback.
- OpenAI pricing is volatile (the 07-30 price cut on the Terra family) — the $0.10/$0.60 quote could move; watch cost per review.
- Deep reviewers stay on GLM-5.2 (rare, quality-solid) — a future swap candidate if Luna proves out.

**Experiment watch (next ~10 standard-gated tasks):** reviewer tool-call time-box compliance (15 files / 25 tool calls), verdict quality as observed by the orchestrator (false approves / false rejects), wall-clock per review session vs MiMo baseline, cost per review vs the $0.435/$0.87 baseline. Rollback trigger: verdict-quality regression, cost blowup, or reviewer behavior problems — `git revert` of the model-line commit.

**Files changed:** `agents/review-code.md`, `agents/review-tests.md`, `agents/review-plan.md` (model lines), this decision, README index.

**Test coverage:** gate runs standard reviewers — which ARE the swapped models post-merge; the WO itself runs the full review gate per the keep-hard harness clause (agent-config changes never auto-skip).
