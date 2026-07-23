---
title: "Role-fit scores: Orchestrator / Implementer / Oracle / Reviewer"
type: reference
status: active
date: 2026-07-23
---

# Role-fit scores for OpenRouter models

Combined per-role **quality** scores plus a **cost** score for a cost-conscious set of
OpenRouter models, scored against role-specific benchmark priorities for five roles:
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
[`role_scores.json`](data/role_scores.json). Data snapshot: **2026-07-23** (OpenRouter
models + Artificial Analysis cache fetched 2026-07-22).

> **2026-07-23 refresh — read before comparing to the 2026-07-16 snapshot:**
> 1. **Pricing corrections.** Hy3's row used *preview* pricing; the 2026-07-06 release
>    is ~2.8× more expensive on every meter ($0.031 → **$0.064/M** blended — now *more*
>    expensive than MiMo V2.5 Pro). GLM-5.2 was *cut* ($0.338 → **$0.292/M**), as was
>    Grok 4.5's cache-read ($0.803 → **$0.617/M** blended).
> 2. **Three new value-tier members** (Qwen3.7 Plus, GPT-5.4 nano, MiMo-V2.5 non-pro)
>    widened the min-max bounds, so **scores are not cross-comparable with the
>    2026-07-16 snapshot** — within-set normalization shifted (e.g. MiMo V2.5 Pro's
>    Orch "rise" from 42.4 to 51.0 is a bounds artifact, not new capability).
> 3. **Kimi K3 added to the frontier appendix** (the main-session driver; released
>    2026-07-15, after the last snapshot).

---

## TL;DR — value-tier picks (cost-conscious set, flagships excluded)

| Role | Top pick | Best value | Notes |
|---|---|---|---|
| **Orchestrator** | **GPT-5.6 Luna** (93.5, $0.41, 1M) | **GLM-5.2** (82.9, $0.29, 1M) | Both 1M context. Grok 4.5 scores 85.6 but only 500K ctx. IF-strong mid-tier: MiniMax-M3 (best IFBench in set, $0.12). |
| **Implementer** | **Grok 4.5** (99.1, $0.62) | **GLM-5.2** (80.8, $0.29) · **DeepSeek V4 Pro** (47.8, **$0.055**) | Balanced blend rewards self-contained coding → DeepSeek/Qwen rise. Rock-bottom workers: DeepSeek V4 Flash $0.029. |
| **Oracle (math/algo)** | **DeepSeek V4 Pro** (91.9, verified) | **DeepSeek V4 Flash** (90.2, **$0.029**) | #1 globally on LiveCodeBench + Codeforces. GLM-5.2/Kimi show 95–99 but that's **saturated AIME only** — not trusted. |
| **Reviewer (deep)** | **GLM-5.2** (R-code 79.5 / R-test 79.9, $0.29) | — | Best non-flagship reviewer by a wide margin; price cut widened its value lead. |
| **Reviewer (standard)** | **MiMo V2.5 Pro** (43.3 / 48.7, **$0.055**, 1M) | — | Cheapest *decorrelated-from-DeepSeek* reviewer with solid standalone data. Hy3 is now both weaker (34.5/36.1) **and** pricier ($0.064). |

**Two value stars, different jobs:**
- **GLM-5.2** ($0.29, 1M ctx, open weights) — the best **generalist**: top-3 on
  Orchestrator, Implementer, and Reviewer with solid coverage.
- **DeepSeek V4 Pro / Flash** ($0.055 / **$0.029**) — the **math/algo oracle** and a cheap
  self-contained coder; weak as an orchestrator (41.0) and same-lab as the implementers
  (so unusable as their reviewer).

