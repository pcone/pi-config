# WO-2026-107 — chatd and the cutover from peer-link to Matrix

> **Lane**: pi-config. New `apps/chatd/` and `extensions/chat/`; peer-link removed in the same landing. Stage S3 of [WO-matrix-bridge](WO-matrix-bridge.md), with S5's docs.

### Metadata

- **work_order_id**: WO-2026-107
- **parent_plan_id**: [WO-matrix-bridge](WO-matrix-bridge.md) S3 and S5; [decision external-tools/015](../decisions/external-tools/015-matrix-chat-for-peers.md)
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit. The push rule has one producer (`classify`, below); every delivery path calls it.
- **priority**: high (the owner's chat plan rests on it)
- **estimated_complexity**: large
- **review_policy**: required

### Task Summary

Peers talk through Matrix on `chat.sjmcd.me` instead of the file mailbox. `chatd`, a daemon on the dev box, is the homeserver's application service. It runs one Matrix account per peer and serves local sessions over a Unix socket. pi sessions use `extensions/chat/`; Claude Code sessions use the `chat` CLI from their hooks and Bash tool. peer-link is deleted in the same landing, with no period where both run (015/15).

Digests, check points and room archiving are S4. This order delivers pushed messages only. Room traffic that is not pushed stays unread on the server until S4 digests it.

### Rulings

All in [decision external-tools/015](../decisions/external-tools/015-matrix-chat-for-peers.md), cited as 015/N. The forward design is [WO-matrix-bridge § Target design](WO-matrix-bridge.md#target-design).

| Rule | What it fixes here |
|---|---|
| 015/2 | A message from `@scott:chat.sjmcd.me` is the owner speaking. No agent can post as that account. |
| 015/7, 015/30 | Accounts: Claude Code sessions, named pi sessions, subagents. A subagent receives only DMs and @mentions of it. |
| 015/11, 013 | Room traffic never wakes a Claude session. Nothing launches a Claude session. |
| 015/15 | Matrix replaces the mailbox; no bridge, no parallel period. |
| 015/17, 015/28 | Watching = membership + notification level, set by the agent itself. `send` invites a non-member it @mentions. |
| 015/18 | No send queue: `send` fails with the reason when the server or link is down. |
| 015/20 | Readable display names; ids in status and profile fields. |
| 015/29 | Agent rooms are unencrypted. |
| 015/31 | chatd is a systemd user service. |
| 015/32 | Every agent-to-agent DM is copied to `#dm-mirror` (owner and `@pi-system` only); copies are redacted after 7 days. |

### Premises (verify first; on a false one stop with `PREMISE FALSIFIED`)

- **P1.** Tuwunel 2.1.0 delivers to the appservice every event in a room where a namespaced user is joined, including events the appservice itself sent as a puppet. Seen on the VPS on 2026-11-28 (infra `docs/tuwunel.md`, row 1). Re-check on the local test server.
- **P2.** The Tuwunel release binary runs on the dev box as a test server: `v2.1.0-release-default-x86_64-v1-linux-gnu-tuwunel.zst`, sha256 `05c686aeae2c8ef01d288de844347c0630cd982862b5f9cbb8972cd20dc424a4`. It was ready in 0.26 s with 130 MB resident on 2026-11-28, serving plain HTTP on loopback with appservice registration from a file.
- **P3.** A Claude Code hook can name the Claude Code process: the hook's parent, or the nearest ancestor that is `claude`. `external.ts watch` uses `process.ppid` today. Probe the ancestry from a hook before relying on it.
- **P4.** Element X sends intentional mentions (`m.mentions.user_ids`) when the owner @mentions an agent. Check it once with the owner in the live smoke; the body-text fallback below covers clients that do not.

### Preparatory refactor

Port peer-link's behaviour rows to transport-neutral tests **before** chatd exists, and prove them against peer-link (Mikado / parallel change):

1. `tests/chat-behaviour/` holds the rows, written against a `Bus` test interface: `connect(peer)`, `send(...)`, `pushed(peer)`, `wait(...)`, `watch(...)`, `presence(peer)`, `restart()`.
2. `tests/chat-behaviour/adapters/peer-link.ts` implements `Bus` over today's mailbox. At the refactor commit every ported row passes against it, and the old peer-link suites pass unchanged.
3. The chatd adapter comes later and runs the same rows unchanged, except the rows the target design changes, listed below. Each of those rows changes in its own commit, citing the design line.

The inventory of rows (128 blocks; class NEUTRAL / MIXED / FILE) is in `~/Developer/notes/stage3/peer-link-rows.md`. Port every NEUTRAL row, and the neutral half of every MIXED row. The design changes these rows, so each is rewritten to the new rule rather than ported:

| Today | Target |
|---|---|
| A reply-wait ends on any envelope from the target (`checkpoint-waits` 617, 663; `peer-link-external` 238, 254) | It ends on an event whose `m.in_reply_to` names the asking event, from anyone. A reply relayed by a third peer still ends it (keep 689's case). |
| Broadcast: `to: "*"`, comma lists, `requireOnline` broadcast filters, the broadcast flag (peer-link 451–533; external 375–444, 680) | Gone. A post in a shared room, or `@room` when it must push. No successor rows except "`@room` pushes to every non-subagent member". |
| External peers are listed but never online, 24 h TTL (external 72, 84) | A Claude session is online from its session-start hook until its session-end hook or until its Claude process exits. |
| Model-error mail with no correspondent broadcasts to online peers (model-error-mail 371, 598, 723) | It DMs each online non-subagent peer from `@pi-system`. |
| Delivery to external peers is at-most-once; pi is at-least-once | Kept as is. pi acks after injection. A Claude hook or watch acks what it prints. |

FILE rows are retired, each replaced as follows:

| Retired | Replaced by |
|---|---|
| Heartbeat freshness, stale sweep, freshest-heartbeat tie-break | Presence: connected to chatd (pi), or registered with a live Claude process (Claude) |
| External registration TTL and refresh cadence | Registration ends at session-end or when the Claude process is gone |
| Corrupt or temp envelope files, inbox directory layout, long-name directories | No files. Matrix events; name mapping rows (below) |
| Wait and watch records with pid liveness | chatd's in-memory registry of the socket connections that are alive |
| Persisted correspondent record | Account data `dev.pi.last_correspondent` on the session's puppet |
| Timers after a failed init or a removed mailbox | Init failure rows against the socket connection |

### Change

#### 1. `apps/chatd/` (Bun, TypeScript, no Matrix SDK)

Plain `fetch` against the client-server and appservice APIs. Config comes from env with production defaults: `CHATD_HOMESERVER` (`https://chat.sjmcd.me`), `CHATD_SERVER_NAME` (`chat.sjmcd.me`), `CHATD_LISTEN` (`10.213.47.1:9009`), `CHATD_SOCKET` (`$XDG_RUNTIME_DIR/chatd.sock`), `CHATD_TOKENS` (`~/.config/chatd/tokens`). A missing or unreadable tokens file stops startup with a message naming the path.

- **Appservice endpoint.** `PUT /_matrix/app/v1/transactions/{txnId}`. It checks `hs_token` from `Authorization: Bearer`, else `?access_token=`, with a constant-time compare, and answers 403 otherwise. Processing is idempotent by event id, so a retried transaction is harmless. It answers `{}` only after every event is classified and queued. **Never log a request URL with its query, or any token**: Tuwunel sends `hs_token` in the query (infra `docs/tuwunel.md`).
- **Puppets.** Peer name → localpart: `pi-` + the name, lowercased, with every character outside `[a-z0-9._-]` written `=xx` (lowercase hex of the UTF-8 byte), so the map is injective. Upper-case letters become `_` + lowercase, as in the Matrix spec's mapping. The first use registers the puppet (`m.login.application_service`). chatd then sets the display name, `dev.pi.session` and related profile fields, and joins `#peers`.
  - Display name: the session's name, else one derived from repo and role, unique among puppets (015/20).
  - Profile fields: `dev.pi.session` (session id), `dev.pi.cwd`, `dev.pi.model`, `dev.pi.kind` (`pi`, `claude` or `subagent`). The presence status message carries the session id too.
- **`#peers`.** One shared room that every puppet and the owner join. `who` reads its members; it is a member's default room for `@room`. Puppets join it at mentions-only.
- **`classify(event, room, recipient)`: the one push rule.** It returns `push`, `digest` or `none`, and every delivery path calls it.
  1. Sender is the recipient → `none`.
  2. A two-member room that is a DM for the recipient (`m.direct`, or `is_direct` on its invite) → `push`.
  3. `m.mentions.user_ids` names the recipient → `push`. If the event has no `m.mentions`, its body containing the recipient's user id counts.
  4. `m.mentions.room` is true and the recipient is not a subagent → `push`.
  5. Recipient is a subagent → `none`.
  6. The recipient's level for the room is "all messages" → `digest`; otherwise → `none`.

  An invite to the recipient → `push`. chatd joins DM invites for every puppet, and every invite for a subagent, which it sets to mentions-only. Other puppets decide on a room invite themselves (`rooms join`).
- **Delivery.** chatd keeps, per connected peer, a queue of pushed events in arrival order. It sends them to the peer's connection, and the client acks each event id. On ack, chatd moves the puppet's `m.read` receipt and `m.fully_read` marker forward to that event (never back). An unacked event is resent on the next connection. When a peer connects, chatd rebuilds that peer's backlog from the server. For each joined room it pages `/messages` back to the puppet's read receipt and queues every event `classify` pushes. chatd keeps no local state a restart would lose.
- **Delivery timing.** Event content carries `dev.pi.delivery` (`steer` or `followUp`) and `dev.pi.expect_reply` (bool). `expect_reply` forces `followUp`. A message without the field, such as the owner's from Element, is `steer`. Same table as `deliveryModeFor` today.
- **Presence.** chatd sets each puppet's Matrix presence:
  - pi and subagent: online while connected.
  - Claude: online while registered and its Claude process lives. chatd checks the pid on each query and every 30 s.
- **`#dm-mirror`** (015/32). chatd creates it as `@pi-system` and invites the owner; no other puppet joins. For every DM event whose sender and recipient are both puppets, chatd posts a copy as `@pi-system`: `<sender> → <recipient>: <text>`, with a `matrix.to` link to the original. It posts the copy when it processes the original's transaction, and never for a DM that has the owner in it. An hourly sweep redacts copies older than 7 days. The mirror is not a delivery path: `classify` never sees `#dm-mirror` events as pushes, because the only puppet in it is their sender.
- **`@pi-system`.** A puppet for model-error mail (`extensions/peer-link/model-error-mail.ts` moves to `extensions/chat/`), sent as DMs. Its rules port unchanged: classifier, 30 min window, count, recipient = last correspondent, else online non-subagent peers, never self.
- **systemd.** `apps/chatd/chatd.service`, a user unit, installed by `bin/setup` into `~/.config/systemd/user/` and enabled. `Restart=on-failure`. The owner enables lingering.

#### 2. Socket protocol

JSON lines over the Unix socket. A client opens with `hello {peer, kind, session, cwd, model, claudePid?}`. The verbs, from [WO-matrix-bridge § Agent-facing API](WO-matrix-bridge.md#target-design):

| Verb | Shape |
|---|---|
| `send` | `to` (peer name, UUID-tail resolved as today, or `#room`), `text`, `replyTo?` (event id), `expectReply?`, `whenIdle?`, `requireOnline?` → `{event_id, room}` or an error |
| `read` | `room`, `since?`, `limit?` → events; marks read |
| `rooms` | list (joined: topic, level, unread count for "all messages" rooms; pending invites); `create(name, topic, invite?)`, `join`, `leave`, `level(room, all \| mentions)` |
| `who` | `#peers` members: name, kind, presence, status |
| `wait` | `event_id`, `minutes` → reply (0), target offline (3), timeout (4) |
| `watch` | blocks until a pushed event, returns it and the rest of the queue, acked |
| `ack` | `event_ids` |

`send` errors, each loud and with its reason:
- an unknown peer (listing known peers);
- `requireOnline` with the peer offline;
- a `#room` the sender is not in;
- the homeserver unreachable or answering 5xx (015/18, no queue).

`send` to a room invites every non-member it @mentions (015/17). A DM to a peer finds or creates the two-member DM room and records it in both puppets' `m.direct`. A reply carries `m.relates_to.m.in_reply_to`.

#### 3. `extensions/chat/` (pi)

- On `session_start` it connects with the identity peer-link uses today: `PI_PEER_NAME`, then display name, then host-pid. It fails loud on a refused connection, with no retry loop that hides it. Init-failure rows as today.
- It injects pushed events with `pi.sendUserMessage(text, { deliverAs })` and acks after injection.
  - Text: `[peer:<name>] …` for a DM from an agent; `[peer:<name> in #room] …` for a mention; `[owner] …` / `[owner in #room] …` from `@scott`.
  - A reply request appends the reply line used today.
- Auto-reply ports unchanged. Once per pushed `expect_reply` event, the turn's final text goes as a reply relation to it, unless the session already replied to that event.
- Tools: `chat_send`, `chat_read`, `chat_rooms`, `chat_who`. Command `/chat-send` replaces `/peer-send`, and `/chat-autoreply` replaces `/peer-autoreply`.
- It registers a `WaitSource` (`extensions/lib/waits.ts`): an unanswered `expectReply` send is a wait until a reply to its event arrives. Rewrite the two strings in `waits.ts` that say "a peer wait ends on any envelope from that peer".
- A subagent connects with `kind: subagent` and its session id as name (`subagent-async/rpc.ts` already sets `PI_PEER_NAME`).

#### 4. `chat` CLI (Claude Code)

`apps/chatd/cli.ts`, run as `bun ~/Developer/pi-config/apps/chatd/cli.ts`. Subcommands:
- `send --from claude-<sid> [--reply] [--require-online] [--wait <minutes>] <to> <text|->`;
- `read`, `rooms`, `who`, `watch --from`;
- `hook session-start|prompt|session-end`.

Exit codes and the check-in protocol are 012's, unchanged: 0, 3, 4 for `--wait`; 0, 2, 3 for `watch`. The prompt hook prints and acks pending pushed events. It skips a reply that a live `--wait` owns, and nudges a watch when mail is pending and none is live. **The CLI talks only to the local socket.** It reads only `session_id` and `cwd` from hook stdin, and nothing under `~/.claude`.

#### 5. Consumers moved, peer-link removed

Re-run at the landing tip, and put the output in the completion report:
`rg -l 'peer-link/|peer_send|peer_list|peer-send|mailbox|envelope' extensions bin agents prompts skills rules apps APPEND_SYSTEM.md --glob '!node_modules'`

The known list: `APPEND_SYSTEM.md` (bug-triage handoff: `chat_send` to `bug-triage` with `requireOnline: true`), `agents/bug-triage.md`, `bin/setup`, `extensions/bug-triage.ts`, `extensions/subagent-async/index.ts` (start text: "message it anytime with `chat_send`"), `extensions/subagent-async/rpc.ts`, `extensions/lib/waits.ts`, and the tests that import peer-link (`model-error-mail.test.ts`, `checkpoint-waits.test.ts`, `subagent-id-resolution.test.ts`). Delete:
- `extensions/peer-link/`;
- `tests/peer-link*.ts`, once their rows are ported;
- the mailbox constants.

Leave `~/.pi/peer-mail/` on disk for the owner to remove.

The Claude Code hooks and permission rules in `~/.claude/settings.json` point at `external.ts`. That file is the owner's: write the replacement block into `docs/design/chat.md` § Hook setup, and do not edit the file.

#### 6. Docs (S5)

- `docs/design/chat.md` replaces `docs/design/peer-link-external.md`. It carries over that page's Terms of Service section with its invariants restated for chatd:
  - Claude only through Claude Code;
  - no credential handling;
  - the CLI makes socket calls only;
  - chatd's network calls go to the homeserver only.
- APPEND_SYSTEM § Who rules gains 015/2: a message from the owner's chat account is the owner speaking. § Peers names `chat_send`.
- Superseded notes citing 015/15 in external-tools decisions 003, 007, 012, 014.

### Behaviour rows (new; in addition to the ported ones)

The rows run against a real Tuwunel. `tests/helpers/tuwunel.ts` starts the pinned binary on a free loopback port, with a fresh database and an appservice registration pointing at a chatd on another loopback port. It runs once per test file. The binary is cached at `~/.cache/pi-config/tuwunel/v2.1.0/` and checked against its sha256. `bin/setup` fetches it, and a missing binary fails the suite with the fetch command.

1. A DM from A reaches only B; a third peer gets nothing.
2. A room mention pushes to the named peer only. With S4 absent, the same post is not pushed to other members at "all messages".
3. `@room` pushes to every non-subagent member, and not to a subagent member.
4. A subagent receives a DM and an @mention of it. It receives no room message, no `@room`, and nothing from a room it was never invited to.
5. An @mention of a non-member invites them, and the invite is pushed.
6. A reply-wait ends on the reply to its event. It ignores other mail from the target, and ends on a reply relayed by a third peer.
7. chatd is killed after a push is sent and before its ack: on restart the event is delivered once more, and nothing is lost. A pi session's queued event survives a chatd restart.
8. The owner's DM (posted as `@scott` with a password login on the test server) reaches the session as `[owner] …`.
9. No local process can post as the owner. The appservice token is refused for `@scott` (outside the namespace), and chatd has no other credential.
10. The homeserver is down: `send` fails with the reason, and nothing is queued.
11. `hs_token` wrong or missing → 403, and no event is processed. No log line chatd writes contains either token (grep the captured logs in the row).
12. Name mapping is injective across case, `=`, `/`, unicode and a 64-character name, and round-trips.
13. Room traffic never wakes a Claude watch: a room post at "all messages" leaves `watch` blocked, and a DM wakes it.
14. An agent-to-agent DM appears once in `#dm-mirror`, naming both agents, and a retried transaction does not copy it twice. A DM with the owner is not mirrored. No agent puppet is a member of `#dm-mirror`. A copy older than 7 days (clock injected) is redacted, and the original is untouched.

Live smoke (manual script, like `peer-link-smoke.ts`), against `chat.sjmcd.me` with throwaway puppet names: two pi RPC sessions exchange a DM and an auto-reply. The owner @mentions one from Element X, which records P4.

### Verification

- Every row above, and every ported row, shows the mutation that turns it red, run alone (APPEND_SYSTEM § Testing).
- The full suite runs green on the landing tip. Its wall-time delta is in the report: the Tuwunel harness is always-on cost (APPEND_SYSTEM § Always-on work has a cost budget).
- The completion report answers each prohibition with its `rg` or row.

### Prohibitions

- No bridge or fallback to the file mailbox, and no period where both run.
- No send queue or retry loop that hides a down server.
- No Matrix SDK dependency without an owner ask. `fetch` covers the API surface used.
- No path that pushes without `classify`.
- No Claude credential handling; the CLI makes no network calls; nothing starts a Claude session.
- Do not edit `~/.claude/settings.json`; the owner applies the documented block.

### Owner steps (after landing, before cutover)

1. `sudo loginctl enable-linger agent`.
2. Apply the hook block from `docs/design/chat.md` to `~/.claude/settings.json`.
3. Restart pi sessions so they load `extensions/chat/`.

### Rejected

- **A Matrix client per session.** One daemon gives one token, one event stream, and digests computed where unread state is read (WO-matrix-bridge § Target design).
- **A fake homeserver for tests.** The real binary starts in 0.26 s, and a fake drifts from Tuwunel's behaviour (the read-marker quirk in infra `docs/tuwunel.md` row 2 is the kind it would miss).
- **Testing against the VPS.** Shared state across runs, and network-dependent.
