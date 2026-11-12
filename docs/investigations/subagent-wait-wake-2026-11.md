# The parked `wait` that never wakes — investigation (WIP)

WO-2026-098. Work in progress: **no fix and no test row landed.** This records
what is established and what the next window should do first.

## Established

**1. pi 1.4.0's steer delivery is not the defect.** `sendUserMessage(…,
{ deliverAs: "steer" })` goes to `AgentSession.prompt()` (`dist/core/agent-session.js:1910`).
A session that is idle — including one whose turn ended on the `wait` tool's
`terminate: true` — takes the `!isStreaming` branch and calls `_startRun`, which
starts a new turn. `deliverAs` only matters while `isStreaming`.

Probe (`~/Developer/notes/wo-098/probe1.ts`, real `AgentSession`, faux provider,
real `wait` tool): turn 1 ends on `wait`'s `terminate: true`; a later
`sendUserMessage(…, { deliverAs: "steer" })` starts turn 2. Wakes under `mode:
"tui"` and `mode: "rpc"`.

**2. The parent-side close path delivers, in-process.** `probe2.ts` — real
`AgentSession` parent, real `subagent` spawn of a stand-in child, real close
handler: the child's completion arrives as a user message and the parent's next
turn runs. So the close handler, `deliverResult`'s `liveSessionCtx` guard and the
steer delivery all work when the delivering session is a normal in-process
session.

**3. The field evidence splits by session kind, not by code path.** Every parked
`wait` in `~/.pi/agent/sessions/` whose directory is a subagent worktree
(`--Users-scott-Developer-wt-subagents-*`) has **no** completion as the entry
after the park: the next entry is an operator message or nothing at all
(2026-11-09 09:41, 2026-11-10 04:18/04:35/04:48/05:34/06:06/07:09/08:11/09:03).
Parks in **root** session directories (`--Users-scott-Developer-pi-config--`,
`--Users-scott-Developer-tfd--`) are routinely followed by
`[Subagent … finished]`.

Root sessions are the TUI orchestrator. Subagent sessions are `pi --mode rpc`
children (`buildSubagentArgs`). So the trigger is a property of an **RPC child
session as the deliverer**, which neither probe reproduces yet: probe 1 ran a
real `AgentSession` in-process, not a real spawned `pi --mode rpc` process.

## Next step

Reproduce with a real spawned RPC child as the delivering session, not an
in-process one. `~/Developer/notes/wo-098/probe-faux-provider.ts` is the
start of the harness: a test-only extension that registers a scripted faux
provider with `pi.registerProvider(provider)`, driven by `PI_FAUX_SCRIPT` /
`PI_FAUX_LOG`, so a real `pi -e … --mode rpc` process can be driven with no
network and its children inherit the same model (`--model faux/faux-1`).

Plan: spawn a real RPC subject with `extensions/subagent-async/index.ts` plus the
faux provider; subject dispatches a child, then parks on `wait`; child finishes.
Observables: the subject's session JSONL (does a `[Subagent … finished]` user
entry appear, and a turn 2) and `PI_ASYNC_DEBUG=1`'s `/tmp/pi-async-debug.log`
(`deliverResult: no live session — dropping result` would name the skip).

Also worth a probe before writing the row: run the same shape with the subject
bound `mode: "tui"` to confirm the mode/depth split rather than modelling it.

## Ruled out

- Steer semantics for an idle, turn-terminated session (probe 1).
- The close handler and `deliverResult`'s guard, in-process (probe 2).
- `_compactionAbortController`: cleared in `finally` on every path
  (`agent-session.js:2210-2350`), so a failed compaction cannot wedge delivery.
- The throw-before-delivery hazard in the close handler: `preCommitSteps` and
  `verifyWorkRecord` both catch internally; `closeWorkRecord` always calls its
  commit step.

## Note for the suite

`bash tests/setup.sh` was needed in this worktree: without it a bare import of
`@earendil-works/pi-coding-agent` resolves to bun's cache (1.5.2) instead of the
installed 1.4.0, and `new ModelRuntime(...)` fails with `providers.map` of
undefined.