**Current assignments vs. the data** (see [Role-by-role review](#role-by-role-review-2026-07-23)):

| Slot | Agent file | Model | Verdict |
|---|---|---|---|
| Main session | `settings.json` | kimi-k3 | ✓ strong (frontier-class; see appendix) |
| Orchestrator-subagent | `agents/orchestrator.md` | glm-5.2 | ✓ switched 2026-07-23 (was deepseek-v4-pro, Orch 41.0 — the weakest link) |
| Implementer (pro/flash) | `agents/implement-{pro,flash}.md` | deepseek-v4-pro / -flash | ✓ value picks hold |
| Oracle | `agents/math-algo-oracle.md` | deepseek-v4-pro | ✓ correct |
| Review standard ×3 | `agents/review-{code,plan,tests}.md` | mimo-v2.5-pro | ✓ confirmed (Hy3 now worse *and* dearer) |
| Review deep ×3 | `agents/review-*-deep.md` | glm-5.2 | ✓ price cut helps |
| Scouts ×2 | `agents/scout-{code,web}.md` | deepseek-v4-flash | ✓ fine |
| Compaction | `extensions/compaction-model.ts` | deepseek-v4-flash | ✓ switched 2026-07-23 (was minimax-m3, 3× dearer on uncached input) |

---

## Primary table — value tier (18 cost-conscious models)

Sorted by Orchestrator. Orchestrator/Implementer normalized **within this 18-model set**
(100 = best-in-set); Oracle is an absolute math/algo %-composite (see its own table).
Cost at 95/5 I/O, 98% cache.

| Model | Orch | Impl | Oracle | $/M | Ctx | MM | Conf (O / I / Or) |
|---|--:|--:|--:|--:|--:|:--:|---|
| GPT-5.6 Luna | **93.5** | 91.1 | – | 0.412 | 1050K | ✓ | solid / solid / — |
| Grok 4.5 | 85.6 | **99.1** | – | 0.617 | 500K | ✓ | solid / solid / — |
| GLM-5.2 | 82.9 | 80.8 | 99.2 ⚠ | 0.292 | 1048K | – | solid / solid / aime-only |
| Gemini 3.5 Flash | 64.4 | 54.4 | – | 0.618 | 1048K | ✓ | solid / solid / — |
| MiniMax-M3 | 64.0 | 44.9 | – | 0.122 | 1048K | ✓ | solid / solid / — |
| Qwen3.7 Max | 57.8 | 67.8 | 91.6 | 0.524 | 1000K | – | solid / solid / **solid** |
| MiMo-V2.5-Pro | 51.0 | 36.2 | – | **0.055** | 1048K | – | solid / solid / — |
| Kimi K2.6 | 47.6 | 43.8 | 96.4 ⚠ | 0.318 | 262K | ✓ | solid / solid / aime-only |
| DeepSeek V4 Pro | 41.0 | 47.8 | **91.9** | **0.055** | 1048K | – | solid / **solid** / **solid** |
| GPT-5.4 mini | 38.2 | 1.8 ⚠ | – | 0.309 | 400K | ✓ | partial / **proxy** / — |
| Hy3 | 32.4 | 16.5 | – | 0.064 | 262K | – | solid¹ / solid¹ / — |
| Kimi K2.7 Code | 32.2 | 30.1 ⚠ | – | 0.352 | 262K | ✓ | partial / **proxy** / — |
| Nex-N2-Pro | 29.7 | 19.9 ⚠ | – | 0.078 | 262K | ✓ | **proxy** / **proxy** / — |
| GLM-5.1 | 21.5 | 26.6 | 95.3 ⚠ | 0.337 | 202K | – | solid / partial / aime-only |
| DeepSeek V4 Flash | 14.0 | 30.3 | 90.2 | **0.029** | 1048K | – | solid / **solid** / **solid** |
| GPT-5.4 nano | 13.9 | 1.8 ⚠ | – | 0.085 | 400K | ✓ | **proxy** / **proxy** / — |
| Qwen3.7 Plus | 6.8 | 0.6 ⚠ | – | 0.130 | 1000K | ✓ | **proxy** / **proxy** / — |
| MiMo-V2.5 | 4.4 | 6.0 ⚠ | – | **0.019** | 1048K | ✓ | **proxy** / **proxy** / — |

⚠ = score is an unverified proxy (AA-index-only, AIME-only, or no role data). MM = image input.
`–` in Oracle = **no competition-math/algo eval published** (unknown, not zero).
¹ Hy3's standalone benchmarks are for the **preview**; the release has no AA evals yet, and
release pricing is ~2.8× the preview's. Treat the whole row as stale.

**New members, read carefully:**
- **MiMo-V2.5 (non-pro)** — $0.019/M, cheapest cache-read in the set ($0.0028/M), 1M ctx,
  multimodal. Composite is proxy-grade (AA indices only: int 37.2 / cod 56.8) — a
  plausible ultra-cheap scout/reviewer **candidate**, but trial before adopting.
- **Qwen3.7 Plus / GPT-5.4 nano** — no standalone role benchmarks and weak AA-agentic;
  not competitive for any role at their price.

---

## Reviewer table — value tier

Adversarial review splits into two passes (weights in
[Role definitions](#role-definitions--weights)): **review-code** (comprehension-tilt:
find bugs in the implementation) and **review-tests** (reasoning-tilt: find coverage
gaps, weak or tautological tests). "Decorr" flags lab-diversity from the DeepSeek
implementers — a same-lab reviewer is an independence risk regardless of score.

| Model | R-code | R-test | $/M | Ctx | Lab / decorr |
|---|--:|--:|--:|--:|---|
| GPT-5.6 Luna | 90.5 | 90.8 | 0.412 | 1050K | OpenAI ✓ |
| Grok 4.5 | 89.2 | 84.6 | 0.617 | 500K | xAI ✓ |
| **GLM-5.2** | **79.5** | **79.9** | 0.292 | 1048K | Zhipu ✓ |
| Gemini 3.5 Flash | 67.9 | 68.7 | 0.618 | 1048K | Google ✓ |
| Qwen3.7 Max | 63.5 | 62.6 | 0.524 | 1000K | Alibaba ✓ |
| MiniMax-M3 | 55.2 | 61.4 | 0.122 | 1048K | MiniMax ✓ |
| Kimi K2.6 | 45.9 | 48.0 | 0.318 | 262K | Moonshot ✓ |
| **MiMo-V2.5-Pro** | **43.3** | **48.7** | **0.055** | 1048K | Xiaomi ✓ |
| Hy3 | 34.5 | 36.1 | 0.064 | 262K | Tencent ✓ |
| DeepSeek V4 Pro | 30.1 | 33.0 | 0.055 | 1048K | DeepSeek ✗ same-lab |
| Kimi K2.7 Code | 30.5 | 30.7 | 0.352 | 262K | Moonshot ✓ |
| GPT-5.4 mini | 21.3 | 27.4 | 0.309 | 400K | OpenAI ✓ |
| Nex-N2-Pro | 21.2 | 21.8 | 0.078 | 262K | NexAGI ✓ |
| GLM-5.1 | 14.4 | 13.3 | 0.337 | 202K | Zhipu ✓ |
| DeepSeek V4 Flash | 7.0 | 8.9 | 0.029 | 1048K | DeepSeek ✗ same-lab |
| Qwen3.7 Plus | 5.2 | 7.0 | 0.130 | 1000K | Alibaba ✓ |
| GPT-5.4 nano | 3.7 | 4.4 | 0.085 | 400K | OpenAI ✓ |
| MiMo-V2.5 | 3.3 | 2.3 | 0.019 | 1048K | Xiaomi ✓ |

The two-tier assignment (**MiMo V2.5 Pro** standard / **GLM-5.2** deep) sits exactly on
the value frontier: MiMo is the cheapest decorrelated reviewer with solid standalone
data, and GLM-5.2 is the strongest non-flagship reviewer — now 14% cheaper than when
decision-005 was written.

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
| 90/10 | 1.82× | 4.24× | 7.21× |
| **95/5** | **2.21×** | **5.29×** | **7.48×** |

That's why MiniMax M3 — a fine orchestrator on quality — proved too expensive per-turn
versus MiMo. **Compare models on cached-read price / blended cost, not sticker price.**

---

## Oracle — math/algo detail (value tier)

Only 6 of 18 value models published *any* competition-math/algorithm eval. The composite
is a weighted % of LiveCodeBench (×5) · IMO/HMMT (×4) · AIME (×3). **AIME is saturated**
(most capable models hit 95–100%), so it barely discriminates — the real signal is
LiveCodeBench, Codeforces, and IMO/HMMT.

| Model | LiveCodeBench | IMO/HMMT | AIME | Codeforces | Score | Evidence |
|---|--:|--:|--:|--:|--:|---|
| DeepSeek V4 Pro | **93.5** | 89.8 | – | **3206** | 91.9 | ✅ hard/algo — #1 globally |
| Qwen3.7 Max | 91.6 | – | – | – | 91.6 | ✅ algo only |
| DeepSeek V4 Flash | 91.6 | 88.4 | – | 3052 | 90.2 | ✅ hard/algo · **$0.029/M** |
| GLM-5.2 | – | – | 99.2 | – | 99.2 | ⚠ AIME-only (saturated) |
| Kimi K2.6 | – | – | 96.4 | – | 96.4 | ⚠ AIME-only |
| GLM-5.1 | – | – | 95.3 | – | 95.3 | ⚠ AIME-only |

**Unknown** (no math/algo eval): Grok 4.5, GPT-5.6 Luna, Gemini 3.5 Flash, MiniMax-M3,
MiMo-V2.5-Pro, Kimi K2.7 Code, Hy3, Nex-N2-Pro, GPT-5.4 mini, Qwen3.7 Plus, GPT-5.4
nano, MiMo-V2.5.

**Read by evidence, not raw score.** GLM-5.2 tops the number (99.2) but on saturated AIME
alone; **DeepSeek V4 Pro is the true math/algo oracle** — #1 on contamination-free
LiveCodeBench (93.5) and Codeforces (3206), plus IMO 89.8 / HMMT 95.2. **DeepSeek V4 Flash
delivers ~98% of that for $0.029/M.**

---

## Role-by-role review (2026-07-23)

Current assignments audited against the refreshed data:

1. **Main session — `kimi-k3` ($1.09/M blended).** Frontier-class (in the full-set
   normalization: Orch 87.9, Impl 94.4 — between GPT-5.6 Terra and GPT-5.6 Sol) at half
   GPT-5.5's price. AA-index-only confidence (released 2026-07-15; no standalone evals
   yet), but nothing at its price comes close for the human-facing driver. **Keep.**
2. **Orchestrator-subagent — switched to `glm-5.2` ($0.29) on 2026-07-23** (was
   `deepseek-v4-pro`, Orch 41.0 — the weakest link; the data has always said DeepSeek is
   a weak orchestrator on planning/IF/agentic weighting). GLM-5.2 (82.9, 1M ctx) more
   than doubles the quality score for 5.3× the per-token cost — and orchestrator tokens
   are few relative to the implementer/reviewer tokens they steer, so the multiplier
   buys more here than anywhere else. GPT-5.6 Luna (93.5, $0.41) remains the ceiling.
   See `decisions/subagents/008-orchestrator-compaction-models.md`. (Note: this doc's
   old TL;DR claimed the stack was "MiMo (orchestrator)" — that was stale;
   `agents/orchestrator.md` had been DeepSeek V4 Pro since its first commit.)
3. **Implementers — `deepseek-v4-pro` ($0.055) / `deepseek-v4-flash` ($0.029). ✓ Keep.**
   The balanced blend still rewards them; GLM-5.2 (80.8, $0.29) is the upgrade path if
   implementer rework loops get expensive. Grok 4.5 (99.1) got cheaper ($0.62) but is
   still 11× DeepSeek Pro.
4. **Oracle — `deepseek-v4-pro`. ✓ Correct.** Only verified hard-math/algo leader.
5. **Review standard — `mimo-v2.5-pro` ($0.055). ✓ Keep; re-confirmed against Hy3.**
   Hy3's refreshed row is worse on every axis that matters: R-code 34.5 vs 43.3,
   R-test 36.1 vs 48.7, 262K vs 1M ctx, $0.064 vs $0.055 — and its quality data is
   preview-based on top. The one thing to watch: **MiMo-V2.5 non-pro ($0.019, 1M ctx,
   multimodal)** is 3× cheaper with the second-cheapest cache-read in the set. Its
   composite is proxy-grade, so don't adopt blind — but it's worth a trial on the
   *standard* tier where mistakes are cheap and recoverable.
6. **Review deep — `glm-5.2` ($0.29, was $0.34). ✓ Keep.** The price cut strengthens
   decision-005's conclusion; nothing else decorrelated reaches 79 at any price below
   flagships.
7. **Scouts — `deepseek-v4-flash` ($0.029). ✓ Fine.** Read-only research; 1M ctx;
   cheapest solid-coverage model. MiMo-V2.5 ($0.019) is the only cheaper option and
   would also diversify labs away from the implementers it feeds — a trial candidate
   here too.
8. **Compaction — switched to `deepseek-v4-flash` ($0.094/M prompt) on 2026-07-23**
   (was `minimax-m3`, $0.30/M). Compaction is a one-shot uncached-heavy workload, so the
   *prompt* price dominates: Flash is ~3× cheaper per compaction with the same 1M ctx
   and only a modest AA-index gap on a low-difficulty task. Revert is a two-line change
   if session continuity measurably degrades. The MiniMax quota segment in
   `footer-session-id` now tracks a plan whose main consumer is gone — left in place
   deliberately. See `decisions/subagents/008-orchestrator-compaction-models.md`.

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

- **GPT-5.6 Luna (93.5, $0.41, 1M)** — strong across long-context, reasoning, IF, and
  agentic tool-use; cheap; 1M context; native MCP. Best all-round orchestrator in the tier.
- **GLM-5.2 (82.9, $0.29, 1M)** — best pure value; open weights.
- **Grok 4.5 (85.6)** — high, but **500K context** is marginal for long sessions.
- **IF-strong mid-tier:** MiniMax-M3 (IFBench 82.9, best in set — matters most for writing
  unambiguous subagent specs; $0.12) and Gemini 3.5 Flash (IFBench 76.3).
- **DeepSeek V4 Pro (41.0, $0.055)** — cheap but planning-weak; was the
  orchestrator-subagent model until the 2026-07-23 switch to GLM-5.2
  (see [role review](#role-by-role-review-2026-07-23)).

### Implementer — *balanced blend* (repo-SWE ≈ self-contained coding)
SWE-bench Pro ×5 `mm` · **LiveCodeBench ×5 `raw`** · AA Coding Index ×4 `mm` · SWE-bench
Verified ×3 `mm` · Terminal-Bench 2.0 ×3 `mm` · **IFBench ×2 `raw`**.
Cost is the second axis (parallel-worker throughput economics).

- **Grok 4.5 (99.1, $0.62)** — top quality; **GPT-5.6 Luna (91.1, $0.41)** close and cheaper.
- **GLM-5.2 (80.8, $0.29)** — the throughput sweet spot.
- **Self-contained coding value:** **DeepSeek V4 Pro (47.8, $0.055)** and **Qwen3.7 Max
  (67.8, $0.52)** rose once LiveCodeBench was weighted in. **DeepSeek V4 Flash (30.3,
  $0.029)** is the cheapest capable worker. (DeepSeek's edge is algorithmic more than
  large-repo SWE.)

### Oracle — *math/algo focused*
LiveCodeBench ×5 · IMO/HMMT ×4 · AIME ×3 (raw weighted %). HLE and GPQA-Diamond were
**removed** — they measure science *knowledge*, not math/algorithms. **DeepSeek V4 Pro /
Flash** are the picks; the AIME-only leaders are flagged.

### Reviewer — *adversarial, two passes*
**review-code** = AA-Coding ×5 `mm` · AA-Intelligence ×4 `mm` · IFBench ×4 `raw` ·
AA-LCR ×3 `mm` · SWE-bench Pro ×3 `mm` (comprehension-tilt: find bugs).
**review-tests** = AA-Intelligence ×5 `mm` · IFBench ×4 `raw` · AA-LCR ×4 `mm` ·
AA-Coding ×3 `mm` · SWE-bench Pro ×2 `mm` (reasoning-tilt: find coverage gaps).
Lab decorrelation from the implementer (currently DeepSeek) is a **hard filter applied
at assignment time**, not a score term.

---

## Confidence & "unknown"

Every model has the three AA composite indices (full coverage), which internally embed the
role benchmarks — so no score is *baseless*. The flag measures **standalone corroboration**:

- **solid** — most standalone role benchmarks published; measured.
- **partial** — one standalone benchmark; the rest lean on the AA index.
- **proxy (⚠)** — no standalone role benchmark → AA-index-only estimate = **"unknown."**
- Oracle-specific: **aime-only (⚠)** = only saturated AIME; **`–`** = no math/algo eval.

**Treat as effectively unknown:**

| Model | Unknown for | Why |
|---|---|---|
| **MiMo-V2.5, Qwen3.7 Plus, GPT-5.4 nano** | all roles | New 2026-07-23 additions; no granular leaderboard data. |
| **Kimi K3** | all roles | Released 2026-07-15; AA-index only (but those indices are frontier-class). |
| **Nex-N2-Pro** | all roles | On no granular leaderboard; AA-index only. |
| **Hy3** | quality/pricing mismatch | Benchmarks are preview-only; pricing is release. Doubly stale. |
| **12 value models** | Oracle | No competition-math/algo eval published. |
| **GLM-5.2 / Kimi K2.6 / GLM-5.1** | Oracle rigor | Only saturated AIME — high number, weak evidence. |
| **GPT-5.4 mini / Kimi K2.7 Code** | Implementer | No SWE / LiveCodeBench data. |

Pattern: the newest agentic-tuned models (GPT-5.6 Luna, Grok 4.5, Sonnet 5, Kimi K3)
stopped publishing classic academic benchmarks (GPQA/HLE/AIME/IFBench), reporting only
agentic/coding evals — which is why Oracle and IFBench are the thinnest-covered axes.

---

## Appendix A — full frontier (all 29, incl. flagships)

Reference "ceiling." Normalized **within all 29**, so **not comparable** to the value-tier
table. Flagships excluded from the primary analysis on cost grounds. Cost at 95/5 I/O.
Sorted by Orchestrator.

| Model | Orch | Impl | Oracle | $/M | Ctx | Conf (O/I/Or) |
|---|--:|--:|--:|--:|--:|---|
| GPT-5.6 Sol | 89.6 | 76.6 | – | 2.061 | 1050K | solid/solid/— |
| Claude Fable 5 | 88.9 | 94.8 | – | 3.621 | 1000K | solid/solid/— |
| **Kimi K3** | **87.9** | **94.4** | – | 1.086 | 1048K | proxy/proxy/— |
| GPT-5.6 Terra | 79.7 | 70.7 | – | 1.030 | 1050K | solid/solid/— |
| GPT-5.5 | 73.3 | 59.5 | – | 2.061 | 1050K | solid/solid/— |
| GPT-5.6 Luna | 72.9 | 59.6 | – | 0.412 | 1050K | solid/solid/— |
| Claude Sonnet 5 | 68.8 | 56.6 | – | 0.724 | 1000K | solid/solid/— |
| Claude Opus 4.8 | 67.2 | 67.6 | – | 1.810 | 1000K | solid/solid/— |
| Grok 4.5 | 66.6 | 62.5 | – | 0.617 | 500K | solid/solid/— |
| GLM-5.2 | 65.3 | 52.2 | 99.2 ⚠ | 0.292 | 1048K | solid/solid/aime-only |
| GPT-5.4 | 65.2 | 41.8 | – | 1.030 | 1050K | solid/partial/— |
| Claude Opus 4.7 | 62.0 | 57.0 | – | 1.810 | 1000K | solid/solid/— |
| Gemini 3.5 Flash | 56.3 | 41.3 | – | 0.618 | 1048K | solid/solid/— |
| Gemini 3.1 Pro | 55.1 | 53.7 | – | 0.824 | 1048K | solid/solid/— |
| MiniMax-M3 | 54.5 | 30.4 | – | 0.122 | 1048K | solid/solid/— |
| Qwen3.7 Max | 49.6 | 52.8 | 91.6 | 0.524 | 1000K | solid/solid/solid |
| MiMo-V2.5-Pro | 42.7 | 23.1 | – | 0.055 | 1048K | solid/solid/— |
| Kimi K2.6 | 39.9 | 26.9 | 96.4 ⚠ | 0.318 | 262K | solid/solid/aime-only |
| GPT-5.4 mini | 38.2 | 1.4 ⚠ | – | 0.309 | 400K | partial/proxy/— |
| DeepSeek V4 Pro | 36.6 | 39.2 | 91.9 | 0.055 | 1048K | solid/solid/solid |
| Kimi K2.7 Code | 34.0 | 23.1 ⚠ | – | 0.352 | 262K | partial/proxy/— |
| Hy3 | 33.4 | 15.1 | – | 0.064 | 262K | solid¹/solid¹/— |
| Claude Sonnet 4.6 | 30.8 | 29.9 | – | 1.086 | 1000K | partial/partial/— |
| Nex-N2-Pro | 22.0 | 15.3 ⚠ | – | 0.078 | 262K | proxy/proxy/— |
| GLM-5.1 | 21.9 | 11.8 | 95.3 ⚠ | 0.337 | 202K | solid/partial/aime-only |
| DeepSeek V4 Flash | 17.4 | 27.6 | 90.2 | 0.029 | 1048K | solid/solid/solid |
| GPT-5.4 nano | 10.3 | 1.4 ⚠ | – | 0.085 | 400K | proxy/proxy/— |
| Qwen3.7 Plus | 5.0 | 0.5 ⚠ | – | 0.130 | 1000K | proxy/proxy/— |
| MiMo-V2.5 | 3.3 | 4.6 ⚠ | – | 0.019 | 1048K | proxy/proxy/— |

Flagship ceiling: Claude Fable 5 / GPT-5.6 Sol lead Orchestrator+Implementer, but at
**~7–66× the cost** of MiMo / DeepSeek for a modest quality delta — and neither publishes
math/algo evals, so they're unknown as oracles too. **Kimi K3 is the outlier**: released
2026-07-15, it lands 3rd on both axes at *half* GPT-5.5's price — AA-index-only so far,
but it is the main-session driver and the early indices justify the pick.

---

## Appendix B — raw benchmark data & coverage

Per-benchmark coverage across the 29 models (blank = no published/tracked score).

| Benchmark | Role use | Norm | Coverage | Source(s) |
|---|---|:--:|--:|---|
| AA Intelligence Index | Orch | mm | 29/29 | OpenRouter `/benchmarks` (Artificial Analysis) — local cache |
| AA Coding Index | Impl | mm | 29/29 | OpenRouter `/benchmarks` — cache |
| AA Agentic Index | Orch | mm | 29/29 | OpenRouter `/benchmarks` — cache |
| AA-LCR (long context) | Orch, Review | mm | 24/29 | Artificial Analysis / BenchLM |
| Terminal-Bench 2.0 | Orch, Impl | mm | 19/29 | BenchLM |
| SWE-bench Pro | Orch, Impl, Review | mm | 19/29 | BenchLM / morphllm |
| SWE-bench Verified | Impl | mm | ~15/29 | BenchLM / web (saturated) |
| IFBench | Orch, Impl, Review | raw | 4/29 | BenchLM / Artificial Analysis |
| LiveCodeBench | Impl, Oracle | raw | 3/29 | framia / BenchLM / web |
| IMO-AnswerBench / HMMT | Oracle | raw | 2/29 | framia (DeepSeek) |
| AIME 2025/26 | Oracle | raw | 3/29 | BenchLM |
| Codeforces (rating) | Oracle (info) | — | 2/29 | framia |
| AA-Omniscience | Orch (info) | — | 3/29 (flagships) | Artificial Analysis / llm-stats |
| Pricing (prompt/cache-read/completion) | Cost | — | 29/29 | OpenRouter `/models` — cache |

**Excluded from composites** (too sparse to score the set, or off-role):

- **HLE, GPQA-Diamond** — moved *out of Oracle*: science knowledge, not math/algorithms.
- **AA-Omniscience** — 0/18 value-tier coverage; informational only.
- **τ³-Bench, LiveCodeBench Pro (Elo)** — sparse; AA Agentic / LiveCodeBench substitute.
- **Throughput (tokens/sec)** — considered, not added (per steering); cost is the value axis.

### Caveats

1. **Relative, within-set (Orch/Impl/Review).** Min-max makes best-in-set = 100, worst = 0.
   Value-tier and full-frontier tables use different bounds and aren't cross-comparable.
2. **Snapshots aren't comparable either.** The 2026-07-23 refresh added three low-scoring
   models to the value set, which stretched the min-max bounds and *raised* incumbents'
   scores (MiMo V2.5 Pro Orch 42.4 → 51.0 with zero new capability data). Compare within
   a snapshot, not across.
3. **Saturation.** GPQA-D, SWE-Verified, AIME are compressed near the top — small real gaps
   get stretched (Orch/Impl) or dominate raw scores (AIME in Oracle). Read leads as ties.
4. **Sparse benchmarks use raw %** (IFBench, LiveCodeBench) to avoid 3–4-point min-max
   artifacts, at a mild scale-mismatch cost with the min-max benchmarks.
5. **Benchmark gaming.** A 2026 Berkeley (RDI) study showed SWE-bench Verified,
   Terminal-Bench, and others can be driven to near-perfect scores without solving tasks —
   don't over-trust any single agentic benchmark.
6. **Source consistency.** Vendor vs. SEAL scaffolds differ 15–30 pts on SWE-bench Pro; HLE
   varies with tools. BenchLM used as the primary consistent source, cross-checked.
7. **Cost basis.** Blended $/M at **95/5 I/O + 98% cache** — input-heavy because these roles
   re-read cached context each turn; cached-read price dominates. It's per-token, not
   per-resolved-task (a cheap model that fails often is expensive per success). The ratio is
   a one-line knob (`IN_RATIO`/`OUT_RATIO`) in `role_scores.py`.

### Sources

- [OpenRouter benchmarks](https://openrouter.ai/api/v1/benchmarks?source=artificial-analysis) · [models](https://openrouter.ai/api/v1/models) (local `model-tiers` cache, fetched 2026-07-22)
- [Artificial Analysis](https://artificialanalysis.ai/) — [Intelligence Index](https://artificialanalysis.ai/evaluations/artificial-analysis-intelligence-index) · [AA-LCR](https://artificialanalysis.ai/evaluations/artificial-analysis-long-context-reasoning) · [IFBench](https://artificialanalysis.ai/evaluations/ifbench) · [AA-Omniscience](https://artificialanalysis.ai/evaluations/omniscience)
- [BenchLM.ai](https://benchlm.ai/) — swePro, terminalBench2, ifBench, lcr, sweVerified, aime, gpqaDiamond, hle
- [morphllm — SWE-bench Pro](https://www.morphllm.com/swe-bench-pro) · [framia — DeepSeek V4 benchmarks](https://framia.converge.ai/page/en-US/news/deepseek-v4-benchmarks) · [LM Council](https://lmcouncil.ai/benchmarks) · [Silicon Report — Fable 5](https://www.siliconreport.com/claude-fable-5-benchmarks-hle-swe-bench-gpqa-5c675c4e)

