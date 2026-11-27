# WO-2026-107 — chatd and the cutover from peer-link to Matrix

> **Lane**: pi-config. New `apps/chatd/` and `extensions/chat/`; peer-link removed in the same landing. Stage S3 of [WO-matrix-bridge](WO-matrix-bridge.md), with S5's docs.

### Metadata

- **work_order_id**: WO-2026-107
- **parent_plan_id**: [WO-matrix-bridge](WO-matrix-bridge.md) S3 and S5; [decision external-tools/015](../decisions/external-tools/015-matrix-chat-for-peers.md)
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit. The push rule has one producer (`classify`). The pushed-delivery state has one writer (`ack`). Every delivery path goes through both.
- **priority**: high
- **estimated_complexity**: large; one landing in the commits listed under § Commit sequence
- **review_policy**: required
- **revision**: 2, after plan review 2026-11-28 (REJECT_AND_REWORK: H1–H8, M1–M11, L1–L7, each answered below)

### Task Summary

Peers talk through Matrix on `chat.sjmcd.me` instead of the file mailbox. `chatd`, a daemon on the dev box, is the homeserver's application service. It runs one Matrix account (puppet) per peer and serves local sessions over a Unix socket.
- pi sessions use `extensions/chat/`.
- Claude Code sessions use the `chat` CLI from their hooks and Bash tool.

peer-link is deleted in the same landing, with no period where both run (015/15).

S4 owns digests, check points and room archiving. This order delivers pushed events only; anything else stays unread on the server until S4.

### Rulings

