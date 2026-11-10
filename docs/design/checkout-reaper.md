# The `wt/` checkout reaper

`extensions/lib/checkout-reaper.ts`. One pass per session start over
`~/Developer/wt`: classify every checkout, decide which are no longer needed,
remove those, and write what it kept to `~/Developer/wt/.reaper-report.json`.
`/reaper` prints that report on demand. Decision:
`decisions/subagents/049-wt-checkout-reaper.md`.

## Entry points

| where | what |
|---|---|
| `extensions/subagent-async/index.ts` `session_start` | 027's reap (`reapFinishedWorktrees`) runs first; its verdicts and the worktree paths its metas name are handed to `reapCheckouts`, which gates everything else and reports 027's rows. Fire-and-forget, and skipped when `PI_SUBAGENT_DEPTH` is set: a spawned child starts no pass, because N children would pay N passes and each would overwrite the report the parent announced. |
| `/reaper` | prints the last report. |
| `walkCheckouts({root, subagentBase})` | classification only, no spawns. |
| `reapCheckouts(opts)` | one full pass, report written. `dryRun` gates without removing. |

The report file is written on every pass, empty or not, so "nothing held" is
distinguishable from a report nobody wrote.

## Kinds

| kind | shape | removed by |
|---|---|---|
| `worktree` | `.git` is a file naming a gitdir | `removeWorktreeTree` (091) |
| `clone` | `.git` is a directory | `rm -rf` of the directory |
| `scratch` | no `.git` | nothing: reported with age and size |
| `other` | a `.git` this module will not judge (socket), or an entry that is itself a symlink | nothing: reported |

A symlink is never traversed: `classify` stats the entry itself and answers
`other`. Following it would classify the tree the link names as the link's
entry, and 091 would then remove that tree — a linked worktree elsewhere on the
box — rather than the link.

`orphaned` is a state of `worktree`, not a fifth kind: `.git` names a gitdir
that does not exist, because the repository that owned the checkout was
deleted. `git status` fails in such a tree and `git worktree remove` has no
repository to run in, so the ordinary gates cannot decide it. It is removed
with a plain recursive delete, and the row says so. This is the only removal
that is not 091's, and the only one that can be (owner 2026-11-09).

## Gates

Every gate must hold. A gate that cannot be evaluated is a keep. The probes run
cheapest first, so a checkout that is young or locked costs no spawn.

| gate | probe | cost |
|---|---|---|
| locked | `<gitdir>/locked` exists | `stat` |
| idle | newest mtime among the checkout's **own** git metadata (`index`, `HEAD`, `ORIG_HEAD`, `MERGE_HEAD`, `REBASE_HEAD`, `locked`, `logs/HEAD`; a clone adds `packed-refs`, `FETCH_HEAD`) is ≥ 7 days old | 7 `stat`s |
| clean | `git --no-optional-locks status --porcelain --branch --ignored=matching -uall` reports no changed path | 1 spawn |
| no stash | `logs/refs/stash` holds no entry made on this worktree's branch (a clone: no entry at all) | file read |
| nothing only local | `git log --source <HEAD\|--branches HEAD --tags> --not --remotes` is empty; a worktree in sync with its upstream (`ahead 0` in the status header) skips the spawn | 0–1 spawn |
| ignored bytes | `du -csk` over the paths git ignores — reported, never a blocker | 1 spawn, only when something is ignored |
| idle again | the newest file mtime in the tree (`.git` and git-ignored paths excluded) is ≥ 7 days old | stat walk, removal candidates only |
| unused | one `lsof -d cwd -Fpn` pass for the whole box, resolved on first need | 1 spawn per pass |

The age screen reads the checkout's own metadata, not the tree: a full-tree walk
of 100 worktrees costs minutes (a single 8,000-file `target/` is ~250 ms), and
the paths it would find are either ignored (gate 3 says build output is not
work) or caught by the clean and pushed gates. The removal re-checks the tree's
own mtimes so a checkout whose content changed inside the window is still a
keep.

`HEAD` for a worktree and `--branches HEAD --tags` for a clone is the difference
between the two: a worktree dies alone, so only its own branch matters; a clone
takes every local ref with it. `--branches` alone starts from `refs/heads/*`, so
it cannot see a commit on a detached HEAD; `--tags` is there because a local tag
can be a commit's only ref. Both keep a clone git would otherwise lose work
from.

## The subagent namespace

027's `reapFinishedWorktrees` owns `wt/subagents`. It hands this pass the
worktree paths its metas name and the verdicts it reached; a namespace checkout
in that set is reported with 027's outcome and none of this pass's gates run on
it.

Two cases fall to the general gates. A namespace checkout that **no meta names**
is nobody's record, so it is gated like any other entry. And when **any one of
027's metas fails**, `subagentScopeFailed` is set: a half-read meta set is not
knowledge, so the pass reports that subtree and judges none of it, whatever its
gates would have said.

One meta's failure holds its own trees, not the rest of the list. The reap
processes each meta in its own turn, records the failing meta's worktree path
before anything that can throw, and keeps going with the remaining metas. A
clean finished tree after the failing one is still reaped; the failing meta's
tree is reported as ungoverned, never judged by this pass's gates.

