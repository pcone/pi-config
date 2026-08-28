---
title: "Fleet → zai/glm-5.3-flash, /fleet-model toggle, reviewer deep-tier deletion, effort policy, models.json prune"
type: work-order
status: open
date: 2026-08-28
---

# WO-2026-048: Fleet flash seat → zai/glm-5.3-flash; deep-tier deletion; effort policy; models.json prune

### Metadata

- **work_order_id**: WO-2026-048
- **parent_plan_id**: N/A (ad-hoc orchestration; plan section in docs/TODO.md § "WO-2026-048")
- **sequence_position**: 1 of 1
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit
- **priority**: normal
- **estimated_complexity**: moderate (wide blast radius, mechanical changes, fully enumerated below)
- **review_policy**: required
- **review_depth**: standard

### Task Summary

**One-sentence description**: Move the fleet flash seat (implementer, 3 reviewers, 2 scouts, compaction) to `zai/glm-5.3-flash` with a `/fleet-model` runtime toggle back to deepseek-0731, delete the never-used reviewer deep tier, set per-agent thinking levels via pi's native `provider/model:level` shorthand, bump the orchestrator to `zai/glm-5.3`, and prune stale `models.json` overrides.

**Goal**: Subagent traffic defaults to glm-5.3-flash on the z.ai plan (⅓ the points of glm-5.3 per call); a credit-low period is survived by `/fleet-model deepseek` (zero file edits); one review tier; effort dialed to the seat's job.

### Scope

**Files to modify**:

