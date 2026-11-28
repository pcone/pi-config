---
title: "Seats have fixed names; one Claude dispatcher; design work in rooms"
type: decision
status: active
date: 2026-11-28
---

# Seats have fixed names; one Claude dispatcher; design work in rooms

**Ruling.**

1. **Fixed seat names, not tied to features.** The three tfd pi orchestrator lanes are `alpha`, `beta` and `gamma`. Each lane's clone directory carries the same name. `tfd-triage` keeps its name: it is a role, not a lane.
2. **One Claude dispatcher, `charlie`.** One Opus Claude Code session dispatches to all three pi orchestrators. It replaces the one sibling Claude orchestrator per lane.
3. **Design work lives in long-running rooms, not long-running sessions.** Each design concept has a room. Any session the owner starts for design work joins the room, reads it and the records, and works there. Design sessions never dispatch. A design room may hold models other than Claude.

The state that must survive a session is in records (decisions, briefs, the question registry) and the room's history. A session's context is a cache of those, which compaction loses anyway, so no session is load-bearing. Restarts cost one catch-up read, and two sessions can work one concept.

**Rejected: a long-running Claude session per concept.** Its context becomes the only copy of reasoning the records never got, and losing the session loses it.

**Ruling (owner, 2026-11-28, over Matrix).** Scott: "can we go with descriptive names for sessions? probably alongside a rename of the dir for the clones to match - currently we have tfd, tfd-d and tfd-threading - I want three recognizable names that *aren't* tied to specific features". On orchestration: "I think for efficiencies sake we should probably just have one opus session dealing with dispatch to all three orchestrators, and that per lane design work would be done in separate claude sessions that don't directly dispatch." Offered tree, river or star names: "lets go with greek letters/symbols for the pi sessions to keep the obvious equivalence / for the claude dispatcher, go with charlie". On design sessions he was "torn between a long running session for each concept, and more of an approach where we have a long running room but have a pool or more general sessions to work with on the design?" Offered rooms with general sessions, recommended: "yeah I think that's nice - it would also allow us to have other models contribute to a design session, not just claude".

On the mechanism, after the work order's draft proposed a variable for the Claude name, Scott: "on the names - for permanent sessions we should name the session in claude, and use the same name in matrix".

4. **A permanent session's own name is its chat name.** The session is named where it runs (Claude Code `--name` or `/rename`; pi `--name`), and chatd uses that name.

**Recorder's reading (Claude, 2026-11-28).** "Greek letters … to keep the obvious equivalence" is read as alpha, beta, gamma in lane order, with the directories named `tfd-alpha` and so on, and the peer names `alpha`, `beta`, `gamma`.

**Not ruled yet:** the mechanisms, in `work-orders/WO-seat-names.md` § Open questions.
