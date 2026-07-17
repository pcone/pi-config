---
title: "Role-fit scores: Orchestrator / Implementer / Oracle"
type: reference
status: active
date: 2026-07-16
---

# Role-fit scores for OpenRouter models

Combined per-role **quality** scores plus a **cost** score for a cost-conscious set of
OpenRouter models, scored against role-specific benchmark priorities for three roles:
**Orchestrator** (session driver / planner), **Implementer** (worker / coder),
**Oracle** (deep math / algorithm reasoner), and **Reviewer** (adversarial review, split
into *review-code* and *review-tests*). Weightings reflect explicit steering
(see [Role definitions](#role-definitions--weights)).

- **Quality score (0–100)** — star-weighted composite of role-relevant benchmarks. A
  *relative* score, not an absolute capability %.
- **Cost score ($/M)** — blended price per million tokens at a **95/5 input/output split
  and 98% cache-hit rate**. (Input-heavy because these roles re-read a large cached
  context each turn; the ratio is a one-line knob in `role_scores.py`.) Lower is better.
- **Confidence** — how much *standalone* benchmark data backs each role score
  (see [Confidence & "unknown"](#confidence--unknown)).

Computed by [`role_scores.py`](data/role_scores.py); raw values in
[`role_scores.json`](data/role_scores.json). Data snapshot: **2026-07-16**.

---

## TL;DR — value-tier picks (cost-conscious set, flagships excluded)

| Role | Top pick | Best value | Notes |
|---|---|---|---|
| **Orchestrator** | **GPT-5.6 Luna** (92.7, $0.41, 1M) | **GLM-5.2** (81.3, $0.34, 1M) | Both 1M context. Grok 4.5 scores 85.6 but only 500K ctx. IF-strong mid-tier: MiniMax-M3 (best IFBench in set, $0.12). |
| **Implementer** | **Grok 4.5** (99.1, $0.80) | **GLM-5.2** (80.8, $0.34) · **DeepSeek V4 Pro** (47.8, **$0.055**) | Balanced blend now rewards self-contained coding → DeepSeek/Qwen rise. Rock-bottom workers: DeepSeek V4 Flash $0.03, DeepSeek V4 Pro $0.055. |
| **Oracle (math/algo)** | **DeepSeek V4 Pro** (91.9, verified) | **DeepSeek V4 Flash** (90.2, **$0.03**) | #1 globally on LiveCodeBench + Codeforces. GLM-5.2/Kimi show 95–99 but that's **saturated AIME only** — not trusted. |

**Two value stars, different jobs:**
- **GLM-5.2** ($0.34, 1M ctx, open weights) — the best **generalist**: top-3 on both
  Orchestrator and Implementer with solid coverage.
- **DeepSeek V4 Pro / Flash** ($0.055 / **$0.03**) — the **math/algo oracle** and a cheap
  self-contained coder; weak as an orchestrator.

> **The user's chosen stack — MiMo V2.5 Pro (orchestrator) + DeepSeek V4 Pro (implementer +
> oracle) — runs at ~$0.055/M blended.** See [cost mechanics](#a-note-on-cost--the-io-ratio).

---

## Primary table — value tier (15 cost-conscious models)

Sorted by Orchestrator. Orchestrator/Implementer normalized **within this 15-model set**
(100 = best-in-set); Oracle is an absolute math/algo %-composite (see its own table).
Cost at 95/5 I/O, 98% cache.

| Model | Orch | Impl | Oracle | $/M | Ctx | MM | Conf (O / I / Or) |
|---|--:|--:|--:|--:|--:|:--:|---|
| GPT-5.6 Luna | **92.7** | 91.1 | – | 0.412 | 1050K | ✓ | solid / solid / — |
| Grok 4.5 | 85.6 | **99.1** | – | 0.803 | 500K | ✓ | solid / solid / — |
| GLM-5.2 | 81.3 | 80.8 | 99.2 ⚠ | 0.338 | 1048K | – | solid / solid / aime-only |
| Gemini 3.5 Flash | 61.4 | 54.4 | – | 0.618 | 1048K | ✓ | solid / solid / — |
| MiniMax-M3 | 59.0 | 44.9 | – | 0.122 | 1048K | ✓ | solid / solid / — |
| Qwen3.7 Max | 52.0 | 67.8 | 91.6 | 0.524 | 1000K | – | solid / solid / **solid** |
| MiMo-V2.5-Pro | 42.4 | 36.2 | – | **0.055** | 1048K | – | solid / solid / — |
| Kimi K2.6 | 40.1 | 43.8 | 96.4 ⚠ | 0.317 | 262K | ✓ | solid / solid / aime-only |
| DeepSeek V4 Pro | 35.3 | 47.8 | **91.9** | **0.055** | 1048K | – | solid / **solid** / **solid** |
| GPT-5.4 mini | 24.5 | 1.8 ⚠ | – | 0.309 | 400K | ✓ | partial / **proxy** / — |
| Hy3 | 24.4 | 16.5 | – | 0.031 | 262K | – | solid / solid / — |
| Kimi K2.7 Code | 19.1 | 30.1 ⚠ | – | 0.327 | 262K | ✓ | partial / **proxy** / — |
| GLM-5.1 | 10.3 | 26.6 | 95.3 ⚠ | 0.337 | 202K | – | solid / partial / aime-only |
| Nex-N2-Pro | 8.8 ⚠ | 19.9 ⚠ | – | 0.078 | 262K | ✓ | **proxy** / **proxy** / — |
| DeepSeek V4 Flash | 5.5 | 30.3 | 90.2 | 0.030 | 1048K | – | solid / **solid** / **solid** |

⚠ = score is an unverified proxy (AA-index-only, AIME-only, or no role data). MM = image input.
`–` in Oracle = **no competition-math/algo eval published** (unknown, not zero).

---

## A note on cost & the I/O ratio

Cost uses a **95/5 input/output split at 98% cache hit**. These roles are input-heavy —
the orchestrator re-reads a big cached context (system prompt + session state) every turn
with small outputs — so the **cached-read price**, not nominal prompt price, dominates.

The give-away is the cache discount. Example (raw $/M): MiniMax-M3's prompt is the
*cheapest* of its peers ($0.30) but it only discounts cached tokens by 80% → cached-read
**$0.060/M**, versus MiMo V2.5 Pro / DeepSeek V4 Pro at **$0.0036/M** (99.2% off). On a
cache-heavy workload that ~16.7× gap is the whole bill.

Going more input-heavy (90/10 → 95/5) **widens** every differential, because it up-weights
the cheap cached-input and down-weights output (where models converge):

| Ratio (of MiMo) | MiniMax-M3 | GLM-5.2 | GPT-5.6 Luna |
|---|--:|--:|--:|
| 90/10 | 1.82× | 4.90× | 7.21× |
| **95/5** | **2.21×** | **6.13×** | **7.48×** |

That's why MiniMax M3 — a fine orchestrator on quality — proved too expensive per-turn
versus MiMo. **Compare models on cached-read price / blended cost, not sticker price.**

---

## Oracle — math/algo detail (value tier)

Only 6 of 15 value models published *any* competition-math/algorithm eval. The composite
is a weighted % of LiveCodeBench (×5) · IMO/HMMT (×4) · AIME (×3). **AIME is saturated**
(most capable models hit 95–100%), so it barely discriminates — the real signal is
LiveCodeBench, Codeforces, and IMO/HMMT.

| Model | LiveCodeBench | IMO/HMMT | AIME | Codeforces | Score | Evidence |
|---|--:|--:|--:|--:|--:|---|
| DeepSeek V4 Pro | **93.5** | 89.8 | – | **3206** | 91.9 | ✅ hard/algo — #1 globally |
| Qwen3.7 Max | 91.6 | – | – | – | 91.6 | ✅ algo only |
| DeepSeek V4 Flash | 91.6 | 88.4 | – | 3052 | 90.2 | ✅ hard/algo · **$0.03/M** |
| GLM-5.2 | – | – | 99.2 | – | 99.2 | ⚠ AIME-only (saturated) |
| Kimi K2.6 | – | – | 96.4 | – | 96.4 | ⚠ AIME-only |
| GLM-5.1 | – | – | 95.3 | – | 95.3 | ⚠ AIME-only |

**Unknown** (no math/algo eval): Grok 4.5, GPT-5.6 Luna, Gemini 3.5 Flash, MiniMax-M3,
MiMo-V2.5-Pro, Kimi K2.7 Code, Hy3, Nex-N2-Pro, GPT-5.4 mini.

**Read by evidence, not raw score.** GLM-5.2 tops the number (99.2) but on saturated AIME
alone; **DeepSeek V4 Pro is the true math/algo oracle** — #1 on contamination-free
LiveCodeBench (93.5) and Codeforces (3206), plus IMO 89.8 / HMMT 95.2. **DeepSeek V4 Flash
delivers ~99% of that for $0.03/M.**

---

## Role definitions & weights

Star weights → numeric; normalization noted per benchmark
(`mm` = min-max within set, `raw` = raw %/100 for sparsely-reported benchmarks).

### Orchestrator — *balanced* (planning leads, execution counts)
AA-LCR ×5 `mm` · AA Intelligence Index ×5 `mm` · **IFBench ×4 `raw`** · Terminal-Bench 2.0
×4 `mm` · SWE-bench Pro ×3 `mm` · AA Agentic Index ×3 `mm`.
Context window & MCP are separate columns (soft, not gated). **AA-Omniscience**
(hallucination) requested but **unpublished for every value-tier model** — carried as an
informational column (flagships only), not in the composite.

- **GPT-5.6 Luna (92.7, $0.41, 1M)** — strong across long-context, reasoning, IF, and
  agentic tool-use; cheap; 1M context; native MCP. Best all-round orchestrator in the tier.
- **GLM-5.2 (81.3, $0.34, 1M)** — best pure value; open weights.
- **Grok 4.5 (85.6)** — high, but **500K context** is marginal for long sessions.
- **IF-strong mid-tier:** MiniMax-M3 (IFBench 82.9, best in set — matters most for writing
  unambiguous subagent specs; $0.12) and Gemini 3.5 Flash (IFBench 76.3).
- **User's pick: MiMo V2.5 Pro (42.4, $0.055)** — mid-pack overall but strong long-context
  (AA-LCR 73.3) at rock-bottom cost; IFBench unpublished, so verify spec precision in use.

### Implementer — *balanced blend* (repo-SWE ≈ self-contained coding)
SWE-bench Pro ×5 `mm` · **LiveCodeBench ×5 `raw`** · AA Coding Index ×4 `mm` · SWE-bench
Verified ×3 `mm` · Terminal-Bench 2.0 ×3 `mm` · **IFBench ×2 `raw`**.
Cost is the second axis (parallel-worker throughput economics).

- **Grok 4.5 (99.1, $0.80)** — top quality; **GPT-5.6 Luna (91.1, $0.41)** close and cheaper.
- **GLM-5.2 (80.8, $0.34)** — the throughput sweet spot.
- **Self-contained coding value:** **DeepSeek V4 Pro (47.8, $0.055)** and **Qwen3.7 Max
  (67.8, $0.52)** rose once LiveCodeBench was weighted in. **DeepSeek V4 Flash (30.3, $0.03)**
  is the cheapest capable worker. (DeepSeek's edge is algorithmic more than large-repo SWE.)

### Oracle — *math/algo focused*
LiveCodeBench ×5 · IMO/HMMT ×4 · AIME ×3 (raw weighted %). HLE and GPQA-Diamond were
**removed** — they measure science *knowledge*, not math/algorithms. **DeepSeek V4 Pro /
Flash** are the picks; the AIME-only leaders are flagged.

---

## Confidence & "unknown"

Every model has the three AA composite indices (100% coverage), which internally embed the
role benchmarks — so no score is *baseless*. The flag measures **standalone corroboration**:

- **solid** — most standalone role benchmarks published; measured.
- **partial** — one standalone benchmark; the rest lean on the AA index.
- **proxy (⚠)** — no standalone role benchmark → AA-index-only estimate = **"unknown."**
- Oracle-specific: **aime-only (⚠)** = only saturated AIME; **`–`** = no math/algo eval.

**Treat as effectively unknown:**

| Model | Unknown for | Why |
|---|---|---|
| **Nex-N2-Pro** | all three | On no granular leaderboard; AA-index only. |
| **9 value models** | Oracle | No competition-math/algo eval (Grok 4.5, GPT-5.6 Luna, Gemini 3.5 Flash, MiniMax-M3, MiMo, Kimi K2.7, Hy3, Nex-N2, GPT-5.4 mini). |
| **GLM-5.2 / Kimi K2.6 / GLM-5.1** | Oracle rigor | Only saturated AIME — high number, weak evidence. |
| **GPT-5.4 mini / Kimi K2.7 Code** | Implementer | No SWE / LiveCodeBench data. |

Pattern: the newest agentic-tuned models (GPT-5.6 Luna, Grok 4.5, Sonnet 5) stopped
publishing classic academic benchmarks (GPQA/HLE/AIME/IFBench), reporting only
agentic/coding evals — which is why Oracle and IFBench are the thinnest-covered axes.

---

## Appendix A — full frontier (all 25, incl. flagships)

Reference "ceiling." Normalized **within all 25**, so **not comparable** to the value-tier
table. Flagships excluded from the primary analysis on cost grounds. Cost at 95/5 I/O.
Sorted by Orchestrator.

| Model | Orch | Impl | Oracle | $/M | Ctx | Conf (O/I/Or) |
|---|--:|--:|--:|--:|--:|---|
| GPT-5.6 Sol | 89.4 | 76.6 | – | 2.061 | 1050K | solid/solid/— |
| Claude Fable 5 | 88.9 | 94.8 | – | 3.621 | 1000K | solid/solid/— |
| GPT-5.6 Terra | 78.9 | 70.7 | – | 1.030 | 1050K | solid/solid/— |
| GPT-5.5 | 72.4 | 59.5 | – | 2.061 | 1050K | solid/solid/— |
| GPT-5.6 Luna | 71.4 | 59.6 | – | 0.412 | 1050K | solid/solid/— |
| Claude Sonnet 5 | 67.7 | 56.6 | – | 0.724 | 1000K | solid/solid/— |
| Claude Opus 4.8 | 66.5 | 67.6 | – | 1.810 | 1000K | solid/solid/— |
| Grok 4.5 | 65.6 | 62.5 | – | 0.803 | 500K | solid/solid/— |
| GLM-5.2 | 63.8 | 52.2 | 99.2 ⚠ | 0.338 | 1048K | solid/solid/aime-only |
| GPT-5.4 | 63.4 | 41.8 | – | 1.030 | 1050K | solid/partial/— |
| Claude Opus 4.7 | 60.9 | 57.0 | – | 1.810 | 1000K | solid/solid/— |
| Gemini 3.5 Flash | 54.9 | 41.3 | – | 0.618 | 1048K | solid/solid/— |
| Gemini 3.1 Pro | 52.4 | 53.7 | – | 0.824 | 1048K | solid/solid/— |
| MiniMax-M3 | 52.3 | 30.4 | – | 0.122 | 1048K | solid/solid/— |
| Qwen3.7 Max | 47.6 | 52.8 | 91.6 | 0.524 | 1000K | solid/solid/solid |
| MiMo-V2.5-Pro | 39.8 | 23.1 | – | 0.055 | 1048K | solid/solid/— |
| Kimi K2.6 | 37.3 | 26.9 | 96.4 ⚠ | 0.317 | 262K | solid/solid/aime-only |
| DeepSeek V4 Pro | 34.0 | 39.2 | 91.9 | 0.055 | 1048K | solid/solid/solid |
| GPT-5.4 mini | 33.1 | 1.4 ⚠ | – | 0.309 | 400K | partial/proxy/— |
| Hy3 | 30.4 | 15.1 | – | 0.031 | 262K | solid/solid/— |
| Kimi K2.7 Code | 29.4 | 23.1 ⚠ | – | 0.327 | 262K | partial/proxy/— |
| Claude Sonnet 4.6 | 27.6 | 29.9 | – | 1.086 | 1000K | partial/partial/— |
| GLM-5.1 | 17.8 | 11.8 | 95.3 ⚠ | 0.337 | 202K | solid/partial/aime-only |
| Nex-N2-Pro | 14.2 | 15.3 ⚠ | – | 0.078 | 262K | proxy/proxy/— |
| DeepSeek V4 Flash | 14.2 | 27.6 | 90.2 | 0.030 | 1048K | solid/solid/solid |

Flagship ceiling: Claude Fable 5 / GPT-5.6 Sol lead Orchestrator+Implementer, but at
**~7–66× the cost** of MiMo / DeepSeek for a modest quality delta — and neither publishes
math/algo evals, so they're unknown as oracles too.

---

## Appendix B — raw benchmark data & coverage

Per-benchmark coverage across the 25 models (blank = no published/tracked score).

| Benchmark | Role use | Norm | Coverage | Source(s) |
|---|---|:--:|--:|---|
| AA Intelligence Index | Orch | mm | 25/25 | OpenRouter `/benchmarks` (Artificial Analysis) — local cache |
| AA Coding Index | Impl | mm | 25/25 | OpenRouter `/benchmarks` — cache |
| AA Agentic Index | Orch | mm | 25/25 | OpenRouter `/benchmarks` — cache |
| AA-LCR (long context) | Orch | mm | 24/25 | Artificial Analysis / BenchLM |
| Terminal-Bench 2.0 | Orch, Impl | mm | 19/25 | BenchLM |
| SWE-bench Pro | Orch, Impl | mm | 19/25 | BenchLM / morphllm |
| SWE-bench Verified | Impl | mm | ~15/25 | BenchLM / web (saturated) |
| IFBench | Orch, Impl | raw | 4/25 | BenchLM / Artificial Analysis |
| LiveCodeBench | Impl, Oracle | raw | 3/25 | framia / BenchLM / web |
| IMO-AnswerBench / HMMT | Oracle | raw | 2/25 | framia (DeepSeek) |
| AIME 2025/26 | Oracle | raw | 3/25 | BenchLM |
| Codeforces (rating) | Oracle (info) | — | 2/25 | framia |
| AA-Omniscience | Orch (info) | — | 3/25 (flagships) | Artificial Analysis / llm-stats |
| Pricing (prompt/cache-read/completion) | Cost | — | 25/25 | OpenRouter `/models` — cache |

**Excluded from composites** (too sparse to score the set, or off-role):

- **HLE, GPQA-Diamond** — moved *out of Oracle*: science knowledge, not math/algorithms.
- **AA-Omniscience** — 0/15 value-tier coverage; informational only.
- **τ³-Bench, LiveCodeBench Pro (Elo)** — sparse; AA Agentic / LiveCodeBench substitute.
- **Throughput (tokens/sec)** — considered, not added (per steering); cost is the value axis.

### Caveats

1. **Relative, within-set (Orch/Impl).** Min-max makes best-in-set = 100, worst = 0.
   Value-tier and full-frontier tables use different bounds and aren't cross-comparable.
2. **Saturation.** GPQA-D, SWE-Verified, AIME are compressed near the top — small real gaps
   get stretched (Orch/Impl) or dominate raw scores (AIME in Oracle). Read leads as ties.
3. **Sparse benchmarks use raw %** (IFBench, LiveCodeBench) to avoid 3–4-point min-max
   artifacts, at a mild scale-mismatch cost with the min-max benchmarks.
4. **Benchmark gaming.** A 2026 Berkeley (RDI) study showed SWE-bench Verified,
   Terminal-Bench, and others can be driven to near-perfect scores without solving tasks —
   don't over-trust any single agentic benchmark.
5. **Source consistency.** Vendor vs. SEAL scaffolds differ 15–30 pts on SWE-bench Pro; HLE
   varies with tools. BenchLM used as the primary consistent source, cross-checked.
6. **Cost basis.** Blended $/M at **95/5 I/O + 98% cache** — input-heavy because these roles
   re-read cached context each turn; cached-read price dominates. It's per-token, not
   per-resolved-task (a cheap model that fails often is expensive per success). The ratio is
   a one-line knob (`IN_RATIO`/`OUT_RATIO`) in `role_scores.py`.

### Sources

- [OpenRouter benchmarks](https://openrouter.ai/api/v1/benchmarks?source=artificial-analysis) · [models](https://openrouter.ai/api/v1/models) (local `model-tiers` cache)
- [Artificial Analysis](https://artificialanalysis.ai/) — [Intelligence Index](https://artificialanalysis.ai/evaluations/artificial-analysis-intelligence-index) · [AA-LCR](https://artificialanalysis.ai/evaluations/artificial-analysis-long-context-reasoning) · [IFBench](https://artificialanalysis.ai/evaluations/ifbench) · [AA-Omniscience](https://artificialanalysis.ai/evaluations/omniscience)
- [BenchLM.ai](https://benchlm.ai/) — swePro, terminalBench2, ifBench, lcr, sweVerified, aime, gpqaDiamond, hle
- [morphllm — SWE-bench Pro](https://www.morphllm.com/swe-bench-pro) · [framia — DeepSeek V4 benchmarks](https://framia.converge.ai/page/en-US/news/deepseek-v4-benchmarks) · [LM Council](https://lmcouncil.ai/benchmarks) · [Silicon Report — Fable 5](https://www.siliconreport.com/claude-fable-5-benchmarks-hle-swe-bench-gpqa-5c675c4e)
