# 048 — A removed worktree's build output dies with it, and the shared cargo dir is bounded

**Date:** 2026-11-08
**Status:** accepted — owner rulings 2026-11-08 (WO-2026-091)
**Supersedes:** 045's "no longer reclaimed by deleting a worktree" tradeoff

## What

One removal path — `removeWorktreeTree(deps, rs, policy)` in
`extensions/subagent-async/index.ts` — and the build-output prune behind it
(`extensions/lib/build-output-reaper.ts`):

- **M1** `removeWorktreeTarget` deletes `<worktree>/target` when it is a real
  directory (lstat; a symlink is left alone). Runs after a successful removal,
  and on a tree the reap keeps (M4).
- **M2** `pruneCargoArtifactsFor` drops one worktree's share of the clone's
  shared dir. Route 1 attributes artifacts by `.d` dep-info that names the
  worktree; route 2 (when route 1 finds nothing) runs `cargo clean -p <member>`
  for the parent checkout's workspace members. Never a full `cargo clean`.
- **M3** `enforceCargoTargetBound` bounds each clone's shared dir at **20 GiB**,
  checked once per session-start reap: route 1 per dead worktree path, then one
  coarse pass per clone, then re-measure. Still over is reported as over-bound,
  never force-cleaned.
- **M4** `dropLandedWorktreeTarget` drops a kept tree's `target/` once its
  isolation branch is merged into the parent's current HEAD or no longer exists.

## Why

The box went from ~250 GB free to 22 GB in a day: per-worktree `target/` dirs
(one 3.1 GB, five present) plus 11.9 GB of per-clone shared dirs that nothing
ever pruned. 045's shared dir removed the per-worktree registry rebuild and, as
a side effect, made build output outlive its worktree forever.

## The bound measures allocated blocks, as `du -sk` does

`dirSizeBytes` shells out to `du -sk`. Summing `st.blocks` in Node over-reports
this box's shared dirs by 2.2× (17.7 GiB against du's 8.2 GiB for
`tfd-gate-424-prep`): cargo hard-links build-script outputs into the worktree's
own target, and `du` counts a shared extent once. A bound stated in `du`'s unit
must be measured in it, or it fires at half the size the owner named.

## Route 1 is inert for workspace-root builds

Cargo writes dep-info paths relative to the workspace root it built
(`members/alpha/src/lib.rs`), so a `.d` from a worktree build never names the
worktree path. Measured on two probes and on this box's real shared dirs
(`.d` files present, none naming a worktree). Route 2 is what actually runs, and
it drops every worktree's copy of the workspace crate it cleans — accepted by
the owner's ruling ("if they can be told apart", and the coarse route is the
case where they cannot).

## Costs measured, not asserted

| measurement | value |
|---|---|
| `reapFinishedWorktrees`, 36 worktrees, real box, before | 336 ms |
| ... after (the bound's walk included) | 1.0–1.1 s |
| `du -sk` of the two real shared dirs (per reap) | 0.9 s, 12.4 GiB |
| synthetic reap of 36 finished trees, before / after | 4.3 s / 6.2 s |
| `cargo clean -p <member>`, 8-member tfd workspace | 0.15–1.6 s per member |
| M2 route 1 per removal, 700 `.d` files | ~50 ms |

The per-removal coarse pass is the expensive part on a cargo-workspace clone
(~1.5–3 s at 8 members); it runs once per removed worktree.

## Alternatives rejected

- **Keep the JS `stat` walk for the bound.** Over-reports clone- and
  hard-link-shared extents by 2.2× on this box (above).
- **A full `cargo clean` when over the bound.** Rebuilds the registry crates the
  shared dir exists to keep — the outcome the bound is meant to avoid.
- **Reaping `target/` inside the worktree guard.** The guard blocks writes; the
  removal sites are where a tree's end is known.
