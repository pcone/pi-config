---
title: "Experiment: MiMo V2.6 Flash on review-code + review-plan"
type: decision
status: experiment
date: 2026-10-01
---

# Experiment: MiMo V2.6 Flash on `review-code` + `review-plan`

**What:** `review-code` and `review-plan` move to `xiaomi/mimo-v2.6-flash:high`; `review-tests` goes back to `deepseek/deepseek-v4.1-flash:high`. The parallel post-implementation gate is therefore **MiMo (implementation) + DeepSeek (tests)** — the lab-decorrelated pair from 016/017 is preserved, with the code seat on MiMo instead of the coverage seat. `models.json` pins MiMo Flash to Xiaomi's first-party endpoint (`only: ["Xiaomi"]`, no fallbacks; fp8, $0.14/$0.28/M, cache $0.0028) so the experiment measures MiMo, not a cheapest-endpoint fp4 rendition. Two model lines moved, one reverted; rollback is the same edits.

**Why these seats:** User preference — plan and code review are the seats worth MiMo. `review-code` is the highest-frequency adversarial seat (fires on every code-changing WO), so it maximizes both data and savings (output $0.28 vs $0.60/M, cache reads ≈ equal; ~29% cheaper than DS first-party on the 2026-10-01 session profile, more at DS peak). `review-plan` fires selectively but is the only seat that reads a plan before an implementer does. `review-tests` staying on DS is not just leftovers: it gives every round a **same-diff, cross-lab check** — one MiMo reviewer and one DS reviewer on the same artifact — which anchors verdict quality (the two lenses differ, but fabrication, citation accuracy, and obvious misses are comparable).

**Why Flash and not Pro (explicit):** The user's read is that BenchLM numbers and anecdotal human feedback disagree for this series, so *Pro > Flash* is a hypothesis, not a premise. Flash's BenchLM composite (66.4) is within noise of DeepSeek's (64.6) — it is the cheap near-peer, and if it clears the quality bar it is the win. Pro (75.5 composite, AA 46.3, $0.41–0.44/$0.83–0.87) is the fallback only if Flash fails and its price is separately justified.

## Protocol

Window: the next 2–3 code-changing work orders (`review-code` fires every one; `review-plan` when its criteria trigger). The gate is unchanged, so data arrives automatically.

Signals, judged by the orchestrator (and user where wanted):

1. **Verdict quality** — defects found vs missed, compared against the DS `review-tests` verdict on the same WO; fabricated file/line citations (017's mechanical checks must catch any, and that itself is a finding); smug "looks correct" passes.
2. **False-positive cost** — how often the implementer/orchestrator has to push back on MiMo findings.
3. **Cost per round** — sum `usage` from the child session JSONL (`~/.pi/agent/sessions/**/<child-id>.jsonl`), compared with DS rounds on similar work.
4. **Wall-clock and failures** — round duration; endpoint errors/timeouts (the pin fails loud, so zeros are meaningful).

Decision rule: **keep** if verdicts are clean and cost/wall-clock improve; **try one Pro round** if Flash is materially worse but the format is promising; **revert to DeepSeek** if fabrication, missed defects, or pushback rate regresses. The user makes the final keep/revert call.

## Risks / tradeoffs

- **`review-code` is the highest-stakes seat and MiMo Flash is the series' weakest coding row** (BenchLM coding rank #38, 49.8 index; composite carried by agentic/knowledge rows). This is the experiment's main risk, accepted knowingly; the same-diff DS `review-tests` verdict is the anchor, and the decision rule reverts on missed defects.
- **BenchLM coverage is thin** (14/495 displayable slots, vendor rows unranked) and the series has a public "benchmaxxed" critique; the experiment is deliberately outcome-measured (verdicts), not benchmark-trusted.
- **fp8 host**: Xiaomi's first-party serving is fp8. If MiMo underperforms, quantization is a confound — DeepInfra fp8 (99.5% uptime, 944k out) or GMICloud bf16 (unquantized, 86.6% uptime) are the swaps, same price class.
- **Round-to-round noise**: WOs differ in complexity; 2–3 rounds is a smell test, not a clean verdict. Do not generalize to the implementer or oracle seats without a separate test.
- **Decorrelation is not automatically good**: same concerns 016/017 raised apply — the experiment tests whether Xiaomi's independent reasoning catches things DeepSeek misses, or just adds noise.
- **Thinking is binary-ish on MiMo** (OR exposes `reasoning`/`include_reasoning`, no graded `reasoning_effort`), so `:high` means "thinking on"; there is no effort dial to tune here.

## Rollback

`agents/review-code.md` and `agents/review-plan.md` model lines → `deepseek/deepseek-v4.1-flash:high`; drop the `xiaomi/mimo-v2.6-flash` override from `models.json` if no seat uses it. `git revert` of this commit does the model lines plus the docs.

**Files changed:** `agents/review-code.md`, `agents/review-plan.md`, `agents/review-tests.md` (revert from the first draft's seat choice), `models.json` (MiMo first-party pin, unchanged by this revision), `docs/model-role-scores.md`, `docs/thinking-levels.md`, `docs/TODO.md`, `README.md`, decisions index, this decision.

**Test coverage:** none — agent frontmatter + routing config. Verified by real dispatch: `review-tests` already spawned on MiMo through the pinned route (4 turns, correct tool use), and `review-code` was smoke-spawned on this revision before commit; live signal comes from the next code-changing WO round.
