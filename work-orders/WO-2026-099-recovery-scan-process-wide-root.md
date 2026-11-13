# WO-2026-099 — the recovery scan's /tmp and cargo root are process-wide injectable

### Metadata

- **work_order_id**: WO-2026-099
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit
- **estimated_complexity**: medium
- **review_policy**: required
- **order_source**: seat `8f90746f`, 2026-11-13 — "027's recovery scan reaching the real `/tmp` and cargo root from tests … same shape as `PI_SUBAGENT_WT_ROOT`: an override that replaces or throws, seeded by the test preload rather than by each file."

### Task Summary

Two seams in `extensions/subagent-async/recovery.ts` are per-process in-memory
test hooks, not process-wide configuration:

- `_testSetRecoveryScanDir(dir)` — the metas dir the `session_start` recovery
  scan reads (default `/tmp`).
- `_testSetCargoHome(home)` — the home whose shared cargo target root
  `reapFinishedWorktrees` bounds and prunes.

Every entry point that forgets a hook reads the real `/tmp` (the box's live
`pi-subagent-*` metas and logs, including other sessions' running children) and
the real cargo root. That is the leak: which files remember is a list, and a list
is incomplete the day someone adds a file. It is the same defect
`PI_SUBAGENT_WT_ROOT` was introduced to remove for the worktree base
(`decisions/subagents/049`, `docs/design/subagent-worktree-root.md`).

### Scope

- `extensions/lib/subagent-state.ts` — `SUBAGENT_TMP_DIR` becomes the default of
  a resolver that reads `PI_SUBAGENT_META_DIR`: absolute or throw
  (`PI_SUBAGENT_WT_ROOT`'s shape, `extensions/lib/subagent-worktree.ts:66-72`),
  never absorbed.
- `extensions/subagent-async/recovery.ts` — the cargo home resolves through
  `PI_SUBAGENT_CARGO_HOME` the same way; `_testSetRecoveryScanDir` and
  `_testSetCargoHome` are deleted.
- `tests/preload-worktree-root.ts` (rename to fit its now-wider job) sets both
  vars to fresh temp dirs before any test file loads, and removes them after, so
  a nested `bun test` gets its own too.
- Every test that used the hooks sets the env var for its row instead, restoring
  the previous value in a `finally`. A row that needs a *specific* fixture dir
  keeps passing it as an argument (`deps.dir`) where the seam allows it.
- `docs/design/subagent-worktree-root.md` gains the two new variables and the
  same "an explicit argument wins over the override" limit, with the reasoning.

### Acceptance rows

1. **No test reaches the real `/tmp`.** A row asserts `subagentMetaDir()`
   resolves to the preload's dir with no per-file setup, and that an unset
   variable still defaults to `/tmp` (the production path).
2. **A non-absolute or empty value throws**, naming the variable and the value —
   driven for both variables; the throw is not caught by the recovery scan's
   swallow-all paths (a swallowed override would silently read `/tmp`).
3. **The hooks are gone**: `rg -n '_testSetRecoveryScanDir|_testSetCargoHome' extensions/ tests/` → 0.
4. **The nested-run property survives**: `bun test tests/<a spawning file>` inside
   a test still redirects, i.e. the preload applies to child processes.
5. **027's own behaviour is unchanged** with the override unset: one row that
   calls `reapFinishedWorktrees` with no `dir` and no env sees the `/tmp` default
   (assert the resolved *path*, not a scan of it — do not read the real directory).

### Sequencing

Independent of WO-2026-098 and WO-2026-097. Land it behind the existing
`tests/subagent-recovery-ownership.test.ts` and `tests/subagent-worktree-lock.test.ts`
rows, which are the characterisation of the machinery being rewired.

### Verification

- Each row fails before the change for its stated reason.
- Full suite: one `bin/heavy -- bun test` run, green apart from the known
  pre-existing reds (`tests/subagent-model-inheritance.test.ts:493` and the
  hermeticity row derived from it).
- `rg -n '"/tmp"' extensions/` afterwards: report every remaining occurrence and
  why it stays.

## Gate-back record — 2026-11-13

Landed on `pi-subagent-ebf9a4ee2574` for rounds 1–2: `100ad98` (round 1, code+tests),
`e9899c3` + `0c553fe` (docs/decision 052), `f4cb623` (round 2: the two reviews' HIGHs and
the surviving hook) and `8e80ce8` (decision 052 round 2, the register snapshot, Q-099-a).
Round 3 lands the base pre-flight, its row, and the corrected claim (decision 052 § Round 3).
Snapshot: `docs/investigations/structure-trend.md`, 2026-11-13 entry.

### Owner question Q-099-a (raised 2026-11-13, by both round-1 reviews) — RULING PENDING

**Ask:** is acceptance row 5 satisfied by the split implementation, or does it need a seam
that reports the reap's resolved roots?

Row 5 as written asks for "one row that calls `reapFinishedWorktrees` with no `dir` and no
env sees the `/tmp` default (assert the resolved *path*)". Taken literally it contradicts
itself: the reap must list the directory it resolves, which is a read of the real `/tmp`,
and the same row says not to read it. Round 1 landed the two halves instead —
`tests/subagent-recovery-ownership.test.ts:813-821` (unset `subagentMetaDir()` → `/tmp`,
asserted as a path, never listed) and `:897-918` (a reap with no `dir` observes the
*override* it resolved) — which together entail the row's intent, because
`deps.dir ?? subagentMetaDir()` is one expression.

**Rulings that bear on it.** `decisions/subagents/034-spec-authority.md` — a work order's
acceptance rows change only by an owner ruling, and a *verdict* never rules: this stays a
question rather than a recorder's call. `decisions/subagents/053-recovery-scan-process-wide-root.md`
— the split's mechanism is the region's one rule (an override is resolved before the pass's
swallow-all `try`s, and an explicit argument still wins); option (b) would add surface
beside it rather than change it.

**Options.** (a) accept the split as the faithful reading of a self-contradictory row, and
record it in the row's own text; (b) add a seam that reports the roots the reap resolved
(no such seam exists today, and it would be new surface). Recorder's recommendation: (a).
