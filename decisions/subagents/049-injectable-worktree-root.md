# 049 — The subagent worktree base is process-wide injectable, so tests stop spawning into the human namespace

**Date:** 2026-11-09
**Status:** accepted — mechanism specified by the owner in the work order for the test-suite worktree leak
**Supersedes:** none; adds a seam to 045's location rule

## What

`subagentWorktreeBase()` (`extensions/lib/subagent-worktree.ts`) answers
`$PI_SUBAGENT_WT_ROOT` when that is set to an absolute path, else
`~/Developer/wt/subagents` as before. A set-but-unusable value (empty,
relative) throws `UnusableWorktreeRootError`; `createWorktree` lets it
through instead of folding it into the `null` that means "not a git repo or
`worktree add` failed".

An explicit `home` argument still wins, so `subagentWorktreeBase("/probe")`
keeps testing the derivation while an override is on.

`tests/helpers/subagent-wt-root.ts` points the variable at a per-file temp
dir and removes it in `afterAll`. Every test file that reaches
`createWorktree` uses it.

**Superseded 2026-11-10 (owner, work-order round 2):** the per-file helper is no
longer the guarantee. `bunfig.toml` preloads `tests/preload-worktree-root.ts`,
which sets the variable for the whole run — decision
`050-worktree-root-preload.md`. The helper remains where a row asserts a temp
root of its own.

## Why

Tests spawn through the registered `subagent` tool, so the leaking code path
has no call argument to thread a base through. The base has to be process
state or nothing.

Without it, a test whose repo lives in `$TMPDIR` created its worktree at
`~/Developer/wt/subagents/<temp-repo>-<suffix>`. The tree outlives the repo
it was branched from, so the `.git` file it leaves points at a dead
directory: 149 of them, across `wo-landing-repo-*` (work-record-landing) and
`pi-lock-repo-*` (subagent-worktree-lock), removed by hand on 2026-11-09.

## Alternatives rejected

- **A `base` parameter on `createWorktree`, or an `isolate`-style spawn
  option.** The leaking files drive the tool, never the function; a parameter
  cannot reach the call site that matters.
- **Fall back to the real path when the override is unusable.** The fallback
  is the bug: a typo in the variable would put a test's tree back in a
  human's directory, silently.
- **Reap the orphans from the suite.** WO-2026-092 owns that; a second
  cleanup path would race it.

## Tradeoffs accepted

- The guard (`extensions/worktree-guard.ts`) resolves its prefix from the
  same function at module load, so a file that sets the override after its
  imports keeps the real prefix. Harmless for the redirect, which is about
  creation; rows that test the guard assert the derivation directly.
- `CARGO_TARGET_DIR` is not redirected: `cargoTargetDirFor` still derives
  from home, so a test spawn leaves a `~/.cache/cargo-target/<temp-repo>`
  behind. Separate leak, separate order.
