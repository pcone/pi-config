---
title: "Async subagents with organic parent supervision"
type: decision
status: done
date: 2026-07-14
---

# Async subagents with organic parent supervision

**What:** A new extension (`subagent-async`) that makes subagent invocations non-blocking via RPC mode. The subagent runs autonomously in the background while the parent remains interactive. The parent checks progress and decides to steer or stop organically — no fixed turn schedule, no file conflicts.

**Why:** The synchronous model wastes the parent's time waiting. Organic supervision lets the user and parent decide when to intervene based on real progress, not arbitrary turn counts.

## Flow

1. Parent delegates to subagent (fire-and-forget), returns immediately
2. Subagent runs autonomously in background via RPC mode
3. User asks "how's the subagent doing?" — parent checks progress
4. Parent decides: continue, steer, or stop
5. Subagent finishes → result injected as user message, triggers automatic parent turn

## New extension: `subagent-async`

Separate from the existing `subagent` extension. No shared state, no risk of breaking synchronous subagents.

## Implementation details

### RPC mode

Switch from `--mode json -p "Task: ..."` to `--mode rpc --session-id <id>`. Send initial prompt as `{"type": "prompt", "message": "..."}` on stdin. Pipe stdin for subsequent commands (steer, stop). Route RPC events to the same tracking logic currently in `processLine`.

### Background process lifecycle

- In-memory `Map<sessionId, { proc, result, startTime }>` in the extension.
- Register `session_shutdown` handler to SIGTERM → 5s → SIGKILL all running subagents.
- Surface active subagents in the TUI footer: "2 subagents running" with a `/subagents` command to list them (session_id, agent name, turns, current activity).
- No persistence across pi restarts. Lost subagent work is re-delegated by the parent.

### Progress tracking (`subagent_status` tool)

Extension tracks per-session:
```typescript
{
  turns: number,
  filesRead: string[],      // deduplicated
  filesModified: string[],  // deduplicated
  currentActivity: string,  // last few tool calls summarized
  errors: string[],         // error messages encountered
  startedAt: number,
}
```
Files tracked via `tool_execution_start` events (parse tool name + args).

### Result delivery

When subagent finishes, inject a user message via `pi.sendUserMessage()`:
```
[Subagent implement finished — session: subagent-<id>]
Task: <original task>
Turns: 47 | Files read: 3 | Files modified: 2
Session log: /path/to/session.jsonl (grep, don't read in full)
---
<final output>
```
Triggers an automatic parent turn (`triggerTurn: true` implied by `sendUserMessage`).

### Steering (`subagent_steer` tool)

Sends `{"type": "prompt", "message": "<steering>", "streamingBehavior": "steer"}` via RPC stdin. Delivers before the subagent's next LLM call. If subagent is idle, triggers a new turn.

### Stop (`subagent_stop` tool)

1. Sends final steer: "Wrap up your current work and return a summary. Do not start new tasks."
2. Waits up to 5 minutes for the subagent to finish.
3. If subagent finishes: deliver result as above.
4. If timeout: SIGTERM → 5s → SIGKILL, deliver whatever was produced with a `[Force-stopped after timeout]` note.
5. Cleans up the process handle from the tracking map.

### Safety net

Hard kill at 500 turns as a last-resort fallback. Should never trigger under normal supervision.

### Surface active subagents

- TUI footer shows count: `2 subagents`
- `/subagents` command lists: session_id, agent name, turns, current activity, elapsed time
- Option to stop or steer from the listing

## Tradeoffs

- **Subagents fork from HEAD**, not the working tree. Uncommitted changes in the parent are invisible to the subagent. Commit any work the subagent needs before delegating.
