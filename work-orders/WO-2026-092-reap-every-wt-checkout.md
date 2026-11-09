# WO-2026-092 — every checkout under `~/Developer/wt` is reaped when it stops being needed

### Metadata

- **work_order_id**: WO-2026-092
- **parent_plan_id**: owner 2026-11-08 — *"make sure they get reliably cleaned up when they're no longer needed … it's not just the target dir — it's everything related to the no longer needed clone"*.
- **sequence_position**: 2 of 2 — lands after **WO-2026-091** and reuses its `removeWorktreeTree`.
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit — §Verification enumerates every kept/removed case; the implementer names any checkout kind the enumeration misses.
- **priority**: high (disk)
- **estimated_complexity**: complex
- **review_policy**: required
- **turn_budget**: planned **110** turns, cap **150**. Report `planned / cap / actual`. Targeted rows only — never the full `bun test` (box-wide `flock` slot; the orchestrator gates it). Tell any reviewer you spawn the same.
- **base**: `origin/main` at dispatch (`removeWorktreeTree` landed at `7db182d` and now lives in `extensions/subagent-async/worktree.ts:455`; do not re-implement it).

### Task Summary

**One-sentence description**: one reaper owns every directory under `~/Developer/wt` — subagent worktrees, seat-made gate/land trees, standalone clones — removing a checkout only when nothing it holds exists nowhere else, and reporting the ones it had to keep.

**Goal**: `wt/` stops being an accretion of dead checkouts, and a checkout holding unsaved work is never a casualty of tidying.

### Premise

Measured 2026-11-08: `~/Developer/wt` holds **100** top-level directories — **64** git checkouts (subagent trees, seat-made gate/land/base/review trees, a few standalone clones) and **36** non-git scratch dirs — plus 37 entries under `wt/subagents`. WO-2026-091 cleans build output for subagent trees only; the rest has no owner.

### Dependency

WO-2026-091 extracts `removeWorktreeTree` and the target/cache pruning. This order calls them; it does not duplicate them. If 091 is not landed at your base, stop with `PREMISE FALSIFIED` and say so.

### Rulings

- **Owner 2026-11-08** — (1) one reaper for every checkout under `~/Developer/wt`, removing the whole checkout (worktree entry, merged branch, target, cache attribution) once it is no longer needed; (2) a checkout with dirty or unpushed work is **never** deleted — it goes in a report the boss seat reads (path, age, what is unsaved); (3) scratch and notes stop being created in `wt/` (guidance: `~/Developer/notes/<topic>`); existing non-git dirs are reported, never deleted; (4) a standalone clone gets the same rule against its own remotes.
- **Recorder's call (this order, stated as required):** a checkout is *idle* at **7 days** with no mtime anywhere in the tree newer than that, and *unused* when no process has its cwd inside.
- **Cost budget (this order):** the reaper's wall time at session start is **≤ 2,000 ms** with the directory counts above, measured, not asserted.

### Mechanism

**M1 — one candidate walk.** `reapCheckouts({root})` visits every top-level entry under `~/Developer/wt` (and the subagent namespace beneath it) and classifies it: `worktree` (a `.git` file naming a gitdir), `clone` (a `.git` directory), `scratch` (no `.git`), `other`. The existing `reapFinishedWorktrees` becomes one caller of this walk for the subagent subtree, gated by its own terminal-footer and adoption rules; the general walk does not second-guess them.

**M2 — removal gates, all required.** A checkout is removable only when every one holds:
1. **clean** — `git status --porcelain -uall` empty, and no stash entries;
2. **nothing only local** — every commit on HEAD is reachable from some remote ref of its owning repository (`git branch -r --contains` … or `rev-list --count HEAD --not --remotes` = 0); the branch, if it holds no unique commits, may be deleted;
3. **nothing unpushed in the tree** — no untracked-but-ignored large artifacts that the owner would call work: an ignored file is not a blocker, but the report names the ignored bytes it is deleting;
4. **unused** — no process with a cwd inside, and no `.git/worktrees/<name>/locked` marker;
5. **idle** — newest mtime in the tree older than 7 days.
Then: `removeWorktreeTree` (091) for a worktree, `git worktree remove` + branch delete for a merged branch, `rm -rf` for a clone whose own remotes hold everything, and target/cache attribution via 091's functions.

