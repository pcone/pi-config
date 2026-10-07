---
title: "BenchLM as a second axis source — evaluated and rejected"
type: decision
status: done
date: 2026-10-07
---

# BenchLM as a second axis source — evaluated and rejected

**Question:** AA lags weeks behind on `coding_index`/`agentic_index` for new
models (Opus 5.5 published an intelligence index while both others were null).
BenchLM's JSON API (`benchlm.ai/api/data/leaderboard?limit=200`, no auth) carries
those axes for the same models — Opus 5.5 is coding 83.54 / agentic 88.48 where AA
has null. Should the tiers table fill the gaps from BenchLM?

**Answer: no.** BenchLM carries the values but not on AA's scale, so filling would
replace a visible gap with an invisible bias — the same defect class as the
partial-row bug this pipeline just fixed (`001`), just harder to see.

## Evidence (cache 2026-10-07T06:37, BenchLM snapshot 2026-10-06)

Every overlapping model scored by both sources, joined by display name and slug
tail (83 of the 245 AA rows with a gap match a BenchLM row; the join is clean —
200/200 distinct normalized names, zero name-vs-slug disagreements):

| axis | n | mean BenchLM−AA | fit | Pearson | Spearman | residual sd |
|---|---|---|---|---|---|---|
| coding | 78 | **−11.3** (−13.6 supported-only, n=54) | `benchlm = 0.804·aa − 1.3` | 0.957 | 0.974 | 5.10 |
| agentic | 59 | **+15.7** (+16.4 supported-only, n=42) | `benchlm = 1.064·aa + 14.1` | 0.970 | 0.966 | 4.95 |

Same-model pairs, so this is scale, not join error: GPT-5.4 coding AA 71.1 vs
BenchLM 48.8; GPT-5.4 nano 56.1 vs 31.1; Muse Spark 1.1 agentic AA 25.8 vs 56.8.

**Raw fill.** A BenchLM coding value lands ~11 points below the AA equivalent
(22 at the top end), so a capable model reads below the C≥56 floor and drops out;
agentic lands ~16 points high, admitting rows AA would reject. Both directions
were observed in the candidate fills, not hypothesized.

**Affine-aligned fill** (map BenchLM onto AA via the per-axis fit above, the
strongest version of the idea), measured through the extension's own `scoreModels`
on the 2026-10-07 cache: it admits and evicts **0** rows at the thresholds, but it
**re-anchors the normalization**. `computeBounds` spans every row carrying an axis,
so a clamped extrapolation becomes the new axis maximum (coding hi: 81.6 → 100) and
every complete row moves — all 15 of them, up to **−12.0** (Claude Fable 5.1
97.4→85.4; Claude Opus 5 93.5→81.9; Qwen3.8 Max 89.1→77.7). On the compact table
the stricter `supported`-only fill drops three of the seven frontier rows
(Muse Spark 1.3, GLM-5.3, GLM 5.3 Flash) and adds one (GPT-6.1 Sol), while
Sonnet 5.5 falls T1→T2; admitting `estimated` evidence too keeps one of the
dropped rows (frontier 7→6) but adds two more tier moves (Muse Spark 1.3
T2→T3, MiMo-V2.6-Pro T3→T4).

The row the fill was meant to help needs it least: Opus 5.5 already renders at
**100.0, Tier 1** in the AA-only table, because its published intelligence *is* the
axis maximum; the fill leaves it at 100.0 and degrades everything else. And its
aligned coding needs an extrapolation to exist at all — BenchLM's 83.54 maps to
AA≈105, past AA's observed maximum of 81.6.

**Residual noise.** Even the aligned fit leaves ~±5 points — half a 10-point tier
band — which is the same magnitude as the gaps being fixed.

## Alternatives considered

- **BenchLM raw primary for coding/agentic (option B):** rejected — the two axes
  are offset in opposite directions, so the composite would be internally
  inconsistent by construction.
- **BenchLM display-only column in the full table (never averaged):** honest, but
  a foreign-scale number needs its own legend and interpretation, and AA's fixed
  scale is the one the floors and tiers are defined in. No user-facing request for
  it; revisit only if AA's coding/agentic coverage collapses.
- **Stay AA-only (chosen):** `†` already states the truth for a partial row — its
  average spans the axes AA has published — and that survived review as the
  correct representation. The cost basis is unaffected; BenchLM has no cache-read
  rate anyway.

## Revisit trigger

BenchLM publishing AA-aligned indices, or per-benchmark *raw* scores the pipeline
could score itself the way AA does. Any future attempt must re-run the
scale comparison above; the fit is roster-dependent and must not be copied from
this record.

## Unaffected

`docs/data/fetch_benchlm.py` → `benchlm_snapshot.json` → `docs/model-role-scores.md`
is a different pipeline (per-benchmark pages for role-fit, not composite axes) and
is untouched by this decision. Its snapshot was last refreshed 2026-08-03.
BenchLM's license is CC BY-NC 4.0 (`attribution: Data from BenchLM.ai`); no
BenchLM data is ingested here, so no attribution is owed.
