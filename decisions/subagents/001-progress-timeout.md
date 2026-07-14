---
title: "Progress-based timeout for subagents"
type: decision
status: planned
date: 2026-07-14
---

# Progress-based timeout for subagents

**What:** Add a configurable progress timeout to the subagent extension — kill the subagent process if it produces no stdout output for N minutes, resetting the timer on each line emitted (including thinking output from `--mode json` streaming).

**Why:** Subagents have no timeout at all currently. A runaway or hung agent burns tokens indefinitely. A hard wall-clock timeout is wrong for implement agents that legitimately run long. A progress timeout catches hangs without capping legit work.

**Alternatives considered:**
- **Hard wall-clock timeout per agent**: Too blunt — long implementations legitimately exceed any reasonable cap.
- **Token budget per agent**: Not directly controllable via CLI flags; would need per-agent config.
- **Provider-level timeout**: Already exists (`retry.provider.timeoutMs`) but only covers individual API calls, not multi-turn sessions.
- **Do nothing**: Relies on the parent's abort mechanism (Ctrl+C), but parent sessions also run unattended.

**Tradeoffs:**
- The threshold must be chosen carefully — too short kills legit work during long tool calls (large file reads, slow builds); too long doesn't catch hangs quickly enough.
- Implementation requires tracking `lastOutputTime` in the stdout handler, with a `setInterval` or `setTimeout` chain to check staleness.

**Implementation notes:**
- Add a `subagentProgressTimeoutMs` setting (or similar) to the extension, defaulting to something like 5 minutes (300000ms).
- Reset the timer on every stdout line received (covers both thinking and tool output in JSON mode).
- On timeout: SIGTERM, then SIGKILL after 5s (same as the existing abort handler).
- Surface the timeout in the result (`stopReason: "timeout"`) so the caller knows it didn't finish.
