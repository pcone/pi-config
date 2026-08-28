# WO-2026-048 — Fleet → zai/glm-5.3-flash, single review tier, /fleet-model toggle

**Status**: MERGED 2026-08-28 (branch pi-subagent-88be00a6153e → merge 5588a0a; both reviewers APPROVED_WITH_NOTES round 1, notes resolved). E2E: model+suffix verified live (scout spawn ran zai/glm-5.3-flash, effective thinking high — zai has no real medium, see thinking-levels addendum); stray default-equivalent state file removed; `/fleet-model` command available from next session start (this session pre-dates the merge). Watch item: GLM-5.3 math rows (MathArena/HF card) — recheck ~2026-09-01.

**Decisions (all user-confirmed):**
- Flash seat (implement, 3 reviewers, 2 scouts, compaction) → `zai/glm-5.3-flash`, toggleable
  back to `deepseek/deepseek-v4-flash-0731` via `/fleet-model` (state `~/.pi/fleet-model.json`).
- Deep tier DELETED (3 agent files): exactly one deep spawn ever (2026-07-23), 017 routing
  never existed, quality rationale lapsed, decorrelation inverted by the z.ai flip.
  `review_depth` removed from WO template.
- Orchestrator → `zai/glm-5.3:high` (016 follow-up: cap reasoning spend).
- Effort policy via native `provider/model:level` shorthand: implement high, scouts medium,
  reviewers max, oracle max. resolveFlashModel is suffix-aware (toggle preserves level).
- Oracle STAYS `deepseek/deepseek-v4-pro-0813` — recon (scout subagent-520b5fa4, 2 passes):
  zero math/algo benchmarks for any GLM-5.x model anywhere (vendor surface + MathArena +
  BenchLM + llm-stats all checked); omission is editorial (GLM-5.2 had a self-reported AIME
  0.992 row). 0813: AIME 96.67 / HMMT 95.2 / CF 3206.
- models.json pruned to one override (0813 first-party routing pin — correctness guard);
  maxTokens pins were stale-to-restrictive (0731 catalog 943,718 vs pin 131,072).

**Design:** standing default versioned in agent frontmatter; runtime override file only ever
overrides. Shared table in `extensions/lib/fleet-model.ts` (lib/ skips auto-discovery).
Interception: subagent-async 2 effectiveModel sites + compaction-model.ts + new
`/fleet-model` command extension. Watch item: GLM-5.3 math rows on MathArena/HF card
(weights dropped 2026-08-28) — recheck in 3–5 days; oracle seat re-decides only if
independent math data appears.

**Reviewer-split audit (done 2026-08-28):** deep tier fired once ever; post-019 reviewers
100% standard in pairs (session files + /tmp meta.json).

---

# WO-2026-031 — Implementer-tier collapse experiment

**Status**: in progress (implementer dispatched 2026-08-02)

## Goal

Collapse `implement-flash` + `implement-pro` into a single `implement-pro` on
`deepseek/deepseek-v4-flash-0731`. Oracle stays on `deepseek/deepseek-v4-pro`.

## Why (experiment framing)

0731 beats V4 Pro on all three served-model AA indices (49.9/69.1/45.7 vs
44.3/59.4/36.4) at ~⅓ the blended price ($0.019 vs $0.055). DeepSeek's agentic
suite shows large gains (DeepSWE 7.3→54.4, Cybergym 38.7→76.7). SWE-Pro/LCB
unpublished for 0731 → this is a deliberate, documented experiment.

## Rollback path (one commit revert)

1. `git revert` the merge of branch `pi-subagent-1d9ecd067225` → restores
   `agents/implement-flash.md` + the two model lines
2. `agents/implement-pro.md` model → `deepseek/deepseek-v4-pro`
3. `agents/math-algo-oracle.md` unchanged (never touched)

## Steps

- [x] Scope blast radius (agents/, orchestrator, work-order skill, SYSTEM_PROMPT,
      modes.ts, reviewers, docs, decisions) — WO-2026-031 written
- [x] Dispatch implement-pro (session subagent-f4c6afbf-f9da-4ada-9e49-1d9ecd067225)
- [ ] Review completion report (status, invariant calibration, structural checks)
- [ ] Verify: grep implement-flash → zero in live config; bun test → no new failures
- [ ] Verify survivor resolves; oracle untouched
- [ ] Merge worktree branch
- [ ] Post-experiment watch: SWE-Pro/LCB for 0731 (`fetch_benchlm.py --check-0731`)
      → if granular beats Pro, keep collapse; if regression, rollback

