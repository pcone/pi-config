---
title: "Effort rebalance — flash seats :high, glm-5.3 seats :max, low banned fleet-wide"
type: decision
status: done
date: 2026-08-28
---

# Effort rebalance — flash seats :high, glm-5.3 seats :max, `low` banned

**What:** Effort-only rebalance, decision-020 follow-up (020 owns model choice; this decision owns effort levels only). The three standard reviewers drop `:max`→`:high` on `zai/glm-5.3-flash`; the orchestrator rises `:high`→`:max` on `zai/glm-5.3`; the main session's `defaultThinkingLevel` goes `high`→`max` (the user flipped `settings.json` the same day; committed by WO-2026-049); **`low` is banned fleet-wide**; scouts **keep** `:medium`; implement (`:high`) and the oracle (`deepseek/deepseek-v4-pro-0813:max`) are unchanged. It also supersedes the effort-policy table in 020 (that table's rows for reviewers, orchestrator, and the now-banned `low` option only — 020's model choices and toggle design stand).

**Why:** Measured, not estimated — the user's benchmark review of GLM per-effort comparisons, 2026-08-28 evening. Three convergent findings:

1. **glm-5.3-flash, high vs max:** very small quality delta, very large token delta. The reviewers ×3 are the fleet's highest-volume thinking seats (three spawns per review round) — paying max's token bill there for a negligible margin is a bad trade.
2. **glm-5.3, high vs max:** the token delta is notably less stark than flash's — worth `max` for the seats that own the complex tail (orchestrator, main session). 020 itself flagged this as unresolved: "the quality delta at `high` is unmeasured — but the cost is certain." The benchmark review resolves the tradeoff the other way for the full model.
3. **low vs high:** large quality delta on **both** glm-5.3 and glm-5.3-flash. `low` is never the right seat level → banned fleet-wide.

Level-map facts this rides on (from [docs/thinking-levels.md](../../docs/thinking-levels.md), live-verified 2026-08-28, twice, including one spawn under `defaultThinkingLevel: max`): zai maps `low`→low (real), `medium`→**null** (falls back to the *provider* default, `high` — not the session default), `high`→high, `xhigh`→**null**, `max`→max. DeepSeek V4 maps `low`→low, `medium`/`high`/`xhigh`→high, `max`→max.

## Why scouts keep `:medium`

- **Inert on zai:** `medium`→null falls back to the provider default, so scouts already run GLM-high today — no behavior change, no token cost.
- **Valid under the toggle:** `/fleet-model deepseek` substitutes the base and preserves the suffix; 0731 maps `medium`→high, so the semantics hold on both sides.
- **Future-proofing:** if z.ai ships a real medium, pi's catalog `thinkingLevelMap` picks it up without another config edit.
- **User's explicit call** ("keep that for deepseek").

## Routing principle (explicit)

The complexity dial in this fleet is **model choice**: complex work rides `zai/glm-5.3` at `max`, everything else rides `zai/glm-5.3-flash` at `high`. Per-task effort-down on glm-5.3 is **not** a lever — less-complex work moves to the flash seat instead. Effort levels are per-seat policy, not per-dispatch knobs.

## `low` ban

No config uses `:low` today (verified: zero `:low` matches in `agents/`, `extensions/`, `settings.json`, `models.json`). The ban closes the standing suggestion in docs/thinking-levels.md ("the cheaper real option is `:low` … revisit only if scout token spend matters") — now rejected on the low-vs-high quality evidence above. It covers DeepSeek too: V4's `low` is a real level and is equally rejected; the quality cliff, not provider quirks, is the reason.

## Alternatives rejected

- **Keep reviewers `:max`** — negligible quality gain, large certain token cost on the fleet's highest-volume thinking seats (3 spawns per review round).
- **Keep orchestrator `:high`** — 020's own text admits the quality delta was unmeasured while the token cost was certain; the new benchmark review resolves the tradeoff the other way for the full model.
- **Move scouts to explicit `:high`** — same effective level on zai (medium is inert), but loses the deepseek-toggle semantics and the intent legibility of `:medium`.
- **`:low` scouts for cost** — banned: large low-vs-high quality delta measured on both GLM variants; a cheap-but-wrong research pass poisons everything downstream.
- **Per-spawn effort dialing on glm-5.3** — unmeasured, adds an orchestrator decision per dispatch, and duplicates the complexity signal the model dial already encodes (see routing principle).

## Tradeoffs

- **Reviewers give up the small max-effort margin.** Anti-fabrication is carried by 017's mechanical checks (interval-arithmetic citation validation, prove-each-finding, patch-vs-spec audit), not by effort level.
- **Orchestrator/main-session token spend rises with `max`.** Accepted: glm-5.3 spawns are rare relative to the flash seat, and the z.ai plan bills flash at ⅓ the points — the quota-weighted increase is modest.
- **The GLM per-effort numbers come from the user's benchmark review, not yet from the fleet's data pipeline.** `docs/data/benchlm_snapshot.json` (2026-08-02 snapshot) predates GLM-5.3 entirely — it has no GLM-5.3 rows. The next snapshot refresh should capture GLM-5.3 effort-variant rows if published.

## Rollback

`git revert` of this change restores the frontmatter levels, `settings.json`, and the doc statements in one commit; the README index row records the supersession so the history stays legible.

**Files changed:** `agents/{review-code,review-plan,review-tests,orchestrator}.md` (model lines), `settings.json` (`defaultThinkingLevel: "max"`), `docs/thinking-levels.md`, `docs/model-role-scores.md`, `README.md`, decisions index, this decision. No code changes — `extensions/lib/fleet-model.ts` is level-agnostic (suffix-preserving) and `tests/fleet-model.test.ts` uses level strings generically.

> **Superseded in part (2026-10-01):** the GLM per-effort evidence behind this rebalance no longer applies — all seats moved to `deepseek/deepseek-v4.1-flash` (decision 022). The level assignments survive as seat policy (`:max` orchestrator/oracle, `:high` implement/reviewers), not as a re-derived result — and the same-day 022 effort audit moved scouts `:medium`→`:low` and pinned compaction `:low`, scoping this decision's fleet-wide `low` ban to code/hard-tail seats.
