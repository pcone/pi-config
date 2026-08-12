---
title: "Footer Activity Timeline"
type: design-plan
status: draft
date: 2026-08-01
feature: footer-activity-timeline
---

# Footer Activity Timeline

A full-width footer row in the interactive TUI showing the current session's activity over the last 7 days on a logarithmic time scale. Rendered by the existing custom footer (`extensions/footer-session-id.ts`, which replaces pi's built-in footer via `ctx.ui.setFooter`).

## Goals

- One glance answers "when was this session actually worked on?" — and, because the scale is fixed, sessions are directly comparable by their activity profile.
- Recent activity gets fine resolution (seconds-to-minutes at the right edge); old activity gets coarse buckets (hours at the left edge).
- Zero-config: derived entirely from the session file, no new state.

## Data model

Source: `sessionManager.getEntries()` — all session entries (whole-session activity, not just the current branch). Per entry only `entry.timestamp` (ISO string) and, for `type === "message"`, `entry.message.role` are read.

Cell classification per time bucket:

| status | condition (message roles in bucket) |
|---|---|
| solid | any `user` |
| half | no `user`, any of `assistant` / `toolResult` / `bashExecution` |
| empty | none of the above |

`toolResult` and `bashExecution` count as LLM activity (they are the LLM's tool round-trips). Deliberately excluded: `compactionSummary` / `branchSummary` messages (LLM-generated but not conversation messages) and all non-message entries (`model_change`, `thinking_level_change`, `compaction`, `custom`, …). Rationale: the spec is about user-vs-LLM *messages*; summaries and state entries would smear the signal. Easy to revisit if a real session shows a misleading gap.

Session start (for the marker): `sessionManager.getHeader()?.timestamp`, falling back to the first entry's timestamp. The header is the session-creation record, which survives `/resume` — the marker then shows where the session *originated*, which is the comparability anchor.

## The scale

Fixed window, log-uniform in age:

- `WINDOW_MS` = 7 days = 604 800 000 ms
- `MIN_AGE_MS` = 1 minute = 60 000 ms (log floor; never log 0)
- `R = WINDOW_MS / MIN_AGE_MS = 10080`

For a message at time `t`, `age = now − t`. Map age to a column `k` ∈ [0, W−1] (left = 7 days ago, right = now):

```
f(age) = ln(max(age, MIN_AGE_MS) / MIN_AGE_MS) / ln(R)      // 0 → 1, clamped for age < MIN
k      = W − 1 − floor(f · W), clamped to [0, W−1]
```

Column `k` spans ages `[MIN_AGE_MS · R^((W−k−1)/W),  MIN_AGE_MS · R^((W−k)/W))`. Age `≥ WINDOW_MS` is excluded (outside the fixed window) — a strict 7-day window keeps sessions comparable.

Granularity scales with pane width exactly as requested (range fixed, buckets shrink):

| W (cols) | youngest bucket (right edge) | leftmost bucket |
|---|---|---|
| 20 | 35 s | 62 h |
| 40 | 16 s | 34.6 h |
| 80 | 7.3 s | 18.3 h |
| 120 | 4.8 s | 12.4 h |

Youngest bucket ≈ `ln(10080)/W` minutes ≈ `9.22/W` min — sub-minute at any readable width, ~1 min only at very narrow panes (W≈9). This is the honest "granularity depends on width" reading: the log curve is fixed, so no column is ever thinner than the window allows.

### Half-cell resolution

Each column is rendered from **two half-cells** — `▌` (earlier half of the bucket) and `▐` (later half) — making the row exactly a log timeline at 2W virtual columns packed two-per-physical-column. Virtual column `v ∈ [0, 2W−1]` uses the same mapping with `2W` substituted for `W`; physical column `k = floor(v/2)`, half `= v mod 2` (0 = left/earlier, 1 = right/later). This is why half-width block characters give double resolution: the row *is* a 2W-column timeline, just stacked.

| W (cols) | youngest half-bucket | leftmost half-bucket |
|---|---|---|
| 20 | 16 s | 34.6 h |
| 40 | 7.3 s | 18.3 h |
| 80 | 3.6 s | 9.4 h |
| 120 | 2.3 s | 6.3 h |

## Presentation

One new row at the **bottom of the footer** (row 4: pwd / stats+model / statuses+quota / timeline). Always rendered, exactly `width` cells. Each cell packs two half-cells (earlier = `▌`, later = `▐`):

| column contents | renders |
|---|---|
| earlier half active only | `▌` U+258C |
| later half active only | `▐` U+2590 |
| both halves active | `█` U+2588 |
| neither | space |
| session-start column | `█` in warning (overrides) |

Per half-cell, the original three-state mapping moves to **color** (the user-vs-LLM distinction is per half, at half the time resolution):

| state | color |
|---|---|
| user message(s) in this half | bright — `theme.fg("accent", …)` |
| only LLM messages in this half | dark — accent alpha-composited at ~50% over the terminal's actual background (OSC 11 query via `tui.queryTerminalBackgroundColor`, one query per footer install): `getFgAnsi("accent")` → RGB → `result = bg·(1−α) + accent·α` → opaque truecolor. Visually identical to translucency without needing terminal alpha support. Unknown background (query unanswered, e.g. no OSC 11 response) → fallback: same hue at halved saturation and lightness (the v2 oversaturation fix). Non-truecolor accent (default/256-color) → `theme.fg("dim", …)`. |
| no activity in this half | transparent (the half stays empty) |

When both halves are active but differ in state, the merged `█` takes the bright state (user beats LLM — same precedence as v1). The session-start marker stays column-level (`█` warning, overrides the whole cell) — unchanged from v1; the half-cell split does not refine it.

`now` = `Date.now()` at render time. Refresh cadence reuses the footer's existing 30 s interval plus `footerData.onBranchChange`; new messages re-render naturally (the screen redraws on activity). The leading edge therefore lags real time by ≤ 30 s; tighten to ~10 s only if that reads stale.

## Alternatives considered

- **Linear time scale** — rejected: minute resolution across 7 days needs 10080 columns; at 80 cols each cell would be ~2 h. The log curve is the only way to get both 7 days of range and seconds-of-resolution at the edge.
- **Clamp the rightmost column to exactly 1 min, log the rest** — rejected: granularity then stops scaling with width (contradicts the requirement) and the clean age→column mapping gets a seam at the 1-min boundary.
- **`getBranch()` instead of `getEntries()`** — rejected: the comparability unit is the whole session; a branch is a view, not a different session.
- **Count compaction/branch summaries as LLM activity** — rejected: they are harness-generated, not conversation messages; a summary landing in a quiet column would fabricate "the LLM was working here".
- **`▒` dither for the llm-only state (v1)** — rejected as the resolution scheme: a dither glyph can't subdivide a cell in time, so it capped resolution at one state per column. Superseded by half-width blocks (v2) with the user-vs-LLM distinction moved to color.
- **llm-only as gray `dim` token** — rejected: gray shifts hue, reading as "muted" rather than "same activity, dimmer". A darkened accent (same hue/saturation, lower lightness) keeps the row monochrome-hued.
- **Pure desaturation at the same lightness** — rejected as the sole mechanism: it fixes oversaturation but keeps the color floating at mid-brightness instead of sitting *on* the background. Compositing against the real background (OSC 11) is strictly better and is the primary path; desaturation is only the no-background fallback.
- **Vertical half-blocks `▀`/`▄` for the split** — rejected: the left/right split follows the timeline's reading direction (no top/bottom convention needed) and matches "half width" literally.
- **Marker as separate glyph (`■`) next to the activity char** — rejected: it needs an extra column, breaking the uniform width, and the spec asked for the marker *on* the chunk.

## Edge cases (decided)

- **Session older than 7 days**: timeline still renders the full window (comparability requirement); marker is off-scale → no marker, no edge glyph.
- **Message older than 7 days**: excluded from the window entirely (see *The scale*).
- **Message with future/zero timestamp** (clock skew): `age < MIN` clamps to the rightmost column.
- **Empty session**: all-space row; still rendered so footer height is stable and the marker appears in the rightmost column the moment the session has a start time.
- **Width < 1**: render nothing for the row.
- **Light themes**: a plain darkened accent reads *stronger* against a light background (darker = higher contrast). Alpha compositing against the real background fixes this — over a light bg the composite raises lightness and mutes the accent, the correct veil in both directions. Only the unknown-background fallback (halved sat/light) retains the light-theme caveat; it degrades to the `dim` token if that ever bites.

## Implementation notes

Live in `extensions/footer-session-id.ts` `render()`; pure, exported helpers for testability (mirrors `footer-session-id-multiplier.test.ts` pattern, `bun:test`):

- `timelineColumn(ageMs, width)` — the `f`/`k` mapping; called with `2W` for half-cells.
- `computeTimelineCells(entries, nowMs, width, sessionStartMs)` — per-column `{ left, right, isSessionStart }`, where `left`/`right` ∈ `"bright" | "dark" | "none"` (v2 states; `solid`/`half`/`empty` of v1 are gone).
- `darkenAccentFg(theme)` — accent ANSI code → darkened-accent ANSI code (null when unreachable → render falls back to `theme.fg("dim", …)`).
- `renderTimelineRow(cells, theme, width)` — packs half-cell pairs into `▌`/`▐`/`█`; exactly `width` visible columns (`visibleWidth` from `@earendil-works/pi-tui` to assert).

Tests pin: boundary columns (age = MIN → rightmost, age = WINDOW → leftmost, age > WINDOW → excluded), half-boundary placement, per-half precedence and merged-`█` winner, darken math (hue preserved, lightness halved, null fallback), marker placement/override/out-of-range absence, row width == `width` for several widths.
