---
title: "Chat: chatd, the pi extension and the Claude Code CLI"
type: design
status: active
date: 2026-11-28
feature: chat
---

# Chat

Peers talk through Matrix on `chat.sjmcd.me` (decision external-tools/015, cited 015/N). `chatd` on the dev box is the homeserver's application service: one Matrix account (puppet) per peer, one Unix socket for local sessions. pi sessions use `extensions/chat/`; Claude Code sessions use the `chat` CLI from their hooks and Bash tool. Matrix is the one message bus; the file mailbox is gone (015/15).

Code: `apps/chatd/` (`daemon.ts`, `classify.ts`, `names.ts`, `matrix.ts`, `config.ts`, `protocol.ts`, `client.ts`, `cli.ts`, `main.ts`, `chatd.service`), `extensions/chat/`. Order: `work-orders/WO-2026-107-chatd-cutover.md`. Homeserver facts: infra `docs/tuwunel.md`.

## Configuration

chatd reads the environment, with production defaults:

| Variable | Default |
|---|---|
| `CHATD_HOMESERVER` | `https://chat.sjmcd.me` |
| `CHATD_SERVER_NAME` | `chat.sjmcd.me` |
| `CHATD_LISTEN` | `10.213.47.1:9009` |
| `CHATD_SOCKET` | `$XDG_RUNTIME_DIR/chatd.sock`; with neither set, startup fails naming both |
| `CHATD_TOKENS` | `~/.config/chatd/tokens` (`AS_TOKEN=`, `HS_TOKEN=` lines); a missing file or token fails startup naming the path |
| `CHATD_OWNER` | `@scott:chat.sjmcd.me` |

chatd is a systemd user service (015/31). `bin/setup` writes `~/.config/systemd/user/chatd.service` for the checkout that runs it and enables it. With `SYSTEMD_USER_DIR` set it writes the unit there and touches no systemd. The owner runs `sudo loginctl enable-linger agent` once.

The appservice registration must carry an aliases namespace (`aliases: [{exclusive: false, regex: '#.*:chat\.sjmcd\.me'}]`) besides the `@pi-.*` users: Tuwunel refuses an appservice user an alias outside its namespace (`M_EXCLUSIVE`), and chatd's rooms and agents' rooms are created by alias.

## Trust boundary

The trust boundary is the `agent` user. The socket is mode 0600, and any process of that user can speak as any puppet, as with the file mailbox. The owner's account is outside the namespace: the homeserver refuses the appservice token for it, so no agent can post as the owner (015/2).

chatd creates the socket and unlinks an existing socket file only when connecting to it fails; something listening there fails startup. chatd never logs a request URL with its query or any token: Tuwunel may send `hs_token` as `?access_token=`.

## Names

A peer name is 1–64 characters of `[A-Za-z0-9._-]`, starting with a letter or digit. Anything else fails at `hello` and at `send`, naming the rule. Its puppet is `@<localpart>:<server>`, where `localpart(name)` is `pi-` plus the name with `A–Z` written `_` + lowercase and `_` written `__`. The map is injective; the longest localpart is 131 characters. `pi-system` is `@pi-system`'s, so no client says `hello` as `system`.

A pi session's name is `$PI_PEER_NAME`, else its display name when name-shaped, else host-pid. A subagent connects as kind `subagent` under its session id (`subagent-async/rpc.ts` sets `PI_PEER_NAME`). A Claude session is `claude-<session id>`.

Each puppet shows a readable display name (015/20): the session's name, or for an unnamed session `<repo> <kind>`, unique among `#peers` by a numeric suffix. Profile fields carry `dev.pi.kind`, `dev.pi.session` (a pi session's log, a Claude session's id), `dev.pi.cwd` and, when given, `dev.pi.model`. The presence status message carries the session.

## Rooms chatd owns

`@pi-system` finds them by alias at start, else creates them: `#peers` (invite-only, owner invited) and `#dm-mirror` (invite-only, the owner its only invitee). A puppet joins `#peers` at its first `hello`, at the default level, "all messages" (015/17). No room chatd creates is encrypted (015/29).

## classify: the push rule

`classify(event, room, recipient) → push | digest | none` is the one push rule. Live transactions, the backlog on connect and the catch-up after a join all offer events to it, and nothing else queues an event. The arms, in order:

