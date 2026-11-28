# WO: `#peers` holds every account

Carries 015/40 (owner 2026-11-28). Slug-only until dispatch (`rules/work-order-numbering.md`).

## Goal

Every puppet chatd has registered is a member of `#peers` at all times it can act on, and the owner holds an invite when he is not a member.

## Today

`register` (`apps/chatd/daemon.ts`, after the profile writes) invites and joins a puppet missing from `#peers`. The `rooms` verb's `leave` passes `#peers` through. `onMember` does not react to a puppet leaving `#peers`. A puppet that left stays out until its next `hello`, and an offline one stays out indefinitely.

## Changes

1. **One funnel.** `ensurePeers(user)` invites and joins a puppet that is not joined. `register` calls it in place of its inline block.
2. **Leave refused.** The `rooms` verb refuses `leave` on `#peers`, with an error naming 015/40.
3. **Leave undone.** `onMember`, on a `leave` or `ban` of a puppet in `#peers`, calls `ensurePeers`. A ban is lifted first, since `@pi-system` holds the power to do it.
4. **Startup reconcile.** After `ownedRoom("peers")`, chatd reads `#peers` membership state and calls `ensurePeers` for every `@pi-*` user whose membership is `leave` or `ban`. It re-invites the owner when his membership is `leave`.

## Preparatory refactor

`daemon.ts` is flag 1 in `docs/investigations/structure-trend.md` (1,307 lines, then 1,375): "its next chunk extracts the verbs and the wait registry before adding to it". This change adds to the verbs (`rooms`) and the rooms chatd owns (`ownedRoom`). So it lands that split first, behind the existing chatd tests passing unchanged: the socket verbs, the wait registry, and chatd's own rooms (`ownedRoom`, `mirror`, `sweepMirror`, `certificateWatch`, `systemDm`) each move to their own module.

## Acceptance

- A puppet's `rooms leave #peers` is refused, and the puppet is still a member.
- A puppet removed from `#peers` by another account (owner kick) is rejoined within one transaction.
- A puppet that left while chatd was down is a member again after chatd starts, without a `hello`.
- The owner, after leaving `#peers`, holds an invite again after the next startup.
- `rg -n 'invite\(.*peersRoom' apps/chatd` → one site, in `ensurePeers`.

## Open question (owner)

- **Q-a, the six test puppets.** The startup reconcile rejoins every puppet that was ever a member, including the two leaked test puppets and the four smoke puppets, which left. Recommended: the owner deactivates them before this lands (`!admin users deactivate @pi-<name>:chat.sjmcd.me`). After that, a deactivated account is skipped.