## Files that will change

`agents/implement-pro.md` (model+prose), `agents/implement-flash.md` (delete),
`agents/orchestrator.md`, `agents/review-code.md`, `agents/review-tests.md`,
`skills/work-order-template/SKILL.md`, `extensions/subagent-async/SYSTEM_PROMPT.md`,
`extensions/modes.ts`, `apps/changelog-gen/ROADMAP.md`, `docs/thinking-levels.md`,
`docs/model-role-scores.md`, `decisions/subagents/{012-new,011-footnote,README}`,
`work-orders/WO-2026-031.md`.

## WO-2026-034 — carry parent's uncommitted state into isolated worktrees

**Problem:** `createWorktree` (extensions/subagent-async/index.ts:445) branches off
parent HEAD only; an uncommitted plan/work-order doc in the parent is invisible to
the isolated subagent (first `read` → ENOENT).

**Fix:** overlay parent's uncommitted WIP (via `git status --porcelain=v1 -uall -z`,
read-only on parent) into the worktree after `worktree add`. New `carryUncommitted`
spawn param (default true); skip when `baseRef` is set. Do NOT touch preCommitSteps
(line 522). Production change confined to index.ts; test = new standalone script
`extensions/subagent-async/test-carry-uncommitted.cjs` (test-subject.cjs pattern —
index.ts isn't importable: typebox/pi packages resolve only under jiti).

**State:** dispatched to implement-pro via work-orders/WO-2026-034.md.
**After merge:** orchestrator runs real-dispatch E2E (steps 1–6 in WO), then
optional follow-ups (skip byte-identical carried files in auto-commit; warn on
missing carried paths).

**Update (user decision):** follow-up #1 (completion-time filter — skip committing carried files
byte-identical to the carried-in snapshot) is bumped from optional to MUST-DO. Sequenced as
WO-2026-035 on 034's branch (depends on 034's carried-snapshot data), merged with 034 as one
change. `carryPaths` narrowing param remains optional/unplanned for now.

**Live bug found (E2E, post-reload):** `createWorktree` destructures
`const [topLevel, headResult]` where `topLevel` is the git RESULT OBJECT
({stdout,stderr,exitCode}); the carry passes the object as the repo path →
spawn cwd invalid → best-effort catch swallows → carry NEVER ran in production
(silent). Every real isolated worktree clean despite dirty parent; replication
with the path string works; mirror test has the same blind spot (execFileSync
returns a string). Fix folded into WO-2026-035 (steered): extract
`topLevelResult.stdout.trim()`, fail-fast typeof guard in carryUncommittedState,
mirror wiring pin + new matrix row. Lesson: the mirror/unit boundary cannot catch
object-vs-string wiring bugs — real-dispatch E2E is mandatory verification for
createWorktree changes.

**WO-2026-035 merged (4fbee59):** completion filter (skip committing carried
files byte-identical to the snapshot) + topLevel wiring fix + mirror row 21.
All suites green (carry 21, filter 12, subject 9, guard 51). Remaining: final
E2E battery after ONE more /reload (session still runs pre-035 code):
(1) default carry → handoff readable; (2) guards still ENOENT; (3) read-only
scout → no branch commit + branch deleted; edit scout → commit has edit;
(4) parallel isolation. Then cleanup handoff file + docs, and consider a
doc/decision note on "E2E mandatory for createWorktree changes".

**FINAL E2E BATTERY — ALL GREEN (fixed code, after 2nd reload):**
1. Default carry → handoff file READABLE (E2E-CARRY-PASSED); worktree shows all 6
   carried entries. 2. carryUncommitted:false → ENOENT. 3. baseRef → ENOENT,
   branch pinned at ref. 4. Parallel isolation → both see carried file, neither
   sees the other's marker; both branches' auto-commits contain ONLY their own
   marker (filter excluded the 5 carried M files + carried untracked doc).
5. 035 read-only scout → NO commit, branch deleted by postDeliveryCleanup.
6. 035 edit scout → branch commit contains ONLY the edited handoff
   (EDITED-BY-E2E-SUBAGENT); untouched carried files absent. Verification
   steps 1-7 of the original spec: complete. E2E scratch artifacts cleaned.
