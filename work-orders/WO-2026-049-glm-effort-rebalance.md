# WO-2026-049 — GLM effort rebalance: flash seat → :high, glm-5.3 seats → :max, `low` banned

### Metadata

- **work_order_id**: WO-2026-049
- **parent_plan_id**: N/A — direct user directive (orchestrator session, 2026-08-28 evening)
- **sequence_position**: 1 of 1
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit
- **priority**: normal
- **estimated_complexity**: moderate — edits are trivial; the load-bearing part is the decision record + doc consistency sweep
- **review_policy**: required — agent frontmatter strings drive live spawn behavior (a typo'd level silently mis-levels every future spawn), and five doc surfaces must stay mutually consistent

### Task Summary

**One-sentence description**: Rebalance fleet thinking levels per the user's 2026-08-28 benchmark review — reviewers drop `max`→`high` on glm-5.3-flash, the orchestrator rises `high`→`max` on glm-5.3, `low` is banned fleet-wide, scouts keep `:medium` — and record it as decision 021.

**Goal**: After this WO, the fleet's per-agent effort levels are: implement/reviewers `zai/glm-5.3-flash:high`, scouts `zai/glm-5.3-flash:medium`, orchestrator `zai/glm-5.3:max`, oracle `deepseek/deepseek-v4-pro-0813:max` (unchanged), main session glm-5.3 at `defaultThinkingLevel: max` (commit the already-staged-in-working-tree settings change); `low` appears nowhere and is policy-banned; decision 021 records the why; every living doc surface agrees.

### Scope

**Files to modify**:
- `agents/review-code.md` — frontmatter `model: zai/glm-5.3-flash:max` → `zai/glm-5.3-flash:high`
- `agents/review-tests.md` — same edit
- `agents/review-plan.md` — same edit
- `agents/orchestrator.md` — frontmatter `model: zai/glm-5.3:high` → `zai/glm-5.3:max`
- `settings.json` — commit the working-tree change (`defaultThinkingLevel: "high"` → `"max"`); it is already edited in the parent tree and will be carried into your worktree — do not revert it, commit it as part of this work
- `decisions/subagents/021-effort-rebalance.md` — NEW decision record (content spec below)
- `decisions/subagents/README.md` — add index row 021; optionally annotate 020's row "(effort table superseded by 021)" — the 020 *file body* must NOT be edited (append-only record)
- `docs/thinking-levels.md` — update stale/contradicted claims (detailed list below)
- `docs/model-role-scores.md` — update all living references to the changed levels (detailed list below)
- `README.md` — line ~33 agents section: "reviewers `:max`" → `:high`; "Orchestrator on `zai/glm-5.3:high`" → `:max`

**Files to read (reference only, do not modify)**:
- `decisions/subagents/020-fleet-glm-53-flash-single-tier.md` — pattern for the decision record format; 021 supersedes ONLY its effort-policy table
- `docs/thinking-levels.md` — the level-map facts 021 cites (zai `medium`→null→provider-default high, E2E-verified twice; DeepSeek V4 map)
- `extensions/lib/fleet-model.ts` — confirms effort suffixes survive the `/fleet-model` toggle (no code change needed)

**Files NOT to modify**:
- `decisions/subagents/020-fleet-glm-53-flash-single-tier.md` — decisions are append-only; supersede via 021 + index annotation, never rewrite
- `work-orders/*` — frozen dispatch records
- `extensions/**` — no code changes; the fleet-model lib is level-agnostic (suffix-preserving) and nothing here touches it
- `agents/implement.md`, `agents/scout-code.md`, `agents/scout-web.md`, `agents/math-algo-oracle.md`, `agents/bug-triage.md` — seats whose levels are unchanged by this decision (implement `:high`, scouts `:medium`, oracle `:max`; bug-triage has no model frontmatter by design)
- `docs/TODO.md` — orchestrator-owned tracking; updated post-merge
- `models.json`, `tests/**` — untouched

**Out of scope**: changing any seat's *model* (020 owns model choice; this WO is effort-only); the GLM-5.3 math-rows watch item (due ~2026-09-01, separate); adding tests (no code changes — `tests/fleet-model.test.ts` uses level strings generically and stays green); the work-order template or skills.

### Implementation Specification

**Detailed requirements**:

1. Frontmatter edits (exact strings):
   - `agents/review-code.md`: `model: zai/glm-5.3-flash:max` → `model: zai/glm-5.3-flash:high`
   - `agents/review-tests.md`: same
   - `agents/review-plan.md`: same
   - `agents/orchestrator.md`: `model: zai/glm-5.3:high` → `model: zai/glm-5.3:max`
2. Commit `settings.json` as carried (defaultThinkingLevel max).
3. Write `decisions/subagents/021-effort-rebalance.md`. Required content (frontmatter: `type: decision`, `status: done`, `date: 2026-08-28`), following the repo's re-litigation-proof rule (ground in observation, refute the obvious alternative, list alternatives rejected, state tradeoffs):
   - **What**: effort rebalance, decision-020 follow-up. Reviewers ×3 `:max`→`:high`; orchestrator `:high`→`:max`; main-session `defaultThinkingLevel` high→max (user already flipped settings.json same day); `low` banned fleet-wide; scouts KEEP `:medium`; implement `:high` and oracle `:max` unchanged.
   - **Why (grounding)**: user benchmark review 2026-08-28 evening (GLM per-effort comparisons): (a) glm-5.3-flash high vs max — very small quality delta, very large token delta; (b) glm-5.3 high vs max — token delta notably less stark than flash's, worth max for the seat that owns the complex tail; (c) low vs high — large quality delta on BOTH glm-5.3 and glm-5.3-flash → never use low. Known level-map facts from docs/thinking-levels.md (live-verified 2026-08-28, twice): zai maps `low`→low, `medium`→**null** (falls back to the PROVIDER default, high — not the session default), `high`→high, `xhigh`→null, `max`→max; DeepSeek V4 maps low→low, medium/high/xhigh→high, max→max.
   - **Why scouts keep `:medium`**: it is inert on zai (effective = provider-default high — so scouts already run GLM-high today) and valid under the `/fleet-model deepseek` toggle (0731 maps medium→high; suffix is preserved by substitution). It also future-proofs: if z.ai ships a real medium, pi's catalog map picks it up. This is the user's explicit call ("keep that for deepseek").
   - **Routing principle (state it explicitly)**: the complexity dial in this fleet is MODEL CHOICE — complex work rides glm-5.3 at `max`, everything else rides glm-5.3-flash at `high`. Per-task effort-down on glm-5.3 is NOT a lever; less-complex work moves to the flash seat instead.
   - **`low` ban**: no config uses `:low` today; the ban closes the standing suggestion in docs/thinking-levels.md ("the cheaper real option is `:low` … revisit only if scout token spend matters") — now rejected with the low-vs-high quality evidence. Covers DeepSeek too (its `low` is real and equally rejected).
   - **Alternatives rejected** (each with one-line why): keep reviewers `:max` (negligible gain, large certain token cost on the fleet's highest-volume thinking seats — 3 spawns per review round); keep orchestrator `:high` (020's own text admits the quality delta was unmeasured while token cost was certain — the new benchmark review resolves the tradeoff the other way for the full model); move scouts to explicit `:high` (same effective level on zai, loses deepseek-toggle semantics and intent legibility); `:low` scouts for cost (banned — quality cliff); per-spawn effort dialing on glm-5.3 (unmeasured, adds an orchestrator decision per dispatch; the model dial already encodes complexity).
   - **Tradeoffs (state honestly)**: reviewers give up the small max-effort margin — anti-fabrication is carried by 017's mechanical checks, not effort level; orchestrator/main-session token spend rises with max (accepted: 5.3 spawns are rare vs the flash seat, and z.ai plan bills flash at ⅓ points); the GLM per-effort numbers are from the user's benchmark review, NOT yet in `docs/data/benchlm_snapshot.json` (2026-08-02 snapshot predates GLM-5.3 entirely — it has no GLM-5.3 rows; note that the next snapshot refresh should capture GLM-5.3 effort-variant rows if published).
4. Add the 021 row to `decisions/subagents/README.md` index (`| 021 | Effort rebalance — flash :high, glm-5.3 :max, low banned | done |`), and annotate 020's row status to note its effort table is superseded by 021 (e.g. `done (effort table superseded by 021)`). Do not touch the 020 file.
5. `docs/thinking-levels.md` updates (keep the doc's research structure; make it agree with 021):
   - "How levels reach the fleet": `defaultThinkingLevel` is now `"max"` (021) — fix the stale `"high"` mention; keep the subagent-inherits-default explanation (now correct with max).
   - The GLM-5.3 row in the findings table ("Sweet spot" cell): update to the 021 effort-per-seat policy (implement `:high`, reviewers `:high`, scouts `:medium` (inert→provider-default high), orchestrator/main `:max`).
   - The addendum sentence "The cheaper real option is `:low` — untested quality …; revisit only if scout token spend matters": replace with the 021 ban (low rejected on quality evidence; fleet-wide).
   - "What this means for current assignments": item 1 (flash seat) now implement `:high`, reviewers `:high`, scouts `:medium`; item 2 (orchestrator) now `zai/glm-5.3:max` — 021 supersedes 020's "stay on high" reasoning; item 3 (oracle) unchanged. Where 020's rationale is quoted, mark it superseded by 021 rather than silently rewriting history.
   - Add a dated 021 addendum block citing the user benchmark review and linking the decision.
6. `docs/model-role-scores.md` updates (living sections only — the historical snapshot reasoning stays):
   - Current assignments table ("Slot | Agent file | Model | Effort | Verdict"): Orchestrator row effort high→max (verdict: "✓ raised to max 2026-08-28 (decision 021 — user benchmark review)"); Review standard ×3 row max→high (verdict: "✓ dropped to high 2026-08-28 (decision 021)"); Main session row: note `defaultThinkingLevel` now max (021); other rows unchanged.
   - The "2026-08-28 fleet move (decision 020)" callout block (~line 58): append/adjust to note effort levels were rebalanced same day by 021 (orchestrator `:max`, reviewers `:high`).
   - Seat-table rows (~lines 73-74): orchestrator `:high`→`:max` (cite 021); reviewer/implementer cells mention reviewers `:high` where they say `:max`.
   - Assignment audit items: #1 (fix "defaultThinkingLevel stays `high`" → now `max` per 021; the settings flip is same-day user action, committed by WO-2026-049), #2 (orchestrator now `:max` — 021 supersedes the cap-reasoning-spend note), #5 (reviewers now `:high` — 021), #7 (scouts unchanged but note 021's keep-`:medium` rationale in one clause if space allows).
   - The single-tier reviewer paragraph (~line 181): `at :max` → `at :high (decision 021)`.
7. `README.md` (~line 33): "reviewers `:max`" → "reviewers `:high`", "Orchestrator on `zai/glm-5.3:high`" → "on `zai/glm-5.3:max`". Scan the rest of README for other level mentions (e.g. model-tiers section) and align.
8. Run the full verification matrix below; commit everything as one logical change with a message referencing WO-2026-049 and decision 021.

**Required test boundary**: No code changes → no new tests. The boundary is (a) `bun test` in `extensions/` (or repo root if configured — check `package.json`/`bun.lock` location) stays green, and (b) the grep matrix below passes exactly. Both are mandatory completion evidence.

**Behavior and failure matrix** (the test reviewer audits row by row):

| # | Case | Expected |
|---|---|---|
| 1 | `agents/review-code.md` model line | `model: zai/glm-5.3-flash:high` |
| 2 | `agents/review-tests.md` model line | `model: zai/glm-5.3-flash:high` |
| 3 | `agents/review-plan.md` model line | `model: zai/glm-5.3-flash:high` |
| 4 | `agents/orchestrator.md` model line | `model: zai/glm-5.3:max` |
| 5 | `agents/implement.md` model line | unchanged: `zai/glm-5.3-flash:high` |
| 6 | `agents/scout-code.md` + `agents/scout-web.md` model lines | unchanged: `zai/glm-5.3-flash:medium` |
| 7 | `agents/math-algo-oracle.md` model line | unchanged: `deepseek/deepseek-v4-pro-0813:max` |
| 8 | `settings.json` | `defaultThinkingLevel: "max"` committed; no other keys changed vs parent working tree |
| 9 | `rg -n ':low' agents/ extensions/ settings.json models.json` | zero matches |
| 10 | Living docs (README.md, docs/thinking-levels.md, docs/model-role-scores.md current-assignments sections, decisions/subagents/README.md) | every effort mention matches 021's table; no living doc still says reviewers `:max` or orchestrator glm-5.3 `:high` |
| 11 | Historical records (`decisions/subagents/020-*` body, `work-orders/*`, the 2026-08-01 snapshot reasoning in model-role-scores) | NOT rewritten — they may still describe the old levels as history |
| 12 | `decisions/subagents/021-effort-rebalance.md` | exists; has what/why grounded in the 2026-08-28 user benchmark review + the live-verified level maps; ≥5 alternatives rejected; tradeoffs stated; index row added |
| 13 | `bun test` | all suites green, zero test files modified |
| 14 | `docs/thinking-levels.md` | no residual ":low … revisit" suggestion; `defaultThinkingLevel` stated as max; 021 addendum present |

**Representation-level checks**: N/A — no code/IR changes.

**Integration contract**: Agent frontmatter `model:` values are parsed by pi at spawn time; the `:level` suffix is pi-native and survives `extensions/lib/fleet-model.ts` substitution (suffix-preserving) — so `zai/glm-5.3-flash:high` reviewers become `deepseek/deepseek-v4-flash-0731:high` under the deepseek toggle, which is valid (0731 maps high→high). Nothing downstream keys on the specific level strings.

**Reference patterns**: `decisions/subagents/020-fleet-glm-53-flash-single-tier.md` for decision-record structure (What/Why/Alternatives rejected/Tradeoffs); the 2026-08-28 addendum in `docs/thinking-levels.md` for how dated addenda are layered without rewriting history.

### Invariants

**Cross-file conventions**:
- Decision records are append-only: 020's body is never edited; supersession is expressed via 021 + the README index.
- Living docs must never contradict the current decision; historical sections keep old values as history with a supersede note.
- The effort shorthand stays pi-native `provider/model:level`; no custom parsing.
- Effort suffixes on flash-seat agents must remain in the substitution-surviving form (base is exactly `zai/glm-5.3-flash`).

**Default values to preserve**:
- `settings.json`: every key except `defaultThinkingLevel` unchanged (it is already `max` in the working tree — commit as-is).
- `models.json` untouched (single 0813 routing pin).

**Ordering assumptions**: N/A.

**Error handling conventions**: N/A (no code).

**Unspecified invariants**: none — exhaustive above.

### Verification Criteria

**Entry points that must work**: the grep matrix (rows 1-11, 14) passes verbatim; `bun test` exits 0.

**Input shapes**: N/A.

**Tests that must pass**: `bun test` from `extensions/` (fleet-model suite included) — zero modifications to test files.

**Test surface requirements**: the grep matrix IS the behavioral surface here (config-as-frontmatter has no test harness; the matrix pins every changed and unchanged model line).

**Build requirements**: none (docs + config only).

### Structural Risks

- [ ] **Route/path correctness**: model strings are exact — `zai/glm-5.3-flash` (hyphen in glm-5.3, flash suffix), level suffix exactly `:high`/`:max`/`:medium` (no whitespace, no `thinking:` prefix)
- [ ] **Input validation scope**: N/A
- [ ] **Test surface**: grep matrix run against the worktree, not described from memory
- [ ] **Recovery logic**: N/A
- [ ] **No unrequested changes**: no agent file beyond the four listed; no extension edits; 020 body untouched; tests untouched
- [ ] **Build config untouched**: `package.json`, `bun.lock`, `models.json` unchanged
- [ ] **No unsolicited features**: no new seats, no model changes, no test additions, no TODO.md edits

### Context

**Prior work orders completed in this plan**: WO-2026-048 (merged 2026-08-28): fleet flash seat → zai/glm-5.3-flash, single review tier, `/fleet-model` toggle, effort policy (the table this WO rebalances), models.json prune. Key state: FLASH_SEAT table in `extensions/lib/fleet-model.ts` is the toggle mechanism and is level-agnostic.

**Upcoming work orders**: watch item due ~2026-09-01 (GLM-5.3 math rows → oracle re-decide). Do not pre-empt it.

**Relevant decisions from planning session**:
- User directive, 2026-08-28 evening: flash high-vs-max quality delta very small / token delta very large → flash seats to `high`; low-vs-high quality delta large on both GLM variants → ban `low`; glm-5.3 high-vs-max token delta less stark → glm-5.3 at `max` most of the time, less-complex work routes to flash `high` instead; scouts keep `:medium` (no real medium on GLM — falls back to provider-default high, verified; keep for deepseek).
- Decision 020 owns model choice + toggle; 021 owns effort levels only.

### Completion Report Format

Per template: status / invariant_exhaustiveness / files_modified / tests / structural_checks / deviations_from_spec / notes_for_orchestrator, plus for review-policy work: assumptions_made, unexpected_changes, issues_encountered, test_coverage, adversarial_reviews (both reviewer verdicts + session IDs + rounds), review_cap_reached, accepted_notes.
