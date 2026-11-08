# 045 — Subagent worktrees live on disk, and a clone's worktrees share one cargo target dir

**Date:** 2026-11-01
**Status:** accepted — owner approved both changes, 2026-11-01
**Supersedes:** none

## What

`createWorktree` (`extensions/subagent-async/index.ts`) places trees at
`~/Developer/wt/subagents/<repo>-<suffix>` instead of
`os.tmpdir()/pi-subagent-wt-<suffix>`. Isolated children spawn with
`CARGO_TARGET_DIR=~/.cache/cargo-target/<repo>`, one directory per clone.

Both shapes are owned by `extensions/lib/subagent-worktree.ts`. `worktree-guard`
takes its sibling-blocking prefix from that module, so the tree creator and the
guard cannot disagree about where trees are.

## Why

`os.tmpdir()` was the wrong home for a worktree. It holds uncommitted work and a
multi-gigabyte build tree, and macOS deletes untracked files there: the daily
`tmp_cleaner` removes every file not read, written or changed in three days, and
a reboot clears the directory outright. The cleaner works file by file, so a
swept tree still looks present and then fails mid-build instead of erroring
cleanly. This happened for real on 2026-11-01: an OS update rebooted the box and
every implementer worktree vanished, along with four live agents working in
them; three registrations were left locked, pointing at deleted directories,
which `git worktree prune` skips until each is unlocked.

The cargo target dir has a second purpose. Every worktree compiled from cold,
repeating the same 3.5 GB of registry-crate artifacts per tree. Sharing one
target dir de-duplicates those artifacts and, more importantly, cargo's
target-dir lock serialises concurrent rustc runs — the memory spike that pushes
this 8 GB box into deep swap when several lanes build at once.

## Placement: a namespace, not a name prefix

Subagent trees sit in `~/Developer/wt/subagents/`, not directly in
`~/Developer/wt/`. The guard must block a child from writing into *another
subagent's* tree without blocking the hand-made worktrees beside them
(`~/Developer/wt/tfd-425`). A path prefix is the only static discriminator the
guard has, so subagent trees need their own prefix; matching a
`pi-subagent-wt-` name pattern instead would have kept the old naming and lost
the repo name from the path.

## Alternatives rejected

- **Keep `os.tmpdir()`, rely on the harness removing trees on completion.**
  The harness does remove them — when it completes. A crash, a reboot, or a
  killed process leaves the tree, which is exactly when the work is worth most.
- **Share the parent checkout's `./target`.** Cargo fingerprints handle the
  branch differences, but the child would then rewrite the build state that
  mainline suite runs use. The harness must not mutate the mainline's artifacts.
- **No shared target dir; per-worktree only.** Keeping the status quo. Costs a
  full rebuild per dispatch and loses the lock that serialises memory-heavy
  rustc runs.

## Tradeoffs accepted

- Workspace-crate artifacts still rebuild per worktree: cargo fingerprints them
  by source path, and each worktree's copy is a different path. Only registry
  dependencies are reused.
- The first build in a clone after this change is still cold; the shared dir
  warms on the first build and then serves every worktree of that clone.
- `~/.cache/cargo-target/` grows to the size of a full build per clone, and is
  no longer reclaimed by deleting a worktree. **Superseded 2026-11-08 (owner,
  WO-2026-091):** deleting or reaping a worktree now drops its share of the
  shared dir, and each clone's dir is bounded at 20 GiB — decision
  `048-build-output-reaper.md`.
- An unisolated child (`isolate: false`, resumed sessions) gets no
  `CARGO_TARGET_DIR` and keeps building in the parent checkout, the one place
  its artifacts are already warm.

## Retained behaviour

`createWorktree` still locks the tree, carries the parent's uncommitted state,
and returns the branch and parent commit. Resume still runs in the recorded
parent cwd with no worktree. The guard still allows the session's own tree and
blocks siblings.

## Measurement

`cargo build --release` on the `tfd` clone, nightly toolchain, this box.

| run | wall | crates compiled | peak RSS |
|---|---|---|---|
| cold, shared target dir (worktree A) | 400 s | 188 | 846 MB |
| second worktree, same commit, shared dir | 266 s | 8 | 730 MB |

Concurrency: two builds started 1 s apart against one target dir — the second
printed `Blocking waiting for file lock on build directory`, waited out the
first, then found the artifacts usable. Peak concurrent `rustc` was 8, one
lane's worth. Unshared, the same two lanes run 8 + 8 and each holds its own
build tree: that is the pattern that took this box to load 74 and 5 GB of swap
earlier the same evening, with three agents' suite runs and two independent
release builds in flight.

The residual 266 s is the workspace crates themselves plus the link; cargo
fingerprints path dependencies by source, so those rebuild once per worktree.
