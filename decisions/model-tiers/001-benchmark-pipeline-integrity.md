---
title: "Benchmark pipeline integrity — partial coverage, pricing joins, cutoff, cache TTL"
type: decision
status: done
date: 2026-10-07
---

# Benchmark pipeline integrity

**What:** `extensions/model-tiers/index.ts` scored and priced rows incorrectly for
five independently-reproduced reasons; all are fixed:

1. **Unpublished AA indices averaged as zero.** `?? 0` ranked the newest models
   (Opus 5.5, Sonnet 5.5, GPT-6.1 Sol, DeepSeek V4.1 Flash, MiMo V2.6 Flash) near
   the floor, and the compact table dropped them via `C≥56/A≥30`. Now the average
   covers published axes only, thresholds apply per published axis, per-axis bounds
   span every row that carries the axis, and partial rows render with `†`.
2. **`:batch`/`:free` variants lent their price to standard models.** Variants
   share the standard entry's `canonical_slug`; last-write-wins priced 56 of the
   160 benchmark rows in the 2026-10-05 cache from a variant (67/224 after the
   next refresh — the count moves with the feed). At fix time DeepSeek V4.1 Flash
   read $0.011/M (batch) instead of $0.030/M and GLM 5.3 Flash $0.016 instead of
   $0.040. The lookup now skips `:`-suffixed ids.
3. **Unmatched slugs priced at $0.** Delisted/renamed permaslugs rendered as
   `$0.00/M`, dominated the Pareto, and tripped the `/tiers` cutoff at frontier
   index 3 (4 of 35 rows shown). Rows without a resolvable standard entry and
   pricing are dropped from the cost-ranked table instead of priced at zero.
4. **Cutoff label** said `$0.00/M` while the condition is `<$0.005/M`; now
   "free-tier models".
5. **`Infinity` value scores** made free-model sorts and `☆ ALT` picks
   order-dependent; free rows use a finite sentinel and a stable tiebreak.

Removed as dead/misleading: `paretoFilter3D` (never called), `contextTier` (never
read; its comment described four buckets the code did not implement), and the
`UPCOMING_OPEN_WEIGHTS` kimi-k3 entry (weights shipped — `hugging_face_id` is set).

**Cache:** TTL 72h → **24h** — the header and README already claimed 24h, and the
feed backfilled 185 rows in 46h, so a 3-day cost basis misleads. `fetchedAt` must be
finite and payloads arrays or the cache is rejected; writes are atomic (tmp +
rename). The startup sweep moved out of module scope, so importing the module
(tests) no longer touches the real cache.

**Why not:** treat missing indices as zero (not-yet-benchmarked is not scored-worst);
drop partial rows (hides exactly the newest models the table exists to compare);
fall back to the benchmark feed's own pricing (no cache-read rate — overstates cost
and mixes pricing bases); price a `:free`-only model at $0 (rate-limited free tiers
are not a like-for-like cost basis — six such slugs exist in the 2026-10-07
catalog; those rows are dropped like other unpriced rows rather than ranked free).

**Validation:** `tests/model-tiers-render.test.ts` (37 tests) pins each rule, including
the `/tiers` cutoff (including the exact $0.005/M boundary), hidden-tail label, tier
picks and threshold floors. Live at the 2026-10-07 cache: Opus 5.5 tops the compact
table at 100.0 `†`; GLM-5.3, GLM 5.3 Flash and GPT-6.1 Sol appear; DeepSeek V4.1
Flash prices at $0.033/M (standard).

**Tradeoff:** a `†` row's average spans fewer axes, so it is not strictly
comparable to a complete row's three-axis average. The marker keeps the model
visible with that caveat rather than hiding it; filling the gap from a second
source is the question answered in `002` — rejected, because the sources' axes do
not share a scale.

**Pending:** whether to add BenchLM (`benchlm.ai/api/data/*`) as a second coverage
source for coding/agentic — **evaluated and rejected in `002`**: its axes run 11.3
points below AA's coding and 15.7 above its agentic for the same models, and an
aligned fill re-anchors every row's normalized average by up to 12 points. No code
change follows.
