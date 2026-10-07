---
title: "Recovery scan ownership — adopt a subagent socket only when its spawning process is this process or is gone"
type: decision
status: done
date: 2026-10-06
---

# Recovery scan ownership

**What.** The `session_start` orphan-recovery scan in
`extensions/subagent-async/index.ts` no longer adopts every
`/tmp/pi-subagent-*.sock` with a matching meta file. Adoption is gated on the
spawning process's identity, written into the meta file at spawn:

- `ownerPid` — the spawning pi process's pid.
- `ownerStartToken` — an OS start-time token for that pid (Linux
  `/proc/<pid>/stat` field 22; macOS/BSD `ps -o lstart=`) so a recycled pid is
  not mistaken for the original owner.

`recoverOrphanedSubagents` adopts only when:

1. the owner pid **IS this process** (`/reload`, `/new`, and session switches
   keep the old process alive and its socket server listening — this is the
   recovery path the scan exists for), or
2. the owner process **is gone** (pid absent, or pid present with a start token
   that does not match the recorded one → the pid was reused).

A **live foreign owner is skipped**. The adopted client socket is `unref()`ed
unconditionally, so a recovery connection can never pin the event loop. Legacy
metas (no `ownerPid`) are skipped: ownership cannot be established, and
adopting a stranger is the bug being fixed. Spawn-time handles (child `proc`,
its stdio pipes, the spawn `sockServer`) stay referenced on purpose.

**Why.** `pi -p --tools subagent …` stayed alive indefinitely while any other
live pi session had a running subagent. At `session_start` the scan found those
foreign sockets, connected to them, and kept the client fds referenced — so the
print-mode process could not drain. The foreign child's completion then closed
the borrowed connection and the scan delivered
`[Isolation] Recovered from previous session.` into the wrong session. Measured:
198 s to a child that finished at ~40 s; the parent held 3 unix socket fds.
Moving every `/tmp/pi-subagent-*.meta.json` aside made the same command exit
~7 s after its own child.

The meta file carried no owner identity, so the scan could not tell a genuine
orphan from another live session's child. The safe direction is asymmetric: a
false "owner alive" only skips a best-effort recovery, while adopting a
stranger's child delivers someone else's work into this session and pins the
process.

**Owner model ruling.** "Owner" is the spawning **process**. A same-process
owner is adopted even though it is alive, because the previous *session* in
that process is gone and its socket server is still listening; the raw
"owner alive → skip" rule alone would silently kill `/reload` recovery. A dead
owner is adopted best-effort — but note the socket server dies with its owner
process, so a genuinely dead owner's connect typically fails and the stale sock
is unlinked (unchanged from before). "Discover, track and deliver a genuine
orphan" is preserved for the case it can work: an orphan whose owning session
was replaced but whose process (and therefore socket server) is still alive.

**Alternatives rejected.**

- *`unref` the recovery client only.* Fixes the hang but still attaches to
  strangers and still delivers their completion into the wrong session.
- *Pid-only liveness.* Races pid reuse; a recycled pid reads as "owner alive".
  The peer that owns the neighbouring work confirmed this; the start-time token
  closes it.
- *Skip recovery in `-p` sessions only.* Not general — a TUI session must not
  adopt a stranger's child either — and it re-introduces a print/interactive
  split where none is needed. No genuine additional distinction was found.
- *Decide liveness by whether the socket connects.* A live stranger's socket
  connects exactly like a live same-process one; connectivity cannot distinguish
  them. Ownership must be recorded, not inferred.
- *Adopt legacy metas (no owner field).* Cannot establish ownership; adopting
  them is indistinguishable from the bug. They are skipped. Cost: a one-time
  loss of recovery for pre-027 orphans.

**Tradeoffs.** Pre-027 orphans are no longer recovered (documented, one-time).
A dead-owner orphan still cannot be tracked once its owner process is gone,
because the socket server was the only tracking channel; this is unchanged and
is not a regression.

**Re-litigation proofing.**

- The bug is not "recovery is too eager"; it is "recovery has no ownership
  predicate". Any fix must record and compare owner identity, not weaken or
  disable recovery.
- A pid alone is insufficient — the start token is required, or pid reuse
  silently re-creates the bug.
- Same-process adoption is load-bearing for `/reload`; do not "correct" it to a
  blanket owner-alive skip without first proving the reload path no longer
  depends on the scan.
- `unref` is about the *recovery* connection only. The spawn handles must stay
  referenced so a parent waits for its own child.

**Ratified (orchestrator, 2026-10-06).** The work order's acceptance (c) — a
new *process* recovering a dead owner's orphan — is not satisfiable and never
was: the socket server lives in the owning process, so it dies with it and a
new process's `connect` gets ECONNREFUSED. Recovery means same-process session
replacement (`/reload`, `/new`) plus dead-owner socket cleanup, which is what
the scan can serve; the process-death reading is dropped rather than
implemented. Verified end-to-end after the merge: with a live foreign subagent
socket present, a `pi -p` run that dispatches its own child exits on that
child's completion (dispatch 7s → exit 27s), zero stale-ctx errors, zero
"[Isolation] Recovered" deliveries.

**Files changed:** `extensions/subagent-async/index.ts` (owner record via
`buildSpawnMeta` at the spawn `writeMetaJson` call, `processStartToken` /
`selfStartToken` / `isOwnerAlive` / `decideRecoveryAdoption`, extracted
`recoverOrphanedSubagents`, `unref` on the recovery client, `_testSetRecoveryScanDir`
test seam), `tests/subagent-recovery-ownership.test.ts`, this decision, index.

**Test coverage:** `tests/subagent-recovery-ownership.test.ts` — the
adopt/skip matrix (live foreign → skip, dead → adopt, recycled pid → adopt,
unreadable/missing/empty token → skip, same-process → adopt, legacy → skip);
the real `defaultOwnerProbe` / `processStartToken` (live self, bogus pid, EPERM
vs ESRCH, invalid-pid guard, real start token); `buildSpawnMeta` stamps the
spawning process's identity (the input the gate reads); the scan with an
injected directory + fake socket (adopted orphan is tracked and its client
`unref()`ed, delivered on close; foreign/legacy/malformed metas never open a
connection; dead-listener dropped and its stale sock unlinked; already-tracked
sid not re-adopted; connect path asserted); and the real `session_start`
handler adopting a self-owned socket from an injected directory (the
handler→scan wiring).

**Footnote (2026-10-08): the child's session file is not a liveness signal.** pi
creates a session file lazily when spawned with `--session-id` — it does not
exist until the first turn's appends (observed: a bare `get_state` on a fresh
`--session-id` session leaves no file behind). Presence or mtime therefore
cannot distinguish a live child from a dead one: right after spawn the file is
absent, and under load a stale mtime reads as death. Liveness stays on
`ownerPid` + `ownerStartToken` (and the socket) as ruled above. This cost a
1-in-4 full-suite flake in decision 031's spawn tests before it was identified;
the same correction was made independently in the tfd repo's
`docs/plans/git-coordination.md` (commit `68e3ff8a`).
