---
title: "Fleet flash seat to zai/glm-5.3-flash with /fleet-model toggle; deep tier deleted; effort policy; models.json prune"
type: decision
status: done
date: 2026-08-28
---

# Fleet flash seat to zai/glm-5.3-flash — single review tier, /fleet-model toggle, effort policy, models.json prune

**What:** The fleet flash seat (implementer, 3 reviewers, 2 scouts, compaction) moves from `deepseek/deepseek-v4-flash-0731` to `zai/glm-5.3-flash`, with a `/fleet-model [glm|deepseek]` runtime toggle that flips the whole seat back to 0731 during a credit-low period (state `~/.pi/fleet-model.json`, read at spawn/compaction time, never checked in). The never-used reviewer deep tier (`review-code-deep`, `review-plan-deep`, `review-tests-deep`) is **deleted outright** — 017's "dormant insurance" framing is retired, and `review_depth` is removed from the WO template. Per-agent thinking levels are set via pi's native `provider/model:level` shorthand (implement `:high`, scouts `:medium`, reviewers `:max`, oracle `:max`; orchestrator `zai/glm-5.3:high`). `models.json` is pruned to a single correctness-guard override.

**Why:** Measured, not estimated — three convergences: (1) glm-5.3-flash dominates the incumbent flash seat on every measured axis at ⅓ the z.ai plan's points per call; (2) the deep tier fired exactly once in fleet history and its quality/decorrelation rationale lapsed; (3) per-role effort was being inherited blindly from the session default instead of being dialed to the seat's job.

## Fleet switch: glm-5.3-flash over 0731

**Recon evidence** (Artificial Analysis v4.1.1 via the live OpenRouter API, fetched 2026-08-28 by scout session `subagent-520b5fa4`):

- **AA indices (served-model):** glm-5.3-flash **57.5 / 71.5 / 58.2** (int / coding / agentic) vs 0731 **51.8 / 69.1 / 48.4** — wins all three axes.
- **OpenRouter list pricing ($/M prompt / completion / cached):** glm-5.3-flash **$0.075 / $0.25 / $0.015** vs 0731 **$0.06 / $0.12 / $0.012** — modest per-token premium, outweighed by the plan economics below.
- **z.ai coding plan:** flash-class models bill **⅓ the points of glm-5.3** per call (3× quota), with a further **50% off-peak discount** — the effective cost of the flash seat collapses on the plan.
- **Model facts:** released ~2026-08-26, MIT weights, **multimodal** — the first image-capable fleet model (scout-web screenshot reads), 1.31M context.

**Alternatives rejected:**
- **Keep 0731** — rejected: dominated on all three measured AA axes, and the OpenRouter price gap that used to justify it is now a rounding error against the plan's ⅓-points flash rate.
- **glm-5.3 full (not flash) for the flash seat** — rejected: 3× the points for the seat that deliberately spends cheaply; the full model is the orchestrator's seat, not the worker seats'.
- **Switch the oracle too** — rejected: no math-specific data for any GLM-5.x model (see watch item below); the oracle stays on `deepseek/deepseek-v4-pro-0813` where the record is measured.
- **Wait for thicker AA samples before moving** — rejected: the toggle makes reversal a single command; waiting buys certainty we can get cheaper by shipping and watching.

**Tradeoffs:**
- Benchmarks are **vendor-only and 1–2 days old**; the AA sample is thin. Accepted because the toggle bounds the downside to one command.
- **No math-specific data** for glm-5.3-flash. **Watch item:** GLM-5.3 weights dropped 2026-08-28 — HF card + MathArena rows are expected within days; re-check in 3–5 days. The oracle seat gets its own decision only if independent math data appears AND beats 0813-pro at its price band.
- Same-lab review decorrelation is gone once the standard reviewers share the implementer's lab (z.ai) — the mechanical anti-fabrication checks from 017 (interval-arithmetic citation validation, prove-each-finding, patch-vs-spec audit) are model-independent and carry the load.

## Toggle design: standing default + runtime override

- The **standing default is versioned in the agent frontmatter** (the single authoritative statement, mirrored by `FLASH_SEAT[DEFAULT_FLASH]` in `extensions/lib/fleet-model.ts`).
- The **temporary override** lives in `~/.pi/fleet-model.json` (`{"flash": "glm"|"deepseek"}`), read at spawn/compaction time. **Runtime state can only override, never define, the default**; a corrupt or unknown file **fails open to the default** — a broken toggle must never block spawning.
- Substitution is **table-driven on the model string**: the agent frontmatter, the subagent-async fallback literal, and compaction all flip from one rule. **Effort suffixes survive substitution** (`zai/glm-5.3-flash:high` → `deepseek/deepseek-v4-flash-0731:high` under the override). Non-flash models are never touched.
- `inheritParentModel` spawns pass the parent model through **unsubstituted** — an explicit spawn choice wins over the seat.

## Deep-tier deletion

