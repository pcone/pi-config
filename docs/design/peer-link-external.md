---
title: "peer-link external peers (Claude Code)"
type: design
status: active
date: 2026-10-11
feature: peer-link
---

# peer-link external peers (Claude Code)

A Claude Code session can join the peer-link mailbox as an **external peer**. Before this, Claude could send to pi peers by hand-writing envelope JSON but could never receive replies.

Code: `extensions/peer-link/external.ts` (CLI, not a pi extension) and `extensions/peer-link/channel.ts` (MCP stdio server). Decisions: `decisions/external-tools/003-claude-code-external-peer.md`, `decisions/external-tools/007-peer-link-channel.md`.

## Flow

- **Channel** (`channel.ts`, spawned by Claude Code over stdio): watches the session's inbox and pushes the envelopes it has not pushed as one `notifications/claude/channel` event per scan, `renderMail` text plus `from` / `ids` / `expect_reply` attributes. A push starts the session's turn, which is the one path allowed to (`decisions/external-tools/007`); every path 003 rejected stays rejected. While it runs it owns delivery and the prompt hook stays silent.
- **SessionStart** (`hook session-start`): registers `_peers/claude-<session_id>.json` with `external: true`; prints the session's identity and send usage as context.
- **UserPromptSubmit** (`hook prompt`): refreshes the registration, then delivers pending envelopes as context on the user's prompt — unless a live channel holds the session, in which case it emits and acks nothing. Delivered envelopes are recorded inflight, not acked.
- **Stop** (`hook stop`): acks exactly the envelopes the completed turn carried (inflight set). Bookkeeping only — deletes files, starts no turn.
- **SessionEnd** (`hook session-end`): removes the registration. Un-acked mail stays in the inbox.
- **Send** (Claude's Bash tool): `external.ts send --from claude-<sid> [--reply] [--require-online] <to> <text | ->`. Same delivery gate as pi: unlisted targets fail loud. `external.ts list` lists peers.
- **pi side:** external peers are listed, never "online", and age out after 24 h without refresh (`EXTERNAL_TTL_MS`) instead of pi's 2 min sweep window. pi's sends and auto-replies to them queue as "queued — external peer, pushed by its channel server if one runs, else read on its user's next prompt"; `requireOnline` fails. pi never reads or injects into an external inbox.

One deliverer per session: `mailbox.mailDeliverer` names it — the channel while the pid it registered in the heartbeat is alive, otherwise the prompt hook. Two live paths would deliver every envelope twice. A channel server checks the claim before it registers, so a server starting while another one holds the session refuses to start; two starting at the same instant are not arbitrated, and both push (duplicates, never a loss) until one exits.

No side can check freshness: both writers refresh the heartbeat's `ts`, so a pid recycled by an unrelated process holds delivery for the rest of the session. Mail then stalls — it is not lost — and only SessionEnd, or a new channel server's write, clears the claim. A prompt does not: the hook inherits a live claim rather than dropping it.

Mail reaches Claude either as a channel event, which starts a turn, or inside a hook the user's prompt fired, which cannot. There is no third path.

The hook path is at-least-once: an aborted prompt (Escape, crash) acks nothing, so the next prompt re-emits the un-acked envelopes (duplicates over loss — the mailbox contract in `extensions/peer-link/mailbox.ts`). Before 2026-10-18 the prompt hook acked at emit and an aborted prompt lost its mail (reported by the external Claude peer after an Escape-re-send dropped five envelopes); the Stop hook is the consumption confirmation Claude Code "gives no later" — it just needed the prompt hook to stop acking early.

### Channel delivery is not ready to enable: no ack yet

Nothing acks an envelope the channel pushed. Mechanism 5 of `work-orders/WO-2026-063-peer-link-channel.md` waits on a probe of which hooks fire around a channel-started turn (a `UserPromptSubmit` that moves pushed envelopes to inflight, plus the existing Stop ack), so the server only pushes. A pushed envelope therefore stays in the inbox, and every channel restart re-pushes the whole un-acked backlog: a duplicate rather than a loss, but unbounded for a long session, since nothing ever removes a pushed envelope. Do not enable the channel until that wiring lands.

## Setup

Two independent deliveries. The hook block works today. The channel entry is **not ready to enable** (see the ack note above) and is text for the owner to apply once that lands.

Hooks — merge into `~/.claude/settings.json`:

```json
"hooks": {
  "SessionStart": [{ "hooks": [{ "type": "command", "command": "bun ~/Developer/pi-config/extensions/peer-link/external.ts hook session-start" }] }],
  "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "bun ~/Developer/pi-config/extensions/peer-link/external.ts hook prompt" }] }],
  "Stop": [{ "hooks": [{ "type": "command", "command": "bun ~/Developer/pi-config/extensions/peer-link/external.ts hook stop" }] }],
  "SessionEnd": [{ "hooks": [{ "type": "command", "command": "bun ~/Developer/pi-config/extensions/peer-link/external.ts hook session-end" }] }]
}
```

Without the Stop hook nothing acks: mail is re-emitted on every prompt (duplicates, no loss). Add it.

Channel — once the ack wiring lands, add to the `mcpServers` block of `~/.claude.json`:

```json
"peer-link": {
  "command": "bun",
  "args": ["/Users/scott/Developer/pi-config/extensions/peer-link/channel.ts"]
}
```

and launch the session with `--dangerously-load-development-channels server:peer-link`. A custom channel is off the research-preview allowlist, so that flag is the only way it loads, and it works only in an interactive session — `-p` and the Agent SDK ignore it. Leave the hook block installed: it registers and refreshes the peer, and hands delivery back to the prompt when the server exits.

The server resolves its identity from `CLAUDE_CODE_SESSION_ID`, which Claude Code passes to the subprocesses it spawns. Unverified for MCP servers (probe P1, `work-orders/WO-2026-063-peer-link-channel.md`): if the variable does not reach it, the server exits naming it, so `/mcp` shows the failure instead of delivery silently going nowhere.

## Terms of Service compliance

Sources, fetched 2026-10-11:

- Anthropic Consumer Terms, <https://www.anthropic.com/legal/consumer-terms>. §3 item 7: no accessing "the Services through automated or non-human means, whether through a bot, script, or otherwise," "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it." §2: "You may not share your Account login information, Anthropic API key, or Account credentials with anyone else." §3 closing: no "bypassing any of our systems or protective measures."
- Claude Code legal and compliance, <https://code.claude.com/docs/en/legal-and-compliance>. "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications." Developers "may not collect, store, or intermediate Claude.ai credentials or session tokens," and may not route "requests through Free, Pro, or Max plan credentials on behalf of their users." "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."

Neither document mentions loops. §3.7 is the operative clause.

**(a) Credentials.** The scripts read only `session_id` and `cwd` from hook stdin, and the channel reads `CLAUDE_CODE_SESSION_ID` and its own mailbox path. They never read Claude Code's auth store, OAuth tokens, `transcript_path`, or `~/.claude`. `external.ts`, `channel.ts` and `mailbox.ts` make no network calls and spawn no processes. Claude Code is unmodified and is the only client that talks to Anthropic. pi never holds Claude credentials, and Claude never receives pi's. The only shared state is files in `~/.pi/peer-mail/`. Nothing collects, stores, or forwards Claude credentials or session tokens, and nothing routes requests through a subscription.

**(b) Automated access (§3.7).** Owner 2026-11-02: the channel is the one path that may start a Claude turn with no human prompt (`decisions/external-tools/007`). Channels are Anthropic's own surface for reacting to events happening outside the terminal, and the reference page documents a local server pushing events into a session. That is the "where we otherwise explicitly permit it" §3.7 reserves; a subscription-backed `claude -p` is not.

Everything else keeps a human in the loop. `UserPromptSubmit` runs inside the turn the human started and only appends text to that prompt. Claude's `send` is a Bash call inside that same turn. Neither reaches Anthropic beyond the turns the human already paid for.

Residual reading: §3.7 says "non-human means," and a channel server is a local non-human process whose event starts a turn. We read the access as Anthropic's shipped feature, used inside the human's own interactive session, with the server making no request to Anthropic: Claude Code stays the only client that talks to Anthropic. The same reading already covers `CLAUDE.md`, `@`-imports and MCP servers.

Rejected designs, and why:

- **Watcher or Monitor that wakes Claude on new mail.** Starts turns with no Anthropic surface permitting it. The channel is that surface; a watcher is not.
- **`claude -p` (or any headless Claude invocation) to answer mail.** Non-human access to the Services, and subscription OAuth outside interactive Claude Code use.
- **Stop hook that forces continuation when mail is pending.** Starts a turn with no human prompt, through no channel. Same as the watcher.
- **`/loop` polling.** Official, but it spends a turn on every tick with no mail; a channel spends one only when mail arrives.
- **An agent-to-agent loop with no human in it.** Mail is not a trigger by itself: a channel push is, and anything that makes pi answer Claude so Claude starts another turn is a loop. Pi's sends land in an inbox a human's session must read.
- **pi holding or forwarding Claude OAuth to reach Claude.** Credential intermediation, which the Claude Code legal page prohibits.

**(c) Usage limits.** Each delivery batch costs one turn of subscription usage, and events that arrive mid-turn batch into the next one. Otherwise volume follows the human's prompt cadence, as before: one local file read and a few lines of context per prompt. This is ordinary individual use under the stated Pro/Max assumptions.

**Invariants for future changes:**

- Exactly one path starts a Claude turn with no human prompt: this channel. No watcher, no `claude -p`, no SDK query call, no continuing Stop hook. A Stop hook that only acks delivered mail is bookkeeping, not continuation.
- Never read, copy, or forward Claude Code credentials, OAuth tokens, transcripts, or `~/.claude` state.
- `channel.ts` declares no permission relay: peer mail is not an authenticated human, so a relayed approval would let any peer approve tool calls.
- `external.ts`, `channel.ts` and `mailbox.ts` stay free of network calls and child processes.
- Sending has one path, `external.ts send`. The channel declares no `tools`.
- One deliverer per session, named by `mailbox.mailDeliverer`; the prompt hook emits nothing while a channel delivers.
- The inbox is the transport, so only user-private mailboxes are usable: the channel refuses to start unless the inbox and `_peers` are owned by the user and mode 0700. A sender allowlist adds nothing, since `from` is self-asserted.
- Nothing reads an external inbox except `channel.ts` and the `UserPromptSubmit` hook; pi never reads or injects into one.

Not legal advice. Checked against the sources above on 2026-10-11. Re-check if Anthropic's terms change.
