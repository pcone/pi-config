---
title: "The ToS line for Claude Code peers is credentials and ordinary usage, not human-started turns"
type: decision
status: accepted
date: 2026-11-26
---

# The ToS line is credentials and ordinary usage

**Ruling (owner, 2026-11-26).** Scott: "from a bit more research it kinda sounds like our setup with pi workers being monitored by this claude session is totally fine? it seems like what claudes TOS is preventing is launching *claude* sessions automatically, and using other harnesses with a claude sub?" Claude agreed and proposed three changes: rewrite the design doc's ToS section around credentials and ordinary usage, allow a watcher that wakes the session on unsolicited pi mail, and retire the channel order. Scott: "yeah this sounds good to me".

**What holds now.** A Claude Code session may be woken by any documented Claude Code feature: background tasks, Monitor, `/loop`, scheduled wakeups, channels. The line is:

1. **No Claude outside Claude Code on the subscription.** No pi provider or other harness uses Claude OAuth. Nothing launches a Claude session automatically: no `claude -p` or SDK run from pi, cron or a daemon.
2. **No credential handling.** Nothing reads, stores or forwards Claude Code credentials, tokens or `~/.claude` state.
3. **Ordinary individual usage.** Wakes stay bounded by the owner's tasks and pi traffic, not round-the-clock loops.

**Why.** The Claude Code legal page bars intermediating Claude.ai credentials and routing requests through Pro or Max credentials, and limits OAuth to "ordinary use of Claude Code and other native Anthropic applications". Consumer Terms §3 item 7 bars automated access "except … where we otherwise explicitly permit it"; the features above are that permission. 003's rule that every turn be human-started is stricter than either text.

**Supersedes in part:** [003](003-claude-code-external-peer.md) (human-started turns only), [007](007-peer-link-channel.md) (channel as the one turn-starting path), [012](012-peer-reply-wait.md) (watcher on unsolicited mail rejected). WO-2026-063 (channel) is no longer needed: its only reason was to be a permitted wake path.

**Still rejected:** pi spawning `claude -p` or any headless Claude run; pi holding or forwarding Claude OAuth; a Stop hook that forces continuation, because it bypasses the session's own end of turn rather than using a wake feature.

**Recorder's reading.** The owner's words do not settle a headless `claude -p` the owner starts by hand. Nothing here needs it, so it is left unruled. The unsolicited-mail watcher is permitted, not ordered.
