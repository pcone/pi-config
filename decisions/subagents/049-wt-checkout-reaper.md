# 049 — One reaper for every checkout under `~/Developer/wt`

**Date:** 2026-11-09
**Status:** accepted — owner rulings 2026-11-08 (WO-2026-092) and 2026-11-09 (R13)
**Supersedes:** nothing. Extends 045 (where worktrees live) and 048 (what a
removal drops).

## What

`extensions/lib/checkout-reaper.ts` — `reapCheckouts`, run at session start from
`extensions/subagent-async/index.ts`, and `/reaper`. Design:
`docs/design/checkout-reaper.md`.

- **M1** one walk, `walkCheckouts`, classifies every entry under
  `~/Developer/wt` and the subagent namespace beneath it: `worktree` (`.git`
  file), `clone` (`.git` directory), `scratch` (no `.git`), `other`.
  `reapFinishedWorktrees` (027) keeps its own gates for the namespace and hands
  its verdicts and meta paths to the general pass, so no tree is decided twice.
- **M2** a checkout is removable only when it is clean, holds nothing that
  exists only locally, has no stash entry of its own, is unused (no process cwd
  inside), and is idle (7 days). Eight gates, each with the probe of its own in
  the design doc's table.
- **M3** everything that fails a gate is reported, never deleted:
  `~/Developer/wt/.reaper-report.json`, written on every pass, with the path,
  the kind, the idle days, the gate that held and the unsaved thing — dirty
  files, unpushed commits with their branches, stash entries, ignored bytes, or
  the pid holding it.
- **M4** non-git directories are reported as `scratch` with age and size and
  never deleted. Guidance: `APPEND_SYSTEM.md` §Scratch locations.
- **M5** a standalone clone gets the same gates against its own refs and is
  removed whole.
- **R13** an `orphaned` worktree — `.git` names a gitdir that no longer exists —
  is removed with a plain recursive delete and reported as such.

## Rulings (owner)

- **2026-11-08 (WO-2026-092).** One reaper for every checkout under
  `~/Developer/wt`, removing the whole checkout (worktree entry, merged branch,
  target, cache attribution) once it is no longer needed. A checkout with dirty
  or unpushed work is **never** deleted: it goes in a report the boss seat reads.
  Scratch and notes stop being created in `wt/` (`~/Developer/notes/<topic>`);
  existing non-git dirs are reported, never deleted. A standalone clone gets the
  same rule against its own remotes.
- **2026-11-09 (R13).** An orphaned worktree directory (`.git` naming a missing
  gitdir) is **removed** by the reaper, reported as such — a recursive delete is
  the only option, because no repository is left to remove a worktree from. A
  checkout whose gitdir **exists** is never treated this way, even when git then
  fails inside it. The leaking tests that produced 149 of them are a separate
  dispatch.

## Recorder's calls

Recorded so they are not re-argued as if the owner had ruled them.

- **Idle is 7 days.** The number and the definition are this order's recorder:
  the order states 7 days in §Rulings and leaves the mechanism to the
  implementer.
- **The age screen reads git metadata, not the tree.** `walkCheckouts` ages a
  checkout by the newest mtime among the paths that move when it is written to
  (`index`, `HEAD`, `ORIG_HEAD`, `MERGE_HEAD`, `REBASE_HEAD`, `locked`,
  `logs/HEAD`; a clone adds `packed-refs`, `FETCH_HEAD`). A shared path is not
  read: `packed-refs` and `refs/` are one copy per clone, so a commit in one
  worktree would age every sibling. The full-tree walk the order's wording
  suggests costs ~250 ms per tree with a `target/` in it, which a session-start
  pass cannot pay 100 times. What the narrowing gives up is caught by the gates:
  ignored content is not work (gate 3 says so and reports its bytes), and any
  uncommitted or unpushed work fails the clean or pushed gate whatever the age
  says. The removal still re-checks the tree's own mtimes, so a checkout whose
  content changed inside the window is kept.
- **A stash holds a worktree only when it is that worktree's.** `refs/stash` and
  its reflog live in the shared repository, so removing a linked worktree loses
  no stash entry at all; what it can lose is an entry made on that worktree's
  branch, which the reflog names. A clone carries the whole repository with it,
  so every entry there is a keep. On this box `tfd` holds 2 stashes and `tfd-d`
  3, which under a repo-wide reading would have kept 40+ worktrees forever.
- **A clone's pushed gate is `--branches HEAD --tags`, a worktree's is `HEAD`.**
  A worktree dies alone. A clone takes every local ref with it: `--branches` for
  R4's shape (a commit on a branch that exists only locally), `HEAD` because
  `--branches` starts from `refs/heads/*` and a clone left on a detached HEAD has
  no branch naming that commit, and `--tags` because a local tag can be a
  commit's only ref. The first two close a deletion-safety defect found in review
  (a detached clone was `rm -rf`ed with its commit); `--tags` is a decision.
