# Subagent paths the harness resolves, and the suite's overrides of them

Three paths are resolved from inside code that a test drives with no argument,
so process state is the only seam:

| Path | Resolver | Variable | Unset it answers |
|---|---|---|---|
| Subagent worktree base | `subagentWorktreeBase()` | `PI_SUBAGENT_WT_ROOT` | `~/Developer/wt/subagents` |
| Metas dir | `subagentMetaDir()` | `PI_SUBAGENT_META_DIR` | `/tmp` |
| Cargo home | `subagentCargoHome()` | `PI_SUBAGENT_CARGO_HOME` | `homedir()` |

The first is the worktree base. It lives at
`~/Developer/wt/subagents/<repo>-<session-tail>`; the shape is owned by
`extensions/lib/subagent-worktree.ts`, where `createWorktree` builds paths with
it and `worktree-guard` takes its sibling-blocking prefix, so the creator and the
guard cannot disagree. Why they live on disk, and why in a namespace rather than
a name prefix: `decisions/subagents/045-worktree-location.md`.

The other two are the `session_start` recovery pass's. The scan reads
`pi-subagent-*.{sock,log,meta.json}` from the metas dir, and the reap of the
finished worktrees it adopts bounds each clone's shared cargo dir under
`<cargo home>/.cache/cargo-target`. A subagent dispatch resolves its worktree
from inside the `subagent` tool, and the recovery pass resolves both of its roots
from inside the pass, so no call argument reaches those sites.

All three follow one rule, implemented once in `extensions/lib/env-path.ts`: a
set value is absolute or the call throws. It never falls back. The fallback is
the bug — a typo in the worktree base puts a test's tree in a human's directory,
and a typo in the metas dir puts a test back on the box's live `/tmp` registry,
where every pi process on the machine keeps its running children's sockets,
logs and metas. `UnusableWorktreeRootError` is the worktree base's own name for
the failure; the other two throw `UnusableEnvPathError`, which it extends.

Absorb-all paths do not keep the failure. `recoverOrphanedSubagents` swallows a
torn socket, log or metas dir — one broken child must not stop the pass — but a
bad override is resolved before that `try`, and `rethrowIfUnusableEnvPath` lets
it out of the two catches the `session_start` handler owns. A rejected
`session_start` is the intended outcome: the alternative is a pass reading `/tmp`
after its override failed.

## The suite sets all three for the whole run

`bunfig.toml` preloads `tests/preload-subagent-roots.ts`, which points every
variable at a fresh temp dir before any test file loads and removes the dirs on
exit. The worktree base is realpath'd, because the guard compares
symlink-resolved prefixes and `tmpdir()` is a symlink on macOS
(`/var/folders/…` → `/private/var/folders/…`).

The guarantee is structural: a test file that never thinks about the override
still cannot create a tree in the human namespace, read the box's registry, or
measure its shared cargo dirs, and a nested `bun test` gets roots of its own.
Asking each file to isolate itself is the shape this replaced — an enumeration
presented as a guarantee, which misses every file added later. The per-file
helper `tests/helpers/subagent-wt-root.ts` remains for a row that asserts a temp
root of its own; `setEnvForRow` in `tests/helpers/subagent-env.ts` sets a root
for one row and restores the preload's value, never an absence.

## Scope: the ambient path only

An override redirects derivations from the *ambient* path. A caller that passes
an explicit argument is not redirected: the argument states which path to derive
from, so a derivation keeps its meaning while the override is on.
`reapFinishedWorktrees` resolves `deps.dir ?? subagentMetaDir()` and
`deps.home ?? subagentCargoHome()`, so a row that names a fixture keeps it.

In `extensions/lib/build-output-reaper.ts`:

- `planCargoBound` always passes a `home` (defaulting to `homedir()`), as does
  the bound walk (`opts.home ?? homedir()`). They answer for a cargo dir under a
  real home, so a test override does not reach them.
- `disposeWorktreeBuildOutput` passes the test seam's `opts.home`. With none
  supplied — the dispatch path — it follows the ambient base like any other
  caller, which the reap now supplies as `subagentCargoHome()`.

`CARGO_TARGET_DIR` is not redirected (`cargoTargetDirFor` derives from a home),
so a test spawn leaves a `~/.cache/cargo-target/<temp-repo>` behind: a separate
leak, owned by `decisions/subagents/048-build-output-reaper.md`. And a row
asserting on the guard must derive its paths from the same base the guard
resolved — the run's temp root, not `homedir()`.
