---
title: "Checkpoint waits: a pending wait is session state"
type: design
status: active
date: 2026-11-02
feature: checkpoint
---

# Checkpoint waits

A session can be waiting on someone: the owner's ruling, a restart, a peer's reply, a subagent it must gate. That wait is session state. A checkpoint continues only when none is pending, so a seat that is holding does not start new work after its context is cleared.

Code: `extensions/lib/waits.ts` (store, sources, continuation rule, kickoff), `extensions/checkpoint.ts` (the `wait_for` tool, the surfaces). Decision: `decisions/checkpoint/003-wait-state-survives-checkpoint.md`. Tests: `tests/checkpoint-waits.test.ts`.

## The rule

`continue` unset continues only when no wait is pending. Explicit `true` continues, explicit `false` stops. Prompt text is never consulted: not `nextSteps`, not the last user message, not the compaction summary.

Wording alone was the defect this replaces. A seat replied RESTARTABLE, checkpointed with `continue: true`, and its 4 kB `nextSteps` never mentioned the restart, so the follow-up started new work a minute after compaction.

## Kinds

| Kind | Source | Who registers it |
|---|---|---|
| `manual` | `wait_for({ reason, kind? })` | the model itself |
| `derived` | the feature that owns the state, on demand | `subagent-async`, `peer-link` |

A wait is `{ id, kind, reason, since, source }`. `kind` is one of `owner`, `peer`, `restart`, `subagent`, `other`.

- A **running child** is a `subagent` wait. Derived from the subagent meta registry, so a restart still sees a child that outlived its parent process. A child that ends stops being a wait without anyone clearing it. An orphaned child is not a wait: its owner is gone, nothing will deliver its result, and resuming it is work rather than waiting.
- An **unanswered `expectReply` send** is a `peer` wait. Recorded when the envelope is sent; dropped when an inbound envelope carrying that `inReplyTo` arrives in the delivery scan. External peers are never recorded — they read mail only on their user's next prompt and never auto-reply.

## Where a manual wait is stored

`pi.appendEntry("checkpoint-wait", { waits })` writes a full snapshot of the manual waits. The store rebuilds by taking the last such entry on the branch (`SessionManager.getBranch()`).

- **Invisible to the model.** A pi `custom` entry is not part of the LLM context, so the snapshot costs no tokens and cannot be rewritten by a summarizer.
- **Survives compaction.** Compaction appends an entry; it does not remove the branch. The snapshot is still on the branch afterwards.
- **Survives a restart.** The entry is in the session file, so a new process reads it back by opening the same session.
- **Branch-aware.** Reading the last entry on the branch rather than every file entry means an abandoned branch's snapshot is not read.

Full snapshots rather than deltas: replay takes the last one, so an overwritten or lost entry costs nothing. A malformed snapshot throws, naming the entry: reading it as "nothing is pending" is the one answer that starts work.

## How a wait clears

A **manual** wait clears only through `wait_for({ clear: true })` (one by `id`, or all). No inbound message clears it — a waiting seat answers mail and goes back to waiting. That is the owner's ruling: holding mail would leave the very message that ends the wait unread.

A **derived** wait clears when its source ends: the child finishes, the reply arrives.

## What the model sees

- **`wait_for` result.** Every pending wait, with the ids that clear it.
- **Checkpoint tool result.** `describePending`: `1 wait pending — peer: reply from bug-triage → not continuing`, and `… → continuing anyway (continue: true overrides the wait)` when the model overrode it. A model that forgot the wait learns the session is holding.
- **Kickoff prompt.** The post-compaction follow-up and a restart's injected context both open with `WAITING ON: <kind>: <reason>`, then the rule: answer what arrives, start nothing else. A restarted seat learns at kickoff that a wait is still pending.
- **`session_start`.** The snapshot is read from the branch and injected before the first turn's model call, as a hidden custom message. Nothing there starts a turn of its own.

The waits are resolved once, at the checkpoint call, so the tool result and the kickoff state the same thing even if a source ends while compaction runs.

## Limits

- Derived peer waits are in-process. A restart forgets an unanswered `expectReply`; the durable kind is the manual wait.
- A `checkpoint_fork` resolves against the source session's waits and names them in the new session's kickoff, but does not copy the snapshot into the new session.
