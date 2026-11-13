# The parked `wait` that never wakes — investigation

WO-2026-098. **No fix and no test row landed.** This records what two rounds
established, including a reproduction that fails today.

## Established (round 2)

**1. The delivery mechanism works in a real RPC session.** A real
`pi --mode rpc` process parked by a `terminate: true` tool result wakes on a
post-turn `pi.sendUserMessage(…, { deliverAs: "steer" })`
(`~/Developer/notes/wo-098/probe3-rpc-wake.ts`). The one-level shape
(subject dispatches a child, parks, child finishes) and the nested shape
(subject → child → grandchild) both wake when the extension is loaded with
`-e` and the agentDir carries only a faux provider
(`probe4-real-subagent.ts`, `probe5-nested-wait.ts`). Round 1's reading of the
field (below) is what made this look otherwise.

**2. The field split is not by session kind.** Every `wait` tool result in
`~/.pi/agent/sessions` (6,883 rows), with the entry that follows it:

| transcript dir | wake-up next | nothing after the park |
|---|---|---|
| root (`--Users-scott-Developer-…`) | 4,749 | 10 |
| subagent worktree (`--Users-scott-Developer-wt-subagents-…`) | 231 | 6 |

Round 1's "parks in subagent session dirs are never followed by a completion"
is falsified by 231 counter-examples. Retrieval: `~/Developer/notes/wo-098/`
plus the scan scripts in `/tmp/wo098-scan*.py`.

**3. The six stuck subagent parks share one shape, and the delivery was
attempted.** Each is an implementer that dispatched `review-code` and
`review-tests` in one turn, then parked. In each case both children finished
(the parent's `── Completed (n turns, exit 0) ──` footer is on disk, written by
the close handler's first half), the parent process was still alive when they
finished, and its transcript is frozen at the `wait` tool result:
`2026-11-10T08:11:13` (68d7f8aac83f), `2026-11-10T09:03:05`, `2026-11-12T23:27:03`,
`23:42:36`, `23:57:11`, `2026-11-13T01:24:56`. The root-side "nothing after the
park" rows are a different cause: their children never finished at all (one had
been running three days).

**4. Reproduced: the trigger is the installed extension set, not the shape.**
Run `probe5-nested-wait.ts` with the subject's agentDir carrying a copy of
`~/.pi/agent/extensions` (what production loads) instead of `-e` on our file
alone, and the same nested shape stops waking at both levels. `PI_ASYNC_DEBUG=1`
names the drop, from the middle session's pid:

```
[21999] deliverResult: no live session — dropping result for subagent-0ee148d9-…
```

**5. The drop contradicts that process's own lifecycle.** A lifecycle logger
loaded alongside the installed set (`probe-lifecycle.ts`) records, for that same
pid:

```
[21999] depth=1 session_start reason=startup
… turn_start, message_end …, agent_settled aborted=false
```

with no `session_shutdown` before the drop. `session_start` sets
`liveSessionCtx`; the close handler then read it as null, in one process that
never shut the session down. The only reading that holds both observations is
**two module instances of `extensions/subagent-async/index.ts` in that process**:
the instance whose `session_start` ran set its own `liveSessionCtx`, and the
instance holding the child's close handler reads its own, still null. That also
explains the stickiness — every later delivery in that process is dropped by the
same null-holding instance — and why no in-process probe reproduces it.

## Next step

Confirm the duplication before designing the fix:

1. Patch a copy of `extensions/subagent-async/` to stamp a per-module-instance
   id (`Math.random()` at module scope) into `session_start` and into
   `deliverResult`'s `!liveSessionCtx` branch. Two different ids in one pid
   proves it; one id means the null came from somewhere else.
2. List the loaded extensions for duplicate paths resolving to the same file
   (`loader.getExtensions()`), and check pi 1.4.0's
   `dist/core/extensions/loader.js` path canonicalisation — a second load path
   (copy vs `-e`, or two entries under `<agentDir>/extensions`) is the candidate.
3. Then the repro row: the `probe5` shape, real nested `pi --mode rpc` processes
   against the installed set, is the row that fails today. It needs a home under
   `tests/` with a timeout, cleanup (`removeSpawnArtifacts`), and rows 3–5 of the
   order.

A landed fix only reaches the field after `seat-sync` copies it into
`~/.pi/agent/extensions/` (that copy is identical to the repo tip today, except
`session-trim.ts`, so the field failures ran main's code).

## Probes

`~/Developer/notes/wo-098/`: `probe3-rpc-wake.ts`, `probe4-real-subagent.ts`,
`probe5-nested-wait.ts`, `probe6-delivery-windows.ts`, `probe-faux-provider.ts`
(real `pi` processes, scripted model, no network; script steps are keyed by
`PI_FAUX_SCRIPT_DEPTH_<n>`), `probe-lifecycle.ts`, `bisect.sh`.

`probe6` rules two candidate windows out for an in-process session: a steer
during the `agent_settled` emit is deferred and then run (it loops if the handler
delivers on every settle), and a steer during compaction is rejected with
"Cannot submit a prompt while compaction is in progress" — the latter is a real
silent-drop path, but `isIdle` is false only while compacting and no stuck
session ever compacted (no `checkpoint` call in any of the six).

## Ruled out

- Steer semantics for an idle, turn-terminated session: the `!isStreaming`
  branch starts a new turn (`dist/core/agent-session.js:1910`).
- The close handler and `deliverResult`'s `liveSessionCtx` guard, for a session
  whose module instance is the one that ran `session_start` (probe 2, probes
  3–5).
- Auto-compaction as the trigger: the field models declare a 1,000,000-token
  window and the stuck transcripts sat at 120k–245k, so `shouldCompact`
  (`contextWindow - reserveTokens`) never fired; none called `checkpoint`.
- `_compactionAbortController` stuck set: cleared in `finally` on every path
  (`agent-session.js:2210-2350`).
- The throw-before-delivery hazard in the close handler: `preCommitSteps` and
  `verifyWorkRecord` both catch internally; `closeWorkRecord` always calls its
  commit step.
- `armIdleCompaction` (`auto-checkpoint.ts:469`) compacting under a parked
  session: it returns early unless `ctx.mode === "tui"`.

## Note for the suite

`bash tests/setup.sh` is needed in a fresh worktree: without it a bare import of
`@earendil-works/pi-coding-agent` resolves to bun's cache (1.5.2) instead of the
installed 1.4.0, and `new ModelRuntime(...)` fails on `providers.map` of
undefined. A probe run from outside the repo needs a `node_modules` symlink
pointing at the checkout's (`~/Developer/notes/wo-098/node_modules` is one).
