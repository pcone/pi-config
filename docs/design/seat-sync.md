# Seat checkout sync

A seat starts its session in the clone itself (`~/Developer/tfd`,
`~/Developer/tfd-d`). A clone days behind `origin` means the session's
`APPEND_SYSTEM.md`, docs and decision records are those of a checkout days old.
This extension fetches and fast-forwards that checkout at `session_start`, and
says so loudly when it cannot.

Code: `extensions/seat-sync.ts` (the `session_start` wiring),
`extensions/lib/seat-sync.ts` (gate, decision, report),
`extensions/lib/git-fetch.ts` (the shared fetch). Ruling:
`decisions/sessions/002-seat-checkout-sync.md`. Tests:
`tests/seat-sync.test.ts`.

## What runs, and when

`session_start` is awaited before the first prompt
(`dist/core/agent-session.js:2680`), so the handler does two cheap things and
returns: it reads the scope, and it starts a task it does not await. The fetch,
the decision and the fast-forward all live in that task. A fetch that never
returns therefore costs the session nothing; the report simply lands late.

```
session_start ─ gate (statSync) ─┬─ not a seat → return
                                 └─ seat → task: upstream probe → fetch → status
                                                  → counts → ff-only merge → report
```

## The scope gate

A seat is a clone's main checkout: a `.git` **directory** whose branch has an
upstream. Two shapes are never seats, whatever their `.git` looks like:

| cwd | verdict | why |
| --- | --- | --- |
| `.git` is a file | `worktree` | a `git worktree` shares another checkout's refs; syncing it moves a tree something else owns |
| any `wt` path component | `wt-path` | `~/Developer/wt/…` and `~/Developer/wt/subagents/…` are hand-made and harness worktrees |
| no `.git` at all | `not-a-clone` | not a repository, or a subdirectory riding the checkout a session started at its top |

The verdicts are `seatScope()`'s, and the gate is filesystem-only so it stays off
the network. Roughly every session on this box is a `wt-path`: the cost of the
gate is 0 ms (measured below).

## The fetch, and why it is shared

One `git fetch --quiet` per checkout per process, in `lib/git-fetch.ts`.
`owner-asks` already fetched (`extensions/owner-asks/lib.ts`, once per five
minutes, for its `@{u}` ask counts) — that fetch was detached and unobserved, so
it could not gate a fast-forward, and a second fetch would download the same pack
again. Both callers now use one function: whoever asks first spawns, the second
joins the same promise. `owner-asks` still ignores the result (its counts read
whatever refs land); `seat-sync` awaits it.

The fetch is killed after 10 s (`FETCH_TIMEOUT_MS`), including a remote waiting
on credentials (`GIT_TERMINAL_PROMPT=0`). A seat further behind than 10 s of
network reaches keeps its current refs and reports the timeout — the next session
tries again.

## The fast-forward rule

`git merge --ff-only @{u}`, and nothing else: no `reset`, no `stash`, no non-FF
merge. It runs only when the tree is clean (`git status --porcelain -uall` empty)
and the branch is not ahead (`rev-list --count --left-right @{u}...HEAD` → behind
only).

Everything else is a report, in this order of precedence:

| state | status note |
| --- | --- |
| dirty tree | `seat sync: BLOCKED — N dirty files`, up to 10 paths with their status codes, then `… and N more` |
| diverged | `seat sync: BLOCKED — diverged from origin/main: A ahead, B behind` |
| ahead | `seat sync: BLOCKED — N commits ahead of origin/main`, first three subjects |
| behind, clean | `seat sync: fast-forwarded N commits` |
| up to date | no note (a stale note is cleared) |

Dirty outranks divergence because a fast-forward needs a clean tree whatever the
counts say; divergence outranks ahead because it needs both numbers to be
understood.

A branch with no upstream is skipped silently and spends no fetch: it has nothing
to fast-forward to.

## Where the report is seen

- Status line, key `seat-sync`. A blocked checkout is drawn in the warning colour.
- A warning notification for every blocked outcome — the paths, subjects or
  stderr, and one sentence saying nothing was moved.
- `PI_SEAT_SYNC_DEBUG=1` adds an info line with the exact git invocations and the
  outcome, including for a skip or a no-op. Without it, a no-op says nothing.

Print/RPC mode has no status line, so a warning goes to stderr there.

## Cost

Measured 2026-11-08 on this box (local bare remote, warm fetch cache, 20 runs;
`session_start` blocking time is what pi awaits before the first prompt):

| session | blocking | total | git invocations |
| --- | --- | --- | --- |
| any `wt/` session (the common case) | 0.00 ms | 0.00 ms | 0 |
| seat, up to date, warm fetch | 2.7 ms | 228 ms | 4 |
| seat, 1 commit behind → fast-forward | 2.3 ms | 297 ms | 5 |
| seat, fetch stubbed to 3 s | 2.0 ms | 3 145 ms | 4 |

The budget for always-on blocking work is 300 ms. The blocking column is the
whole of it; everything that spawns git is in the unawaited task, so the total
column is latency of the report, not of the first prompt.

## Not covered

- A session started in a subdirectory of a seat (`~/Developer/tfd/docs`) is
  `not-a-clone`. The checkout is synced by the session that starts at its top.
- The fetch does not prune deleted remote branches, and adds no `--depth`.
- Nothing syncs a `tfd`-style *registry* branch other than the branch's own
  upstream: `origin/hamster`, not `origin/main`.
