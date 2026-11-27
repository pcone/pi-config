# WO-matrix-bridge — Matrix is the peer message bus

> **Lane**: a new infra repo (`~/Developer/infra`), and pi-config: a new `extensions/chat/` replacing `extensions/peer-link/`, its consumers, APPEND_SYSTEM. Plan-level order: each stage dispatches as its own numbered order.

### Metadata

- **work_order_id**: slug until dispatch (`rules/work-order-numbering.md`)
- **routed_to**: plan review, then one implement order per stage
- **priority**: medium
- **estimated_complexity**: large (two repos, a remote box, a transport replacement)
- **review_policy**: required, per stage
- **order_source**: owner 2026-11-27, ten rounds in [decision external-tools/015](../decisions/external-tools/015-matrix-chat-for-peers.md); `015/<n>` cites its numbered rules.

### Goal

Agents and the owner talk in Matrix as in team chat. Matrix is the only message bus (015/15): the peer-link file mailbox is removed, not bridged. The API below is the target design.

### Settled (do not reopen)

| Point | Rule |
|---|---|
| Self-hosted Matrix; one process owns the agent user namespace (application service) | 015/1 |
| Owner's Matrix account is the owner speaking | 015/2 |
| Agents create rooms; one per major feature thread, others as needed | 015/4 |
| Room traffic pulled; DMs and @mentions pushed | 015/5 |
| No loop brakes until a loop is observed | 015/6 |
| Accounts: owner, Claude Code sessions, named pi sessions; subagents none | 015/7 |
| Check points: session start, stage boundaries, before an owner question | 015/8 |
| Digest: N = 15 min, engaged window E = 10 min, idle sessions not woken, each digest logged | 015/9, 015/11 |
| Homeserver Tuwunel, provisional on S2 | 015/10 |
| VPS-2, Debian, Compose stacks, Caddy, scripted host setup, own infra repo, WireGuard | 015/3, 015/12, 015/13 |
| Core portable to any SSH box; provider code only where it is the only way, under `providers/<name>/` | 015/14 |
| Boxes linked over OVHcloud's private network where possible | 015/16 |
| Matrix replaces the mailbox | 015/15 |
| No Claude outside Claude Code; nothing launches a Claude session; room traffic never wakes one | [013](../decisions/external-tools/013-tos-line-credentials-not-turns.md), 015/11 |

### Target design

**One model: every message is in a room.** A DM is a two-member room. One rule decides delivery:

> A message is **pushed** to a member when it is addressed to them: posted in a DM room with them, or @mentioning them (`@room` mentions every member). An invite is pushed. Any other message is **digested** for members whose notification level for the room is "all messages" (015/11, 015/17), and for nobody else.

**Watching is Matrix's own room state** (015/17): membership plus the per-room notification level, stored as the user's push rules.

| State | Effect |
|---|---|
| joined, all messages (default on join or create) | digested; mentions pushed |
| joined, mentions only | mentions pushed; not digested |
| not a member | nothing; reachable by invite |

A peer's `send` invites any non-member it @mentions, as Element offers to. chatd reads levels from the server, so the owner sees and changes an agent's levels in Element.

Broadcast stops being a separate concept: it is a post in a shared room, pulled, or an `@room` mention when it must push. The broadcast flag, the `*` target and its `--require-online` rule have no successor.

**Replies are Matrix reply relations.** A reply names the event it answers (`m.in_reply_to`). "Reply requested" is a flag on the asking event. A reply-wait waits for a reply to *that event*, not for any mail from the target, so a reply cannot be taken by the wrong reader and "last correspondent" state disappears.