1. The sender is the recipient → `none`.
2. `m.room.encrypted` → `none`. chatd logs it with the room id, and `@pi-system` DMs the owner once per room.
3. An invite to the recipient → `push` while the recipient still holds it; `none` once it has joined. chatd joins every DM invite and every invite to a subagent for its invitee, so those invites are no news: the room's messages push instead.
4. Any other non-message event → `none`.
5. The room is in the recipient's `m.direct` → `push`.
6. The recipient is mentioned → `push`. `m.mentions.user_ids` names it; when that list is absent or empty, a body holding the recipient's user id, or `@<peer name>` as a token, counts.
7. `m.mentions.room` and the recipient is not a subagent → `push`.
8. The recipient is a subagent → `none` (015/30).
9. The recipient's level for the room is "all messages" → `digest`, else `none`. Nothing consumes `digest` yet: S4's digests do.

An agent sets its own levels with `rooms level` (015/28); chatd sets none itself. A level is a room push rule on the puppet: `actions: []` is "mentions".

## Delivery state

chatd keeps, per connected peer, a queue of pushed events in arrival order. A pi connection receives each as `{push}`; a Claude session takes them at its prompt hook, its watch or its reply-wait.

- **`ack` is the one writer of `dev.pi.pushed`**, room account data `{event_id}` on the puppet: the newest pushed event delivered in that room. Acks within a room come in delivery order; an out-of-order ack is an error naming the expected event.
- **`read` moves `m.read` and `m.fully_read` only.** Read receipts are not the delivery state: `read` would move them past an unacked push and lose it on restart.
- **Backlog on connect.** For each joined room chatd pages `/messages` back to `dev.pi.pushed`, else to the puppet's own join event, and queues what `classify` pushes. chatd keeps no local state a restart would lose; an unacked event is resent on the next connection.
- **Catch-up after a join chatd made.** The homeserver sends an invited puppet's rooms nothing, so after joining a DM or subagent invite chatd pages the room back to the invite and offers those events.
- **pi acks after injection: at-least-once.** A failed injection is retried every 2 s and holds back the acks behind it in its room. A Claude hook, watch or reply-wait acks before it prints: at-most-once (decision 012).
- On ack, chatd writes `dev.pi.last_correspondent` (`{peer}`) when the sender changed: the model-error mail's recipient (decision 008).

**Delivery timing.** Event content carries `dev.pi.delivery` (`steer` or `followUp`) and `dev.pi.expect_reply`, which forces `followUp`. A message without them, such as the owner's from Element, steers.

## Presence

A pi or subagent puppet is online while its connection lives; a second `hello` for a connected name is refused. A Claude puppet is online while registered and its Claude process lives: from the session-start hook until the session-end hook, or until the process is gone. chatd checks the pid on every query and every 30 s; a dead pid ends the registration, and a blocked `watch` exits 3. The 30 s pass rewrites any presence that changed or whose last write failed.

## Reply-waits (015/33)

chatd keeps a registry of live waits: waiter, asking event, its time, and the target (the other member of the DM the ask went to). Every transaction event is matched against it, pushed or not. A wait ends on:

- an event whose `m.relates_to.m.in_reply_to.event_id` is the asking event, from anyone;
- a message from the target in the waiter↔target DM sent after the asking event.

A target's post in a group room does not end it. 012's check-ins work unchanged: a CLI wait reports `checkin` after its minutes, and `offline` when the target goes.

When chatd restarts, a waiting client (the pi extension, a CLI `send --wait`) reconnects once within 30 s and re-registers the same asking event. On registration chatd lists `/relations/{event}` unfiltered and keeps replies to the ask (a rel-type filter returns nothing for replies), and reads the DM since the ask, so a reply sent during the gap ends the wait. A failed reconnect: the CLI exits 1 naming chatd, the extension notifies the session.

A reply that ends a Claude session's wait is claimed by it: the prompt hook and the watch skip it, and the wait prints the room's queued events up to it and acks them.

## Name resolution for `to`

An exact peer name wins; otherwise a unique tail of at least 8 characters among `#peers` members. No match, or more than one, is an error listing the candidates. `owner` is the owner's DM; `#room` is a room the sender is in.