A meta whose JSON will not parse is the same rule from below: it names no tree,
so there is no path to hand over, and the scan reports itself incomplete
instead. "Incomplete" is the operative word — one unreadable meta marks the
whole namespace ungoverned, because a half-read meta set cannot say which trees
it failed to attribute.

## Removal

A worktree goes through `removeWorktreeTree` with `force: false` and both
`parentHeadCommit` and `finalCommit` set to the branch's own HEAD. 091's branch
step deletes the branch when the two match — its test for "nothing unsaved on
it". The reaper proves the same thing more strongly first (gate 2: every commit
on the branch is on a remote ref), which is what makes its two facts a
statement about the branch rather than about the parent.

Build output is 091's: `removeWorktreeTree` drops the tree's own `target/` and
its share of the clone's shared cargo dir, attributed by dep-info. A seat-made
tree outside the subagent namespace is not attributed by 091's namespace rule,
so the reaper runs 091's exact route (route 1) for the directory names that tree
is known by. The coarse route (route 2) is not run per removal: the bound
(091 M3) owns it, and a `cargo clean -p` per removal rebuilds other trees'
crates inside a session-start pass.

## The report

`~/Developer/wt/.reaper-report.json`:

```json
{ "generatedAt": "…", "budgetMs": 1800, "elapsedMs": 812,
  "removed": [ { "path": "…", "kind": "worktree", "ageDays": 12.4, "state": "removed",
                 "unsaved": { "branch": "wt-441", "dirtyFiles": 0, "unpushedCommits": 0, "ignoredBytes": 3145728 },
                 "removed": { "branchDeleted": "wt-441", "buildOutput": "…" } } ],
  "kept":    [ { "path": "…", "gate": "dirty", "unsaved": { "dirtyFiles": 2 } } ],
  "deferred":[ { "path": "…", "gate": "budget", "detail": "no gate ran" } ],
  "problems": [] }
```

`gate` is the one that kept the row: `active`, `in-use`, `locked`, `dirty`,
`stash`, `unpushed`, `git-error`, `age-unknown`, `no-cwd-evidence`, `subagent`,
`scratch`, `other`, `budget`. `unsaved` is the thing that would be lost:
`dirtyFiles`, `unpushedCommits` with `unpushedBranches`, `stashes`,
`ignoredBytes`, `pid`, or `newestFileDays`.

`unpushedBranches` names the refs git's `%S` reports for the commits no remote
holds: a branch by its short name, `HEAD` for a detached HEAD, a tag by its tag
name. The row does not name the remote those commits are missing from. M3 asked
for "branch and remote"; the gate tests against every remote ref of the
checkout, so no single remote is the one missing them, and the row carries the
ref instead. That narrowing is the recorder's call, recorded in decision 049.

`removed.sharedWith` is R12: dep-info is keyed by crate unit, so one `.d` can
name two worktrees and the artifacts under its stem are one copy. Reaping either
takes the other's copy; that tree rebuilds, and its own later removal degrades to
the coarse route. The row names the `.d` and the checkouts it also named
(`sharedDepInfoFiles` in `extensions/lib/build-output-reaper.ts`), so the
rebuild is explained rather than discovered.

## Cost

Measured on this box (103 top-level dirs + 38 subagent entries, 2026-11-09), one
pass, `dryRun`, nothing removable:

| step | wall time |
|---|---|
| `walkCheckouts`: 141 entries classified | 33–53 ms warm, 281 ms cold (re-measured 2026-11-09; an earlier run on the same box read 87 ms) |
| the checkouts' gates (17 locked, 71 active, 2 dirty — 2 `git status` spawns) | 150 ms |
| one batched `du -sk` over the 40 scratch dirs (1.44 GiB) | 1062 ms |
| the `lsof` pass, on a box where a candidate reached the unused gate | 388–1790 ms |
| `du -csk` of one tree's in-tree `target/` (2.8 GiB) | 76 ms |

So the steady-state floor is ~250 ms and the scratch sizes are the pass's only
heavy report step: they run last, under whatever budget is left, and a `du` the
budget kills leaves the directories it finished measured and the rest saying
"size not measured". `lsof` is the other heavy probe and runs only when a
candidate has passed every other gate, so a pass that removes nothing does not
pay for it.

Over budget (1800 ms) the gates stop and the candidates they did not reach are
written as `deferred`, not as keeps: the next session start continues from the
same oldest-first order.

The bound is checked **between candidates**, before a candidate's gates start.
It is not a timer on a probe: the `lsof -d cwd` sweep and the in-tree
`du -csk` for ignored bytes run without a timeout, so one of them can pass the
bound and the pass stops at the next candidate. The scratch `du -sk` is the one
probe handed the remaining budget, and it is killed at it.

## Refusals

- A checkout with uncommitted work, an unpushed commit, a stash, a lock, or a
  process inside it is never removed, whatever else holds.
- `scratch` is never deleted.
- `~/Developer/<repo>` main checkouts are outside the walk: `root` is
  `~/Developer/wt`.
