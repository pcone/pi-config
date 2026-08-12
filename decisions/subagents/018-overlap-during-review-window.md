---
title: "Overlap independent work during an implementer's review window (prompt-only)"
type: decision
status: done
date: 2026-08-10
---

# Overlap independent work during an implementer's review window

**What:** Prompt discipline (orchestrate mode + `orchestrator` agent):
after dispatching an implementer, do independent follow-on work before
calling `wait`, instead of blocking on the full review/rework loop. No
harness change — dispatch is already fire-and-forget (decision 003).

**Why:** The review/rework loop (decisions 004, 006) runs for minutes
but blocks only the implementer. The prompts read sequentially
(dispatch → wait → gate → merge), so orchestrators blocked when they
didn't have to be.

## Why not B/C

- **B — structured interim report** (implementer delivers at "review
  launched," then a final result on close). Deferred. Needs a new
  primitive: delivery is 1:1 with `proc.on('close')`
  (`deliverCloseResult`); the soft-prompt guard (011) re-enters the
  child but doesn't deliver to the parent. And B's purpose is to act
  on the result before the gate vouches for it — building on
  unverified output, which is what the gate exists to prevent.
  **Revisit when:** logs show orchestrators blocked on a reframe with
  no way to act — then `/attach` to the in-flight implementer (007) is
  the answer, not an interim-delivery channel.
- **C — orchestrator-owned rework.** Rejected. Inverts 004 (gate keys
  to whoever spawned the reviewers) and 006 (implementer owns
  re-review targeting). Benefit is already captured by this overlap;
  cost (re-deriving context at the wrong layer) is all downside.

## Discipline

- **Independent work only.** Overlap the next implementer only if it
  doesn't depend on the in-flight item's merged result. Building on
  un-reviewed work risks a rework-induced reframe invalidating the
  follow-on.
- **Track in-flight implementers** (session id, independence) in the
  roadmap/todo doc. The blocking model remembers this for free;
  overlap doesn't.
- **`wait` wakes on first completion** — gate + merge that one,
  re-`wait` for the rest. "One completion = all done" is decision
  004's anti-pattern.

## Tradeoffs

- **Speculation risk.** Overlapping *results* (not just parallel
  independent work) acts on unverified output. Bounded by the
  independence rule.
- **Bookkeeping load.** Multiple pending implementers + merges;
  bounded by the count of dispatchable independent items.
- **Reversible.** Prompt-only; one revert restores the sequential read.

## Files changed

- `extensions/modes.ts` — orchestrate-mode prompt: overlap subsection.
- `agents/orchestrator.md` — step 3: overlap for multiple implementers
  within one item.
- `decisions/subagents/README.md` — row 018.

## Test coverage

Prompt-only. Structural check: doesn't contradict 003 (async
dispatch), 004 (gate ownership + wait semantics), or 006 (implementer
owns the rework loop).
