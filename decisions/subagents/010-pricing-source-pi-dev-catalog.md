---
title: "Pricing source: pi.dev catalog instead of models.json cost overrides"
type: decision
status: done
date: 2026-08-01
---

# Pricing source: pi.dev catalog instead of models.json cost overrides

**What:** Removed the hand-curated `cost` fields from all seven `models.json`
`modelOverrides` entries. Pricing now flows from the **pi.dev remote catalog**
(pi's 4-hourly network overlay that mirrors live OpenRouter `/models` pricing).

**Why:** The overrides encoded a 2026-07-22 snapshot (see decision-008) and went
stale. Live OpenRouter `/models` (verified via the `fetch_benchlm.py` snapshot)
now differs on nearly every curated number:

| Model | field | models.json (curated 07-22) | pi.dev = live /models |
|---|---|---|---|
| z-ai/glm-5.2 | in/out/cache | 0.836/2.627/0.155 | 1.12/3.52/0.208 |
| deepseek/deepseek-v4-flash | in/out/cache | 0.094/0.188/0.0188 | 0.14/0.28/0.028 |
| arcee-ai/trinity-large-thinking | in/out/cache | 0.25/0.8/0.06 | 0.22/0.85/0.06 |
| xiaomi/mimo-v2.5-pro | in/out/cache | 0.43/0.87/0.0036 | 0.435/0.87/0.0036 |
| minimax/minimax-m3 | in/out/cache | 0.30/1.20/0.06 | 0.3/1.2/0.06 |

Keeping the overrides meant pi reported wrong per-token cost in the footer and
cost tracking. Removing them lets the pi.dev catalog (which pi refreshes every
4h with ETag validation, and which matches live `/models` exactly) supply
pricing — including models the overrides never covered, such as
`deepseek/deepseek-v4-flash-0731` (released 2026-07-31; already in the pi.dev
catalog at 0.14/0.28/0.0028 — note the 10× cheaper cache-read vs old flash).

**What stayed in `models.json`:** the non-pricing fields the pi.dev catalog does
not carry, and which were never stale:
- `compat.openRouterRouting` — routing fallback chains (e.g. flash:
  deepseek→novita→streamlake; glm-5.2: streamlake→fireworks→z-ai) are
  models.json-only.
- `maxTokens` caps — flash at 131072 (deliberate cap; catalog says 393216),
  glm-5.2 at 128000.
- `thinkingLevelMap` for glm-5.2 (`xhigh`/`max` → null) — clamps GLM to `high`
  at the provider layer (see `docs/thinking-levels.md`).

**Alternatives considered:**

- **Refresh the curated numbers instead.** Rejected: they'd go stale again the
  next time OpenRouter reprices, and they duplicate what the pi.dev catalog
  already supplies more reliably. The catalog is pi's designed pricing channel.
- **Remove whole override entries.** Rejected: the pi.dev catalog carries no
  routing compat and no `maxTokens` cap — those must stay as overrides.

**Tradeoffs:**

- Pricing is now network-dependent: offline, pi falls back to the builtin
  catalog (package-generated 2026-07-29), which lacks `-0731` and has older
  prices for others. Acceptable — auth already requires network.
- The pi.dev catalog is a pi-maintained mirror, not OpenRouter itself; if pi.dev
  ever lags OpenRouter repricing, cost display lags too. The 4h refresh + ETag
  validation keeps the lag bounded; re-check only if cost display looks wrong.

**Files changed:**

- `models.json` — removed the 7 `cost` blocks from `modelOverrides` (nothing else).

**Verification:** `python3 -m json.tool models.json` valid. The `-0731` slug
resolves through the builtin→pi.dev merge with correct cost (0.14/0.28/0.0028).
`bun test tests/` — 52 pass, 2 pre-existing failures (missing `typebox` package
in `extensions/node_modules`; reproduce identically on HEAD).
