---
title: "Peers chat on a self-hosted Matrix server on its own VPS; a message from the owner's chat account is the owner speaking"
type: decision
status: accepted
date: 2026-11-27
---

# Matrix chat for peers

**Ruling (owner, 2026-11-27).** Asked for "something that organically looks like regular chat - direct peer messages would be dms or @tagged messages, and agents could spontaneously discuss things if needed in a discussion channel - perhaps with different channels for different topics", Claude recommended a self-hosted Matrix server with an application-service bridge, and asked whether a message from Scott's verified chat account counts as him speaking. Scott: "yeah matrix sounds good to me, and yeah message from my chat account counts as me speaking". On hosting: "I'm thinking we should keep this box clean as *just* ephemeral dev/build stuff and I'll provision another on the lowest or second lowest tier of ovhcloud to host the matrix server and any other little things we need".

**What holds now:**

1. **Platform.** Peers chat on a self-hosted Matrix homeserver. DMs and @mentions map to direct peer mail; rooms are topic channels.
2. **Owner identity.** A message from the owner's Matrix account is the owner speaking, with the standing of a message typed into a session. The session that receives it records any ruling, as today.
3. **Hosting.** The homeserver and other standing services run on a separate OVHcloud VPS (lowest or second-lowest tier) that the owner provisions. The dev box holds only ephemeral dev and build work.
4. **Channels.** Agents may create channels. Each major feature thread gets a dedicated channel; agents may also create others as a need arises.

**Ruling (owner, 2026-11-27, second round).** Asked who may create channels, Scott: "I think agents being able to create channels might be useful - we should add dedicated ones for major feature threads but I can see dynamically created new ones being useful sometimes".

**Recorder's reading (Claude, 2026-11-27).** Ruling 2 changes APPEND_SYSTEM § Who rules, which says only a session talking to the owner directly hears an owner ruling. That edit lands with the bridge, when an owner chat account exists; carrier: `work-orders/WO-matrix-bridge.md` (to be written). The bridge itself must hold the owner's Matrix user ID as the only identity that carries owner standing; a display name or room membership carries none.

**Why Matrix over Slack, Discord or Zulip.** Peers come and go, so each needs its own chat identity created on demand. A Matrix application service owns a user namespace (for example `@pi-*`) and acts as any user in it from one process. Slack and Discord need one app or bot token per identity that receives DMs. Zulip fits topics well but is heavier to host. These platform facts are from the recorder's knowledge, not a fetched source; the work order verifies them.

5. **Channel traffic is pulled.** A channel message reaches an agent only when the agent checks the channel. DMs and @mentions stay pushed as peer mail.
6. **No loop limits up front.** Agent-to-agent mention loops get no brake until one is observed.

**Ruling (owner, 2026-11-27, third round).** Scott: "yeah channel messages reaching only on check makes sense - we should nail down *when* an agent checks though, and whether all agent types check in regularly (or even have accounts)". On loop limits: "this hasn't been an issue with our current peer message system yet - lets see if it becomes a problem here".

7. **Accounts.** Owner, Claude Code sessions and named pi sessions (every peer-link peer) get accounts. Subagents get none; their dispatcher speaks for them.
8. **Check points.** An agent checks its channels at session start, at stage boundaries (before a stage; after a landing or stop-report), and before asking the owner a question.
9. **Throttled checks, not counts.** Any unread message is eventually seen, however few. A session checks at most once every N minutes, unless it is engaged in a conversation in that channel. Check cost is measured from the start.
10. **Homeserver.** Tuwunel, provisional on a staging test: bridge registration and device management, Element X login with registration closed, memory on the VPS.

**Ruling (owner, 2026-11-27, fourth round).** Offered Tuwunel provisional on a staging test, the account split above, and check points including an unread-count line at turn boundaries, Scott: "yeah I'm good with most of that". On the unread signal: "I think we should carefully monitor how we inform agents about unread messages etc - don't want to have them spending a bunch of tokens checking them all the time, but also message *count* alone shouldn't be the decider - e.g. if there's a single unread messaeg in a channel I'd expect the agent to eventually check it still maybe after a timeout - perhaps essentially debouncing/throttling message checking so each session doesn't check more often that n minutes unless it's specifically engaged in a conversation?"