**Evidence:**
- **Exactly ONE deep spawn in the entire session history** (2026-07-23, via OpenRouter) — the tier was never a working path.
- 017 documented that `review_depth: thorough` was declared **3×** (WOs 018/037/038) and standard reviewers spawned anyway, because **no routing logic ever existed** for the deep tier.
- **017's quality rationale lapsed:** the deep tier's edge was GLM-5.2's quality at 39× cache cost — but GLM-5.2's AA indices now sit **below glm-5.3-flash's** (the model replacing the standard tier). A tier whose only justification was "stronger model" has no case when its model is weaker than the incumbent's.
- **The decorrelation value is gone once the standard tier went z.ai-lab:** 019's argument (accept same-lab for cost because the deep tier stays decorrelated) inverts — the standard reviewers are now same-lab with each other AND with the implementer, and the deep tier (also z.ai) would be decorrelated from nothing.

**Alternatives rejected:**
- **Keep dormant + bump to glm-5.3** — rejected: maintenance debt for a tier that never paid out once; "insurance" that fired once in 40+ days of fleet history is a fossil.
- **Wire up real routing** — rejected: building machinery for a tier whose quality rationale lapsed; the mechanical checks from 017 carry anti-fabrication, and a second reviewer seat at 3× points buys nothing measurable.

**Consequence:** the three `-deep` agent files are deleted, and `review_depth` is removed from the work-order template (it was already a documented fossil in 017).

## Effort policy — pi's native `provider/model:level` shorthand

Mechanism: the level rides the model string (`zai/glm-5.3-flash:high`), parsed by pi itself — **no custom parser**. The levels survive the fleet toggle because substitution preserves the suffix, and 0731 supports the same level set.

| Seat | Level | Why |
|---|---|---|
| implement | `:high` | Writes code; invariant enumeration is its value-add, and `medium` risks shallow sweeps. |
| scouts ×2 | `:medium` | Read-only research — speed + cost; no code is written, so max-tail reasoning is wasted. |
| reviewers ×3 | `:max` | **User directive** — hard tail on the adversarial pass. |
| oracle | `:max` | **User directive** — the seat's whole job is the hardest tail. |
| orchestrator | `:high` | 016's own follow-up note: cap orchestrator reasoning spend (the model moves to `zai/glm-5.3`, same family, at `high`). |

## models.json prune

Final state: exactly one override. Rationale:

- **`maxTokens` pins were launch-window workarounds.** The live OpenRouter catalog (checked 2026-08-28) says flash-0731 maxes out at **943,718** tokens — our pin of **131,072 was actively restrictive** — and 0813-pro at **384,000** (identical to our pin, hence redundant). Both pins removed.
- **Removed as vestigial:** `z-ai/glm-5.2` (OR slug for a model pi catalogs natively), `deepseek/deepseek-v4-pro` (old-checkpoint alias), and the qwen / mimo / minimax / trinity routing entries (no fleet seat uses them).
- **Kept:** the 0813-pro `only: ["deepseek"], allow_fallbacks: false` routing pin. This is a **correctness guard, not stale pricing**: the oracle's record (MathArena AIME 96.67, BenchLM HMMT 95.2) was measured on DeepSeek's **first-party endpoint**, and default OpenRouter routing may serve resellers with different weights. Not an oversight — the pin is the one piece of routing config the fleet still depends on.

## Rollback

1. **Runtime:** `/fleet-model deepseek` flips the whole flash seat back to 0731 with zero file edits.
2. **Standing:** `git revert` of this change restores the frontmatter defaults, the deep agents, and the models.json overrides in one commit.

**Files changed:** `extensions/lib/fleet-model.ts` (new), `extensions/fleet-model.ts` (new `/fleet-model` command), `extensions/subagent-async/index.ts` (two `effectiveModel` sites), `extensions/compaction-model.ts` (seat-based resolve), `settings.json` (extension registered), `agents/{implement,review-code,review-plan,review-tests,scout-code,scout-web,orchestrator,math-algo-oracle}.md` (model lines), `agents/review-{code,plan,tests}-deep.md` (deleted), `models.json` (pruned), `skills/work-order-template/SKILL.md` (`review_depth` removed), `docs/model-role-scores.md`, `docs/thinking-levels.md`, `README.md`, `tests/fleet-model.test.ts` (new), this decision, README index, supersession footnotes on 005/016/017/019.

**Test coverage:** `tests/fleet-model.test.ts` — the 15-row behavior/failure matrix (missing/malformed/unknown state file, both seats, suffix preservation, non-flash pass-through, atomic write/clear, HOME redirection) plus a no-pi-imports source invariant. The subagent-async/compaction wiring is a two-line pass-through; extension loading can't be tested from the worktree (config symlinks serve the parent tree) — live dispatch after `/reload` is the post-merge E2E.

> **Superseded (2026-10-01):** the z.ai subscription is gone — the flash seat, orchestrator, and oracle all moved to OpenRouter's `deepseek/deepseek-v4.1-flash`; the `/fleet-model` toggle and its override file were deleted (no second seat to flip to). Deep-tier deletion and the models.json correctness-pin principle stand. See [decision 022](022-openrouter-fleet-v41-flash.md).