**Delivery timing stays a property of the message.** A pushed message lands at the recipient's next turn boundary (pi's steer) unless it asks to wait until the recipient is idle (pi's follow-up). A reply-requested message always waits until idle. This keeps today's rule ([012](../decisions/external-tools/012-peer-reply-wait.md), check-in latency) and stores it in the event's content (`dev.pi.delivery`).

**Identity.** Each peer name is one Matrix user, `@pi-<name>:<server>`, created on first use. Claude Code sessions use their peer name as today. Every user shows a readable display name (015/20): the session's name, or for an unnamed session one chatd derives from its repo and role and keeps unique. Session id, working directory and model go in the presence status message, and in custom profile fields if Tuwunel supports them (MSC4133). The owner's account sits outside the namespace, so no agent process can send as the owner: the server enforces 015/2, and the forged-owner question of the first draft goes away.

**State lives on the server.**
- Unread state is each puppet's Matrix read marker. A pushed message is marked read only after the session injects it, so delivery is at-least-once, as today.
- The last-digest time and engaged rooms live in the puppet's Matrix account data.
- The local daemon keeps no state a restart would lose.

**chatd, the local daemon on the dev box.**
- It is the application service: it receives the homeserver's transactions over the private link and holds the namespace token.
- It serves one Unix socket to local sessions. A session connects, names its peer, and receives its pushed messages as they arrive.
- Connection is presence: connected means online. chatd sets the puppet's Matrix presence, so the owner sees in Element who is live.
- One daemon instead of a Matrix client per session: one sync stream, one token, digests computed where unread state is read. A session restart reconnects without losing anything.

**Agent-facing API.** pi tools; the Claude Code CLI exposes the same verbs as `chat <verb>`.

| Verb | Shape | Replaces |
|---|---|---|
| `send` | `to` (peer name, or `#room`), `text`, optional `replyTo` (event), `expectReply`, `whenIdle` | `peer_send`, `/peer-send`, `external.ts send` |
| `read` | `room`, optional `since`, `limit`; marks read | — |
| `rooms` | joined rooms with topic, level, and unread count for "all messages" rooms; pending invites; `create(name, topic, invite?)`, `join`, `leave`, `level(room, all \| mentions)` | — |
| `who` | peers with presence and current room activity | `peer_list`, `external.ts list` |
| `wait` (CLI) | event id, minutes: exits on a reply, on the target going offline, or on timeout, with 012's codes | `external.ts send --wait` |
| `watch` (CLI) | blocks until a pushed message arrives for this session, prints and acks it, exits | `external.ts watch` |
| `hook` (CLI) | session-start / prompt / session-end: register, inject pushed messages and the digest, deregister | `external.ts hook` |

Pushed messages and digests reach a pi session without a tool call; the tools are for sending and for reading further.

**Model-error mail** (008) becomes a DM from a system puppet `@pi-system` to the peer it targets today.

**Removed with the cutover:** `extensions/peer-link/` (`mailbox.ts`, `index.ts`, `external.ts`, `model-error-mail.ts` moves into `chat/`), the mailbox directory, heartbeat files, watch and wait records, the external-peer TTL, and their tests once their behaviour rows are ported.

### Consumers to move

`rg -l 'peer-link/|peer_send|peer_list|mailbox' extensions bin agents prompts skills rules APPEND_SYSTEM.md --glob '!*.test.*' --glob '!node_modules'` at `5cfa826`: `APPEND_SYSTEM.md`, `agents/bug-triage.md`, `bin/setup`, `extensions/bug-triage.ts`, `extensions/subagent-async/index.ts`, `extensions/subagent-async/rpc.ts`, and peer-link itself. Also the Claude Code hooks in `~/.claude/settings.json` that call `external.ts`. Tests: `peer-link.test.ts`, `peer-link-external.test.ts`, `peer-link-smoke.ts`. The S3 order re-runs this count at its tip.

### Stages

Each stage is its own numbered implement order with its own Preparatory refactor section. A roadblock replans from that point.

**S1 — infra repo, host bootstrap, private link.** New repo `~/Developer/infra`.
- `core/bootstrap`: from bare Debian over SSH, once: Docker, firewall, `deploy` user with key-only SSH, unattended security upgrades. Rerunning changes nothing.
- `providers/ovh/`: attach both boxes to the private network. The owner's account lists a vRack beside the two VPSs (owner, 2026-11-27). On 2026-11-27 the dev box had one interface (`ens3`, public, OpenStack MAC prefix `fa:16:3e`) and no private one, so it is not attached yet. The stage attaches both, confirms a second interface appears on each, and reports if a VPS cannot join; WireGuard then runs over the public addresses.
- `core/wireguard`: tunnel between the boxes to whatever address the provider layer gives, matching the dev box's `wg0` style. Keys never committed.
- `core/deploy`, `core/stacks/caddy`, `core/dns` (provider-neutral tool; adapter and credentials under `providers/<registrar>/`), `core/backup` (nightly, off the VPS, with a restore script).
- Acceptance: fresh box bootstrapped from zero, second run a no-op; WireGuard handshake both ways; a test volume restored onto a fresh box.

**S2 — Tuwunel staging test (gates 015/10).** `core/stacks/tuwunel`: federation off, registration closed, application service in config. Rows, each recorded with its observation:
1. A stub service on the dev box receives transactions over the link and creates a namespaced user on demand.
2. Read markers, account data, presence and per-room push rules set for a namespaced user round-trip, and a level set from Element is visible to the stub service.
3. Element X on the owner's phone logs in with registration closed, no MAS, and shows a namespaced user's display name and status message (and custom profile fields, if supported); the observation records which ones it shows.
4. Resident memory after a day idle and after 1,000 messages across 20 users.

Any row failing stops the stage (`PREMISE FALSIFIED`); Continuwuity, then Synapse, are the fallbacks to put to the owner.

**S3 — chatd and the cutover.** `apps/chatd/` (Bun) and `extensions/chat/`; consumers moved; peer-link removed in the same landing, with no period where both run.
- Preparatory refactor: port peer-link's behaviour rows to transport-neutral tests first: delivery timing, reply-requested pivot, reply-wait exits and check-ins, watch wake rules, at-least-once delivery across a restart, model-error throttling. Rows tied to files (heartbeat freshness, TTL, unreadable envelopes) are listed as retired, each with what replaces it.
- Acceptance: the ported rows pass against chatd; a DM reaches only its recipient; an @mention in a room pushes to the named peer only, and the same post is digested for other members; a reply-wait ends on the reply to its event and ignores other mail from the target; killing chatd mid-push redelivers once and loses nothing; the owner's DM from Element reaches the session as owner mail; no local process can post as the owner's account.

**S4 — digest and check points.** In `extensions/chat/` and the Claude hook, per 015/8, 015/9 and 015/11.
- Acceptance: a message in a mentions-only room never enters the digest, and an @mention there is pushed; an @mention of a non-member invites them and the invite is pushed; a level set in Element is the level the agent's digest uses; a restarted session of the same peer keeps its rooms and levels; one unread message digested after 15 min at the next turn; an engaged room's message reaches the next turn unthrottled and goes back to throttled 10 min after the agent's last post or mention; an idle session gets nothing until its next turn; each digest writes its log line; a subagent loads no chat extension.

**S5 — docs.** APPEND_SYSTEM § Who rules gains 015/2. APPEND_SYSTEM § Peers, `docs/design/peer-link-external.md` and the external-tools decisions 003, 007, 012, 014 get superseded notes citing 015/15; the design doc is rewritten as `docs/design/chat.md`. Lands with S3's cutover.

### Open (owner questions at plan review)

- **Q-a — answered (owner, 2026-11-27): "agree".** Ruling below as recommended.
- **Q-b — answered (owner, 2026-11-27): "agree".** Ruling below as recommended.

- **Q-a: chat server unreachable.** With Matrix as the only bus, a down VPS or link stops peer messages. Recommendation: `send` fails loud with the reason, and the agent reports it; no local queue. A queue would hide undelivered mail behind an apparent success, and with both boxes in one region on a private link outages should be rare.
- **Q-b: room names and archiving.** Recommendation: `#feat-<slug>` for feature threads, `#topic-<slug>` otherwise; a room silent for 14 days is archived by chatd and listed in a weekly digest to the owner.
- **Q-c: domain.** Which domain hosts the server, and who registers it.
- **Q-d — answered (owner, 2026-11-27):** "yeah we should make sure each session has a readable name, and put stuff like session ids in statuses/bios if matrix supports that". 015/20; see Identity above.

### Not in scope

Federation; end-to-end encryption in agent rooms (agent accounts are server-side puppets without device keys; the server is private and federation is off); rebuilding the dev box from the infra repo; voice and video.
