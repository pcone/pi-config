# 050 — The suite's worktree root is set by a preload for the whole run, not per file

**Date:** 2026-11-10
**Status:** accepted — owner direction in the work order for the test-worktree
leak, round 2
**Supersedes:** the per-file enforcement in 049; the override itself stands

## What

`bunfig.toml` preloads `tests/preload-subagent-roots.ts`, which sets
`PI_SUBAGENT_WT_ROOT` to a fresh realpath'd temp dir before any test file loads
and removes it on exit. Every process that runs the suite gets one: a nested
`bun test` included.

The guard row that snapshotted `~/Developer/wt` and `~/Developer/wt/subagents`
across a nested `bun test` is deleted. It is replaced by a row asserting the
preload took effect, plus the two rows that already pinned the override
(`createWorktree` lands under it; an unusable value throws).

## Why

The snapshot row was flaky by construction. Its base is where live peer
dispatches create and remove trees, so any before/after comparison over a ~99 s
window is noise; a reviewer proved it by creating and deleting one directory
mid-run. It also pushed the hermeticity row's child `bun test` at its 300 s
`spawnSync` budget.

The guarantee it stood for is now structural. 049 asked each spawning file to
call `isolateSubagentWorktrees`; that is an enumeration presented as a guarantee
— complete only for the files someone remembered, and blind to the next one.
A preload covers a file that never thinks about the override.

## Alternatives rejected

- **Shrink the snapshot row to a shorter window, or move it.** Still a
  comparison against a directory other processes mutate; the noise is the
  mechanism, not the size.
- **Keep per-file isolation as the guarantee and add the preload as a
  backstop.** Two mechanisms for one rule. The per-file helper stays only where
  a row asserts a specific temp root of its own.
- **Redirect `CARGO_TARGET_DIR` too.** Out of scope: `cargoTargetDirFor`
  derives from home, and a caller passing an explicit home is deliberately not
  redirected. See `docs/design/subagent-worktree-root.md`.

## Tradeoffs accepted

- A `bun test` invocation that does not read the repo's `bunfig.toml` (a
  different cwd) gets no preload. Files that isolate themselves still do, and
  the human namespace is untouched either way.
- The preload's root is deleted on `exit`. A hard kill leaves the temp dir; it
  is under `$TMPDIR` and the daily cleaner takes it.
- The variable is set for every file in the run, so a row that wants to observe
  the human base must pass an explicit `home` (`subagentWorktreeBase(homedir())`).
