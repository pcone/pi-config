---
title: "peer-link external peers (Claude Code)"
type: design
status: active
date: 2026-10-11
feature: peer-link
---

# peer-link external peers (Claude Code)

A Claude Code session can join the peer-link mailbox as an **external peer**. Before this, Claude could send to pi peers by hand-writing envelope JSON but could never receive replies.

Code: `extensions/peer-link/external.ts` (CLI, not a pi extension). Decisions: `decisions/external-tools/003-claude-code-external-peer.md`, `012-peer-reply-wait.md`, `013-tos-line-credentials-not-turns.md`.

## Flow

- **SessionStart** (`hook session-start`): registers `_peers/claude-<session_id>.json` with `external: true`; prints the session's identity and send usage as context.
- **UserPromptSubmit** (`hook prompt`): refreshes the registration, prints pending envelopes as context on the user's prompt, records them as inflight (no ack).
- **Stop** (`hook stop`): acks exactly the envelopes the completed turn carried (inflight set). Bookkeeping only — deletes files, starts no turn.
- **SessionEnd** (`hook session-end`): removes the registration. Un-acked mail stays in the inbox.

Delivery is at-least-once: an aborted prompt (Escape, crash) acks nothing, so the next prompt re-emits the un-acked envelopes from the inbox (duplicates over loss — the mailbox contract in `extensions/peer-link/mailbox.ts`). Before 2026-10-18 the prompt hook acked at emit and an aborted prompt lost its mail (reported by the external Claude peer after an Escape-re-send dropped five envelopes); the Stop hook is the consumption confirmation Claude Code "gives no later" — it just needed the prompt hook to stop acking early.
- **Send** (Claude's Bash tool): `external.ts send --from claude-<sid> [--reply] [--require-online] [--wait <minutes>] <to> <text | ->`. Same delivery gate as pi: unlisted targets fail loud. `external.ts list` lists peers.
- **Reply-wait** (`send --wait <minutes>`, run with Bash `run_in_background`): implies `--require-online`, so a wait on a peer that is not online fails before sending. After sending, it blocks until any envelope from the target sent after the send arrives (prints it, exit 0), the target is no longer online (exit 3), or the interval elapses with the target online (exit 4). Printed mail joins the inflight set, so the Stop hook acks it. On a check-in exit Claude asks the peer for a progress update with another `--wait`, sent without `--reply` so it lands as a steer at the peer's next tool-call boundary rather than after its turn. The interval is 40 minutes. A check-in waits 10 minutes; if it times out, Claude reads the tail of the peer's session log (`sessionFile` in its heartbeat, shown by `list` and the check-in exit). Recent entries, or one open tool call that plausibly runs long, mean busy, so Claude waits again without another check-in. A long silence with nothing that explains it means hung, so Claude tells the owner. One check-in stays outstanding per peer.
- **pi side:** external peers are listed, never "online", and age out after 24 h without refresh (`EXTERNAL_TTL_MS`) instead of pi's 2 min sweep window. pi's sends and auto-replies to them queue as "queued — external peer, read when its user next prompts"; `requireOnline` fails. pi never reads or injects into an external inbox.

Mail reaches Claude inside a hook that the user's prompt fired, or as the output of a reply-wait. A reply-wait's exit starts a Claude turn when none is running.

## Hook setup

Merge into the `hooks` block of `~/.claude/settings.json`:

```json
"hooks": {
  "SessionStart": [{ "hooks": [{ "type": "command", "command": "bun ~/Developer/pi-config/extensions/peer-link/external.ts hook session-start" }] }],
  "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "bun ~/Developer/pi-config/extensions/peer-link/external.ts hook prompt" }] }],
  "Stop": [{ "hooks": [{ "type": "command", "command": "bun ~/Developer/pi-config/extensions/peer-link/external.ts hook stop" }] }],
  "SessionEnd": [{ "hooks": [{ "type": "command", "command": "bun ~/Developer/pi-config/extensions/peer-link/external.ts hook session-end" }] }]
}
```

Without the Stop hook nothing acks: mail is re-emitted on every prompt (duplicates, no loss). Add it.

## Terms of Service compliance

Sources, fetched 2026-10-11:

- Anthropic Consumer Terms, <https://www.anthropic.com/legal/consumer-terms>. §3 item 7: no accessing "the Services through automated or non-human means, whether through a bot, script, or otherwise," "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it." §2: "You may not share your Account login information, Anthropic API key, or Account credentials with anyone else." §3 closing: no "bypassing any of our systems or protective measures."
- Claude Code legal and compliance, <https://code.claude.com/docs/en/legal-and-compliance>. "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications." Developers "may not collect, store, or intermediate Claude.ai credentials or session tokens," and may not route "requests through Free, Pro, or Max plan credentials on behalf of their users." "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."

The line has three parts (decision 013, owner 2026-11-26). Waking the session is not one of them.

**(a) Claude only through Claude Code.** No pi provider or other harness uses the Claude subscription. Nothing launches a Claude session automatically: no `claude -p` or SDK run from pi, cron or a daemon. Claude Code is unmodified and is the only client that talks to Anthropic.

**(b) No credential handling.** The scripts read only `session_id` and `cwd` from hook stdin. They never read Claude Code's auth store, OAuth tokens, `transcript_path`, or `~/.claude`, and make no network calls (`external.ts`, `mailbox.ts`). pi never holds Claude credentials, and Claude never receives pi's. The only shared state is files in `~/.pi/peer-mail/`.

**(c) Ordinary individual usage.** Wakes are bounded by the owner's tasks and pi traffic: one turn per delivered reply, peer exit or 40-minute check-in. Round-the-clock loops are out.

**Why waking is allowed.** §3.7 exempts access "where we otherwise explicitly permit it". Background tasks, Monitor, `/loop`, scheduled wakeups and channels are Claude Code features that start a turn without a typed prompt, documented for that use. A session woken by one is the permitted case. A watcher that wakes the session on unsolicited pi mail is permitted on the same grounds; none is built.

Rejected designs, and why:

- **pi spawning `claude -p` (or any headless Claude invocation) to answer mail.** Launches a Claude session automatically, outside interactive Claude Code use.
- **pi holding or forwarding Claude OAuth to reach Claude.** Credential intermediation, which the Claude Code legal page prohibits.
- **Stop hook that forces continuation when mail is pending.** It overrides the session's end of turn instead of using a wake feature. Wake the session with a background task or Monitor instead.

**Invariants for future changes:**

- Never launch Claude outside Claude Code, and never route a harness through the Claude subscription.
- Never read, copy, or forward Claude Code credentials, OAuth tokens, transcripts, or `~/.claude` state.
- Wake the session only through a documented Claude Code feature. A Stop hook only acks delivered mail.
- Keep `external.ts` free of network calls and child processes. A reply-wait polls in-process.
- Nothing reads an external inbox except the `UserPromptSubmit` hook and a reply-wait; pi never reads or injects into it.

Not legal advice. Sources checked 2026-10-11; reading revised 2026-11-26 (decision 013). Re-check if Anthropic's terms change.