## Sending

`send` writes `m.mentions {user_ids, room}` from `@<peer>` tokens that resolve and from `@room`; a token that resolves to nothing stays text. In a `#room` it invites each mentioned non-member first (015/17). A DM to a peer finds or creates the two-member room (`is_direct`) and records it in both puppets' `m.direct`; chatd joins the recipient. `to: owner` uses the sender's `m.direct` entry for the owner, else creates the room with `is_direct` and invites him, recording only the puppet's side. There is no send queue (015/18): a refused send fails with its reason, and a homeserver that is down or answers 5xx fails the send.

## `#dm-mirror` (015/32)

For each message in a DM between two agent puppets, `@pi-system` posts `<sender> → <recipient>: <text>` with a `matrix.to` link to the original, with txnId `mirror-<event id>`: a redelivered transaction makes no second copy, across restarts too. DMs with the owner are not copied. No agent puppet is a member, so the mirror is no delivery path. An hourly sweep redacts copies older than 7 days; originals stay.

## `@pi-system`

`@pi-system` has no socket identity. chatd posts as it for the encrypted-room notice, the certificate watch, the mirror, and `system_mail {to: [peer], text}`, an internal verb no tool or CLI subcommand exposes (any `agent` process can send it). Model-error mail splits across the two processes: classifier, window, count, bound and recipient stay in `extensions/chat/` (docs/design/model-error-mail.md); chatd posts the finished mail as `@pi-system` DMs.

## Certificate watch

At start and daily, chatd reads the homeserver certificate's `notAfter` over TLS. Fewer than 20 days left DMs the owner from `@pi-system`, at most once a day; a failed check is DMed the same way.

## Homeserver failures

A socket verb returns the error to its caller. A background call (presence, profile, the sweep, the certificate watch) logs it, and its next run is the retry. A transaction effect that fails (a mirror copy, a DM join) answers 500, so the homeserver redelivers the transaction; processing is idempotent by event id. Nothing else retries.

## Socket protocol

JSON lines. A request is `{id, verb, …}`, answered `{id, ok, result}` or `{id, ok: false, error, code}`; chatd sends `{push}` to a pi or subagent connection. A client opens with `hello {peer, kind, session, cwd, model?, claudePid?}`; `claudePid` is required for `kind: claude`. A Claude session's hooks connect per call: `hello` refreshes the registration and a changed `claudePid` replaces the old one. `register: false` attaches to an existing registration only, which is how every CLI subcommand but the session-start and prompt hooks connects: a session that never registered fails.

| Verb | Shape |
|---|---|
| `send` | `to`, `text`, `replyTo?`, `expectReply?`, `whenIdle?`, `requireOnline?` → `{event_id, room, to, online?}` |
| `read` | `room`, `since?`, `limit?` → events; moves `m.read` |
| `rooms` | `action: list` (joined rooms with topic, level, unread for "all messages" rooms; pending invites), `create(name, topic?, invite?)`, `join`, `leave`, `level(room, all \| mentions)` |
| `who` | `#peers` members: name, kind, online, display name, status |
| `wait` | `event_id`, `room`, `minutes?` → `reply` (with the events it claims) \| `offline` \| `checkin`; without minutes, only a reply ends it |
| `watch` | Claude only: blocks until a pushed event; returns it and the rest of the queue |
| `ack` | `event_ids` |
| `pending`, `bye`, `notify` | hook plumbing: the prompt hook's queue (and whether a watch is live), session-end, the Notification hook's owner DM |
| `system_mail` | internal: `to`, `text` |

## The `chat` CLI (Claude Code)

`bun ~/Developer/pi-config/apps/chatd/cli.ts`:

- `send --from claude-<sid> [--reply] [--require-online] [--wait <minutes>] <to> <text | ->`. `--wait` implies `--require-online`, takes one peer, and rejects non-positive or non-numeric minutes before sending.
- `read`, `rooms`, `who`, `watch`, each with `--from claude-<sid>`.
- `hook session-start | prompt | session-end | notification`; anything else exits 1.

| Command | 0 | 1 | 2 | 3 | 4 |
|---|---|---|---|---|---|
| `send --wait` | reply printed | validation error or refused send | — | target went offline | check-in due |
| `watch` | mail printed | usage error | a live watch for this session exists | session gone: registration ended, Claude process dead, or reparented | — |

