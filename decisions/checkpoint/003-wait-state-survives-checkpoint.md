---
title: "A pending wait is session state, and a checkpoint continues only when none is pending"
type: decision
status: accepted
date: 2026-11-02
---

# A pending wait survives a checkpoint

**Ruling (owner, 2026-11-02, in Claude session 8f90746f).** Scott was asked two questions.

1. Whether a session's wait should be explicit state that survives a checkpoint. He picked "Yes, add it (Recommended)", which approves the proposal as asked:
   - A seat sets a wait itself, through a `wait` tool or `wait: true` on checkpoint, when told to hold.
   - Running subagents and unanswered outbound `expectReply` sends count as waits automatically.
   - `continue` left unset continues only when no wait is pending. An explicit `true` or `false` overrides.
   The recorder reads the choice between a `wait` tool and a checkpoint flag as left to the implementer.
2. Whether a wait should hold peer mail back. He picked "Don't hold mail (Recommended)". Mail still starts a turn while a seat waits, and the wait carries across that turn.

**Ruling (owner, 2026-11-03, in Claude session 8f90746f), from WO-2026-064's gate.** Scott was asked two more questions.

3. A Claude Code peer's reply carries no `inReplyTo`, so a derived wait on an `expectReply` sent to one never cleared. He picked "Any msg from peer (Recommended)": any envelope from the peer waited on ends that peer's waits. A matching `inReplyTo` stays the fast path. External sends are still recorded, and `external.ts` gains no flag.
4. Whether `checkpoint_fork` carries a pending manual wait into the new session. He picked "Copy the wait (Recommended)": the fork inherits the source's manual-wait snapshot.

**Why.** The tfd seat replied RESTARTABLE, then checkpointed with `continue: true`. Its `nextSteps` never mentioned the pending restart, so the follow-up prompt started new work (WO-2026-456) a minute after compaction. A wait held only in prose has to survive a compaction that discards the conversation it was written from. The 30-day corpus: 281 checkpoint calls; 33 passed `false`, and none of those continued on its own; 248 continued, 36 of them with a wait named in their own `nextSteps`.

**Rejected: holding mail while waiting.** The wake-up was not the defect. A waiting seat must still answer questions and take "resume" or "restart now", and held mail would leave a message that clears the wait unread. The defect was the checkpoint resuming work.

**Rejected: wording only.** `edfffd6` fixes the wording on every surface the model reads. It still relies on the model writing the wait into `nextSteps`, which is the step that failed.

**Rejected: not recording external sends.** It drops the wait the owner's first ruling counts, for every Claude Code peer.

**Rejected: `external.ts` stamping `inReplyTo`.** It adds surface to a non-pi CLI to fix a match that the sender's identity already answers.

**Outcome (2026-11-02).** Landed as `62dd8d8` (preparatory refactor), `08a2f25` (the change), `f9ab947` (review rework: the surface moved beside the store) and `f12fb2c` for rulings 3 and 4 (the sender rule is the rule, not a fallback; the fork copies the manual snapshot and its kickoff names only what travels), merged to main as `d787839`, with WO-2026-064. The hashes above are the rebased ones; the pre-rebase ids in earlier revisions of this paragraph were `3e56a97`, `36e4342` and `fbb78f2`. `62dd8d8` is the preparatory refactor: `checkpoint` and `checkpoint_fork` each resolved `continue` and assembled the kickoff their own way; both now call one `resolveContinuation` and one `sendKickoff` in `extensions/lib/waits.ts`, with the row-level test results unchanged.

The choice left open — a `wait` tool or a `wait: true` checkpoint flag — landed as the tool, named `wait_for` because pi ships a `wait` tool that collects subagent results. A wait has to exist before the checkpoint that carries it: a seat told to hold has not necessarily checkpointed yet, and the flag alone would cover only a wait that already survived to a checkpoint.

Manual waits are a full snapshot entry on the session branch (`pi.appendEntry("checkpoint-wait")`), which is invisible to the model and survives both compaction and a restart. Derived waits are computed by the extension that owns the state: `subagent-async` (a running child, from the meta registry) and `peer-link` (an unanswered outbound `expectReply`). Neither holds mail.

Rulings 3 and 4 changed two things. A peer wait now ends on any envelope from that peer, with a matching `inReplyTo` as the fast path, so an external peer's reply ends it without `external.ts` stamping anything (ruling 3). And `checkpoint_fork` copies the source's manual-wait snapshot into the new session as a real entry on its branch, so a store over that branch replays it (ruling 4); derived waits do not travel.

Design: `docs/design/checkpoint-waits.md`. Tests: `tests/checkpoint-waits.test.ts`.