**M3 — the report, not the axe.** Every candidate that fails a gate is written to `~/Developer/wt/.reaper-report.json` (path, kind, idle days, gate failed, the unsaved thing: dirty file count, unpushed commit count with branch and remote, ignored bytes, the process holding it). The reap returns the same rows. At session start, entries appear in the status/summary line; a `/reaper` command prints them on demand. A clean file is written when nothing is held, so an empty report is distinguishable from a stale one.

**M4 — scratch stays put.** Non-git directories under `wt/` are reported as `scratch` with age and byte count, never deleted. Guidance text (owner ask 3) goes where seats read scratch rules: the global instructions' *Scratch locations* paragraph — scratch, notes, mutation copies go under `~/Developer/notes/<topic>`; `wt/` is for checkouts only.

**M5 — standalone clones.** A `.git` *directory* at the top level is a clone: the same gates run against its own `origin` and its own refs. A clone whose remote holds every commit and which is idle and unused is removed whole.

### Scope

`extensions/lib/checkout-reaper.ts` (new), `extensions/subagent-async/index.ts` (delegate the subagent reap to the walk), session-start wiring, `/<reaper>` command, guidance text in the global instructions, tests.

Out of scope: `~/Developer/<repo>` main checkouts; `~/Developer/notes`; anything under `.pi/`.

### Prohibitions

- Never delete a checkout that fails any M2 gate. "Probably fine" is a keep.
- Never delete a non-git directory under `wt/`.
- No second removal path: `removeWorktreeTree` from 091 is the only way a worktree goes.
- No re-implementation of 091's attribution logic.
- No new blocking work on the spawn path: the reaper runs at session start, not on spawn.
- Do not widen `wt/` deletion to `~/Developer/*` or to hand-made trees outside `wt/`.

### Verification Criteria

Each case gets a row, and each row gets the mutation that reds it (name it, show it red):

- **R1** clean + merged + idle + unused worktree → removed (tree, branch, target, cache attribution all gone).
- **R2** dirty worktree → kept, in the report with its file count.
- **R3** unpushed commit → kept, report names the branch and commit count.
- **R4** branch merged but another commit exists only on a local remote-less branch → kept.
- **R5** process with cwd inside → kept, report names the pid.
- **R6** active within 7 days → kept, and not listed as actionable.
- **R7** standalone clone, fully pushed and idle → removed whole.
- **R8** standalone clone with an unpushed commit → kept.
- **R9** non-git scratch dir → reported, never deleted.
- **R10** subagent tree whose child is still running → untouched (091's gate still governs that subtree).
- **R12** **a `.d` naming two worktrees.** A shared `release/<pkg>.d` can name a dead worktree *and* a live one (this box: `tfd-d-487/release/tfd.d` names `…-210bf89ad757` in 255 source paths and `…-5c8863381bd8` in two). Reaping the dead one deletes the live one's `.d` and binary; the live tree rebuilds, and its own later removal degrades to the coarse route. The row pins the *report*: the reap names that it took a live tree's copy, so the rebuild is explained rather than discovered. Decision 048 §"A `.d` naming two worktrees takes the live one's copy with it" is the record; this order's job is to surface it, not to change the mechanism.
- **R11** empty report writes the file, so "nothing held" is distinguishable from a stale report.

### Cost — measure, do not assert

The reaper runs at every session start: measure wall time with the current 100 `wt/` entries plus 37 under `wt/subagents`, before and after, and the process spawns it adds (`git status`, `rev-list`, `lsof`). Over the 2,000 ms budget: name the expensive step and the cheaper probe that replaces it (e.g. mtime-only idle checks, a single `lsof -d cwd` pass instead of one per candidate) rather than shipping it slow.

### Stop reports

- `PREMISE FALSIFIED` if 091's `removeWorktreeTree` is absent or cannot be called for a non-subagent tree.
- `PLAN MISMATCH` if a checkout kind exists that M1's four classifications miss, or if a removal needs a gate M2 does not state.
- Anything you would have to swallow to keep a row green: stop and report it.
