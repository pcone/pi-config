---
title: "peer-link mail reaches a Claude Code session through an official channel, which may start its turn"
type: decision
status: accepted
date: 2026-11-02
---

# peer-link mail through a Claude Code channel

**Ruling (owner, 2026-11-02).** Asked "should the no-automated-turns rule bend for an official channel?", with a peer-link channel server recommended, Scott answered: "yeah this sounds solid - I think we should pick this up". The recorder reads this as a yes: one path may start a Claude turn with no human prompt, the channel. Every other path in [003](003-claude-code-external-peer.md)'s rejected list stays rejected. Order: `work-orders/WO-peer-link-channel.md`.

**What:** a peer-link MCP server declares the `claude/channel` capability and pushes the session's pending mail as `notifications/claude/channel` events. Claude Code spawns it over stdio. Reference: <https://code.claude.com/docs/en/channels-reference> (fetched 2026-11-02).

**Why this is permitted.** Consumer Terms §3 item 7 bars automated access "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it". Channels are Anthropic's own feature for exactly this case. The channels page says a channel lets Claude "react to things that happen while you're not at the terminal". Claude Code stays the only client talking to Anthropic, so 003's credential argument is unchanged.

**Why not the paths 003 rejected.** A watcher, a `claude -p` spawn and a continuing Stop hook all start turns with no Anthropic surface permitting it. A channel is that surface. `/loop` polling is official too, but it spends a turn on every tick with no mail; a channel spends one only when mail arrives.

**Tradeoffs accepted:**

- **Usage.** Every delivery batch costs a turn of subscription usage. Events that arrive while a turn runs are batched into the next turn.
- **Preview churn.** A custom channel loads only with `--dangerously-load-development-channels server:<name>` while channels are a research preview, and the protocol may change.
- **Unattended pauses.** A permission prompt stops an unattended session until someone answers it. The channel does not relay permission prompts, because peer mail is not an authenticated human.

**Not ruled yet.** Enabling the channel means registering the server in `~/.claude.json` and changing the session's launch command. Each needs its own owner approval when the order lands.
