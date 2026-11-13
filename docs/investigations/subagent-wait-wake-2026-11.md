# The parked `wait` that never wakes — investigation

WO-2026-098. Rounds 1–2 recorded a falsified trigger. This round names the
mechanism by probe and carries the fix.

## The mechanism

One `pi` process evaluates `extensions/subagent-async/index.ts` **twice**, under
two spellings of one file, and the two evaluations hold separate copies of every
module-level binding.

jiti resolves a relative import through the **realpath** of the importing file.
pi's loader hands jiti the path as configured, **without** realpath
(`loader.js:527-531`: `resolvePath(extensionPath, cwd)` then
`jiti.import(resolvedPath)`). When the extension sits under a symlinked
ancestor, the root evaluation and its own cycle re-entry disagree about the
module id:

```
EVAL instance=wfczi8 url=file:///private/var/…/subagent-async/index.ts depth=1
  stack: jiti.import ← …/subagent-async/worktree.ts:24 ← …/subagent-async/index.ts:99 ← pi loader
EVAL instance=4f25wi url=file:///var/…/subagent-async/index.ts depth=1
  stack: jiti.import ← pi loader
```

`index.ts:99` imports `./worktree.ts`; `worktree.ts:24` imports back from
`./index.ts` (the cycle). The first leg resolves to `/private/var/…`, so the
re-entry is a *different module record* from the `/var/…` root pi loaded. The
other seven modules in the cycle are single-instance — they are only ever
reached through the realpath leg:

| module | evaluations per pid |
|---|---|
| `index.ts` | 2 (both spellings) |
| `worktree.ts`, `spawn.ts`, `sleep-guard.ts`, `ui.ts`, `recovery.ts`, `records.ts`, `rpc.ts`, `turn-cap.ts` | 1 (`/private/var/…`) |

Census: `MOD`/`EVAL` lines in `/tmp/probe-eval.log` and
`/tmp/pi-async-debug.log` from `~/Developer/notes/wo-098/r3/probe5-nested-wait.ts`
(instrumented copy `~/Developer/notes/wo-098/r3/instr/`).

The root instance (`/var/…`) is the one pi holds as the extension factory, so it
owns every registered handler and tool closure — including `session_start`:

```
INSTANCE 4f25wi session_start liveSessionCtx set depth=1
```

Every other module binds `liveSessionCtx` to the *other* instance, whose
`session_start` never ran. `deliverResult` therefore reads null in a process
that has a perfectly live session:

```
INSTANCE wfczi8 deliverResult DROP depth=1 url=…/sleep-guard.ts
deliverResult: no live session — dropping result for subagent-b7dbc241-…
```

The same split applies to the rest of `index.ts`'s module-level state: `running`
is two maps, so a child recorded through one is invisible to the other, and
`activeWaitTimer`/`attachedSessionId` are two handles.

The trigger is the **spelling of the path the extension is loaded from**, not the
installed extension set. The default macOS `TMPDIR` (`/var/folders/…`, symlinked
to `/private/var/folders/…`) supplies it for free; a realpath'd root evaluates
the file once per pid and the same shape wakes at both levels.

## Retracted

**"The trigger is the installed extension set, not the shape."** Falsified by
both round-2 reviewers and by the probe above: with the installed set in place
and only `TMPDIR` changed, the nested shape wakes at both levels. The installed
set is what the field runs, and it is what the probe must copy to be
field-shaped, but it is not the cause. The drop was real and reproduced; its
cause was misattributed.

**Round 1's "the trigger is a property of an RPC child session as the
deliverer".** Also wrong, for the same reason: the depth-1 child is merely the
first process in the chain whose `agentDir` sits under the symlinked temp root.

## Why the suite's preload did not cover this

`tests/preload-worktree-root.ts:20` realpaths the temp root it hands to
`PI_SUBAGENT_WORKTREE_ROOT`, so the worktree paths a test compares and stats are
canonical. It never loads the extension *through* a symlinked ancestor — the
suite imports `extensions/subagent-async/index.ts` from the checkout, one
spelling, one module record. A test that only realpaths the root it creates
therefore cannot see the duplicate, because the duplicate needs the extension
path itself to be spelled two ways.

## Still standing from round 2

- The delivery mechanism works in a real RPC session: a parked `terminate: true`
  turn wakes on `sendUserMessage(…, { deliverAs: "steer" })`
  (`~/Developer/notes/wo-098/probe3-rpc-wake.ts`).
- The field split is not by session kind: 231 counter-examples falsify "parks in
  subagent session dirs are never followed by a completion". See the transcript
  census below; its classification, not its conclusion, was wrong (reviewers
  found subagent transcripts filed under `wt-subagents`).
- The six stuck subagent parks share one shape (implementer dispatched both
  reviewers, then parked) and the field's `agentDir` is `~/.pi/agent`, a real
  path, so the field parks are **not** this mechanism. They remain unexplained by
  this record, and the fix below does not claim them.

## Probes

`~/Developer/notes/wo-098/`: `probe3-rpc-wake.ts`, `probe4-real-subagent.ts`,
`probe5-nested-wait.ts`, `probe6-delivery-windows.ts`, `probe-faux-provider.ts`
(real `pi` processes, scripted model, no network), `probe-lifecycle.ts`,
`bisect.sh`. Round 3: `r3/probe-double-eval.ts` (spelling A/B on a bare
extension), `r3/probe5-nested-wait.ts` (the nested shape against an instrumented
copy in `r3/instr/`).
