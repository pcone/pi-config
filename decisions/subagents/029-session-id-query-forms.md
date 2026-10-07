---
title: "Session id query forms and the not-attached message contract"
type: decision
status: active
date: 2026-10-07
---

# Session id query forms and the not-attached message contract

**Ruling.** Every id-taking entry point accepts the same forms: the full
`subagent-<uuid>`, the bare uuid, any tail of 8+ characters with or without the
`subagent-` prefix, a tail spanning the prefix boundary
(`-ac5fe548-…-c3587cc8c12e`), and surrounding whitespace. An empty or
prefix-only query matches nothing. The meta scan keeps its exact-match-then-throw
ambiguity rule; the running-map lookups (`/watch`, `/attach`) take the first
match. `describeUnknownSession` is the one not-attached message for the four
tracker tools, and it states **only observed facts**.

**Why.** On 2026-10-07 a prefixed tail query (`subagent-c3587cc8c12e`) was
answered "No running subagent found" because the stored id was matched with
`sid.endsWith(sessionId)` on a key that already carried the prefix — a query in
the prefixed display form could never be a suffix of it. The orchestrator read
that sentence as death and force-committed and force-removed three live
worktrees, destroying uncommitted work in two. The same failure mode lived in
the message for a second reason: one flat string collapsed four different states
(`id matches nothing`, `running under another session`, `attached here`, `not
running`) into a single reading, so any lookup miss looked like a dead child.

**Alternatives rejected.**

- *Patch only the call site that failed* (strip the prefix in `/watch` or in the
  tool): three matchers had already drifted apart, and the drift is what let the
  prefixed form work in one place and fail in another. One predicate
  (`idMatchesQuery`) that matches a suffix of a stored handle with or without its
  `subagent-` prefix: both stores key by the full handle (the running map
  directly, meta files as `pi-subagent-<handle>.meta.json`), so one predicate
  covers every surface and none can drift. An earlier version canonicalized the
  stored id first on the assumption that meta files were keyed by a bare uuid;
  they are not, and the branch was dead — removed rather than documented.
- *Keep one not-found string and append a hint*: the sentence itself was the
  bug — it asserted a state the code had not established. A hint does not undo
  "found nothing, so it must be dead".
- *Require the exact full id*: breaks the documented "8+ character tail" usage
  and makes the orchestrator copy a 45-character string it usually sees
  truncated in logs.
- *Probe the socket to prove liveness* (`net.connect`): the four tools are
  synchronous text-returning lookups, and a probe would make the message depend
  on a race rather than on facts. Report the facts (socket file present or
  absent, owner recorded or not, owner alive or gone) and let the owner session
  settle the child's state.
- *First-match-wins nowhere / ambiguity throw everywhere*: a tail collision at
  8+ hex characters that the tool descriptions recommend is a 32-bit
  coincidence, and `/attach` has no error channel for
  it; the meta scan throws because it is the path where a wrong pick costs a
  wrong-session recovery.

**Consequences.** `describeUnknownSession` claims "Running under another
session" only when a socket file exists *and* a recorded owner process is still
alive; every other combination reports the two observed facts verbatim. The
phrases "No running subagent found" and "finished or been stopped" are gone from
live output — the first because it is false for a live child, the second because
a live parent can own a dead child (the socket, not the owner pid, is that
distinction). A legacy meta with no `ownerPid` can no longer render "pid
undefined is alive". Tool and command parameter descriptions name the accepted
forms, so the contract is discoverable without reading this record.
