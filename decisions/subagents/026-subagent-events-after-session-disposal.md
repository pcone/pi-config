---
title: "Subagent events after session disposal — guard async callbacks with a live-session ctx"
type: decision
status: done
date: 2026-10-06
---

# Subagent events after session disposal

**What:** `extensions/subagent-async/index.ts` now tracks a module-level
`liveSessionCtx` (set in `session_start`, cleared in `session_shutdown`). The
post-turn async paths that run from a child's socket/close callbacks —
`updateFooter`, the child-end `notifyChildDetached`, the `detach` attach
cleanup, and `deliverResult` — read the live ctx and no-op when it is null. The
captured spawn-time `ctx` is no longer used after `spawnSubagent` returns.
`updateFooter` lost its `ctx` parameter and all call sites were updated;
`detach` lost its `ctx` parameter; `deliverResult` deliberately drops a result
that arrives with no live session (logged via `debugLog`).

The timer-based `pi.sendUserMessage` wake-ups (`bumpStaleWatchdog` and the
`wait` tool's timer) are guarded the same way: both callbacks run after the turn
that armed them, so each skips its wake-up when `liveSessionCtx` is null.
`postDeliveryCleanup`'s steer warning is already try/caught and is left as-is.

**Why.** `pi -p` crashed the parent process whenever a child reported back after
the print run ended:

```
pi -p --no-session --thinking low --tools subagent \
  "Call the subagent tool exactly once …"
```

Observed: the child is dispatched, then the parent dies with `Error: This
extension ctx is stale after session replacement or reload …` at
`updateFooter` ← `processLine` ← the child's socket `data` handler. The chain is
verified in pi source:

- `dist/modes/print-mode.js:26` calls `runtimeHost.dispose()` when the run ends.
- `dist/core/agent-session-runtime.js:290-296` `dispose()` emits
  `session_shutdown` (reason `"quit"`) **then** calls `session.dispose()`.
- `dist/core/agent-session.js:555-570` `dispose()` ends with
  `this._extensionRunner.invalidate(...)`.
- `dist/core/extensions/runner.js:352-361,462` — after `invalidate`, any captured
  ctx use throws (`ctx.ui` getter asserts active), and
  `dist/core/extensions/loader.js:243-245` asserts active on `pi.sendUserMessage`
  too.

So the session is invalidated the moment print mode finishes, while the async
child is still running. The child's first post-disposal RPC line reaches
`updateFooter(ctx)` with the spawn-time ctx → uncaught throw inside a socket
handler → process death. Interactive sessions are unaffected because they never
dispose mid-run. Async subagents are *designed* to outlive the turn, so the
extension must handle "no live session" instead of assuming the spawning session
is still valid.

**Alternatives rejected.**
- *Swallow the exception (try/catch around UI/delivery calls):* hides real bugs,
  leaves the captured-spawn-ctx pattern in place, and turns a loud failure into a
  silent one. The liveness check is explicit instead.
- *Make print mode wait for children before disposing:* changes print-mode
  semantics (`-p` is a one-shot run, not a supervisor) and is out of scope for
  the extension. Async children are meant to survive; the parent need not.
- *Use `pi` instead of `ctx`:* `pi` is invalidated by the same
  `ExtensionRunner.invalidate` call — `loader.js:243` asserts active on
  `sendUserMessage` — so it is not a safe substitute.
- *Key liveness off a timer / "assume alive until N ms":* a heuristic that races
  the real disposal event. `session_shutdown` is the exact signal, and pi emits it
  before invalidation.

**Tradeoffs.**
- A child result that arrives after the spawning session shut down is dropped
  from the parent. This is deliberate, not data loss: the child's own session
  file and `/tmp/pi-subagent-<id>.log` retain the full output, and the child is
  recoverable via `subagent_resume`.
- Stale-turn wake-ups and delivery are silently skipped in the dead-session
  window. They have no receiver by definition, so nothing observable is lost.

**Reopening triggers.** pi changes the dispose ordering so `session_shutdown` is
emitted *after* invalidation (the clear would then be too late) → track the
runner's liveness directly. pi adds a first-class "is this session alive" query
→ replace the module-level ctx with that query. Child results are observed being
dropped in a scenario where the parent session is still live and interactive →
the `liveSessionCtx` wiring is wrong, not the policy.

**Files changed:** `extensions/subagent-async/index.ts` (`liveSessionCtx`,
`session_start`/`session_shutdown`, `updateFooter`, `notifyChildDetached`,
`detach`, `deliverResult`, `bumpStaleWatchdog`, the `wait` timer),
`tests/subagent-session-lifetime.test.ts`, `tests/subagent-async-kill.test.ts`
(existing delivery test now declares a live session), this decision, index.

**Test coverage:** `tests/subagent-session-lifetime.test.ts` — session_start
records the ctx and the footer renders on it; `deliverResult` sends exactly once
on a live session; `notifyChildDetached` emits the exact child-end notification;
`detach` restores/clears the attach UI and resets module state; after
`session_shutdown`, `updateFooter`, `deliverResult`, `notifyChildDetached`, and
`detach` neither throw nor touch `ui` nor call `sendUserMessage` (while detach
still resets module attach state); and the stale-turn watchdog and `wait` timers
skip their wake-ups with no live session while still sending on a live one. The
lifecycle is exercised through the real captured
`session_start`/`session_shutdown` handlers.