[Decision external-tools/015](../decisions/external-tools/015-matrix-chat-for-peers.md), cited as 015/N; forward design in [WO-matrix-bridge § Target design](WO-matrix-bridge.md#target-design).

| Rule | What it fixes here |
|---|---|
| 015/2 | A message from `@scott:chat.sjmcd.me` is the owner speaking. No agent can post as that account. |
| 015/7, 015/30 | Accounts: Claude Code sessions, named pi sessions, subagents. A subagent receives only DMs and @mentions of it. |
| 015/11, 013 | An idle session is not woken for room traffic; @mentions and DMs push (015/5). Nothing launches a Claude session. |
| 015/15 | Matrix replaces the mailbox; no bridge, no parallel period. |
| 015/17, 015/28 | Watching = membership + notification level. Agents set their own levels; chatd never sets one. `send` invites a non-member it @mentions. |
| 015/18 | No send queue: `send` fails with the reason when the server or link is down. |
| 015/20 | Readable display names; ids in status and profile fields. |
| 015/29 | Agent rooms are unencrypted. |
| 015/31 | chatd is a systemd user service; the owner enables lingering. |
| 015/32 | Agent-to-agent DMs are copied to `#dm-mirror` (owner and `@pi-system` only); copies are redacted after 7 days. |
| 015/33 | A reply-wait ends on a reply to the asking event from anyone, or on a DM from the target to the waiter sent after it. 012's check-ins are unchanged. |
| 015/34 | A Notification hook DMs the owner when a Claude session waits on a prompt or for input. A session whose latest owner message came through chat asks its questions in chat. |
| WO-matrix-bridge S3 (owner 2026-11-28) | Certificate watch: a daily check that `chat.sjmcd.me`'s certificate has at least 20 days left, else a DM from `@pi-system` to the owner. |

### Premises

Confirmed (infra `docs/tuwunel.md` § Local test server, 2026-11-28):
- The release binary runs locally.
- Puppet-sent events and third-party replies are delivered back to the appservice.
- A repeated txnId from the same puppet returns the same event.
- `/relations/{event_id}` lists replies.

Verify these before relying on them; on a false one, stop with `PREMISE FALSIFIED`:

- **P3.** A Claude Code hook can name its Claude Code process: the nearest ancestor whose command is `claude`. Probe the ancestry from a hook.
- **P4.** Element X writes `m.mentions.user_ids` when the owner @mentions an agent. Record it in the live smoke. The body fallback in `classify` covers clients that do not.
- **P5.** The `Notification` hook's stdin carries `session_id`, `message` and `notification_type`, and the types for "waiting" are `permission_prompt`, `idle_prompt` and `elicitation_dialog` (code.claude.com/docs/en/hooks). Confirm with a logging hook in a scratch project. A hook marked `"async": true` does not block the session.

### Preparatory refactor

Port peer-link's behaviour rows to transport-neutral tests **before** chatd exists, and prove them against peer-link (parallel change):

1. `tests/chat-behaviour/` holds the rows, written against a `Bus` test interface: `connect(peer, kind)`, `send(...)`, `pushed(peer)`, `wait(...)`, `watch(...)`, `presence(peer)`, `restart()`.
2. `tests/chat-behaviour/adapters/peer-link.ts` implements `Bus` over today's mailbox. At the refactor commit every ported row passes against it, and the old suites pass unchanged.
3. The chatd adapter runs the same rows unchanged. The exceptions are the rows the design changes (table below), each rewritten in its own commit citing the rule.

The row inventory is `~/Developer/notes/stage3/peer-link-rows.md`: 128 blocks, classed NEUTRAL, MIXED or FILE. Port every NEUTRAL row, and the neutral half of every MIXED row.

Rows the design changes:

| Today | Target |
|---|---|
| A reply-wait ends on any envelope from the target (`checkpoint-waits` 617, 663; external 238, 254) | 015/33: a reply to the asking event, from anyone (keep 689's relayed case), or a DM from the target to the waiter sent after it. A target's post in a group room does not end it. |
| Broadcast: `to: "*"`, comma lists, broadcast `requireOnline` filters, the broadcast flag (peer-link 451–533; external 375–444, 680) | Gone, with no successor row except "`@room` pushes to every non-subagent member". |
| External peers are listed but never online, 24 h TTL (external 72, 84) | A Claude session is online from its session-start hook until its session-end hook or until its Claude process exits. |
| Model-error mail with no correspondent goes to online peers (model-error-mail 371, 598, 723) | DMs from `@pi-system` to each online non-subagent peer. |
| `hook stop` fails as an unknown event (external 167) | `chat hook stop` exits 1 as an unknown subcommand. |

Delivery semantics stay as they are, per side. pi acks after injection (at-least-once). A Claude hook or watch acks what it prints (at-most-once).

FILE rows are retired, each replaced:

| Retired | Replaced by |
|---|---|
| Heartbeat freshness, stale sweep, freshest-heartbeat tie-break | Presence (§ 1); tail resolution (§ 2) |
| External registration TTL and refresh cadence | Registration ends at session-end or when the Claude process is gone |
| Corrupt or temp envelope files, inbox layout, long-name dirs | Matrix events; name mapping rows |
| Wait and watch records with pid liveness | chatd's in-memory registry of live socket connections |
| Persisted correspondent record | Room-independent account data `dev.pi.last_correspondent` on the session's puppet. Model-error mail needs it (008); WO-matrix-bridge's sentence removing it referred to reply-waits and is corrected. |
| Timers after a failed init or a removed mailbox | Init-failure rows against the socket connection |

### Commit sequence (one landing, reviewed as a whole)

1. Preparatory refactor: `tests/chat-behaviour/` and the peer-link adapter. Old suites unchanged.
2. `tests/helpers/tuwunel.ts`, and the binary fetch in `bin/setup`.
3. `apps/chatd/` core: appservice endpoint, puppets, `classify`, delivery and ack, presence, socket, `@pi-system`, `#peers`, `#dm-mirror`, certificate watch, systemd unit. New rows 1–5, 7–12, 14–20.
4. `chat` CLI and hooks, including `hook notification`. Rows 6, 13, 21, 22, and the external rows against the chatd adapter.
5. `extensions/chat/`: tools, injection, auto-reply, WaitSource, model-error mail. The pi rows against the chatd adapter.
6. Design-changed rows, one commit per table row above.
7. Cutover: consumers moved, peer-link and its tests deleted.
8. Docs (S5).

### Change

#### 1. `apps/chatd/` (Bun, TypeScript, plain `fetch`, no Matrix SDK)

**Config.** Read from the environment, with production defaults:
- `CHATD_HOMESERVER` (`https://chat.sjmcd.me`);
- `CHATD_SERVER_NAME` (`chat.sjmcd.me`);
- `CHATD_LISTEN` (`10.213.47.1:9009`);
- `CHATD_SOCKET` (default `$XDG_RUNTIME_DIR/chatd.sock`; with `XDG_RUNTIME_DIR` unset and no `CHATD_SOCKET`, startup fails naming both);
- `CHATD_TOKENS` (`~/.config/chatd/tokens`; a missing file, or one without `AS_TOKEN` or `HS_TOKEN`, fails startup naming the path);
- `CHATD_OWNER` (`@scott:chat.sjmcd.me`).

**Socket.** chatd creates the socket with mode 0600. It unlinks an existing socket file only when connecting to it fails. If something listens there, startup fails: another chatd runs.

The trust boundary is the `agent` user. Any process of that user can speak as any puppet, as with the file mailbox. The owner's account is outside it.

**Appservice endpoint.** `PUT /_matrix/app/v1/transactions/{txnId}`.
- It checks `hs_token` from `Authorization: Bearer`, else `?access_token=`, with a constant-time compare. Anything else answers 403 and processes nothing.
- Processing is idempotent by event id.
- It answers `{}` once every event is classified and its effects are done. If an effect's homeserver call fails (a mirror copy, a DM-invite join), it answers 500, so the homeserver redelivers the transaction.
- **Never log a request URL with its query, or any token.** Tuwunel sends `hs_token` in the query.

**Peer names and localparts.**
- A peer name is 1–64 characters of `[A-Za-z0-9._-]`, the rule in `mailbox.ts:74`, ported. Anything else fails at `hello` and at `send` with the rule.
- `localpart(name)` is `pi-` followed by the name encoded per character:
  - `a–z 0–9 . -` stay as they are;
  - `A–Z` becomes `_` + lowercase;
  - `_` becomes `__`.
- `peerName(localpart)` decodes it. The pair is injective, and the longest localpart is 131 characters.

**Puppets.**
- On first use chatd registers the puppet (`m.login.application_service`).
- It sets:
  - the display name: the session's name, or for an unnamed one a name derived from repo and role, made unique among `#peers` members by a numeric suffix;
  - the profile fields `dev.pi.kind` (`pi`, `claude`, `subagent` or `system`), `dev.pi.session` and `dev.pi.cwd`, and `dev.pi.model` only when the client supplies it;
  - a presence status message carrying the session id.
- The puppet then joins `#peers` at the default level, which 015/17 makes "all messages". The agent may change it (015/28).

**Rooms chatd owns.** `@pi-system` (localpart `pi-system`, kind `system`) creates them on chatd's first start, finding them by alias first:
- `#peers:chat.sjmcd.me`, invite-only, with the owner invited;
- `#dm-mirror:chat.sjmcd.me`, invite-only, with the owner the only invitee;
- the DM room `@pi-system`↔owner, created on first need and recorded in `m.direct`.

No room chatd creates sets `m.room.encryption` (015/29).

**`classify(event, room, recipient) → push | digest | none`.** This is the one push rule; every delivery path calls it. The arms are tried in order:
1. The sender is the recipient → `none`.
2. The type is `m.room.encrypted` → `none`, logged with the room id.
3. The room is in the recipient's `m.direct` → `push`. DM-ness comes from `m.direct`, not member count.
4. The recipient is mentioned → `push`. "Mentioned" means `m.mentions.user_ids` names them. When `m.mentions.user_ids` is absent or empty, a body containing the recipient's user id or `@<peer name>` as a token counts instead.
5. `m.mentions.room` is true and the recipient is not a subagent → `push`.
6. The recipient is a subagent → `none`.
7. The recipient's level for the room is "all messages" → `digest`. Otherwise → `none`. S3 has no consumer for `digest`: the event stays unread.

An invite to the recipient → `push`. chatd joins every DM invite (`is_direct`) for its invitee, and every invite to a subagent. Joining sets membership, not a level. Other puppets join rooms themselves (`rooms join`).

**Delivery and ack.**
- chatd keeps a queue of pushed events for each connected peer, in arrival order per room. It sends them to the connection, and the client acks event ids.
- Acks within a room must come in delivery order. An out-of-order ack is an error naming the expected event.
- On ack, chatd writes room account data `dev.pi.pushed = {event_id}` for that puppet. This marker is the pushed-delivery state; `ack` is its only writer. `read` moves `m.read` and `m.fully_read`, and never touches `dev.pi.pushed`.
- An unacked event is resent on the next connection.

**Backlog on connect.** For each joined room, chatd pages `/messages` back to the room's `dev.pi.pushed`. A room without the marker is paged back to the puppet's own join event in it. chatd queues every event in that range that `classify` pushes. chatd keeps no local state a restart would lose.

**Delivery timing.** Event content carries:
- `dev.pi.delivery`: `steer` or `followUp`;
- `dev.pi.expect_reply`: a bool. It forces `followUp`.

A message without the fields, such as the owner's from Element, is `steer`. This ports `deliveryModeFor`.

**Presence.** chatd sets each puppet's Matrix presence:
- pi and subagent puppets are online while connected.
- A Claude puppet is online while registered and its Claude pid lives. chatd checks the pid on every query and every 30 s. A pid found dead ends the registration: presence goes offline, and a blocked `watch` for that peer exits 3.

**Waits.**
- chatd keeps a registry of live waits: waiter, target, asking event and its timestamp.
- Every transaction event is matched against it, push or not. chatd sees every event in rooms where any puppet is joined (P1, confirmed).
- A wait ends on either:
  - an event whose `m.relates_to.m.in_reply_to.event_id` is the asking event, from anyone;
  - an event from the target in the waiter↔target DM room, sent after the asking event (015/33).
- A wait whose client reconnects after a chatd restart re-registers. chatd then checks `/relations/{event}` and the DM room since the asking event, so a reply sent during the gap still ends it.

**Name resolution for `to`.**
- An exact peer name wins.
- Otherwise it must be a unique tail match among `#peers` members, as today's UUID-tail resolution.
- No match, or more than one, is an error listing the candidates.

**`#dm-mirror`** (015/32).
- For each DM event whose sender and recipient are both agent puppets, chatd posts a copy as `@pi-system`: `<sender> → <recipient>: <text>`, with a `matrix.to` link to the original.
- The copy's txnId is `mirror-<original event id>`, so a redelivered transaction makes no second copy. Tuwunel dedupes per puppet txnId, as the probe confirmed.
- DMs with the owner are not mirrored.
- An hourly sweep redacts copies older than 7 days. Its clock is injected for tests.
- Nothing in `#dm-mirror` is a delivery path: no agent puppet is a member.

**`@pi-system`.**
- It is chatd-internal. Model-error mail and the certificate watch call it in-process; it has no socket identity.
- Model-error rules port unchanged: classifier, 30 min window, count, 200-char bound, no prompt text, never self. The recipient is `dev.pi.last_correspondent`, else online non-subagent peers.

**Certificate watch.** Once a day, and at start, chatd opens a TLS connection to the homeserver and reads the certificate's `notAfter`. With fewer than 20 days left, `@pi-system` DMs the owner, at most once a day. A failed check is itself DMed.

**Homeserver call failures.**
- A socket verb returns the error to its caller (015/18).
- A background call (presence, profile, redaction sweep, certificate watch) logs it, and its next scheduled run is the retry.
- A transaction effect answers 500 so the homeserver retries.
- Nothing else retries.

**systemd.** `apps/chatd/chatd.service` is a user unit with `Restart=on-failure`. `bin/setup` installs it into `~/.config/systemd/user/` and enables it.

#### 2. Socket protocol

JSON lines. A client opens with `hello {peer, kind, session, cwd, model?, claudePid?}`. `claudePid` is required for `kind: claude`, and its absence is an error.
- A second `hello` for a pi or subagent peer that is already connected is refused, naming the live connection.
- Claude hooks connect per call. `hello` for a Claude peer refreshes its registration, and a changed `claudePid` replaces the old one.

Verbs, from [WO-matrix-bridge § Agent-facing API](WO-matrix-bridge.md#target-design):

| Verb | Shape |
|---|---|
| `send` | `to` (peer name, `owner`, or `#room`), `text`, `replyTo?`, `expectReply?`, `whenIdle?`, `requireOnline?` → `{event_id, room}` |
| `read` | `room`, `since?`, `limit?` → events; moves `m.read` |
| `rooms` | list: joined rooms with topic, level, and unread count for "all messages" rooms; pending invites. `create(name, topic, invite?)`, `join`, `leave`, `level(room, all \| mentions)` |
| `who` | `#peers` members: name, kind, presence, status |
| `wait` | `event_id`, `minutes` → `reply` (with the event) \| `offline` \| `checkin` |
| `watch` | blocks until a pushed event; returns it and the rest of the queue |
| `ack` | `event_ids` |

**`send`.**
- It parses `@<peer name>` tokens that resolve to a peer, and `@room`, from the text. It writes `m.mentions {user_ids, room}`. A token that resolves to nothing stays plain text.
- In a `#room`, it invites every mentioned non-member first (015/17).
- `to: owner` DMs `CHATD_OWNER`.
- A DM to a peer finds or creates the two-member DM room and records it in both puppets' `m.direct`.
- `replyTo` writes `m.relates_to.m.in_reply_to`.
- Errors, each loud with its reason:
  - an invalid name;
  - no match or an ambiguous match, listing candidates;
  - `requireOnline` with the peer offline;
  - a `#room` the sender is not in;
  - a sender with no registration;
  - the homeserver unreachable or answering 5xx.

#### 3. `extensions/chat/` (pi)

**Connecting.** On `session_start` the extension connects with the identity peer-link uses today:
1. `PI_PEER_NAME`;
2. the display name;
3. host-pid, the existing fallback for an unnamed session (inventory rows 254–270).

A subagent connects with `kind: subagent` and its session id (`subagent-async/rpc.ts` sets `PI_PEER_NAME`). A refused or failed connection fails `session_start` loudly; init-failure rows as today. When the connection drops, the extension reconnects once systemd restarts chatd, waiting at most 30 s, and notifies the session if that fails.

**Injection.** It injects pushed events with `pi.sendUserMessage(text, { deliverAs })`, and acks after injection.
- A DM from an agent becomes `[peer:<name>] …`, and a mention `[peer:<name> in #room] …`.
- The same from `@scott` becomes `[owner] …` or `[owner in #room] …`.
- A reply request appends the reply line used today.

**Auto-reply** ports unchanged. Once per pushed `expect_reply` event, the turn's final text goes as a reply to it, unless the session already replied to that event.

**Tools and commands.** Tools `chat_send`, `chat_read`, `chat_rooms` and `chat_who`. Commands `/chat-send` and `/chat-autoreply`.

**Waits.** It registers a `WaitSource` in `extensions/lib/waits.ts`: an unanswered `expectReply` send is a wait until it ends per 015/33. Rewrite the two strings in `waits.ts` that say "a peer wait ends on any envelope from that peer".

#### 4. `chat` CLI (Claude Code)

`apps/chatd/cli.ts`, run as `bun ~/Developer/pi-config/apps/chatd/cli.ts`. Subcommands:
- `send --from claude-<sid> [--reply] [--require-online] [--wait <minutes>] <to> <text|->`. `--wait` implies `--require-online`, takes one recipient, and rejects non-positive or non-numeric minutes before sending.
- `read`, `rooms`, `who`, and `watch --from claude-<sid>`.
- `hook session-start|prompt|session-end|notification`. Anything else exits 1.

**Exit codes**, as in `extensions/peer-link/external.ts` today:

| Command | 0 | 1 | 2 | 3 | 4 |
|---|---|---|---|---|---|
| `send --wait` | reply printed | validation error | — | target offline or unknown | check-in due |
| `watch` | mail printed | usage error | a live watch for this peer exists | session gone (registration ended, Claude pid dead, or reparented) | — |

`watch` has no timeout. The check-in protocol is 012's, unchanged (015/33).

**Hooks.**
- `prompt` prints and acks pending pushed events, skips a reply a live `--wait` owns, and nudges a watch when mail is pending and none is live.
- `notification` (015/34): for `permission_prompt`, `idle_prompt` and `elicitation_dialog` (P5), the session's puppet DMs the owner: `<display name> is waiting: <message>`. It sends at most one DM per session and type until the next `prompt` hook. The hook is configured `"async": true`.

**Hook input.** The CLI talks only to the local socket. It reads `session_id`, `cwd`, `message`, `notification_type`, and `model` when present, from hook stdin. It reads nothing under `~/.claude`. The Claude pid comes from P3.

#### 5. Consumers moved, peer-link removed

Re-run at the landing tip and put the output in the completion report:
`rg -l 'peer-link|peer_send|peer_list|peer-send|mailbox|envelope' extensions bin agents prompts skills rules apps tests docs APPEND_SYSTEM.md --glob '!node_modules' --glob '!docs/investigations/**'`

Known hits:
- `APPEND_SYSTEM.md`: the bug-triage handoff becomes `chat_send` to `bug-triage` with `requireOnline: true`.
- `agents/bug-triage.md`.
- `bin/setup`.
- `extensions/bug-triage.ts`.
- `extensions/subagent-async/index.ts`: the start text becomes "message it anytime with `chat_send`".
- `extensions/subagent-async/rpc.ts`.
- `extensions/lib/waits.ts`.
- `tests/model-error-mail.test.ts`, `tests/checkpoint-waits.test.ts`, `tests/subagent-id-resolution.test.ts`, `tests/session-trim.test.ts:396` (a tool-name fixture) and `tests/helpers/session-teardown.ts:11`.
- `docs/design/model-error-mail.md` and `docs/design/checkpoint-waits.md`.

Delete `extensions/peer-link/`, `tests/peer-link*.ts` once their rows are ported, and the mailbox constants. Leave `~/.pi/peer-mail/` on disk for the owner.

`~/.claude/settings.json` is the owner's. Write its replacement hook and permission block (`chat` hooks, `"async": true` on `notification`, an allow rule for `chat watch`) into `docs/design/chat.md` § Hook setup. Do not edit the file.

#### 6. Docs (S5)

- **`docs/design/chat.md`** replaces `docs/design/peer-link-external.md`.
  - It carries over the Terms of Service section, with its invariants restated: Claude only through Claude Code; no credential handling; the CLI makes socket calls only; chatd's network calls go to the homeserver only.
  - It documents `classify`, the delivery state, waits, the mirror and the hooks.
- **`docs/design/model-error-mail.md`** and **`docs/design/checkpoint-waits.md`** are updated to the chat paths and 015/33.
- **APPEND_SYSTEM** changes in three sections:
  - § Who rules gains 015/2: a message from the owner's chat account is the owner speaking.
  - § Peers names `chat_send`.
  - A rule for 015/34: "When the owner's latest message to you came through chat (`[owner] …`), ask him questions with `chat_send` to `owner`, not the question dialog."
- **External-tools decisions** 003, 007, 012 and 014 get superseded notes citing 015/15.

### Behaviour rows (new; in addition to the ported ones)

**Harness.** The rows run against a real Tuwunel. `tests/helpers/tuwunel.ts` starts the pinned binary on a free loopback port, with a fresh database and a registration pointing at a chatd on another loopback port. It starts once per test file.
- The binary is cached at `~/.cache/pi-config/tuwunel/v2.1.0/` and checked against sha256 `05c686aeae2c8ef01d288de844347c0630cd982862b5f9cbb8972cd20dc424a4`.
- `bin/setup` fetches it. A missing binary fails the suite with the fetch command.

1. A DM from A reaches only B; a third peer gets nothing. DM creation writes `m.direct` on both puppets.
2. A room mention pushes to the named peer only. Another member at "all messages" is not pushed: `classify` returns `digest`, and nothing consumes it.
3. `@room` pushes to every non-subagent member, and not to a subagent member.
4. A subagent receives a DM and an @mention of it. It receives no room message and no `@room`. An invite to a subagent is joined.
5. An @mention of a non-member in `send` invites them, and the invite is pushed.
6. Reply-wait, per 015/33:
   - it ends on the reply to its event;
   - it ends on a reply relayed by a third peer;
   - it ends on a DM from the target;
   - it does not end on the target's post in a group room;
   - it ends on a reply sent while chatd was down, after reconnecting.
7. chatd is killed after a push is sent and before its ack. On restart the event is delivered once more, and nothing is lost. `read` on that room before the ack does not lose it.
8. The owner's DM (posted as `@scott`, password login on the test server) reaches the session as `[owner] …`, and `send to: owner` reaches `@scott`.
9. The appservice token is refused for `@scott`.
10. With the homeserver down, `send` fails with the reason and nothing is queued.
11. A wrong or missing `hs_token` → 403, and no event is processed. No captured chatd log line contains either token, even with the token sent in the query.
12. Name mapping: `Foo`, `foo`, `_foo` and `__` map to distinct localparts. `peerName(localpart(n)) == n` for every valid `n` in a generated set. A 65-character or out-of-alphabet name fails at `hello`.
13. A room post at "all messages" leaves a Claude `watch` blocked; an @mention or a DM wakes it.
14. An agent-to-agent DM appears once in `#dm-mirror`, naming both agents. chatd killed between the copy and its 200 makes no second copy on redelivery. A DM with the owner is not mirrored. No agent puppet is a member. A copy older than 7 days is redacted, and the original is untouched.
15. An `m.room.encrypted` event is not pushed, and is logged.
16. A body `@peer` mention with `m.mentions: {}` pushes; an unresolved `@word` does not.
17. Tail resolution: an exact name wins over tails; an ambiguous tail lists both candidates; no match lists the peers.
18. Presence: a Claude registration with a dead pid shows offline within 30 s, and its `watch` exits 3. A second pi `hello` for a connected name is refused.
19. Certificate watch, with an injected clock and certificate dates: 19 days left → one DM to the owner from `@pi-system`; 21 days → none; a failed check → a DM.
20. `send` to a `#room` the sender is not in fails; `send` with no registration fails.
21. `hook notification` with `permission_prompt` DMs the owner once; a second before the next prompt does not.
22. `chat hook stop` exits 1.

**Live smoke** (a manual script, like `peer-link-smoke.ts`), against `chat.sjmcd.me` with throwaway puppet names:
- two pi RPC sessions exchange a DM and an auto-reply;
- the owner @mentions one from Element X, which records P4.

### Verification

- Every row above, and every ported row, shows the mutation that turns it red, run alone (APPEND_SYSTEM § Testing).
- The full suite is green on the landing tip. The report gives its wall-time delta: the Tuwunel harness is an always-on cost.
- The completion report answers each prohibition with its `rg` or row, and gives the consumer `rg` output at the tip.

### Prohibitions

- No bridge or fallback to the file mailbox, and no period where both run.
- No send queue, and no retry beyond those named in § 1 (homeserver redelivery, background runs) and § 3 (one reconnect after a chatd restart).
- No Matrix SDK dependency without an owner ask.
- No path that pushes without `classify`. No writer of `dev.pi.pushed` but `ack`.
- chatd never sets a notification level (015/28).
- No Claude credential handling. The CLI makes no network calls. Nothing starts a Claude session.
- Do not edit `~/.claude/settings.json`.

### Owner steps (after landing)

1. `sudo loginctl enable-linger agent`.
2. Apply the hook block from `docs/design/chat.md` to `~/.claude/settings.json`.
3. Restart pi sessions so they load `extensions/chat/`.

### Rejected

- **A Matrix client per session.** One daemon gives one token, one event stream, and digests computed where unread state is read (WO-matrix-bridge § Target design).
- **A fake homeserver for tests.** The real binary starts in 0.26 s. A fake drifts from Tuwunel's behaviour: the read-marker quirk in infra `docs/tuwunel.md` row 2 is the kind it would miss.
- **Read receipts as the delivery state.** `read` would move the marker past an unacked push and lose it on restart (plan review H3).
- **MCP tools for Claude Code** (`send`, `read`, `rooms`, `who`). The owner deferred them on 2026-11-28, offered against one `chat` CLI (recommended, as a small additive change later): "yeah lets follow your recommendation". `watch` and `--wait` stay background commands either way, because an MCP tool cannot wake a session.
- **Answering permission prompts and the question dialog from chat.** Documented hooks can do it (`PermissionRequest`; `PreToolUse` on `AskUserQuestion` with `updatedInput`). It makes chat a way to grant tool calls, so it gets its own order with a security review. 015/34 takes the notification and the ask-in-chat rule only.
- **Testing against the VPS.** Shared state across runs, and network-dependent.