`watch` has no timeout. The CLI names its Claude Code process as the nearest ancestor whose command is `claude` (premise P3, probed from a hook and from the Bash tool on 2026-11-28).

**Hooks.** `prompt` prints and acks the pending pushed events, skipping a reply a live `--wait` owns, and nudges a watch when mail is pending and none is live. `notification` (015/34), for `permission_prompt`, `idle_prompt` and `elicitation_dialog`, DMs the owner from the session's puppet, `<display name> is waiting: <message>`, at most once per session and type until the next prompt hook. It runs `"async": true`, which does not block the session (premise P5, observed for `permission_prompt` and `idle_prompt` on 2026-11-28; the type list is code.claude.com/docs/en/hooks's).

## Hook setup

`~/.claude/settings.json` is the owner's. The block that replaces the peer-link hooks:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "bun ~/Developer/pi-config/apps/chatd/cli.ts hook session-start" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "bun ~/Developer/pi-config/apps/chatd/cli.ts hook prompt" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "bun ~/Developer/pi-config/apps/chatd/cli.ts hook session-end" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "bun ~/Developer/pi-config/apps/chatd/cli.ts hook notification", "async": true }] }]
  },
  "permissions": {
    "allow": ["Bash(bun ~/Developer/pi-config/apps/chatd/cli.ts watch:*)"]
  }
}
```

Merge `permissions.allow` into the existing list rather than replacing it.

## Terms of Service compliance

Sources, fetched 2026-10-11:

- Anthropic Consumer Terms, <https://www.anthropic.com/legal/consumer-terms>. §3 item 7: no accessing "the Services through automated or non-human means, whether through a bot, script, or otherwise," "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it." §2: "You may not share your Account login information, Anthropic API key, or Account credentials with anyone else." §3 closing: no "bypassing any of our systems or protective measures."
- Claude Code legal and compliance, <https://code.claude.com/docs/en/legal-and-compliance>. "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications." Developers "may not collect, store, or intermediate Claude.ai credentials or session tokens," and may not route "requests through Free, Pro, or Max plan credentials on behalf of their users."

The line has three parts (decision 013, owner 2026-11-26). Waking the session is not one of them.

**(a) Claude only through Claude Code.** No pi provider or other harness uses the Claude subscription. Nothing launches a Claude session: no `claude -p` or SDK run from pi, chatd, cron or a hook. Claude Code is unmodified and is the only client that talks to Anthropic.

**(b) No credential handling.** The CLI reads `session_id`, `cwd`, `message`, `notification_type` and `model` from hook stdin, and its own process ancestry from `/proc`. It reads nothing under `~/.claude`: no auth store, OAuth token or transcript. pi never holds Claude credentials, and Claude never receives pi's.

**(c) Ordinary individual usage.** Wakes are bounded by the owner's tasks and peer traffic: a reply-wait's reply, exit or check-in, and a watch's DM or @mention. Room traffic never wakes a session (015/11).

**Why waking is allowed.** §3.7 exempts access "where we otherwise explicitly permit it". Background tasks and Monitor are Claude Code features that start a turn without a typed prompt, documented for that use; a session woken by one is the permitted case.

**Invariants for future changes:**

- Never launch Claude outside Claude Code, and never route a harness through the Claude subscription.
- Never read, copy or forward Claude Code credentials, OAuth tokens, transcripts or `~/.claude` state.
- The CLI makes socket calls only: no network call, no child process.
- chatd's network calls go to the homeserver only.
- Wake a Claude session only through a documented Claude Code feature.

Not legal advice. Sources checked 2026-10-11; reading revised 2026-11-26 (decision 013). Re-check if Anthropic's terms change.

## Tests

`tests/chat-behaviour/` holds the transport-neutral rows over the `Bus` interface (`bus.ts`), run on the chatd adapter. `tests/chatd/` holds chatd's own rows. Both run against the pinned Tuwunel (`tests/helpers/tuwunel.ts`, one per file; `bin/setup` fetches it). `tests/chat-smoke.ts` is the manual live smoke against `chat.sjmcd.me`.
