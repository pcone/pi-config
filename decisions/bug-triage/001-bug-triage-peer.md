---
title: "Bug-triage peer — a standing intake role, not a 4th mode"
type: decision
status: done
date: 2026-08-13
---

# Bug-triage peer

**What:** A long-running session, launched `pi --name bug-triage`, that
owns an intake queue for bugs in `main` — not regressions a session
introduces in its own WIP (those each session fixes itself).
`extensions/bug-triage.ts` injects `agents/bug-triage.md` into that one
session's system prompt; reporters hand off via `peer_send`.

**Why ownership transfer, not delegation:** a subagent's lifecycle is
scoped delegation — task → report → gate → merge → die — with a bounded
deliverable. A bug handoff has no single report to gate and no bounded
scope; it's an open-ended investigation. The caller wants to stop
thinking about it, not manage a return report. That's a persistent
owner — a peer session.

## Why not a 4th mode in modes.ts (the obvious alternative)

- **Axis mismatch + cycle pollution.** The three modes are one axis —
  *operational style for work a session has taken on* (do it directly /
  dispatch / super-orchestrate), cycled via `/mode`. bug-triage is a
  *concurrent role*, not a style. `implement → orchestrate → plan →
  bug-triage` is nonsensical.
- **Global-default clobber.** `saveMode` writes both the per-project
  file *and* the global fallback `~/.pi/agent/modes.json`. The
  per-project file is per-clone, but `/mode bug-triage` would clobber
  the global default — every new session everywhere would come up in
  bug-triage mode until changed.

A name-triggered peer carries no mode state, so nothing to clobber.

## Alternatives considered

- **4th mode, excluded from the cycle, stored per-session.** Rejected:
  "a mode that isn't a mode" — needs a second storage path; the name
  trigger gives per-session isolation for free.
- **A subagent, not a peer.** Rejected: wrong lifecycle (above).
- **A git worktree of one reporter's clone.** Rejected: couples the
  peer to one clone and blinds it to the others; one-clone-per-session
  is already convention, so a 4th clone is simpler.
- **File-only — never fix.** Rejected as default: loses the speed the
  user wanted for one-line fixes. Kept for non-trivial bugs.

## Trigger: session name, not env var

The role activates on the session **display name** being "bug-triage"
(`pi --name bug-triage`), not on `PI_PEER_NAME`. An env var is ambient:
`export PI_PEER_NAME=bug-triage` then reusing the terminal for an
unrelated `pi` would quietly reactivate the role in the wrong session.
`--name` is a per-invocation CLI arg that can't leak into the shell, so
the role fires only for a session explicitly launched as the triage peer
(and reactivates correctly on `/resume` of that named session).

The same `--name` drives peer-link's mailbox identity too: `peerIdentityFrom`
(peer-link) falls back to the session display name when `PI_PEER_NAME` is
unset, so `pi --name bug-triage` is the complete launch — reporters
`peer_send` to "bug-triage" and it reaches this session, no env var.
`sanitizePeerName` rejects human-readable names (spaces), so only
name-shaped display names become identities; casual names fall through to
the filename, keeping the display-label-vs-routing-key distinction intact.
A stale `PI_PEER_NAME=bug-triage` in the shell would still hijack that
identity for an unrelated session, so the extension warns if it's set
without the name.

## Trivial-fix policy

Draft PR from the peer's own clone (branch off `main`, turn the
`.cases` green). "Trivial" is a judgment agents misjudge — an
unreviewed in-place fix that mis-root-caused the bug is a regression
with no gate. Draft-PR keeps the speed without that risk; the review
gate still owns the merge.

## Tradeoffs

- **No auto-spawn.** Launched and pinned manually (`/pin bug-triage`);
  if down, a handoff queues silently until TTL and the reporter thinks
  it's handled. Mitigation: reporters check `peer_list` first
  (APPEND_SYSTEM) and fall back to filing.
- **`main`-only scope.** The peer hands back anything that reproduces
  only on the caller's branch — keeps it from becoming a dumping ground
  for every session's WIP regressions.
- **Name is the contract.** `bug-triage` is hardcoded; renaming is
  coordinated across reporters. Two sessions on the same name collide
  on one mailbox identity.

## Files changed

- `agents/bug-triage.md` — the role prompt.
- `extensions/bug-triage.ts` — name-triggered injection (role into
  system prompt + one-shot kick-off); no-op for every other session.
- `extensions/peer-link/` — `peerIdentityFrom` (mailbox.ts): identity
  chain now falls back to the session display name before the filename,
  so `pi --name bug-triage` supplies the mailbox identity too (no env var).
- `settings.json` — register the extension.
- `APPEND_SYSTEM.md` — reporter handoff clause.
- `README.md` — extension entry.

## Test coverage

`tests/bug-triage.test.ts` — `isBugTriagePeer` predicate (name match,
trim, miss, unset, subagent guard, and the regression: a stale
`PI_PEER_NAME` without the name must not fire).
`tests/peer-link.test.ts` — `peerIdentityFrom` (env → display name →
file → pid) and `deliveryDecision` (the `requireOnline` gate). The
injection path mirrors `append-system-local.ts` (likewise untested).
