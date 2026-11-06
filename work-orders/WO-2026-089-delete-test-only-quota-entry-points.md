# WO-2026-089 — delete the test-only quota entry points, and give the rows the descriptor's door

### Metadata

- **work_order_id**: WO-2026-089
- **parent_plan_id**: review triage 2026-11-06 (review `notes/review-2026-11-06/pi-config.md`, MEDIUM "the pre-refactor quota entry points have no production caller"); carried by the register row `docs/investigations/structure-trend.md:24`
- **sequence_position**: 1 of 1
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit — three named sites, one adapter, one hook kept.
- **priority**: normal
- **estimated_complexity**: moderate
- **review_policy**: required
- **turn_budget**: 50 turns. At 75 without a completion report, stop and report. Targeted rows only — never the full `bun test` (box-wide `flock` slot; the orchestrator gates it). Tell any reviewer you spawn the same.
- **base**: `d5143d0` (`origin/main`)

### Task Summary

**One-sentence description**: `renderQuotaSegment` and `renderGoUsageSegment` are deleted; the four test files keep their call sites through a small test-local adapter over `renderQuotaSnapshot`, and `goParts` is exported so that adapter can build Go parts.

**Goal**: no exported production function whose only callers are tests, and no golden string moves.

### Premise

Verified at `d5143d0`:

- `renderQuotaSegment` (`extensions/lib/quota.ts:666`) and `renderGoUsageSegment` (`:685`) have **no
  production caller**: `rg -n 'renderQuotaSegment|renderGoUsageSegment' --glob '!*.md'` → 2 definitions,
  1 comment and 1 re-export block in `extensions/footer-session-id.ts`, and 4 test files
  (`footer-quota-characterisation`, `footer-session-id-multiplier`, `footer-opencode-usage`,
  `activity-timeline`).
- The footer renders through `quotaDescriptorFor(model?.provider)?.render(cachedQuota, …)`
  (`footer-session-id.ts:1033-1034`), fed by `fetchQuotaSnapshot` → `descriptor.parse` → `snapshotFor`.
- `renderQuotaSnapshot` is already exported (`:184`) and takes exactly what the entry points assemble.
- For the token-window family, the descriptor's `fromQuotaData` hook (`:95`, set at `:352`) is the same
  function (`tokenWindowParts`) the z.ai parse uses; `goDescriptor` (`:556`) and its `goParts` (`:387`)
  are the Go equivalent, and `goParts` is private.
- The rows' fixtures are an *already-normalised* payload — `QuotaData` `{level, limits}` for the
  token-window rows, `GoUsage` for the Go rows. Production never holds that shape: it holds the raw API
  JSON until `descriptor.parse` returns parts. So the rows are testing **the renderer**, through a door
  production does not have.

### Rulings — the mechanism, and what it deliberately does not do

**The adapter goes in the test file, not the lib.** The two entry points assemble
`{provider, parts, overflow}` and call `renderQuotaSnapshot`. That assembly *is* test glue once no
production code does it, so it belongs beside the rows. A ~12-line adapter at the top of
`tests/footer-quota-characterisation.test.ts` keeps the four files' ~60 call sites unchanged, and the
goldens are identical **by construction** because the parts come from the same conversion function.

**`fromQuotaData` stays; `goParts` is exported.** The hook is descriptor metadata, not a render entry
point, and the adapter reads it. Go has no hook, so `goParts` gains an `export` with a `@for-testing`
note — one internal export rather than a second hook nobody asked for.

