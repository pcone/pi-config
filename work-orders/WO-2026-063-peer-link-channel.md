# WO-2026-063 — deliver peer-link mail to a Claude Code session through a channel

**Status: BLOCKED 2026-11-02 — P3 falsified on this account.** Rows 1–6, the preparatory refactor and the docs are done and reviewed on branch `wo-2026-063-peer-link-channel` (`4bf573d`), held unmerged on purpose. Row 7 and the Mechanism 5 ack wiring are unstarted. Condition: the account cannot load any channel yet, so P1 and P2 cannot be measured.

### Metadata

- **work_order_id**: WO-2026-063
- **parent_plan_id**: [decision external-tools/007](../decisions/external-tools/007-peer-link-channel.md)
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit
- **priority**: high (the owner's coordinating Claude session hears pi mail only when Scott prompts it)
- **estimated_complexity**: moderate
- **review_policy**: required

### Task Summary

Add `extensions/peer-link/channel.ts`, an MCP stdio server with the `claude/channel` capability. While a Claude Code session runs it, the server pushes that session's peer-link mail as `notifications/claude/channel` events, and a push starts the session's turn. The prompt hook stops delivering mail while a channel delivers it. Contract: <https://code.claude.com/docs/en/channels-reference>.

### Rulings

- [external-tools/007](../decisions/external-tools/007-peer-link-channel.md), owner 2026-11-02: "yeah this sounds solid - I think we should pick this up". The channel is the one path allowed to start a Claude turn. Every other path in 003's rejected list stays rejected.
- 007 § Not ruled yet: this order does not register the server in `~/.claude.json` or change any launch command. It documents both for the owner to apply.

### Premises (verify first; on a false one stop with `PREMISE FALSIFIED`)

- **P1.** Claude Code passes `CLAUDE_CODE_SESSION_ID` to an MCP server it spawns. Bash children see it (2.1.296); MCP children are unverified. Probe: a stdio server that logs its env keys to stderr, read from `claude --debug`'s log. Without P1 the server cannot name its inbox.
- **P2.** Find which hooks fire around a turn a channel event starts: `UserPromptSubmit`, `Stop`, both or neither. The ack design below depends on it. Probe with logging hooks in a scratch project.
- **P3.** Claude Code 2.1.296 on this account loads a server through `--dangerously-load-development-channels server:<name>`.

The probes need an interactive Claude Code session, so hand them to the owner as a short script with expected output. Never run `claude -p` or a headless session.

### Mechanism

1. **Identity.** The server's peer name is `externalName(process.env.CLAUDE_CODE_SESSION_ID)` (`external.ts`). If the variable is unset, the server exits non-zero with a message naming it, so `/mcp` shows it failed. It never guesses a name.
2. **One deliverer per session.** The external heartbeat (`PeerInfo`) gains the channel's pid. One function in `mailbox.ts` answers who delivers this session's mail: the channel if its pid is alive, otherwise the prompt hook. The prompt hook and the channel both call it, and the prompt hook emits nothing while a channel delivers.
3. **Watch.** The server watches its inbox with pi's mechanism: `fs.watch` as an accelerator, plus a `SCAN_MS` poll.
4. **Push.** A scan that finds envelopes not yet pushed sends one notification that carries all of them. Content is `renderMail`'s text (`external.ts`), so the two delivery paths render alike. `meta` holds `from`, `ids` and `expect_reply`; meta keys must be letters, digits and underscores, so not `expect-reply`. The server's `instructions` say mail arrives as `<channel source="peer-link" …>` and that replies go through `external.ts send`.
5. **At-least-once.** Notifications are not acknowledged, and events that arrive mid-turn queue until the next turn. A turn's Stop must therefore ack only the envelopes that turn carried, never ones still queued. Build the ack from P2's answer:
   - If a hook fires when a channel-started turn begins, that hook moves the pushed envelopes to inflight and Stop acks inflight, the funnel `external.ts` uses today.
   - Otherwise stop with `PLAN MISMATCH`, marked as an owner question, giving the loss window of acking at push.
   - After a server restart, un-acked mail is pushed again: a duplicate, never a loss.
6. **No permission relay, no tools.** Do not declare `claude/channel/permission`. Peer mail is not an authenticated human, and a relayed approval would let any peer approve tool calls. Do not declare `tools` either: sending stays `external.ts send`, the one send path.
7. **Dependency.** Add `@modelcontextprotocol/sdk` to `extensions/package.json` with an exact version. Write no MCP framing by hand.

### Rejected alternatives

- **An HTTP listener, as in the reference's webhook example.** Every local process can reach a port, and browsers can too through DNS rebinding. The user-private inbox directory is already the transport.
- **A sender allowlist on the envelope's `from`.** The reference's allowlist guards network senders. Only the user's own processes can write the inbox (`ensureMailbox`, mode 0700), and a `from` field is self-asserted, so checking it adds nothing. Instead the server checks at startup that the inbox and `_peers` are owned by the user and mode 0700, and refuses to start otherwise.
- **Both deliverers on at once.** Every envelope would arrive twice, once per path.
- **Ack at push.** Claude Code holds queued events in memory, so a session that dies with an event queued loses it. That breaks the mailbox contract (duplicates over loss, `mailbox.ts` header). It is legal only through the owner question in Mechanism 5.
- **`/loop` polling.** It spends a turn on every tick, mail or not (007).

### Preparatory refactor

Extract pi's inbox watch loop (`index.ts`, the `scanTimer`/`fs.watch` block in session start) into one `mailbox.ts` function that pi and `channel.ts` both call. `tests/peer-link.test.ts` and `tests/peer-link-external.test.ts` pass unchanged at the refactor commit.

### Acceptance

Each row fails with its mechanism reverted; show the revert. The tests spawn `channel.ts` under the SDK's `Client` + `StdioClientTransport`, against a temp `$PI_PEER_MAILBOX`, with no Claude process.

1. An envelope dropped into the inbox arrives as one `notifications/claude/channel` with renderMail content and the meta keys above.
2. Three envelopes in one scan arrive as one notification.
3. While the channel's pid is live, the prompt hook emits nothing and acks nothing. Once the pid is dead, the prompt hook delivers.
4. No `CLAUDE_CODE_SESSION_ID`: the server exits non-zero naming it.
5. An inbox that is group- or world-writable: the server refuses to start.
6. An envelope that was pushed and not acked is pushed again after a server restart.
7. The ack rows Mechanism 5 implies, with P2's answer recorded in the test's comment.

Cost: report wall time and process spawns of one idle minute of the server, and of the prompt hook before and after (always-on budget).

### Docs

- `docs/design/peer-link-external.md`: add the channel to Flow. Rewrite ToS (b) and the invariants to 007: the channel is the one turn-starting path; `channel.ts`, like `external.ts`, makes no network calls and spawns no processes.
- Add a Setup section with the exact `~/.claude.json` `mcpServers` entry and launch flag the owner applies: `--dangerously-load-development-channels server:peer-link`.
- `extensions/peer-link/external.ts` header and the session-start context text: mail arrives as a channel event when a channel runs, otherwise on the next prompt.

### Prohibitions

- No path that starts a Claude turn other than the channel: no watcher, no `claude -p`, no SDK query call, no continuing Stop hook.
- Never read Claude credentials, transcripts (`transcript_path` included) or `~/.claude` state.
- Do not edit `~/.claude.json`, `~/.claude/settings.json` or any launch script.

### Landing record (2026-11-02)

**Blocked on channel availability, not on this server.** The owner ran the probe in an interactive 2.1.296 session. Claude Code printed **"Channels are not currently available"** at startup, before any server is named, so P3 is false and P1/P2 could not be measured.

Cause, read from the 2.1.296 binary: the notice prints when `Oyt()` is true, `Oyt()` = `!flag("tengu_harbor") || verdict("allow_channels") ∈ {latched, org_denied}`, and it takes no argument naming a server. The cached GrowthBook flag `tengu_harbor` is true, so the block is the account's server-side `allow_channels` verdict. The channels page says preview availability "is rolling out gradually", and it applies to every channel, official plugins included.

**What stands.** Branch `wo-2026-063-peer-link-channel` at `4bf573d`, five commits above `07a940c`: refactor `ed0f738`, feature `49a95bc`, rework `13677d0`, `1c2ef5d`, `4bf573d`. Rows 1–6, the preparatory refactor and the docs; every row red under its own revert. Reviewed: `review-code` APPROVED (3 rounds), `review-tests` APPROVED_WITH_NOTES (2 rounds, all notes accepted as LOW). Gate re-ran the rows at the tip: 20 pass / 0 fail; the refactor commit alone 33 pass / 2 fail, the two live `peer-link` rows also red at base. Unmerged, unpushed to `main`, nothing registered, nothing enabled — `### Channel delivery is not ready to enable: no ack yet` is in the design doc, and the Setup text is for the owner to apply.

**What is not done.** Row 7 and the ack wiring. No ack work was started and none should be: without P2 there is no honest ack point, and acking at push loses events. No workaround either — no `/loop`, no watcher.

**Gate reading, for the record.** Rows 4 and 5 drive the server with `Bun.spawnSync` rather than the SDK `Client` + `StdioClientTransport` the Acceptance preamble names. The gate reads that as in-scope: a server that refuses to start never reaches `initialize`, so a transport that must negotiate cannot observe the exit code and stderr the rows assert. Rows 1–3, 6 and 7 use the SDK client. The assertions are unchanged.

**Probe kept.** `~/Developer/probe-peer-link-channel/` (`RUN.md`, `server.mjs`, `hooks.mjs`, `.mcp.json`, `.claude/settings.json`). Re-run step 1 after a Claude Code update; P1 and P2 resume from there, and the answers land in Mechanism 5 before row 7 is written.
