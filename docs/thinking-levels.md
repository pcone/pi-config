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
  `model:` uses the `provider/id:<level>` shorthand (e.g. `zai/glm-5.3-flash:high`).
  The fleet sets effort per agent this way (decision 020: implement `:high`, scouts
  `:medium`, reviewers/oracle `:max`, orchestrator `zai/glm-5.3:high`); the
  `/fleet-model` toggle preserves the suffix (`zai/glm-5.3-flash:high` →
  `deepseek/deepseek-v4-flash-0731:high`).
- Provider mappings: **GLM-5.3(-flash) via zai** (pi catalog `thinkingLevelMap`, verified in `models-store.json` + live smoke spawn 2026-08-28): `low`→low (real, cheaper), `medium`→**null** (unsupported — falls back to the *provider's* default, `high`, not the session default), `high`→high, `xhigh`→**null**, `max`→max. So `:medium` frontmatter is inert on zai today (effective = provider default `high`); `low` is the only real sub-high tier. **DeepSeek V4** (official docs): low→low, medium/high/xhigh→high, max→max — `medium` is likewise effectively high there.

## Findings per model

| Model | Fleet roles | Real levels | Sweet spot | Evidence |
|---|---|---|---|---|
| **DeepSeek V4 Pro** | oracle | high, max | ✅ **`high`** — AA Index 43 vs 44 at max (**~98%** of max quality); high variant is also faster | [AA comparison](https://artificialanalysis.ai/models/comparisons/deepseek-v4-pro-high-vs-deepseek-v4-pro) |
| **DeepSeek V4 Flash / 0731** | toggle-back target for the flash seat (`/fleet-model deepseek`) | high, max | ✅ **`high`** (presumed — same AA variant structure as V4 Pro; exact scores behind JS-rendered pages, single-source) | [AA flash-high](https://artificialanalysis.ai/models/deepseek-v4-flash-high) |
| **GPT-5.6 Luna** | *(not in fleet — orchestrator ceiling)* | low, med, high, xhigh, max | ✅ **`high`** — 90.2% of max quality (46 vs 51 AA Index) at **42% of the tokens** (8k vs 19k/task), $0.09 vs $0.21/task. xhigh: 96.1% at 63%. Graceful degradation, no cliff | [AA GPT-5.6 analysis](https://artificialanalysis.ai/articles/gpt-5-6-has-landed), [dataset gist](https://gist.github.com/IgorWarzocha/60bfd11731f15cf8802f0b6e80d47ac7) |
| **GLM-5.3 / GLM-5.3-flash** | orchestrator (5.3), flash seat (5.3-flash) | none, high, max | ✅ **effort per seat (decision 020):** orchestrator `:high`, implement `:high`, scouts `:medium`, reviewers/oracle `:max` — set via `provider/model:level`, not the session default | [Z.ai thinking docs](https://docs.z.ai/guides/capabilities/thinking) |
| **Kimi K3** | main session | low, high, max (default max) | ⚠️ **Unknown — data gap.** All benchmarks at max (AA Index 57, ~132M output tokens across the suite); low/high added post-launch with no published comparisons | [Moonshot reasoning-effort guide](https://platform.kimi.ai/docs/guide/use-reasoning-effort), [K3 blog](https://www.kimi.com/blog/kimi-k3), [AA article](https://artificialanalysis.ai/articles/kimi-k3-achieves-3-in-the-artificial-analysis-intelligence-index-comparable-to-opus-4-8-and-gpt-5-5) |
| **MiMo V2.5 Pro** | *(not in fleet)* | — | 🚫 **No effort control** exposed by vendor or OpenRouter; nothing to tune | [product page](https://mimo.xiaomi.com/mimo-v2-5-pro/), [OpenRouter](https://openrouter.ai/xiaomi/mimo-v2.5-pro) |

No model with data shows a cliff between high and max. The only real cliff is
GLM-5.x at `none`/`minimal`, which disables chain-of-thought entirely.

> **2026-08-28 (decision 020):** fleet moved — GLM-5.2 out (replaced by GLM-5.3 /
> GLM-5.3-flash), deep reviewers deleted, and per-agent effort now rides the
> `provider/model:level` shorthand instead of the session default or the
> `thinkingLevelMap` provider clamp (that clamp and the old z-ai models.json entry
> were removed with the prune).

## Addendum — DeepSeek 0813 high-vs-max, and the real zai level map (2026-08-28)

Two research findings that post-date the table above:

**1. Oracle effort `max` is correct — the composite AA delta hides the math
profile.** The earlier "`high` is the V4 Pro sweet spot" guidance rested on the
AA *composite* (44 high vs 45 max on the April preview, index v4.1.1; the
43/44 in our notes was v4.0 drift). The vendor's Table 7 ablation (arxiv
2606.19348, *preview-era*, self-reported) on exactly the oracle seat's evals:
high→max = Apex **+10.9**, Codeforces **+287 rating**, Apex-Shortlist +4.7,
LiveCodeBench +3.7, HMMT +1.2 — and **all 0813-published numbers are
max-effort** (AA 53, HLE 42.7, HMMT 95.2, MathArena AIME 96.67). The param
is honored (official mapping low→low, medium/high/xhigh→high, max→max; the
0813 card introduces 3-level control as new). Caveats: max evals ran 384K ctx
vs 128K for high (part of the delta is context); one −0.6 regression
(MCPAtlas); no 0813-specific high-vs-max dataset exists yet. Cost at oracle
call volume is a non-issue (~$0.004/K thinking tokens; max even decodes
faster, 66 vs 63 t/s). Decisive follow-up if ever needed: 10-problem AIME/HMMT
slice at both efforts through our OpenRouter route, logging reasoning tokens.
(Research: scout-web session subagent-520b5fa4.)

**2. The zai level map is narrower than assumed above.** pi's catalog
(`models-store.json`) maps GLM: `low`→low (real, cheaper), `medium`→**null**,
`xhigh`→**null**, `high`→high, `max`→max — there is no real `medium`; a
`:medium` request falls back to the provider's default. **Post-merge E2E
confirmed it live — twice:** `scout-code` and `scout-web` spawns
(`zai/glm-5.3-flash:medium`) ran on the real endpoint at effective `high`,
including one under `defaultThinkingLevel: max` — the fallback is the
provider default, not the session default. Scouts are therefore pinned to
GLM-high regardless of session-default flips; `:medium` stays in frontmatter
as intent + future-proofing (if z.ai ships a real medium, pi's catalog map
picks it up). The cheaper real option is `:low` — untested quality for
research tasks, data gap; revisit only if scout token spend matters.

## What this means for current assignments

1. **Flash seat (implement, scouts ×2, reviewers ×3, compaction) — effort per
   seat via the `provider/model:level` shorthand (decision 020).** The seat runs
   `zai/glm-5.3-flash` with implement `:high`, scouts `:medium`, reviewers `:max`;
   compaction rides the seat's default thinking. The `/fleet-model deepseek` toggle
   preserves the level suffix, and 0731 supports the same level set. Do not raise
   implement/scouts toward max — `high`/`medium` are the deliberate levels.
2. **Orchestrator — `zai/glm-5.3:high` (decision 020).** 016's follow-up intent:
   cap orchestrator reasoning spend. Every published GLM-5.x number is at `max`, so
   the quality delta at `high` is unmeasured — but `max` is known to use
   substantially more tokens and think much longer, and that cost/latency is
   certain while the quality gain is hypothetical. Stay on `high`; revisit only if
   Z.ai publishes high-effort benchmarks showing a real gap.
3. **Oracle — `deepseek/deepseek-v4-pro-0813:max` (decision 020, user directive).**
   The seat's whole job is the hardest reasoning tail; no math-specific GLM-5.x
   data exists to challenge the DeepSeek record (watch item in 020).
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