**Recorder's reading of the fourth round (Claude, 2026-11-27).** "Most of that" is read as accepting everything offered except the unread-count line, which rule 9 replaces. The fifth round settles N, "engaged" and idle sessions (rule 11).

11. **Digest mechanics.** The session's chat extension tracks unread messages without the model. At a turn boundary it injects one capped digest when anything is unread and N = 15 minutes have passed since the last digest. A channel where the agent posted or was @mentioned in the last E = 10 minutes is engaged: its new messages enter the next turn boundary's digest unthrottled. An idle session is not woken for channel traffic; it sees the digest at its next turn. Each digest is logged (session, channels, tokens, whether a full read followed).
12. **Server role.** The VPS (OVHcloud VPS-2; VPS-1 was unavailable in the dev box's region) is a general-purpose server under a management layer, not a bare Matrix host.

**Ruling (owner, 2026-11-27, fifth round).** Offered the digest mechanics above with N = 15, E = 10 and idle sessions left to wait, Scott: "yeah this all sounds good". On hosting: "I ended up having to get the VPS-2 tier because VPS-1 wasn't available in the same region as this box. thinking we use it as a general purpose server? so we probably want some kind of management layer on it rather than just running the matrix server on bare metal".

13. **Infrastructure as code; bare WireGuard.** The VPS runs Debian with services as Docker Compose stacks, Caddy for HTTPS, and scripted host setup, all from a dedicated infra repo; no hypervisor or management UI. The VPS joins this box over bare WireGuard, as this box's existing `wg0` link does; no Tailscale.

**Ruling (owner, 2026-11-27, sixth round).** Offered Compose stacks in git (recommended), a self-hosted PaaS, NixOS or k3s, with Tailscale or WireGuard for the private link, Scott: "I've used proxmox before too, but yeah I think a more IaC approach would be nicer - we should stick with bare wireguard rather than tailscale just like we have with this box".

**Recorder's reading of the sixth round (Claude, 2026-11-27).** "A more IaC approach" rules out Proxmox and a UI-driven PaaS. It does not pick between Compose stacks in git and NixOS; the seventh round does.

**Ruling (owner, 2026-11-27, seventh round).** Asked to choose the IaC style, Scott picked "Compose in git (Recommended)": a Debian host, services as Docker Compose files in git, Caddy for HTTPS, a deploy script over SSH, host setup (WireGuard, firewall, deploy user) scripted. Asked where the config lives, he picked "New infra repo (Recommended)", for example `~/Developer/infra`, since the VPS hosts more than chat.

**Recorder's reading on channels (Claude, 2026-11-27).** "Major feature thread" is read as a multi-stage effort with its own plan or orchestrator; the session that opens such an effort creates its channel. The work order proposes naming, and archiving of channels left idle, for the owner to rule on.

14. **Portable to any SSH box; provider code quarantined.** The infra repo's core targets any machine reachable over SSH. Provider-specific automation (OVHcloud or any other) is committed only where the provider's own interface is the only way to automate the step, and lives under a separate per-provider directory, outside the portable core.

**Ruling (owner, 2026-11-27, eighth round).** Offered DNS records under OpenTofu's OVH provider, Scott: "I don't want to build anything that's tied to ovhcloud directly - we can use their api for initial bootstrapping if needed, but the actua IaC setup needs to be portable to any arbitrary 'box with an ssh connection'".

**Recorder's reading of the eighth round (Claude, 2026-11-27).** DNS records are provider state outside the box, so they stay manual (or a bootstrap step) and the repo documents the records it needs. *Superseded by the ninth round.*

**Ruling (owner, 2026-11-27, ninth round).** Scott: "also fyi automating and committing ovhcloud specific stuff is allowed and encouraged, just *only* if the ovhcloud specific way is the only way it can be automated, and it's clearly path separated in a 'this is bad cruft we have to build per cloud provider' dir".

**Recorder's reading of the ninth round (Claude, 2026-11-27).** Rule 14 reads "provider" for "ovhcloud", since the same quarantine fits any provider. DNS records can be automated: a provider-neutral tool (for example dnscontrol or OctoDNS) declares the records in the core, and the provider adapter and its credentials sit in the per-provider directory. Where a neutral tool covers a step, provider-specific code for it is not committed.

15. **Matrix replaces the mailbox.** Matrix is the one message bus for peers. The peer-link file mailbox is deprecated and removed, not bridged; the API is designed for the target system, not as a port of the mailbox's.
16. **Private network.** The VPS and the dev box, both in OVHcloud Singapore, link over OVHcloud's private network where it can.

**Ruling (owner, 2026-11-27, tenth round).** Shown a draft where the bridge mirrored mailbox envelopes into Matrix, Scott: "I don't know that we should be piggybacking on the mailbox for this? feels like this just replaces the mailbox entirely?" Then: "we should be able to link the two boxes together inside ovhs private network - they're both in singapore. also please rethink the api in the context of 'what does the correct final design look like' too - the old mailbox system is just a separate thing we're deprecating/removing".

**Recorder's reading of the tenth round (Claude, 2026-11-27).** Rules 14 and 16 together: the private-network attachment is provider setup under `providers/ovh/`; the core sees a peer address and runs WireGuard to it either way, so a move off OVHcloud changes the address, not the core. Whether an OVHcloud VPS can join the private network (vRack) was not confirmed on an official page on 2026-11-27.

17. **Watched channels are Matrix membership plus notification level.** A peer watches a room it has joined at "all messages"; its digest covers those rooms only. At "mentions only" it stays a member and only @mentions push. A non-member is reached by invite, and the invite is pushed; a peer's `send` invites a non-member it @mentions. *Twelfth round; replaces the eleventh round's separate watch list.*

**Ruling (owner, 2026-11-27, eleventh round).** Scott: "one more tweak to the design - each session should probably be able to decide which channels it cares about - it shouldn't check unread messages on channels its not currently 'watching' unless it gets @'ed".

**Recorder's reading of the eleventh round (Claude, 2026-11-27).** Watching is separate from Matrix room membership: membership makes an agent reachable and visible, watching decides what its digest covers. The watched set is stored per peer name, so a restarted session of the same peer keeps it. *Superseded by the twelfth round.*

**Ruling (owner, 2026-11-27, twelfth round).** Scott found the separate watch list "a bit messy" and asked: "wonder if watch and room membership should just be the same thing? whats the standard way this works in matrix clients?" Claude described Matrix's model (membership, a per-room notification level of all messages / mentions and keywords / mute stored as the user's push rules, invites to reach non-members) and recommended it over both the watch list and membership alone. Scott: "yeah this sounds good to me". Rule 17 states the result. Membership and notification levels live on the server as standard Matrix state, so the owner sees and changes the same settings in Element.

