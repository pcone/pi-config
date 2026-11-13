# 052 — A duplicate evaluation of the extension is harmless, not an upstream bug to route around

**Date:** 2026-11-13
**Status:** accepted — the owner's work order (WO-2026-098, 2026-11-10) names the park as a bug to fix; this record settles the shape of the fix
**Supersedes:** none; extends 026's live-session guard to a second evaluation of the same module

## What

`extensions/subagent-async/index.ts`'s module-level state lives in one registry
on `globalThis` (`extensions/subagent-async/process-state.ts`,
`__pi_subagent_async_runner_v1__`): `running`, `liveSession`,
`activeWaitTimer`, `attachedSessionId`, `attachCtx`, `parentReviewerSpawns`.

`liveSession` records the id of the evaluation that set it. `clearLiveSession`
ignored a clear whose owner is not the stored one, so a stale evaluation's
`session_shutdown` cannot take the live ctx away.

Every other module's module-level state stays where it is. The registry covers
`index.ts` alone.

## Why

### One process, two evaluations

`pi` evaluates `index.ts` twice under two spellings of one file. Its loader hands
jiti the discovered path unresolved (`dist/core/extensions/loader.js:527`,
`resolvePath` is `path.resolve`); jiti resolves an entry's relative imports
through the entry's realpath. `index.ts` participates in an import cycle
(`index.ts` → `worktree.ts` → `index.ts`), so the re-entry lands on a second
module record. Census of a field-shaped pid,
`~/Developer/notes/wo-098/r4/eval-census.log`:

```
EVAL index.ts    url=<root>/stage/extensions/subagent-async/index.ts   ← the cycle re-entry
EVAL worktree.ts url=<root>/stage/extensions/subagent-async/worktree.ts
EVAL index.ts    url=<root>/link-agent/extensions/subagent-async/index.ts  ← the factory pi registered
```

`worktree.ts` and the other seven siblings are single-instance: they are only
reached through the realpath leg.

This is the field's spelling, not a probe artefact. On this box the extension is
installed behind a symlinked `extensions` entry:

```
$ ls -ld ~/.pi/agent/extensions
lrwxr-xr-x  /Users/scott/.pi/agent/extensions -> /Users/scott/Developer/pi-config/extensions
```

so every session that loads it spells the entry one way and realpaths it
another. The plain-directory arm of the same probe is one record per pid.

### What the split costs

The library evaluation's `session_start` never runs, so its `liveSession` stays
null. The close path lives in `spawn.ts` — a sibling, reached through realpath —
and imports `deliverResult` from the library evaluation. A child completes, the
delivery reads null, and the completion is dropped in a process that has a live
session:

```
deliverResult: no live session — dropping result for subagent-62e41fc9-…
```

The parked `wait` then never wakes. `53933ef`'s registry is what makes the two
evaluations agree.

### Why not route around pi

The duplicate is upstream's loader disagreeing with jiti about module identity.
We cannot change either from an extension. Three routes were available and all
are worse:

- **Load-path gymnastics** (making the extension resolve to one spelling, e.g.
  realpath-ing `~/.pi/agent/extensions`). It is the install's symlink, owned by
  the harness on every machine, and a symlinked `extensions` entry is a legiti-
  mate install. Fixing the spelling would leave the next spelling — a bind mount,
  a different loader version — to reintroduce the drop.
- **A singleton module.** Bun's importer collapses spellings, jiti's does not;
  nothing in the module can reach the second record to deduplicate it.
- **A pi bug report and no fix.** The state the design must survive is "the
  extension's own code may exist twice in one process". That is cheap to make
  harmless and impossible to assume away.

`globalThis` is a process fact, not a module fact. State that must be shared
across evaluations is keyed there, and the reason is written at the site
(`process-state.ts`).

### Why the clear is owner-tagged

A duplicate evaluation still receives `session_shutdown`, and a shutdown from the
copy that never ran `session_start` must not clear the live ctx — that is the
mirror image of the drop. Tagging the setter's identity (026's guard, generalised
to "which evaluation") keeps `session_shutdown` from the stale copy silent while
the live copy's own shutdown still clears.

The tag is a per-evaluation random id, not a spelling: a spelling would tie the
guard to the very thing that varies.

## Alternatives rejected

- **Canonicalise the paths the extension compares** — the
  `PI_SUBAGENT_WT_ROOT` override, the guard's anchors and prefix, the session
  file captured from `get_state`. Round 3 wrote
  `extensions/lib/canonical-path.ts` for this and nothing called it. Rejected as
  a second mechanism for a problem this order never observed: the guard already
  resolves both ends of its own comparison (`resolveAnchor`, and a prefix
  realpath'd at module load), the override's spelling changes only which string
  a created tree is named by, and no row can fail on the session-file spelling.
  A helper with no failing row behind it is speculative surface. If a spelling
  mismatch is ever observed at one of those sites, extract the guard's existing
  realpath the day it is observed, with that row.

## Tradeoffs accepted

- A process-wide registry outlives a session's module instance. That is the
  point, but it means state must be cleared on `session_shutdown` rather than
  relied on to die with a module.
- `RunnerState` types `liveSession.ctx` as `any`. The ctx is pi's, and the
  registry is a transport for it, not an owner.
