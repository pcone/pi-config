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
  never force-cleaned. A measure that fails is reported and the entry carries no
  verdict (`afterBytes` and `overBound` are `null`), never a size or an
  under-bound reading nobody took. The per-clone walks run concurrently: 0.70 s
  against 1.07 s serial for this box's three clone dirs.
- **M4** `dropLandedWorktreeTarget` drops a kept tree's `target/` once its
  isolation branch is merged into the parent's current HEAD or no longer exists.

Three lines in `extensions/subagent-async/index.ts` run `git worktree remove`
(`rg -n '"worktree", "remove' extensions/subagent-async/index.ts` → 3, in two
sites). Both of the order's sites go through `removeWorktreeTree`. The third is
`createWorktree`'s stale-leftover cleanup (`index.ts:969` at `f0bb295`), and
whether it must is **WO-2026-091 `Q-091-a`, open**: git's own removal takes an
ignored `target/` with the tree and the path is recreated immediately, so no
build output is orphaned there, but routing it is a mechanism change this
order does not carry.

## Why

The box went from ~250 GB free to 22 GB in a day: per-worktree `target/` dirs
(one 3.1 GB, five present) plus 11.9 GB of per-clone shared dirs that nothing
ever pruned. 045's shared dir removed the per-worktree registry rebuild and, as
a side effect, made build output outlive its worktree forever.

## Rulings (owner, 2026-11-08)

- **`createWorktree`'s stale-leftover cleanup stays out of `removeWorktreeTree`.**
  The owner ruled *"Out of scope (Recommended)"* on `Q-091-a`, the third
  `git worktree remove` site (`extensions/subagent-async/index.ts:969`). The
  recorder's reason, recorded so it is not re-argued: the path is recreated at
  once, git takes the ignored `target/` with the tree, and leftover cache
  artifacts are reused at the same path — pruning there would cost a rebuild and
  buy nothing.
- **The bound is GiB, measured with `du -sk`.** A process fact the owner accepted;
  §*The bound measures allocated blocks* carries the measurement behind it.
- **Route 1 is inert.** Accepted as a process fact. The owner's instruction: if it
  can never fire, delete it rather than keep a dead route, and say which in the
  report. See §*Route 1 is inert* for the probe that decides it.
- **The reap's ~1.0 s is inside budget**, and its cost must be named as the `du`
  walk rather than left as a total: `enforceCargoTargetBound` shells `du -sk` once
  per clone dir on every reap, and that walk is the whole regression from 336 ms.

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
| one removal with route 2 inside, 1-member workspace | 195 / 262 / 276 ms, `cargo clean -p` 62 / 89 / 105 ms |
| one removal with route 2 inside, 8-member workspace | 713 / 775 / 818 ms, eight cleans 546 / 582 / 644 ms |

## Route 2 is what every removal pays

Measured 2026-11-08 on a real workspace, not a fake shared dir: a one-member
cargo workspace at `~/Developer/wo091-f4-cargo`, a locked worktree at
`~/Developer/wt/subagents/wo091-f4-cargo-4add98737109`, a real
`CARGO_TARGET_DIR=~/.cache/cargo-target/wo091-f4-cargo`, `cargo build` in the
worktree, then `removeWorktreeTree` on the reap's policy (plain remove, branch
kept) with every `cargo` call timed through the runner seam. Three runs each:

| fixture | removal, end to end | of which `cargo clean -p` | `.d` scanned / naming the worktree | shared dir |
|---|---|---|---|---|
| 1 member | 195 / 262 / 276 ms | 62 / 89 / 105 ms | 1 / 0 | 2.9 MiB → 8 KiB |
| 8 members | 713 / 775 / 818 ms | 49–100 ms each, 546 / 582 / 644 ms total | 8 / 0 | 23 MiB → 8 KiB |

Route 1 matched nothing in either fixture, as the section above says: a real
cargo build writes dep-info paths relative to the workspace root. Route 2 runs
on every removal, and it runs `cargo clean -p` once per workspace member —
eight invocations for eight members, every time a worktree is removed. These
members have no registry deps, so each clean is the fast end of the range; the
box's real shared dirs cost 0.15–1.6 s per member, i.e. 1.2–13 s per removed
worktree.

The earlier synthetic reap figure (36 finished trees, 4.3 s → 6.2 s) does not
cover that. Its 1.9 s delta cannot be 36 route-2 removals of a workspace this
size unless the parent was a one-member workspace (36 × ~53 ms ≈ 1.9 s, which
matches) or route 2 skipped (no parent checkout, paths outside the namespace).
Use the per-removal figures above.

## The removal's git runs in the parent checkout

`removeWorktreeTree` sets `repoCwd = parentCwd` when that path exists, else the
worktree. Running the whole sequence inside the tree was tried and reverted:
the branch step runs after a successful `git worktree remove`, so its spawn
fails on the missing cwd — `git -C <removed tree> branch -D <branch>` answers
`fatal: cannot change to '<path>': No such file or directory`, exit 128 (probe,
2026-11-08), which the harness's runner reports as exit 1. A branch that never
moved past the parent commit is then kept, reddening two
`tests/worktree-removal.test.ts` rows. Unlock and removal work from either cwd;
only the branch step needs the parent.

What the rule costs: a meta whose `parentCwd` exists but points at the wrong
repository fails the unlock with "not a working tree" and is kept every reap,
where the tree's own cwd would have removed it. No meta on this box has that
shape; it is recorded so the next reader does not rediscover the fork.

## Alternatives rejected

- **Keep the JS `stat` walk for the bound.** Over-reports clone- and
  hard-link-shared extents by 2.2× on this box (above).
- **A full `cargo clean` when over the bound.** Rebuilds the registry crates the
  shared dir exists to keep — the outcome the bound is meant to avoid.
- **Reaping `target/` inside the worktree guard.** The guard blocks writes; the
  removal sites are where a tree's end is known.
