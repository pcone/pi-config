---
title: "A Claude Code session may wait in the background for a pi peer's reply, and the waiter's exit may wake it"
type: decision
status: accepted
date: 2026-11-26
---

# Background reply-waits for a Claude Code peer

> **Superseded in part (owner 2026-11-27, [015](015-matrix-chat-for-peers.md) rule 15).** Matrix replaces the peer-link file mailbox, removed rather than bridged. The behaviour this ruling set that carries over, and what replaced the rest, is in `docs/design/chat.md`.
>
> **Superseded in part (owner 2026-11-26, [013](013-tos-line-credentials-not-turns.md)).** A watcher on unsolicited mail is permitted, not rejected. The reply-wait mechanism stands.

**Ruling (owner, 2026-11-26).** Claude proposed that a background waiter for a reply to Claude's own send may outlive the turn and wake the session, against 003's rule that nothing starts a Claude turn. Scott: "this sounds good to me". On the wait's length he asked whether to "just ask for an update from the pi orchestrators before interval expiry", then: "interrupting the pi orchestrator with a message is fine if it's infrequent - if we're just asking for an update on progress after 30-45 mins to sanity check that it's not churning I don't think that's an issue".

**What:** `external.ts send --wait <minutes>` sends, then blocks until the first of:

1. **Reply.** Any envelope from the target sent after the send. It prints the mail and exits 0. Any envelope from the peer counts as the answer, the rule pi's own waits use (checkpoint/003, ruling 3).
2. **Peer gone.** The target is no longer listed as online (no heartbeat for `ONLINE_MS`).
3. **Check-in due.** The interval elapses while the peer is still online.

The session runs it with Bash `run_in_background` and keeps working. Its exit notifies the session, which starts a turn if none is running. On a check-in, Claude asks the peer for a progress update with another `--wait`, and tells the owner if the updates show churn. The check-in interval is 40 minutes.

**Check-in latency (owner, 2026-11-26).** Scott: "keep in mind it can sometimes take a while for a steer to get to the pi session if it's in the middle of a turn itself - I think they wait until the current turn is done". In the code, a `--reply` send is delivered as `followUp`, after the pi session's in-flight work; a plain send is a steer, delivered at its next tool-call boundary (`deliveryModeFor`, `extensions/peer-link/mailbox.ts`). So:

- Send a check-in without `--reply`, asking the orchestrator to answer by `peer_send`. Any envelope from it ends the wait, so the answer needs no `inReplyTo`.
- Keep one check-in outstanding per peer, and judge churn from an answered update.

**Unanswered check-in (owner, 2026-11-26).** Scott: "if the checkin doesn't get a response in ~10 minutes, the claude session should just tail the pi sessions session log - it's on disk and should make it clear if the session is hung or just busy". So a check-in is sent with `--wait 10`. If that wait times out, Claude reads the last few entries of the peer's session log, the `sessionFile` in its heartbeat. Recent entries, or one open tool call that plausibly runs long (a build, a test suite, a subagent wait), mean busy: wait again without another check-in. A long silence with nothing that explains it means hung: tell the owner.

**Why this is permitted.** Consumer Terms §3 item 7 allows automated access "where we otherwise explicitly permit it". Background tasks that re-invoke the session on exit are a documented Claude Code feature, used as designed. Claude Code stays the only client talking to Anthropic, so 003's credential argument is unchanged. Each wake answers a send Claude made for the owner's task, so usage stays ordinary individual use.

**Why not a fixed timeout.** Any fixed value guesses at worker length. The heartbeat already says whether the peer is alive, and the check-in says whether it is making progress.

**Still rejected** (003, 007): a watcher that wakes the session on unsolicited mail, any headless `claude -p` run, a Stop hook that continues the turn, and pi reading or holding Claude credentials. An open pi↔Claude exchange with no owner task behind it stays rejected too.

**Recorder's reading.** Claude proposed a 4-hour hard cap before the check-in ruling. The ruling replaced it: the owner's limit is check-in frequency, so no fixed cap is recorded.

**Tradeoffs accepted:**

- **Wake turns.** Each reply, peer exit or check-in costs one turn of subscription usage.
- **Delivery.** One read per envelope; see § Single read.

**Single read (owner, 2026-11-26).** The first landing (f19d0f4) left mail readable until a Stop hook acked it, so one reply reached a tester three ways: the waiter, the next prompt hook, and a mid-turn prompt hook. Scott: "I think keeping the receive on user prompt would be wise - we just need to make reading messages atomic once it's read into the session through one means, it shouldn't be read via any other paths". Asked what an Escape-interrupted prompt should do with mail it claimed (Claude Code runs no Stop hook on interrupt), he chose "Accept the loss".

So each reader, the prompt hook or a waiter, claims an envelope by deleting its inbox file before showing it. `unlink` is atomic: one reader wins, the other drops the envelope. Delivery to a Claude session is at-most-once. The inflight set and the Stop-hook ack are gone. This reverses 003's at-least-once delivery and the 2026-10-18 fix for mail lost on Escape: re-showing unacked mail is what produced the duplicates.

