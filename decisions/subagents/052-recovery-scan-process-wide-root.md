# 052 — The recovery scan's metas dir and cargo home are process-wide, not per-file hooks

**Date:** 2026-11-13
**Status:** accepted — owner direction in WO-2026-099 (seat `8f90746f`,
2026-11-13)
**Supersedes:** the test hooks `_testSetRecoveryScanDir` and `_testSetCargoHome`.
Extends 049 (the override's shape) and 050 (the preload as the guarantee).

## What

Two roots the `session_start` recovery pass reads resolve from one rule, in
`extensions/lib/env-path.ts`:

- `subagentMetaDir()` (`extensions/lib/subagent-state.ts`) answers
  `$PI_SUBAGENT_META_DIR` when set, else `/tmp`. It is the dir
  `recoverOrphanedSubagents` scans and `reapFinishedWorktrees` lists.
- `subagentCargoHome()` (`extensions/lib/subagent-worktree.ts`) answers
  `$PI_SUBAGENT_CARGO_HOME` when set, else `homedir()`. It is the home whose
  `.cache/cargo-target` the reap bounds and, over the bound, prunes.

A set-but-unusable value (empty, relative, NUL-bearing) throws. The failure is
not absorbed: both roots are resolved before the pass's swallow-all `try`s, and
`rethrowIfUnusableEnvPath` lets it out of the `session_start` handler's two
catches. The hooks are deleted, with their re-exports.

`tests/preload-subagent-roots.ts` (renamed from `preload-worktree-root.ts`) sets
all three override variables before any test file loads and removes the temp dirs
on exit. Design: `docs/design/subagent-worktree-root.md`.

## Why

`/tmp` is one registry for every pi process on the machine: live children's
sockets, logs and metas, including other sessions' running work. A test that
reaches it reads a stranger's state, and a test whose row forgets the setter
does so silently. Which files remembered is a list, and a list is incomplete the
day someone adds a file — the defect `PI_SUBAGENT_WT_ROOT` was introduced to
remove for the worktree base (049), with the same fix: ambient configuration that
the preload owns, not a per-process in-memory setter.

The throw is loud rather than total. A torn meta must not stop the pass, so the
scan absorbs failures; an override that cannot be resolved is not a torn meta,
and continuing after it would read exactly the `/tmp` the override was set to
avoid.

## Alternatives rejected

- **Keep the setters and add env vars alongside.** Two mechanisms for one rule,
  and the setters stay the path a new test file copies.
- **Fall back to `/tmp` / `homedir()` on an unusable value.** The fallback is the
  bug (049).
- **Route the other readers — `listSubagentMetas`, `resolveSubagentMeta`,
  `discoverSessions` — through `subagentMetaDir()` too.** Their writer is
  `metaPath`, which still hardcodes `/tmp`, so redirecting a reader alone would
  make a meta written through `metaPath` invisible to it. Grounded: redirecting
  `resolveSubagentMeta`'s default reds 12 rows in
  `tests/subagent-id-resolution.test.ts`. The writer side is a separate order: it
  moves the spawn-time registry, and dozens of rows read `/tmp/pi-subagent-*`
  directly.
- **Resolve the roots in the `session_start` handler and pass them as `dir` /
  `home`.** Leaves `reapFinishedWorktrees` unable to answer for itself, and puts
  the throw in a place the reap's own tests cannot reach.

## Tradeoffs accepted

- A `bun test` invocation that does not read the repo's `bunfig.toml` (another
  cwd) gets no preload; a nested run from the repo root does, which is what the
  isolation row pins.
- A row that wants the production default must delete the variable and restore
  the preload's value in a `finally` (`setEnvForRow`), never leave it unset: an
  unset root mid-file is the box's real `/tmp`.
- The metas dir the suite redirects is not where a meta written through
  `metaPath` lands (`metaPath` still hardcodes `/tmp`), so a row that writes one
  and reads it back through a defaulted reader keeps both on `/tmp`. Recovery
  rows that fabricate children keep using `deps.dir`.

## Round 2 (2026-11-13) — what the rework changed, and why

Both reviewers rejected round 1. Three corrections, each a consequence of the
rule above rather than a new ruling:

- **`_testSetInflightScanDir` is the same hook, and is gone too.** It was the
  third per-process registry seam: `listInFlightSubagents` defaulted to
  `SUBAGENT_TMP_DIR`, so the wait source and checkpoint read the box's `/tmp`
  however the preload was set. Those readers now resolve
  `opts.dir ?? subagentMetaDir()`. The rejected alternative above
  (`listSubagentMetas` / `resolveSubagentMeta` / `discoverSessions`) still
  stands: their writer is `metaPath`, and the in-flight reader was not one of
  them.
- **The cargo home's refusal is read in the handler's frame, not rethrown from
  the chain.** The pass runs in a chain `session_start` does not await, so
  `rethrowIfUnusableEnvPath` inside its `.catch` was an unhandled rejection, not
  a refused start. The handler calls `subagentCargoHome()` before the chain
  exists; `reapFinishedWorktrees` keeps resolving it for itself, so a row that
  calls the pass directly reaches the same refusal. Both chain rethrows are
  removed — nothing below them can raise it. The rejected alternative above
  (resolve in the handler and pass `dir`/`home`) stays rejected: the pass still
  answers for itself.
- **The reap's cargo home is not its worktree base.** `removeWorktreeTree`'s
  single `home` served both, so the new cargo override became the base
  attribution used: with `PI_SUBAGENT_WT_ROOT` and `PI_SUBAGENT_CARGO_HOME`
  pointing at different roots — true for every test after this landing —
  attribution returned null and a clone's share was silently never pruned.
  `BuildOutputHomes` carries `cargoHome` and `baseHome`; the reap passes only
  the first, the checkout reaper passes one value as both, and two rows keep
  the two roots apart.

Rows: `tests/subagent-worktree-lock.test.ts` («the worktree base and the cargo
home are separate roots»), `tests/subagent-recovery-ownership.test.ts` («the
real session_start handler refuses a bad cargo home too»),
`tests/subagent-state-vocabulary.test.ts` («with no `dir`, reads the
metas-dir override»), `tests/subagent-worktree-root-isolation.test.ts` (the
nested row now asserts the child's roots are removed).