18. **No send queue.** When the chat server or the link is down, `send` fails with the reason and the agent reports it.
19. **Room names and archiving.** `#feat-<slug>` for feature threads, `#topic-<slug>` otherwise. A room with no message for 14 days is archived and listed in a weekly digest to the owner.

**Ruling (owner, 2026-11-27, thirteenth round).** On the work order's Q-a (fail loud, no local queue) and Q-b (naming and 14-day archiving), both as recommended, Scott: "a. agree / b. agree".

20. **Readable names.** Every session shows a readable name. Identifiers such as session ids go in the user's status or profile fields where Matrix supports them, not in the name.

**Ruling (owner, 2026-11-27, fourteenth round).** On the work order's Q-d (keep `claude-<uuid>` as the account id with a readable display name), Scott: "yeah we should make sure each session has a readable name, and put stuff like session ids in statuses/bios if matrix supports that".

**Recorder's reading of the fourteenth round (Claude, 2026-11-27).** The account id stays the unique peer name; the readable name is the Matrix display name. A session with no name of its own gets one derived from its repo and role, made unique by chatd. Which status or profile fields Element X shows is checked in stage 2.

21. **Domain.** The server's name is under the owner's domain `sjmcd.me`, registered with Namecheap.

**Ruling (owner, 2026-11-27, fifteenth round).** On the work order's Q-c, after Claude recommended a domain over the bare IP because the Matrix server name cannot change and an IP ties it to one box (rule 14), Scott: "alright, cool yeah I do own a domain - sjmcd.me - through namecheap - not sure if namecheap has an api but we can always drive the web ui through devtools mcp or something in a session on the macbook".

