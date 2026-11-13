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
`<cargo home>/.cache/cargo-target`. The metas dir is also the in-flight reader's
registry — `listInFlightSubagents`, behind the wait source and checkpoint — so
one variable redirects every meta *reader* the pass and its consumers have. A subagent dispatch resolves its worktree
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
torn socket, log or metas dir — one broken child must not stop the pass — and
resolves the metas dir before that `try`, so the scan's own catch cannot reach
the override. A rejected `session_start` is the intended outcome: the
alternative is a pass reading `/tmp` after its override failed.

The three roots are named once, by `recoveryRoots()` in
`extensions/subagent-async/recovery.ts`, which resolves all of them or throws.
`session_start` calls it at the top of the reaper block, before its chain exists:
the pass runs in a chain nobody awaits, so a throw from inside the chain is an
unhandled rejection rather than a failed start.

`reapFinishedWorktrees` calls it again for itself and threads the values down, so
a row that drives the pass directly reaches the same refusal, and no frame below
the pass resolves an ambient root for itself. `deps.dir` and `deps.home` still
win as values; they no longer suppress the resolution, because a row that names a
fixture is still a process with an override in its environment, and an unusable
one must refuse.

The base is why the threading matters. `wtRoots()` takes an explicit home, so the
handler's frame never reads `PI_SUBAGENT_WT_ROOT`, and the chain has two readers
that would: the removal's clone-name derivation
(`disposeWorktreeBuildOutput`, inside `removeWorktreeTree`'s best-effort catch,
which reports a prune problem and returns) and the bound's
(`enforceCargoTargetBound` → `planCargoBound`, awaited outside every `try` in the
pass). Left ambient, a bad base would either disappear into the catch or reject
the pass after its trees were already judged. Both are handed the base the pass
resolved, so neither can be the first read.

`removeWorktreeTree` still derives the base ambiently when its caller passes
none, as the post-delivery cleanup does: that path is a spawn-time removal, not
the reap, and its cargo home is not redirected either — the leak
`decisions/subagents/048-build-output-reaper.md` owns.

Nothing below the pass raises the refusal any more. The chain's catches swallow,
so the refusal has to be read before the chain exists, which is what
`recoveryRoots()` in the handler's own frame is for.

## The suite sets all three for the whole run

`bunfig.toml` preloads `tests/preload-subagent-roots.ts`, which points every
variable at a fresh temp dir before any test file loads and removes the dirs on
exit. The worktree base is realpath'd, because the guard compares
symlink-resolved prefixes and `tmpdir()` is a symlink on macOS
(`/var/folders/…` → `/private/var/folders/…`).

The guarantee is structural for the three roots above: a test file that never
thinks about them cannot create a tree in the human namespace, its nested
`bun test` gets roots of its own, which it removes when it exits, and one row pins
that by reading the child's roots back after it has gone. It does not cover the
reaper's own home: the general pass takes `home: opts.home ?? reaperHome()` and
measures `cargoTargetRoot(home)`, which none of the three overrides reach, so a
row that drives `session_start` pins that home explicitly (three rows do).

It stops there. `/tmp` is still the default of the metas dir's *writer*
(`metaPath`) and of the readers that take their own `dir` default —
`listSubagentMetas`, `resolveSubagentMeta` — so a row that writes a meta through
`metaPath` and reads it back through one of those keeps both on the box's `/tmp`
(decision 053, Tradeoffs). Closing that is the writer-side order, not this one.

Asking each file to isolate itself is the shape this replaced — an enumeration
presented as a guarantee, which misses every file added later. The per-file
helper `tests/helpers/subagent-wt-root.ts` remains for a row that asserts a temp
root of its own; `setEnvForRow` in `tests/helpers/subagent-env.ts` sets a root —
or, with `undefined`, unsets it — for one row and restores what was there, never
an absence.

## Scope: the ambient path only

An override redirects derivations from the *ambient* path. A caller that passes
an explicit argument is not redirected: the argument states which path to derive
from, so a derivation keeps its meaning while the override is on.
`reapFinishedWorktrees` takes `deps.dir` and `deps.home` over the roots it
resolved, so a row that names a fixture keeps it.
`listInFlightSubagents` resolves `opts.dir ?? subagentMetaDir()` and has no
override of its own: it is the wait source's and checkpoint's reader of the same
registry, so a per-process seam there would read the box's `/tmp` after every
other reader was redirected.

`extensions/lib/build-output-reaper.ts` takes the two homes as two fields
(`BuildOutputHomes`), because they name different things and move independently:

- `cargoHome` — the home whose `.cache/cargo-target` holds one dir per clone, so
  the dir a tree's artifacts sit in.
- `base` — the subagent worktree base a tree's clone name is derived from. Not a
  home the base is derived from: `PI_SUBAGENT_WT_ROOT` names the base directly and
  need not be `<home>/Developer/wt/subagents`, so only the resolved base survives
  being threaded down. Omitted, the ambient base answers.

Production passes both: the reap supplies `cargoHome: deps.home ?? roots.cargoHome`
and `base: roots.worktreeBase`. The checkout reaper's world has one home —
`wtRoots(home)` and `cargoTargetRoot(home)` both derive from it — so it passes
`cargoTargetRoot`'s home and `subagentWorktreeBase(home)`. A fixture that keeps
its trees and their shared dir under one temp home derives both from it too
(`homesAt` in `tests/build-output-reaper.test.ts`).

One field for both was the bug: whenever the two roots disagree, attribution
looked for the tree under the cargo home's base, found nothing, and the shared
dir's share was never pruned — silently, on the production path.

`CARGO_TARGET_DIR` is not redirected (`cargoTargetDirFor` derives from a home),
so a test spawn leaves a `~/.cache/cargo-target/<temp-repo>` behind: a separate
leak, owned by `decisions/subagents/048-build-output-reaper.md`. And a row
asserting on the guard must derive its paths from the same base the guard
resolved — the run's temp root, not `homedir()`.
