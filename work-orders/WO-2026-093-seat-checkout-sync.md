# WO-2026-093 — a seat's main checkout fast-forwards to its upstream at session start

### Metadata

- **work_order_id**: WO-2026-093
- **parent_plan_id**: owner 2026-11-08 — seat clones are days behind `origin`; each seat starts in its main checkout, so it loads stale instructions and docs.
- **sequence_position**: 1 of 2 (sibling: WO-2026-094, record appends).
- **routed_to**: implement
- **priority**: high
- **estimated_complexity**: moderate
- **review_policy**: required
- **turn_budget**: planned **70** turns, cap **100**. Report `planned / cap / actual`. Targeted rows only — never the full `bun test` (box-wide `flock` slot; the orchestrator gates it). Tell any reviewer you spawn the same.
- **base**: the tip of `origin/main` at dispatch

### Task Summary

**One-sentence description**: at session start in a clone's main checkout, fetch and fast-forward to its upstream when that is safe, and warn loudly with the evidence when it is not.

**Goal**: a seat's first prompt reads current instruction files, and a checkout that cannot be fast-forwarded says so in a way nobody misses.

### Premise

Measured 2026-11-08: `~/Developer/tfd` is **550** commits behind `origin/hamster`; `~/Developer/tfd-d` is **881** behind. Each seat session starts in its main checkout, so its `APPEND_SYSTEM.md`, docs and decision records are those of a checkout days old. No code path syncs a seat checkout: `git fetch` runs in `owner-asks` for a status count and never merges.

### Mechanism

A new extension, `extensions/seat-sync.ts`, on `session_start`, for the **current checkout**:

1. **Scope gate.** Skip unless the cwd is a clone's main checkout — a `.git` *directory* whose branch has an upstream (`@{u}`). Skip inside `wt/` and inside any subagent worktree: a tree whose `.git` is a *file* is a worktree, never a seat checkout.
2. **Fetch**, bounded to 10 s and never on the turn path: run it detached from the first prompt (the session must not wait on the network), but the FF decision waits for it.
3. **Fast-forward only** when `git status --porcelain -uall` is empty **and** `rev-list --count @{u}..HEAD` is 0. Command: `git merge --ff-only @{u}`. Never `reset`, never `stash`, never a non-FF merge.
4. **Loud when it cannot.** Dirty: name up to 10 paths with their status codes, plus the total. Ahead: name the commit count and the first three subjects. Diverged: say both numbers. A fetch failure: its stderr, one line.
5. **Report where it is seen:** a status-line note (`seat sync: fast-forwarded 550 commits` / `seat sync: BLOCKED — 3 dirty files`), and a `PI_SEAT_SYNC_DEBUG=1` line with the exact commands.

### Prohibitions

- No `reset`, `checkout --force`, `stash`, or non-FF merge, ever.
- Never touch a worktree (`.git` is a file) or any path under `wt/`.
- Never block the first prompt on the fetch; a slow or offline remote degrades to a warning.
- No second sync path: if `owner-asks` or anything else already fetches for this checkout, reuse that fetch rather than adding a parallel one (state which you found).

### Verification Criteria

Each row with its mutation, run alone:

- **R1** clean and behind → fast-forwarded; HEAD equals the upstream afterwards.
- **R2** dirty → not moved, warning names the dirty paths.
- **R3** ahead (`@{u}..HEAD` non-empty) → not moved, warning names the commit count.
- **R4** diverged → not moved, warning names both counts.
- **R5** up to date → no-op, no warning.
- **R6** a git worktree (`.git` a file) → gate skips it entirely.
- **R7** a repo with no upstream → skipped, no warning.
- **R8** fetch fails (fake runner, non-zero) → no FF attempted, warning carries stderr.
- **R9** the session is not delayed: with a fetch stubbed to never return, the first prompt is served.

### Cost — measure, do not assert

Wall time added to `session_start` with a warm fetch cache and with a stubbed 3 s fetch; the number of git invocations per session start. Report both. The always-on budget is **≤ 300 ms of blocking work**; anything over has to be deferred, not shaved.

### Stop reports

- `PLAN MISMATCH` if the seat checkouts are not plain clones (e.g. worktrees of a bare repo), or if `session_start` has no cwd you can gate on.
- `PREMISE FALSIFIED` if the checkout cannot be identified from the session without guessing.
