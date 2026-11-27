---
title: "External tool evaluations"
type: decision-index
status: active
date: 2026-08-10
---

# External tool evaluations

Decision records for external/third-party tools we evaluated for integration
with this pi config. Each entry settles "should we adopt X?" so the question
isn't re-litigated every time the tool trends on HN.

| # | Decision | Status |
| --- | --- | --- |
| [001](001-rtk-rejected.md) | RTK (Rust Token Killer) — rejected, no expected savings | done |
| [002](002-ponytail.md) | Ponytail — ladder adopted into system prompt, tool not installed | deferred |
| [003](003-claude-code-external-peer.md) | Claude Code joins peer-link as an external peer; mail delivered only on the user's prompt | done |
| [007](007-peer-link-channel.md) | peer-link mail through an official Claude Code channel, which may start the session's turn | accepted |
| [005](005-owner-asks-statusline.md) | Owner asks on the pi status bar and Claude Code statusline, counted from the pushed registry; `/asks` lists new first and marks seen | done |
| [006](006-opencode-go-usage-footer.md) | OpenCode Go usage in the footer via the aggregate `/zen/go/v1/usage` endpoint; per-model burn stays client-side | done |
| [008](008-model-error-mail.md) | A model request's HTTP 4XX/5XX mails a peer, throttled; Kimi usage joins the footer | done |
| [009](009-baba-for-claude-code.md) | Claude Code reaches baba through a daemon-client CLI, and through an MCP server that replaced the skill (superseded in part) | accepted |
| [010](010-heavy-job-slots.md) | Heavy jobs take a machine-wide slot | accepted |
| [011](011-fable-sweep-footer-count.md) | The owner-asks footer counts landings a Fable review has not swept, read from tfd's `reviewed_through` marker at the upstream | accepted |
| [012](012-peer-reply-wait.md) | A Claude Code session may wait in the background for a pi peer's reply; the waiter's exit may wake it, with 40-minute progress check-ins | accepted |
| [013](013-tos-line-credentials-not-turns.md) | The ToS line for Claude Code peers is no Claude outside Claude Code, no credential handling, and ordinary usage; documented wake features may start turns | accepted |
| [014](014-unsolicited-mail-watch.md) | A Claude Code session watches its inbox in the background and wakes on direct mail; broadcasts, flagged by their sender, wait for the next prompt | accepted |
| [015](015-matrix-chat-for-peers.md) | Peers chat on a self-hosted Matrix server on its own VPS; a message from the owner's chat account is the owner speaking | accepted |