- **The unsent-commit row names the ref, not the remote.** M3 asks for the
  unpushed commits "with branch and remote". The row carries the count and the
  refs git's `%S` reports — a branch by its short name, `HEAD`, or a tag's name —
  and no remote. The gate tests the checkout against every remote ref it has, so
  no single remote is the one missing a commit; naming a ref states what holds
  the work. This is a narrowing of M3, recorded as a recorder's call.
- **027's namespace is reported, not judged, and a failed 027 reap holds all of
  it.** A namespace checkout a meta names is reported with 027's outcome. One no
  meta names is nobody's record, so the general pass gates it. When 027's own
  reap throws, the pass sets `subagentScopeFailed` and reports the whole subtree
  without judging any of it: a half-read meta set is not knowledge.
- **The meta loop is per-meta: one meta's failure holds its own trees, not the
  rest of the list.** Added 2026-11-10, during WO-2026-092's review, as a
  recorder's call — it narrows the bullet above, and it is not owner text.
  `reapFinishedWorktrees` wrapped every meta in one `try` whose catch only
  logged, so one unreadable meta abandoned the metas after it and
  `subagentScopeFailed` could never be set: the general pass judged trees 027
  had not reached, and could remove a tree 027 would have kept. Each meta now
  runs in its own turn. The failing meta's worktree path is read before anything
  that can throw, so it stays in the set handed to the general pass; the
  remaining metas still run; and the failure is reported, which is what makes
  `subagentScopeFailed` live. The signal stays one boolean for the subtree: a
  brittle meta means a half-read meta set, so every namespace checkout is then
  reported as ungoverned and judged by neither half. Deleting the flag instead
  would leave an ungoverned tree silently judged, which is the deletion hole, not
  a simplification.
- **The budget is checked between candidates, and two probes carry no timeout.**
  The bound stops the pass before a candidate's gates start; it is not a timer on
  a probe. `lsof -d cwd` and the in-tree `du -csk` for ignored bytes run without
  a timeout, so one can pass the bound and the pass stops at the next candidate.
  The scratch `du -sk` is handed the remaining budget and killed at it.
- **A symlink under `wt/` is never traversed.** It is reported as `other`.
  Following it would classify the tree the link names as the link's own entry,
  and 091 would remove that tree rather than the link.
- **A seat-made tree's shared cargo dir is dropped by 091's exact route only.**
  `removeWorktreeTree` attributes by the subagent namespace rule; a tree at
  `~/Developer/wt/<name>` is not in it, so the reaper runs route 1 for
  `~/.cache/cargo-target/<name>` (and the parent repo's name) itself. The coarse
  route is left to the bound: a `cargo clean -p` per removal would rebuild other
  trees' crates inside a session-start pass.
- **A pass is bounded at 1800 ms, and candidates it did not reach are
  `deferred`.** The order's budget is 2000 ms with 100 + 37 entries; the gates
  cost one spawn each and this box's entries need ~2.5 s of them, so the pass
  stops and says what it did not look at. Deferral is not a keep and not a
  removal: the next pass continues in the same oldest-first order, so a backlog
  drains over a few session starts rather than holding session start for
  seconds. The steady state is ~250 ms of classification, plus the removal-time
  probes only when something is a candidate.

## Costs measured, not asserted

One dry pass, 2026-11-09, 141 entries (103 top-level, 38 subagent), nothing
removable:

| step | wall time |
|---|---|
| `walkCheckouts` (141 entries) | 33–53 ms warm, 281 ms cold (re-measured 2026-11-09; an earlier run read 87 ms) |
| gates for 97 checkouts (2 needed `git status`) | 150 ms |
| batched `du -sk` over 40 scratch dirs (1.44 GiB) | 1062 ms |
| `lsof -d cwd -Fpn` (once, on the passes that need it) | 388–1790 ms |
| `git status --porcelain --ignored=matching -uall`, warm | 15–33 ms |
| `git log --source --not --remotes` | 14–16 ms |

The scratch sizes are the one expensive report step and they run last, under
whatever budget is left; the `du` is killed at the bound and the directories it
did not reach say "size not measured". `lsof` is resolved on first need, so a
pass with no removal candidate pays nothing for it.

## Alternatives rejected

- **A full-tree mtime walk for the age screen.** ~250 ms per tree with an
  in-tree `target/`; 100+ trees, at every session start.
- **Re-reading the subagent metas in the general pass.** The same scan 027 ran a
  moment earlier, ~0.4 s for this box's 1015 metas.
- **One `lsof` probe per candidate.** The pass pays for the whole process table
  once, not once per checkout.
- **Deleting scratch, or a clone whose remote holds everything but whose tree is
  a bare `HEAD`.** M5's gates are the same as M2's; `scratch` is never deleted.
- **A second `git worktree remove`.** 091's `removeWorktreeTree` is the one
  removal path for a worktree. The orphan case is the single exception and has
  no repository to run it in.
