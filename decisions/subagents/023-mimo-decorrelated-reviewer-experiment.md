---
title: "Experiment: MiMo V2.6 Flash as the decorrelated review-tests reviewer"
type: decision
status: experiment
date: 2026-10-01
---

# Experiment: MiMo V2.6 Flash as the decorrelated `review-tests` reviewer

**What:** `agents/review-tests.md` moves `deepseek/deepseek-v4.1-flash:high` → `xiaomi/mimo-v2.6-flash:high`. `review-code` stays on DeepSeek, so every code-changing round pairs a DeepSeek correctness reviewer with a **Xiaomi-lab coverage reviewer** — the first lab-decorrelated review pair since 020. `models.json` pins MiMo Flash to Xiaomi's first-party endpoint (`only: ["Xiaomi"]`, no fallbacks; fp8, $0.14/$0.28/M, cache $0.0028) so the experiment measures MiMo, not a cheapest-endpoint fp4 rendition. One model-line change plus one pin; revert is the same two lines.

**Why:** The decorrelation argument from 016/017 is back on the table at a price that works. `review-tests` is the coverage half of the parallel gate — it runs on every code-changing WO, and its failures are judged alongside `review-code`'s correctness pass, so a bad round is caught rather than shipped. Cost per review drops on the axis that matters here: output $0.28 vs $0.60/M (cache reads ≈ equal at $0.0028 vs $0.003/M); on the 2026-10-01 session profile (10.51M cache / 222k fresh / 100k out) MiMo Flash is ~29% cheaper than DS first-party, more at DS peak. A two-request probe confirmed provider-automatic caching works on MiMo hosts (~99.8% cached tokens; see 022).

**Why Flash and not Pro (explicit):** The user's read is that BenchLM numbers and anecdotal human feedback disagree for this series, so *Pro > Flash* is a hypothesis, not a premise. Flash's BenchLM composite (66.4) is within noise of DeepSeek's (64.6) — it is the cheap near-peer, and if it clears the quality bar it is the win. Pro (75.5 composite, AA 46.3, $0.41–0.44/$0.83–0.87) is the fallback only if Flash fails and its price is separately justified.

## Protocol

Window: the next 2–3 code-changing work orders (each produces one `review-tests` verdict automatically — the review gate is unchanged).

Signals, judged by the orchestrator (and user where wanted):

1. **Verdict quality** — finds real coverage gaps; no fabricated file/line citations (017's mechanical checks must catch any, and that itself is a finding); no tautological "tests look good" passes; disagreements with `review-code` that turn out to be right.
2. **False-positive cost** — how often the implementer/orchestrator has to push back on MiMo findings vs DeepSeek's historical rate.
3. **Cost per round** — sum `usage` from the child session JSONL (`~/.pi/agent/sessions/**/<child-id>.jsonl`), compared with a DS `review-tests` round on a similar WO.
4. **Wall-clock and failures** — round duration; endpoint errors/timeouts (the pin fails loud, so zeros are meaningful).

Decision rule: **keep** if verdicts are clean and cost/wall-clock improve; **try one Pro round** if Flash is materially worse but the format is promising; **revert to DeepSeek** if fabrication, missed gaps, or pushback rate regresses. The user makes the final keep/revert call.

## Risks / tradeoffs

- **BenchLM coverage is thin** (14/495 displayable slots, vendor rows unranked) and the series has a public "benchmaxxed" critique; the experiment is deliberately outcome-measured (verdicts), not benchmark-trusted.
- **fp8 host**: Xiaomi's first-party serving is fp8; DS first-party is unpinned-quantization. If MiMo underperforms, quantization is a confound — the DeepInfra fp8 (or GMICloud bf16, 86.6% uptime) hosts are the swap, same price class.
- **Same-seat comparison is noisy**: rounds differ in WO complexity; 2–3 rounds is enough for a smell test, not a statistically clean verdict. Do not generalize this to the implementer or `review-code` seat without a separate test.
- **Decorrelation is not automatically good**: same concerns 016/017 raised apply — the experiment tests whether Xiaomi's independent reasoning finds gaps DeepSeek misses, or just adds noise.
- **Thinking is binary-ish on MiMo** (OR exposes `reasoning`/`include_reasoning`, no graded `reasoning_effort`), so `:high` means "thinking on"; there is no effort dial to tune here.

## Rollback

`agents/review-tests.md` model line → `deepseek/deepseek-v4.1-flash:high`; drop the `xiaomi/mimo-v2.6-flash` override from `models.json`; `git revert` of this commit does both plus the docs.

**Files changed:** `agents/review-tests.md` (model line), `models.json` (MiMo first-party pin), `docs/model-role-scores.md`, `docs/thinking-levels.md`, `docs/TODO.md`, `README.md`, decisions index, this decision.

**Test coverage:** none — agent frontmatter + routing config. Verified by smoke run before commit: `pi -p --model xiaomi/mimo-v2.6-flash --tools read` read a repo file and answered correctly through the Xiaomi-pinned route. Live signal comes from the next code-changing WO round.
