---
title: "A Claude Code session watches its inbox in the background and wakes on direct mail; broadcasts wait for the next prompt"
type: decision
status: accepted
date: 2026-11-27
---

# Unsolicited-mail watch for a Claude Code peer

**Ruling (owner, 2026-11-27).** Scott asked for the watcher 013 permits: "yeah we want to build this, but do a review of broadcast type messages - perhaps anything that broadcasts rather than sends to a specific session should probably not trigger this?" Asked how a broadcast is marked, he picked "Sender flag (Recommended)": envelopes carry a `broadcast` field, pi's `to: "*"` sets it, and `external.ts send` gains a multi-recipient form that sets it. Asked whether pi's `*` should reach Claude sessions, he picked "Include Claude (Recommended)": each listed external peer gets a copy, flagged, read at its next prompt.

**What:**

1. **Watch.** `external.ts watch --from <self>`, run with Bash `run_in_background`, blocks until the inbox holds an envelope that wakes. It then claims every pending envelope except replies a reply-wait owns, prints them, and exits 0. The session handles the mail and starts the watch again. It exits 3 when the session's registration is gone (SessionEnd).
2. **What wakes.** An envelope wakes unless it is a broadcast. Direct sends, auto-replies, replies to sends made without `--wait`, and model-error mail all wake.
3. **Broadcast flag.** Every envelope carries `broadcast: boolean`, set by its sender. pi's `to: "*"` and a multi-recipient `external.ts send` set it on every copy; every other send clears it.
4. **One reader per envelope.** A reply-wait records its wait (target, send time) while it runs. The prompt hook and the watch skip envelopes a live wait owns, so a reply reaches its waiter.
5. **Watch liveness.** The watch records its pid. The prompt hook tells the session to start one when none is live, and a second watch refuses to start.

**Why a sender flag.** The receiver cannot tell a fan-out from a direct send: `*` writes one ordinary envelope per recipient, and Claude's fan-outs so far were one `send` per recipient. Matching identical text after the fact guesses at what the sender knew.

**Why broadcasts still reach Claude.** A broadcast is usually context every seat should have, not an ask. Delivered at the next prompt, it costs no turn.

**Why no idle timeout.** A watch that exits on a timer wakes an idle session on that timer, round the clock, which 013's ordinary-usage line rules out. Wakes stay bounded by mail.

**Rejected:**

- **Wake on everything.** A broadcast to four sessions starts four turns for context none of them asked for.
- **Opt-in `--wake` flag.** Direct mail is the common case and should not need a flag; a forgotten flag strands an ask until the owner next types.
- **A second, independent reader beside the reply-wait.** Either reader could claim the reply the other waits for; the waiter would then sit until its 40-minute check-in.
