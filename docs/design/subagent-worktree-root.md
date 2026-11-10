# Subagent worktree root, and the suite's override of it

Subagent worktrees live at `~/Developer/wt/subagents/<repo>-<session-tail>`.
The shape is owned by `extensions/lib/subagent-worktree.ts`: `createWorktree`
builds paths with it and `worktree-guard` takes its sibling-blocking prefix from
it, so the creator and the guard cannot disagree. Why they live on disk, and why
in a namespace rather than a name prefix: `decisions/subagents/045-worktree-location.md`.

## The override

`subagentWorktreeBase()` answers `$PI_SUBAGENT_WT_ROOT` when that is set, else
`~/Developer/wt/subagents`. A subagent dispatch resolves its tree from inside the
`subagent` tool, so no call argument can reach that site; process state is the
only seam a test can use.

A set-but-unusable value (empty, relative) throws `UnusableWorktreeRootError`.
It never falls back to the human path: the fallback is the bug, because a typo
would put a test's tree in a human's directory. `createWorktree` lets the error
through rather than folding it into the `null` that means "not a git repo, or
`worktree add` failed".

## The suite sets it for the whole run

`bunfig.toml` preloads `tests/preload-worktree-root.ts`, which points the
variable at a fresh temp dir before any test file loads and removes it on exit.
The root is realpath'd, because the guard compares symlink-resolved prefixes and
`tmpdir()` is a symlink on macOS (`/var/folders/…` → `/private/var/folders/…`).

The guarantee is structural: a test file that never thinks about the override
still cannot create a tree in the human namespace, and a nested `bun test` gets
its own root. Asking each spawning file to isolate itself is the shape this
replaced — an enumeration presented as a guarantee, which misses every file
added later.

## Scope: the ambient base only

The override redirects derivations from the *ambient* base: `createWorktree`,
and the guard's prefix at module load.

A caller that passes an explicit `home` is not redirected. That argument states
which home the path belongs to, so a derivation keeps its meaning while the
override is on. In `extensions/lib/build-output-reaper.ts`:

- `planCargoBound` always passes one (its `home` defaults to `homedir()`), as
  does the bound walk (`opts.home ?? homedir()`). They answer for a cargo dir
  under a real home, so a test override does not reach them.
- `disposeWorktreeBuildOutput` passes the test seam's `opts.home`. With none
  supplied — the dispatch path — it follows the ambient base like any other
  caller.

Two consequences for tests. `CARGO_TARGET_DIR` is not redirected either
(`cargoTargetDirFor` derives from home), so a test spawn leaves a
`~/.cache/cargo-target/<temp-repo>` behind: separate leak, owned by
`decisions/subagents/048-build-output-reaper.md`. And a row asserting on the
guard must derive its paths from the same base the guard resolved — the run's
temp root, not `homedir()`.
