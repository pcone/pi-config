---
title: "Orchestrator → GLM-5.2, compaction → DeepSeek V4 Flash"
type: decision
status: done
date: 2026-07-23
---

# Orchestrator → GLM-5.2, compaction → DeepSeek V4 Flash

**What:** Two model re-assignments from the 2026-07-23 data refresh
(`docs/model-role-scores.md`, "Role-by-role review"):

1. The orchestrator-subagent (`agents/orchestrator.md`) moves from
   `deepseek/deepseek-v4-pro` to `zai/glm-5.2`.
2. Session compaction (`extensions/compaction-model.ts`) moves from native
   `minimax/MiniMax-M3` to `openrouter/deepseek-v4-flash`.

**Why (orchestrator):** The refreshed role scores put DeepSeek V4 Pro at
**Orch 41.0** — the data has consistently shown DeepSeek is planning/IF-weak —
against **GLM-5.2 at 82.9** ($0.29/M, 1M ctx, solid standalone coverage). The
5.3× per-token multiplier buys more on the orchestrator than anywhere else:
orchestrator tokens are few relative to the implementer/reviewer tokens they
steer, and a planning failure invalidates all downstream spend. GLM-5.2 also
just had a price cut ($0.338 → $0.292/M blended), widening its value lead.
GPT-5.6 Luna (93.5, $0.41) is the quality ceiling but another 1.4× on cost
for ~10 points; GLM-5.2 is the knee of the curve.

**Why (compaction):** Compaction is a one-shot, uncached-heavy workload — the
*prompt* price dominates, not the cached-read price that drives the subagent
fleet's economics. MiniMax-M3's prompt is $0.30/M vs DeepSeek V4 Flash's
**$0.094/M (~3× cheaper)**, with the same 1M context and only a modest
AA-index gap (int 44.4 vs 40.3, cod 58.6 vs 56.2) on a task — conversation
summarization — that is not hard reasoning. M3's cache-read advantage is
irrelevant here because each compaction is a fresh, single-pass input.

**Alternatives considered:**

- **GPT-5.6 Luna for orchestrator.** Highest Orch score (93.5). Rejected:
  7.5× DeepSeek's cost vs GLM's 5.3× for a 10-point delta; GLM-5.2's
  coverage is solid across every orchestrator benchmark.
- **MiMo V2.5 Pro for orchestrator.** Cheap ($0.055) and long-context-strong,
  but Orch 51.0 — barely above DeepSeek. Doesn't fix the problem.
- **MiMo-V2.5 (non-pro) for compaction** ($0.14/M prompt). Cheaper than M3
  but dearer than Flash ($0.094), and its quality data is proxy-grade
  (AA-index only). Flash has solid standalone coverage at a lower price.
- **Keep MiniMax-M3 for compaction.** Rejected on price only; no quality
  failure observed. If Flash compactions measurably degrade session
  continuity, revert is a two-line change.
- **Hy3 anywhere.** Rejected by the data refresh: release pricing
  ($0.064/M blended) is now *above* MiMo V2.5 Pro ($0.055) at lower
  reviewer scores (34.5/36.1 vs 43.3/48.7), and its benchmark data is
  preview-only.

**Tradeoffs:**

- **Orchestrator cost per item rises ~5.3×** (absolute dollars stay small —
  orchestrators are the lowest-token role in the fleet).
- **GLM-5.2 is same-lab as the `-deep` reviewers.** The lab-decorrelation
  rule applies to implementer↔reviewer pairs, not orchestrator↔reviewer, so
  this is acceptable — but if the implementers ever move to GLM, the deep
  reviewers must move off it.
- **Compaction summarization quality is unmeasured on Flash.** Mitigated by
  the task being low-difficulty and the revert path being trivial.
- **MiniMax plan usage drops.** The `footer-session-id` quota segment for
  MiniMax now tracks a plan whose main consumer (compaction) is gone. Left
  in place deliberately — M3 remains available for interactive use.

**Files changed:**

- `agents/orchestrator.md` — `model: deepseek/deepseek-v4-pro` → `zai/glm-5.2`;
  subsequently re-routed to `openrouter/z-ai/glm-5.2` (commit dd425ff) so it
  uses the models.json routing override like the `-deep` reviewers
- `extensions/compaction-model.ts` — provider/id → `openrouter` /
  `deepseek/deepseek-v4-flash`; header comment updated with rationale
- `models.json` — stale cost overrides corrected to the 2026-07-22 OpenRouter
  snapshot: `z-ai/glm-5.2` (0.96/3.01/0.18 → 0.836/2.627/0.1552) and
  `deepseek/deepseek-v4-flash` (0.14/0.28/0.0028 → 0.094/0.188/0.0188)
- `docs/model-role-scores.md` — role-by-role review updated; data refreshed
- `docs/data/role_scores.py` / `role_scores.json` — refreshed pricing,
  three new value-tier candidates, Kimi K3 added to frontier set

**Verification:** `tsc --noEmit` on the edited extension; `bun test tests/` —
72/72 pass.

> **Partially superseded (2026-08-01):** the `models.json` cost overrides this
> decision corrected are now removed — pricing flows from the pi.dev remote
> catalog (live OpenRouter `/models` mirror) instead. The model *assignments*
> (orchestrator → GLM-5.2, compaction → flash) stand; see
> [decision/010-pricing-source-pi-dev-catalog](010-pricing-source-pi-dev-catalog.md).