**What this does not take:** re-authoring the fixtures as raw API payloads (the review's other reading).
That would move every golden *and* change what the rows pin (renderer bytes → parse-plus-render
pipeline), and the descriptor-wiring block at `footer-quota-characterisation.test.ts:330-370` already
pins the parse path against `ZAI_PAYLOAD` and `MINIMAX_PAYLOAD`. Two doors, two jobs.

### Scope

**Files expected to change**: `extensions/lib/quota.ts` (delete 2 functions + the section, export
`goParts`), `extensions/footer-session-id.ts` (re-export block loses 2 names; comment rewritten),
`tests/footer-quota-characterisation.test.ts` (+ the adapter; call sites unchanged),
`tests/footer-session-id-multiplier.test.ts` and `tests/footer-opencode-usage.test.ts` (import the
adapter from wherever it lives — a shared helper in `tests/helpers/quota-render.ts` is acceptable and
preferred if the three files otherwise duplicate it), `tests/activity-timeline.test.ts` (its
"still importable" row), `docs/investigations/structure-trend.md` (the row closes).

**Files NOT to modify**: the two watch viewers, `watch-session.ts`, the footer's render path
(`:1033-1034`), `fetchQuotaSnapshot`, `quotaDescriptorFor`, `fromQuotaData`'s definition, and any golden
string.

**Out of scope**: `tests/footer-session-block.test.ts:40` and `tests/model-tiers-render.test.ts:322`'s
test-local `stripAnsi` copies (a separate fold, noted in WO-2026-088's accepted notes).

### Prohibitions

1. **No golden moves.** Every expected string in the four files is byte-identical before and after;
   `git diff` on those files shows only the adapter and import lines. If a golden changes, stop — the
   adapter is wrong, not the golden.
2. **The two entry points are gone from both modules.** `rg -n 'renderQuotaSegment|renderGoUsageSegment' --glob '!*.md' extensions/` → no output; `rg -n 'renderQuotaSegment|renderGoUsageSegment' --glob '!*.md'` → hits in `tests/` only, and those are the adapter's own definition and calls.
3. **No new production surface but one export.** `git diff` on `extensions/lib/quota.ts` adds exactly
   `export` to `function goParts` and deletes the two functions plus their comment block; nothing else
   changes signature. `fromQuotaData` stays.
4. **`renderQuotaSnapshot` is not modified.** Its signature and body are untouched (its golden rows all
   go through it).
5. **No test spawns a process**; if one does, `env: childEnv()`.
6. **The register row closes**, with the `rg` that proves it.

### Verification Criteria

```
bun test tests/footer-quota-characterisation.test.ts
bun test tests/footer-session-id-multiplier.test.ts
bun test tests/footer-opencode-usage.test.ts
bun test tests/activity-timeline.test.ts
bun test tests/footer-kimi-usage.test.ts
bun test tests/footer-quota-key.test.ts
bun build --target node --outdir /tmp/wo089 extensions/footer-session-id.ts
```

**Acceptance rows**: the existing rows are the acceptance — this order changes no expected value. Prove
the wiring with **three mutations**, each alone, file reverted between:
- adapter passes `provider` where `snapshot.provider` belongs → the `snapshot.provider !== provider` guard
  fires and one or more rows red;
- adapter drops `overflow` (uses the descriptor's, so `undefined` for the hand-built snapshot) → a
  MiniMax clip-vs-truncate row reds;
- `goParts` replaced by `() => []` → the Go rows red.
Each must red something; a mutation that reds nothing means the adapter is not exercising what the rows
think it is — say so rather than moving a golden.

**Report**: `files_modified`; the `rg` results for prohibitions 1–2; the three mutation results; the
adapter's final text; the register row's closing text.

### Stop reports

- **`PREMISE FALSIFIED`** — a production caller exists, or a golden cannot be reproduced through
  `renderQuotaSnapshot` with the same parts.
- **`PLAN MISMATCH`** — the adapter needs more than `tokenWindowParts`/`fromQuotaData`/`goParts`/
  `renderQuotaSnapshot` to reproduce a golden.
- **`REFACTOR FIRST`** — the three test files cannot share one adapter without restructuring their
  fixtures.

---

## Landing stamp — 2026-11-07

**Merged** `c99cd67` (branch `pi-subagent-5fe120740a3a`, tip `59924fe`). **84 turns against a 50-turn
budget** — the overrun that motivated the turn-cap order; the work finished, but no stop-report was
raised at 75.

**Prohibitions verified at the branch, not from the report.** `git grep
'renderQuotaSegment\|renderGoUsageSegment' <branch> -- extensions/` → none; whole-tree hits are the four
`tests/` files, two older work orders and the register. `git diff -U0 <base> <branch> -- tests/ | rg -c
'^[+-].*expected'` → 0. The two hunks in `extensions/lib/quota.ts` are `-386,2 +386,5` (`goParts`'s
export) and `-653,55 +655,0` (the tail), so `renderQuotaSnapshot:184` and `fromQuotaData:95` are outside
them. Register arithmetic re-measured at the tip: 655 / 1111 / 82.

**Mutation 3 re-run at the gate** (`goParts` → `return []`): 18 fail, 46 pass. The reported 18 is right;
the reviewer's first 19 counted a `visibleWidth(s) <= 6` row that an empty segment satisfies.

**Two order defects, corrected here rather than departed from.**
1. Prohibition 1 said the four test files show "only the adapter and import lines", while §Scope named
   `activity-timeline.test.ts`'s "still importable" row as expected to change. That row asserts
   `typeof mod.renderQuotaSegment === "function"`, which cannot survive the deletion: Scope governs, and
   the row now asserts `renderQuotaSnapshot` with `expected` unchanged. The operative rule — no golden
   moves — held at 0 diff lines.
2. The specified mutation 2 ("drop `overflow` → a MiniMax clip-vs-truncate row reds") cannot fire. Both
   MiniMax descriptors are `overflow: "clip"` and the renderer tests `snapshot.overflow === "truncate"`,
   so `undefined ≡ "clip"`; dropping `overflow` reds the two Go rows instead. The discriminating
   direction is forcing the token-window arm to `"truncate"`, which reds the three clip rows. Use that
   form in future quota-wiring mutations.

**Suite:** 1306 tests / 68 files, 9 fail — the standing set in `/tmp/f088.txt`, none new, none gone. Run
from the repo root: from a depth-3 worktree bun's discovery also sweeps `~/Developer/baba-pi/test/`,
which is why the first run read 1277 tests / 11 fail and is not a regression signal.

**Process note:** `invariant_exhaustiveness: explicit` was wrong. Two invariants — the Go body's
redundant `modelProvider !== GO_PROVIDER` check, and `resetNow` taken from the real clock — were only
describable from the deleted bodies, so the order was `implicit`.

**Left standing, deliberately:** the `@for-testing` marker where the repo uses `@for-testing-only` in 15
places (the order named the short form; both reviewers rated it LOW), and the `"opencode-go"` literal in
the adapter, whose clean fix — exporting `snapshotFor` — is the option Ruling 2 rejected.
