---
title: "A seat checkout fast-forwards to its upstream at session start"
type: decision
status: active
date: 2026-11-08
---

# A seat checkout fast-forwards to its upstream at session start

**Ruling.** At `session_start` in a clone's main checkout, `extensions/seat-sync.ts`
fetches and runs `git merge --ff-only @{u}` when the tree is clean and the branch is
not ahead. Every other state is a warning naming the evidence: dirty paths, the
ahead or diverged counts, or the fetch's stderr — or, when the fetch it joined
captured none, that it captured none. A `git worktree` (`.git` is a file) and any
path beneath `wt/` are never touched.

The fetch runs in a task `session_start` does not await. It is the one shared
checkout fetch, joined by `owner-asks` (`extensions/lib/git-fetch.ts`), and it is
killed after 10 s.

**Why.** Measured 2026-11-08: `~/Developer/tfd` was 550 commits behind
`origin/hamster`, `~/Developer/tfd-d` 881. Every seat session starts in its main
checkout, so it reads that checkout's `APPEND_SYSTEM.md`, docs and decision records
— a session working from instructions days old, with nothing announcing it. No code
path synced a seat checkout; `owner-asks` fetched only to count registry asks.

**Why the fetch is shared rather than added.** `owner-asks` already fetched this
checkout once per five minutes. Its fetch is detached and unobserved, so it could
not gate a fast-forward, and a second one would download the same pack twice.
One function is the only shape where at most one fetch is in flight per checkout:
the first caller spawns, the second joins the same promise. Two callers that do
not overlap still fetch twice — "fetched recently enough" stays `owner-asks`'
five-minute stamp, not this module's.

The shape a caller asks for fixes what the outcome can say. `seat-sync` waits, so
it gets git's stderr and can quote a `fatal:` line. `owner-asks` does not wait —
the statusline and `/asks` CLIs must exit at once — so its fetch is detached with
stdio ignored and captures no stderr. A `seat-sync` that arrives while that
background fetch is running joins it and inherits the limit: the warning says
`stderr not captured: joined a background fetch` rather than quoting git.
`owner-asks` ignores the outcome either way.

**Alternatives rejected.**

- *Fetch inside the awaited `session_start` handler.* pi awaits the handler before
  the first prompt (`agent-session.js:2680`), so an offline or slow remote would
  hold the session. The extension reports instead; a single prompt is not worth a
  network RTT it may never get.
- *`git reset --hard` or `stash` + merge, so a dirty tree syncs too.* Both destroy
  or hide work that is not the extension's, on a checkout the owner may be using.
  A dirty seat warns and stays where it is.
- *A non-fast-forward merge on divergence.* It resolves a conflict the extension
  cannot see, and produces a commit nobody asked for on a seat's main branch.
- *Syncing worktrees too.* A worktree shares another checkout's refs; moving it
  moves a tree a subagent or a hand-made branch owns.
- *Blocking until refs move, when a fetch is already in flight.* Joining the
  in-flight promise is that, without a poll.

**Given up.** A 10 s fetch bound means a seat further behind than 10 s of network
keeps its refs and warns — no partial fetch is retained. A dirty or diverged seat
stays stale until a human acts; the warning is the whole mechanism.
