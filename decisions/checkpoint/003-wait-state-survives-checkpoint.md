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