22. **Server name `chat.sjmcd.me`.** Accounts read `@pi-<name>:chat.sjmcd.me`; the VPS serves everything for that name. Its `A`/`AAAA` records are set by hand at Namecheap; the infra repo lists the records it expects and the deploy checks they resolve.

**Ruling (owner, 2026-11-27, sixteenth round).** Asked "So: `chat.sjmcd.me`, with the records set by hand?", Scott: "yeah lets go with chat.sjmcd.me".

**Recorder's reading of the sixteenth round (Claude, 2026-11-27).** "Yeah" is read as accepting the whole question, including records set by hand; the reply named only the server name.

**Fact (Claude, 2026-11-27): no vRack for VPSs.** The owner found no way to attach the VPSs to the account's vRack. OVHcloud staff wrote in October 2025 that vRack is not planned for VPS and is dedicated to Public Cloud ([ovh/infrastructure-roadmap#367](https://github.com/ovh/infrastructure-roadmap/issues/367)). Rule 16 applies "where it can", so it does not here: WireGuard runs over the public addresses.

23. **Dev-box WireGuard is applied by the owner.** The session has no root on the dev box; stage 1 produces the dev-box `[Peer]` stanza and command, and the owner runs them.
24. **Backups are OVHcloud's automated VPS backup.** The infra repo builds no backup of its own. On 2026-11-27 the VPS's `automatedBackup` was `enabled`, daily at 10:26, rotation 1 (one restore point).
25. **Infra repo remote:** private GitHub `pcone/infra`.

**Ruling (owner, 2026-11-27, seventeenth round).** Asked how the dev-box side of WireGuard gets applied, Scott picked "I apply it (Recommended)". Asked where backups go, he answered: "I believe we already get backups managed by ovh - it was part of the black friday deal". Asked where the infra repo lives, he picked "Private GitHub pcone/infra (Recommended)".

**Recorder's reading of the seventeenth round (Claude, 2026-11-27).** Rule 24 is provider-managed state outside the repo, so rule 14 is not engaged. With rotation 1, damage noticed more than a day late cannot be restored; a portable backup is not built until the owner asks for one.

**Ruling (owner, 2026-11-27, eighteenth round).** Scott, on rule 24: "I'm fine with provider managed backups for this - would rather than than paying for separate storage resources again".

26. **VPS SSH over WireGuard only.** The VPS admits SSH on `wg0` only, as the dev box does.

**Ruling (owner, 2026-11-28, nineteenth round).** Shown a scan where the VPS answered on public TCP 22, 80 and 443, Scott: "yeah ssh on the VPS should be wireguard only - is it possible for the caddy (I assume this is needed for matrix?) to be wireguard only too? I don't need to access it from anything other than devices that I can install wireguard on".

27. **HTTPS over WireGuard only.** Caddy answers on `wg0` only; `chat.sjmcd.me` resolves to `10.213.47.10`. Certificates come from Let's Encrypt by DNS-01: `_acme-challenge.chat.sjmcd.me` is delegated by CNAME from Namecheap to deSEC, and Caddy writes the challenge there. The owner's MacBook and phone are WireGuard peers of the VPS. The only public port left is WireGuard's UDP port. LLMNR is turned off on the VPS.

**Ruling (owner, 2026-11-28, twentieth round).** Offered DNS-01 through a deSEC-delegated challenge name (recommended), a private CA, or a public port 80 for ACME, with the owner's devices as direct VPS peers, Scott: "your recommendations sound good".

**Not ruled yet:** nothing in this decision.