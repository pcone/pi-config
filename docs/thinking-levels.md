---
title: "Thinking-level sweet spots per fleet model"
type: reference
status: active
date: 2026-07-23
---

# Thinking-level sweet spots per fleet model

Research on reasoning-effort levels for every model in the fleet: which have a
"sweet spot" below max thinking that uses significantly fewer tokens for ~95%+
of the quality. Sources: Artificial Analysis per-effort model variants and
articles, vendor API docs (Z.ai, Moonshot, OpenAI, Xiaomi). Research date:
**2026-07-23**.

## How levels reach the fleet

- Pi thinking levels: `off, minimal, low, medium, high, xhigh, max`
  (`settings.json` → `defaultThinkingLevel: "high"`).
- Subagents are spawned with `--model` but **no `--thinking` flag**
  (`extensions/subagent-async/index.ts` → `buildSubagentArgs`), so every
  subagent inherits the session default (`high`) unless the agent frontmatter's
  `model:` uses the `provider/id:<level>` shorthand (e.g. `zai/glm-5.2:max`).
- Provider mappings (from vendor docs): **GLM-5.2** effectively has 3 real
  levels — `none`, `high`, `max` (low/medium map to high, xhigh maps to max).
  Additionally, `models.json` now carries a `thinkingLevelMap` override for
  `z-ai/glm-5.2` (`xhigh`/`max` → null, commit 9ba0e77), so GLM-5.2 is
  **clamped to `high` at the provider layer** — a `max` request degrades to
  high via clampThinkingLevel. **Kimi K3** exposes low/high/max (native
  default: max). **DeepSeek V4** exposes at least high/max (AA tracks both as
  separate variants). **MiMo V2.5 Pro** exposes **no effort control** —
  single fixed reasoning mode.

## Findings per model

| Model | Fleet roles | Real levels | Sweet spot | Evidence |
|---|---|---|---|---|
| **DeepSeek V4 Pro** | oracle | high, max | ✅ **`high`** — AA Index 43 vs 44 at max (**~98%** of max quality); high variant is also faster | [AA comparison](https://artificialanalysis.ai/models/comparisons/deepseek-v4-pro-high-vs-deepseek-v4-pro) |
| **DeepSeek V4 Flash / 0731** | implement-pro, scouts, compaction | high, max | ✅ **`high`** (presumed — same AA variant structure as V4 Pro; exact scores behind JS-rendered pages, single-source) | [AA flash-high](https://artificialanalysis.ai/models/deepseek-v4-flash-high) |
| **GPT-5.6 Luna** | *(not in fleet — orchestrator ceiling)* | low, med, high, xhigh, max | ✅ **`high`** — 90.2% of max quality (46 vs 51 AA Index) at **42% of the tokens** (8k vs 19k/task), $0.09 vs $0.21/task. xhigh: 96.1% at 63%. Graceful degradation, no cliff | [AA GPT-5.6 analysis](https://artificialanalysis.ai/articles/gpt-5-6-has-landed), [dataset gist](https://gist.github.com/IgorWarzocha/60bfd11731f15cf8802f0b6e80d47ac7) |
| **GLM-5.2** | orchestrator, review-*-deep | none, high, max | ⚠️ **Unknown — data gap.** All published numbers (AA Index 51, 43k output tokens/task) are at **max**; nothing published at high | [Z.ai thinking docs](https://docs.z.ai/guides/capabilities/thinking), [AA article](https://artificialanalysis.ai/articles/glm-5-2-is-the-new-leading-open-weights-model-on-the-artificial-analysis-intelligence-index) |
| **Kimi K3** | main session | low, high, max (default max) | ⚠️ **Unknown — data gap.** All benchmarks at max (AA Index 57, ~132M output tokens across the suite); low/high added post-launch with no published comparisons | [Moonshot reasoning-effort guide](https://platform.kimi.ai/docs/guide/use-reasoning-effort), [K3 blog](https://www.kimi.com/blog/kimi-k3), [AA article](https://artificialanalysis.ai/articles/kimi-k3-achieves-3-in-the-artificial-analysis-intelligence-index-comparable-to-opus-4-8-and-gpt-5-5) |
| **MiMo V2.5 Pro** | review-code/plan/tests (standard) | — | 🚫 **No effort control** exposed by vendor or OpenRouter; nothing to tune | [product page](https://mimo.xiaomi.com/mimo-v2-5-pro/), [OpenRouter](https://openrouter.ai/xiaomi/mimo-v2.5-pro) |

No model with data shows a cliff between high and max. The only real cliff is
GLM-5.2 at `none`/`minimal`, which disables chain-of-thought entirely.

## What this means for current assignments

1. **DeepSeek fleet (implement-pro, oracle, scouts,
   compaction) — already at the sweet spot.** They inherit `high` from
   `defaultThinkingLevel`, and `high` is the documented ~98%-of-max level for
   V4 Pro. Now deliberate rather than accidental: do not raise these to max.
   (Flash slots moved to the 0731 checkpoint 2026-08-01 — the level mapping
   carries over unchanged; see decisions/subagents/011.)
2. **GLM-5.2 (orchestrator + 3 deep reviewers) — keep `high` (decided
   2026-07-23), enforced at the provider layer.** They inherit `high` from
   `defaultThinkingLevel`, and the `thinkingLevelMap` override in models.json
   (commit 9ba0e77) maps `xhigh`/`max` to null for `z-ai/glm-5.2`, so no code
   path can accidentally escalate GLM spend. Every published GLM-5.2 number
   is at `max`, so the quality delta at `high` is unmeasured — but `max` is
   known to use substantially more tokens and think much longer, and that
   cost/latency is certain while the quality gain is hypothetical. Decision:
   the unmeasured upside isn't worth the measured downside; stay on `high`,
   revisit only if Z.ai publishes high-effort benchmarks showing a real gap.
3. **Kimi K3 main session — keep `high`.** No data exists to price the gap;
   bump to `max` (Shift+Tab) interactively when a session needs it. Note that
   K3's headline benchmarks are all at max.
4. **MiMo V2.5 Pro — nothing to set** (no effort control).
5. **If GPT-5.6 Luna ever enters the fleet, run it at `high`** — the only
   fully-quantified sweet spot (90% quality / 42% tokens / 43% cost).

## Caveats

- AA's Intelligence Index deltas (43 vs 44) are within-run aggregates, not
  per-task guarantees; treat "~98%" as directional.
- DeepSeek V4 Flash's per-effort scores live behind JS-rendered AA pages; the
  high≈max pattern is inferred from the V4 Pro pair and AA's variant naming.
- Effort levels are per-request; nothing here changes provider pricing, only
  token volume.
