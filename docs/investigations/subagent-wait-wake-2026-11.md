# The parked `wait` that never wakes — investigation

WO-2026-098. Rounds 1–2 recorded a falsified trigger. Round 3 named the
mechanism by probe and carried the fix; round 4 pinned the reproduction to the
spelling this box actually installs the extension under. The fix is decision
`decisions/subagents/052-duplicate-extension-evaluation.md`.

## The mechanism

One `pi` process evaluates `extensions/subagent-async/index.ts` **twice**, under
two spellings of one file, and the two evaluations hold separate copies of every
module-level binding.

jiti resolves a relative import through the **realpath** of the importing file.
pi's loader hands jiti the path as configured, **without** realpath
(`loader.js:527-529`: `resolvePath(extensionPath, cwd)`, then
`jiti.import(resolvedPath)`; `utils/paths.js:83-87` shows `resolvePath` is
`path.resolve`, no realpath). When the extension's path runs through a symlinked
component, the root evaluation and its own cycle re-entry disagree about the
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
field-shaped, but the set is not the cause. The drop was real and reproduced;
its cause was misattributed.

The distinction that matters is *set identity* versus *path spelling*. Copying
the same files into a plain directory wakes at both levels; reaching them
through the symlink the field installs under does not. Round 4's finding below
is the second half of this, and it does not revive the retracted claim.

**Round 1's "the trigger is a property of an RPC child session as the
deliverer".** Also wrong: the depth-1 child is merely the first process in the
chain whose extension path ran through a symlink.

## The field's spelling

The field does not need a temp dir to supply the second spelling. The extension
is installed behind a symlinked `extensions` entry:

```
$ ls -ld ~/.pi/agent/extensions
lrwxr-xr-x  1 scott  staff  43 13 Apr 2026 /Users/scott/.pi/agent/extensions -> /Users/scott/Developer/pi-config/extensions

$ realpath ~/.pi/agent/extensions/subagent-async/index.ts
/Users/scott/Developer/pi-config/extensions/subagent-async/index.ts
```

pi discovers the entry as `~/.pi/agent/extensions/subagent-async/index.ts`
(`discoverExtensionsInDir` joins the agent dir with `extensions` and never
realpaths), so the factory is registered under that spelling, and the cycle
re-entry resolves to the checkout's real path. Two records, every session that
loads the extension from the install — the field's shape, not a probe artefact.

The `agentDir` being a real path, as it is in the field (`~/.pi/agent`), is
irrelevant: the symlink is one level down, on `extensions` itself.

### The reproduction, and the control that pins it

`tests/subagent-wait-wake-e2e.test.ts` stages the checkout's `subagent-async` and
`lib` beside the scripted provider and runs the nested chain twice, differing
only in how the agent dir reaches that staged set:

| arm | spelling | `lstat` of `<agentDir>/extensions` | pre-fix | post-fix |
|---|---|---|---|---|
| `link` | `<root>/link-agent/extensions` → `<root>/stage/extensions` | symlink | **red**, 30 s deadline, `deliverResult: no live session … dropping result` | green, 5.9 s |
| `plain` | `<root>/plain-agent/extensions` | real directory | green, 5.2 s | green |

The `plain` arm is the control: same processes, same extension files, same
chain. It wakes before the fix, so the link arm's park is the symlinked spelling
and not a broken chain. Row 4 asserts each tree really has the shape its arm
claims, so the A/B cannot silently degrade into two plain arms.

Why the staged tree and not the live checkout: the scripted provider has to sit
in the same `extensions` directory, and `cpSync`ing the checkout's files is the
same set. The symlinked `extensions` entry — the thing that produces the second
spelling — is identical either way.

Module-record census of one field-shaped pid,
`~/Developer/notes/wo-098/r4/probe-field-census.ts`, output kept in
`~/Developer/notes/wo-098/r4/eval-census.log`:

```
=== link
  EVAL index.ts    url=<root>/stage/extensions/subagent-async/index.ts   ← cycle re-entry
  EVAL worktree.ts url=<root>/stage/extensions/subagent-async/worktree.ts
  EVAL index.ts    url=<root>/link-agent/extensions/subagent-async/index.ts  ← the factory
=== plain
  EVAL worktree.ts url=<root>/plain-agent/extensions/subagent-async/worktree.ts
  EVAL index.ts    url=<root>/plain-agent/extensions/subagent-async/index.ts
```

`index.ts` twice in the link arm, once in the plain arm; `worktree.ts` once in
both. The staged copy carried an `EVAL` line appended from `index.ts` and
`worktree.ts` at module load, which is how the records are counted.

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
- The six stuck subagent parks of 2026-11-10 share one shape (implementer
  dispatched both reviewers, then parked) and the install spelling of this box
  gives every session loading it the duplicate, so the fix covers them. Round 3
  wrote that the field's real `agentDir` put those parks outside this mechanism;
  that was wrong — it looked one level too high, at `agentDir` instead of at
  `extensions`. Which of the six is explained by the drop is a census question
  this record does not answer; the mechanism is present in the field install.

## Probes

`~/Developer/notes/wo-098/`: `probe3-rpc-wake.ts`, `probe4-real-subagent.ts`,
`probe5-nested-wait.ts`, `probe6-delivery-windows.ts`, `probe-faux-provider.ts`
(real `pi` processes, scripted model, no network), `probe-lifecycle.ts`,
`bisect.sh`. Round 3: `r3/probe-double-eval.ts` (spelling A/B on a bare
extension), `r3/probe5-nested-wait.ts` (the nested shape against an instrumented
copy in `r3/instr/`). Round 4: `r4/probe-field-census.ts` (the field's symlinked
`extensions` entry, with `r4/eval-census.log`).
