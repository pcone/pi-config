---
title: "Parent-as-supervisor with RPC mode subagents"
type: decision
status: deferred
date: 2026-07-14
---

# Parent-as-supervisor with RPC mode subagents

**What:** Switch the subagent extension from `--mode json -p` to `--mode rpc`, enabling the parent model to act as an active supervisor — periodically checking in on subagent progress, reviewing work, and injecting steering — rather than a passive delegator.

**Why:** The current fire-and-forget model delegates a chunk and waits for a result. The parent gets a summary at the end but has no visibility or control during execution. With bidirectional RPC, the parent could check in every ~100 turns to review progress, correct course, or stop early. This prevents wasted work when a subagent drifts, and gives the expensive parent model leverage over the cheap implement agent.

**Constraints:** Pi tools are request/response — `execute` runs, streams updates via `onUpdate`, and returns a result. There is no mechanism for the parent to send input back to a running tool mid-execution. This means true mid-invocation check-ins (pause subagent, ask parent, resume) are not possible without tool API changes.

**Practical shape — multi-invocation supervision:** Each check-in is a separate subagent invocation. The agent runs ~100 turns, returns a progress summary (no checkpoint), and the parent decides next steps:

```
Parent:  invoke implement(chunk) → subagent runs ~100 turns, returns progress summary
Parent:  review summary, decide: checkpoint + steer, or steer without checkpoint, or stop
Parent:  invoke implement(session_id, steering + "continue") → subagent resumes
```

Key difference from current chunking: the agent does NOT checkpoint automatically. The parent owns the checkpoint decision — it may want to review progress first, inject steering, or stop without checkpointing. RPC mode enables:
- **Soft turn-limit warnings**: extension injects a steering message around turn 280 telling the agent to find a stopping point (falls back to hard kill at ~350).
- **Richer progress reporting**: RPC events give the extension more visibility into what the subagent is doing, enabling better summaries for the parent.
- **Future**: if/when pi tools support bidirectional communication, true mid-invocation parent check-ins become possible.

**Alternatives considered:**
- **True bidirectional streaming**: Not possible without pi tool API changes to support mid-execution parent input.
- **Hard kill at turn limit**: Clean but can't prompt for graceful wrap-up or parent review. Rejected.
- **Soft prompt in agent body**: The agent can gauge session length from context size, but has no turn counter and no guarantee it notices. Weak.

**Tradeoffs:**
- RPC mode is a significant refactor of the subagent extension: stdin piping, JSON command framing, event routing all change.
- `--mode json -p` is simpler and currently works. The chunking + checkpoint mechanism should keep sessions short naturally.
- The refactor is worthwhile once there's evidence of subagents running away or drifting, or when the parent-supervisor workflow would meaningfully improve results.

**Implementation notes:**
- Replace `--mode json -p "Task: ..."` with `--mode rpc --session-id <id>`. Send initial prompt as `{"type": "prompt", "message": "..."}` on stdin.
- Track turn count via `message_end` events (already done in `currentResult.usage.turns`).
- At ~280 turns: send `{"type": "prompt", "message": "<warning>", "streamingBehavior": "steer"}` to inject a soft warning.
- At ~350 turns: fall back to SIGTERM hard kill as safety net.
- Richer progress: use `turn_start`/`turn_end` events to track tool usage patterns and produce better intermediate summaries for the parent.