1. `extensions/lib/fleet-model.ts` — **NEW** pure module (spec §1).
2. `extensions/fleet-model.ts` — **NEW** `/fleet-model` command extension (spec §2).
3. `settings.json` — add `"extensions/fleet-model.ts"` to the extensions array; NOTHING else. The working tree carries an uncommitted user edit (`defaultThinkingLevel`) — preserve that line exactly.
4. `extensions/subagent-async/index.ts` — the two `effectiveModel` sites (~L1198 spawn args, ~L2885 meta.json write) route through the substitution helper (spec §3).
5. `extensions/compaction-model.ts` — constants replaced by runtime resolve from the lib; docstring updated (spec §4).
6. `agents/implement.md` — model line → `zai/glm-5.3-flash:high`; `allowedSubagents` drop `review-code-deep, review-tests-deep`; update in-body references to the old model and to `-deep` siblings.
7. `agents/review-code.md`, `agents/review-plan.md`, `agents/review-tests.md` — model line → `zai/glm-5.3-flash:max`; update in-body factual references to `deepseek`/`0731` (grep each file); prompt structure otherwise untouched.
8. `agents/scout-code.md`, `agents/scout-web.md` — model line → `zai/glm-5.3-flash:medium`.
9. `agents/orchestrator.md` — model line `zai/glm-5.2` → `zai/glm-5.3:high`; update in-body factual GLM-5.2 references (016-era hallucination rationale stays as history but the *current model* named must be 5.3).
10. `agents/math-algo-oracle.md` — model line gains explicit effort: `deepseek/deepseek-v4-pro-0813:max`. Body otherwise untouched.
11. `agents/review-code-deep.md`, `agents/review-plan-deep.md`, `agents/review-tests-deep.md` — **DELETE**.
12. `models.json` — prune to exactly one override (spec §5).
13. `decisions/subagents/020-fleet-glm-53-flash-single-tier.md` — **NEW** decision record (spec §6).
14. `decisions/subagents/README.md` — index row for 020.
15. Dated supersession footnotes (pattern: 017's footnote on 016), each 1–3 lines: `005-review-tiers.md` (two-tier review deleted 2026-08-28 → 020), `016-luna-standard-reviewers.md` (orchestrator glm-5.2 → glm-5.3, effort capped high → 020), `017-single-review-tier.md` (deep tier deleted outright, standard now glm-5.3-flash → 020), `019-standard-reviewers-flash-0731.md` (standard reviewer model superseded again → 020).
16. `skills/work-order-template/SKILL.md` — remove the `review_depth` metadata field and its informational note (the field described a tier that no longer exists; decision 017 already called it a fossil). Do not touch the `review_policy` bullet or the parser-contract text.
17. `docs/model-role-scores.md` — assignment-table rows: main session (FIX stale row: says 0731, actually `zai/glm-5.3` since commit 80e16db), implementer, reviewers ×3, scouts ×2, compaction → glm-5.3-flash + toggle note; deep-tier rows removed with one-line history note; orchestrator row → glm-5.3; oracle row → +`:max`; add effort column or effort note.
18. `docs/thinking-levels.md` — fleet-roles column updated to new models/levels (grep for stale model names).
19. `README.md` — agent-roster bullet(s) updated (single review tier, new models); add a Structure bullet for `extensions/fleet-model.ts` + `extensions/lib/fleet-model.ts`.
20. `tests/fleet-model.test.ts` — **NEW** (matrix below).

**Files to read (reference only)**:

- `extensions/lib/pdf-convert.ts` — `lib/` placement convention (loader skips lib/).
- `tests/model-tiers-render.test.ts` — importing extension modules under `bun test`.
- `decisions/subagents/019-standard-reviewers-flash-0731.md` — format template for 020; footnote pattern on 017.
- `extensions/subagent-async/index.ts` L1180–1215, L2870–2900 — the two sites.
- `docs/TODO.md` § "WO-2026-048" — the plan this WO executes.

**Files NOT to modify**:

- `extensions/subagent/` (disabled reference), `extensions/modes.ts`, `apps/`, `themes/`, `keybindings.json`, `docs/data/*` (snapshot data), existing test files, `work-orders/*` (frozen), `tmp/*` (scratch), `decisions/*` bodies except the four specified footnotes.
- `extensions/subagent-async/index.ts` outside the two named sites.
- `~/.pi/*` — nothing outside the repo; the state file is created at runtime by the command, not checked in.

**Out of scope**: any new routing/escalation machinery to replace the deep tier (deliberately none — mechanical checks per 017 carry anti-fabrication); OpenRouter overrides beyond the specified prune; zai-provider entries in models.json (none needed — catalog correct); footer/status display of the toggle; auto-toggle on credit thresholds.

### Implementation Specification

**1. `extensions/lib/fleet-model.ts`** (pure: `node:fs`/`node:path`/`node:os` only; no pi imports):

```ts
export type FlashKey = "glm" | "deepseek";
export interface FlashModel { provider: string; model: string }
export const FLASH_SEAT: Record<FlashKey, FlashModel> = {
  glm: { provider: "zai", model: "zai/glm-5.3-flash" },
  deepseek: { provider: "openrouter", model: "deepseek/deepseek-v4-flash-0731" },
};
export const DEFAULT_FLASH: FlashKey = "glm";
```

- State file `~/.pi/fleet-model.json`, content `{"flash":"deepseek"}` or `{"flash":"glm"}`. Path resolved at CALL time from `os.homedir()` (not module load) so tests redirect `process.env.HOME`.
- `readFlashOverride(): FlashKey | null` — missing file, unparsable JSON, or unknown value → `null`. Read never throws.
- `resolveFlashSeat(): FlashModel` — `FLASH_SEAT[readFlashOverride() ?? DEFAULT_FLASH]`.
- `LEVELS = ["off","minimal","low","medium","high","xhigh","max"]` (pi's --thinking set). `splitModelLevel(id): { base, level | null }` — suffix = text after the LAST `":"`, treated as a level only if in LEVELS (so `z-ai/glm-5.2:batch` stays intact); otherwise level=null.
- `resolveFlashModel(m: string | undefined): string | undefined` — split; if `base` equals either flash-seat model string, return `resolveFlashSeat().model` + (`level` ? `:${level}` : ``); else return `m` unchanged. Non-flash models (`deepseek/deepseek-v4-pro-0813`, `zai/glm-5.2`, `zai/glm-5.3`) and `undefined` pass through — the effort suffix they carry is preserved untouched.
- `writeFlashOverride(k)` / `clearFlashOverride()` — atomic (tmp+rename, pattern: `writeMetaJson`); clear removes the file; clear on missing file = no-op, not an error.

**2. `extensions/fleet-model.ts`** — `pi.registerCommand("fleet-model", ...)`:

- No args → notify current resolution: `flash seat: zai/glm-5.3-flash (default)` or `flash seat: deepseek/deepseek-v4-flash-0731 (override) — /fleet-model glm to restore`, + one usage line.
- `glm` → `clearFlashOverride()` (file absence = default) + confirm.
- `deepseek` → `writeFlashOverride("deepseek")` + confirm.
- Any other arg → error notify with usage; no write.

**3. `extensions/subagent-async/index.ts`** — both sites:

```ts
const effectiveModel = inheritParentModel
  ? parentModel
  : resolveFlashModel(agent.model ?? FLASH_SEAT[DEFAULT_FLASH].model);
```

`inheritParentModel` passes the parent model through unsubstituted (explicit spawn choice wins). The bare fallback literal is table-substituted. Site 2 writes the SUBSTITUTED model (suffix included) into meta.json — resume reproduces exactly what ran; later toggle flips do not apply retroactively to resumed sessions. Intended; one-line comment at site 2.

**4. `extensions/compaction-model.ts`** — at event time: `const seat = resolveFlashSeat(); ctx.modelRegistry.find(seat.provider, seat.model)`. Fallback chain (unresolved model / auth fail → notify + default compaction) unchanged. Docstring: compaction rides the fleet flash seat per decision 020; credit-low periods flip the whole seat including compaction. Terse — detail lives in 020.

**5. `models.json`** — final content exactly:

```json
{
  "providers": {
    "openrouter": {
      "modelOverrides": {
        "deepseek/deepseek-v4-pro-0813": {
          "compat": {
            "openRouterRouting": {
              "only": ["deepseek"],
              "allow_fallbacks": false
            }
          }
        }
      }
    }
  }
}
```

Rationale (→ 020): `maxTokens` pins were launch-window workarounds; live OR catalog (checked 2026-08-28) says flash-0731 max-out 943,718 (our pin 131,072 was actively restrictive) and 0813-pro 384,000 (identical to pin, redundant). Vestigial: `z-ai/glm-5.2` OR slug, `deepseek/deepseek-v4-pro` (old-checkpoint alias), qwen/mimo/minimax/trinity. **Kept**: 0813-pro `only:["deepseek"], allow_fallbacks:false` — a correctness guard, not stale pricing: the oracle's record (MathArena AIME 96.67, BenchLM HMMT 95.2) was measured on DeepSeek's first-party endpoint; default OR routing may serve resellers with different weights. State this in 020 so it doesn't read as an oversight.

**6. Decision 020** (`decisions/subagents/020-fleet-glm-53-flash-single-tier.md`) — follow the re-litigation-proof rule (rules/): ground in observation, refute the obvious alternative, name tradeoffs. Must contain:

- **Fleet switch**: recon evidence w/ provenance+date (AA v4.1.1 via live OR API, 2026-08-28, scout session subagent-520b5fa4): glm-5.3-flash 57.5/71.5/58.2 vs 0731 51.8/69.1/48.4 (wins all three axes); OR list $0.075/$0.25/$0.015 vs $0.06/$0.12/$0.012; z.ai coding plan flash = 3× quota of glm-5.3 (⅓ points/call), off-peak 50%; released ~2026-08-26, MIT weights, multimodal (first image-capable fleet model — scout-web screenshot reads), 1.31M ctx. Alternatives rejected: keep 0731 (dominated on all measured axes); glm-5.3 full (3× points); switch the oracle too (no math data — see below); wait for thick AA samples (toggle makes reversal one command). Tradeoffs: benchmarks vendor-only 1–2 days old, AA sample thin; no math-specific data (watch item: re-check MathArena/AA when rows land — GLM-5.3 weights dropped 2026-08-28, HF card + MathArena expected within days).
- **Toggle design**: standing default versioned in agent frontmatter; temporary override in `~/.pi/fleet-model.json` read at spawn/compaction time; runtime state can only override, never define, the default; corrupt file fails open to default. Substitution is table-driven on the model string, so the frontmatter, the subagent-async fallback literal, and compaction all flip from one rule; effort suffixes survive substitution.
- **Deep-tier deletion**: evidence — exactly ONE deep spawn in the entire session history (2026-07-23, via OR); 017 documented that `review_depth: thorough` was declared 3× and standard spawned anyway because no routing logic ever existed; 017's quality rationale lapsed (glm-5.2 AA indices now below glm-5.3-flash's); decorrelation value gone once standard went z.ai-lab (019's argument inverts). Alternatives rejected: keep dormant + bump to 5.3 (maintenance debt, never paid out); wire up real routing (machinery for a tier whose quality rationale lapsed — mechanical checks from 017 carry anti-fabrication). Consequence: `review_depth` removed from the WO template.
- **Effort policy** (mechanism: pi's native `provider/model:level` shorthand — no custom parser): implement `:high` (writes code; enumeration is its value-add, medium risks shallow sweeps), scouts `:medium` (read-only research, speed+cost), reviewers `:max` (user directive: hard tail), oracle `:max` (user directive), orchestrator `:high` (016 follow-up intent: cap orchestrator reasoning spend). Levels survive the fleet toggle (0731 supports the same set).
- **models.json prune** (spec §5 text).
- **Rollback**: `/fleet-model deepseek` (runtime) + `git revert` (standing default + deletions).

**Required test boundary**: pure module `extensions/lib/fleet-model.ts` imported by `tests/fleet-model.test.ts` under `bun test` (precedent: model-tiers-render.test.ts). The subagent-async/compaction wiring is a two-line pass-through; extension loading can't be tested from the worktree (config symlinks serve the parent tree) — live dispatch is the orchestrator's post-merge E2E.

**Behavior and failure matrix**:

| # | Case | Expected |
|---|------|----------|
| 1 | No state file | `resolveFlashSeat()` → `{provider:"zai", model:"zai/glm-5.3-flash"}` |
| 2 | `{"flash":"deepseek"}` | → `{provider:"openrouter", model:"deepseek/deepseek-v4-flash-0731"}` |
| 3 | `{"flash":"glm"}` | → glm (explicit default) |
| 4 | Malformed JSON | `readFlashOverride()` → null, resolve → default, no throw |
| 5 | `{"flash":"luna"}` | → default, no throw |
| 6 | `resolveFlashModel("zai/glm-5.3-flash")` default | unchanged |
| 7 | `resolveFlashModel("zai/glm-5.3-flash:high")` under deepseek override | `"deepseek/deepseek-v4-flash-0731:high"` (suffix preserved) |
| 8 | Same call, default state | unchanged |
| 9 | `resolveFlashModel("deepseek/deepseek-v4-pro-0813:max")` under deepseek override | unchanged (oracle never substituted, suffix intact) |
| 10 | `resolveFlashModel("zai/glm-5.3:high")`, `("zai/glm-5.2")` | unchanged |
| 11 | `resolveFlashModel("z-ai/glm-5.2:batch")` | unchanged (`batch` not a level → no split) |
| 12 | `resolveFlashModel(undefined)` | `undefined` (inherit-parent path preserved) |
| 13 | `writeFlashOverride("deepseek")` then read | file content exactly `{"flash": "deepseek"}` (JSON, 2-space), resolve → deepseek |
| 14 | write then `clearFlashOverride` | file gone; resolve → default; clear on missing = no-op, no throw |
| 15 | `process.env.HOME` redirected to tmp dir | state file lands under tmp dir (call-time homedir) |

Tests isolate `HOME` per-test (mkdtemp, set, restore).

**Integration contract**: lib imported (relative) by subagent-async `index.ts`, `compaction-model.ts`, and `extensions/fleet-model.ts`. No pi-package imports in lib. The command mutates only `~/.pi/fleet-model.json`; nothing in the repo changes at runtime.

**Reference patterns**: `extensions/lib/pdf-convert.ts`, `writeMetaJson` (atomic write), `tests/model-tiers-render.test.ts`, decision 019 + 017 footnote.

### Invariants

**Cross-file conventions**:
- The flash-seat standing default exists in exactly one authoritative definition (`FLASH_SEAT[DEFAULT_FLASH]`) plus the agent frontmatter declarations; the table substitution makes all of them equivalent at runtime, including the subagent-async fallback literal.
- Non-flash models are NEVER substituted — the substitution matches only the two flash-seat base strings (after suffix split).
- No pi-package imports in `extensions/lib/fleet-model.ts`.

**Default values to preserve**:
- Missing/invalid state file → glm. Runtime state only overrides.
- `inheritParentModel` spawns use the parent model verbatim.
- Compaction fallback chain unchanged.

**Error handling conventions**:
- State-file read fails open to default (corrupt toggle file must never break spawning).
- `/fleet-model` bad args: error notify, no write.

**Unspecified invariants**: none — explicit.

### Verification Criteria

**Tests**: `bun test tests/fleet-model.test.ts` all rows green; `bun test tests/` no NEW failures vs recorded pre-change baseline (decision-012 precedent: pre-existing failures from missing pi packages may exist — record baseline first).

**Grep sweeps (zero-hit unless noted)**:
- `grep -rn "deepseek-v4-flash-0731" agents/ settings.json extensions/*.ts extensions/subagent-async/index.ts` → ONLY `extensions/lib/fleet-model.ts` (table).
- `grep -rn "review-code-deep\|review-plan-deep\|review-tests-deep\|review_depth" agents/ skills/ extensions/ README.md docs/model-role-scores.md docs/thinking-levels.md` → zero.
- `grep -rn "glm-5.2" agents/ README.md docs/model-role-scores.md docs/thinking-levels.md` → zero (historical decision files excluded).
- `grep -n "^model:" agents/*.md` → exactly: implement `zai/glm-5.3-flash:high`; review-{code,plan,tests} `zai/glm-5.3-flash:max`; scout-{code,web} `zai/glm-5.3-flash:medium`; orchestrator `zai/glm-5.3:high`; math-algo-oracle `deepseek/deepseek-v4-pro-0813:max`. The three `-deep` files no longer exist.
- `ls agents/` → 9 files (12 − 3 deleted).
- `models.json` valid JSON, exactly the one override.

**Structural risk checks**: template list — all pass. Specifically: no files modified beyond Scope; user's uncommitted `defaultThinkingLevel` edit preserved; no build config touched; no unsolicited features (no footer display, no auto-toggle, no replacement escalation machinery).

**Post-merge E2E (orchestrator's job, NOT implementer's)** — boundary stated so the implementer doesn't attempt it: `/reload`; `/fleet-model` shows default; spawn a trivial scout → session log shows provider zai, model glm-5.3-flash, thinking medium, and meta.json carries the same; `/fleet-model deepseek`; spawn again → 0731:medium; `/fleet-model glm` → file gone. Small `/compact` smoke. This E2E also validates the `:level` shorthand end-to-end through buildSubagentArgs.

### Structural Risks

- [ ] Route/path correctness: command `fleet-model` registered exactly once; lib under `extensions/lib/` (a root placement would be auto-loaded as an extension and fail).
- [ ] Input validation scope: state file accepts only the two keys; unknown/malformed → default, not error.
- [ ] Test surface: tests import the real lib; no re-implemented logic in tests.
- [ ] Recovery logic: corrupt state file must not block spawning.
- [ ] No unrequested changes — including: no changes to `agents/math-algo-oracle.md` body, `docs/data/*`, existing tests, decisions beyond the four footnotes + 020 + README index.
- [ ] Build config untouched.
- [ ] No unsolicited features.

### Context

**Prior work orders**: none in this mini-plan. Related decisions: 011 (0731 adoption, dated-slug explicitness), 012 (implementer collapse), 017 (deep tier dormant — 020 completes the deletion), 019 (standard reviewers → 0731 — 020 supersedes the model choice).

**Upcoming work**: watch item — re-check MathArena/AA/HF-card math rows for GLM-5.3(-flash) within ~3–5 days of 2026-08-28 (weights just dropped); if independent math data appears AND beats 0813-pro at its price band, the oracle seat gets its own decision. No other follow-ups planned.

**Relevant decisions**: 017 (mechanical checks carry anti-fabrication — inherited by 020 for the same-lab z.ai flip), 016 (orchestrator hallucination-first → 5.3 same family, effort capped high per its own follow-up note), 014 (WO is review-policy source of truth — unaffected), 005/006 (two-tier review origin — superseded).

### Completion Report Format

Standard implement schema: status / invariant_exhaustiveness / files_modified / tests / structural_checks / deviations_from_spec / notes_for_orchestrator, plus: assumptions_made / unexpected_changes / issues_encountered / test_coverage / adversarial_reviews (both verdicts + session IDs) / review_cap_reached / accepted_notes.
