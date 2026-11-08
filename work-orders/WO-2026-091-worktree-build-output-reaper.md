# WO-2026-091 — a subagent worktree's build output dies with it

### Metadata

- **work_order_id**: WO-2026-091
- **parent_plan_id**: owner 2026-11-08 — three asks on the subagent worktree lifecycle (remove → drop target; kept-for-gating → drop target once its branch lands or is abandoned; bound the shared cargo dir), with the bound left to us.
- **sequence_position**: 1 of 1.
- **routed_to**: implement
- **invariant_exhaustiveness**: implicit — two removal sites and one bound, enumerated in §Mechanism; the implementer names any producer of a worktree path it finds that is not one of them.
- **priority**: high (disk: the box went from ~250 GB free to 22 GB in a day)
- **estimated_complexity**: complex
- **review_policy**: required
- **turn_budget**: planned **100** turns, cap **140**. Report `planned / cap / actual`. Targeted rows only — never the full `bun test` (box-wide `flock` slot; the orchestrator gates it). Tell any reviewer you spawn the same.
- **base**: `origin/main` = `1f94025`

### Task Summary

**One-sentence description**: removing or reaping a subagent worktree also removes the build output that worktree produced — its own `target/` and its share of the clone's shared cargo target dir — and the shared dir is bounded.

**Goal**: after this lands, no removal path in the harness can leave a multi-GB target behind, and the shared cache cannot grow without limit.

### Premise

Measured on this box, 2026-11-08, at `1f94025`:

- `~/Developer/wt/subagents` holds **36** worktrees; **5** carry their own `target/`, the largest **3.1 GB**.
- `~/.cache/cargo-target` holds **2** per-clone dirs totalling **11.9 GB** (`tfd-gate-424-prep` 8.2 GB, `tfd-d-487` 3.7 GB). Nothing in the harness ever deletes from it: `cargoTargetDirFor` has one definition (`lib/subagent-worktree.ts:48`) and one caller (`subagent-async/index.ts`), and that caller only creates the dir.
- Two removal sites, each with its own copy of the unlock → remove → branch-delete sequence:
  - `postDeliveryCleanup` (`subagent-async/index.ts` ~1280-1310) — `git worktree remove --force` after delivery;
  - `reapFinishedWorktrees` (~3810) — the session-start reap, plain `worktree remove` for a clean tree, keeps a dirty one for `subagent_resume`.
- `target/` is a **real directory** per worktree when `CARGO_TARGET_DIR` is not set for that child; when it is set (the shared cache), the workspace-crate artifacts land in `<shared>/<profile>/…` keyed by source path.

### Preparatory refactor

The two removal sites duplicate the sequence unlock → remove → branch-delete. Extract one `removeWorktreeTree(deps, rs): Promise<void>` that both call, with the branch-delete decision (`finalCommit === parentHeadCommit`, WO-2026-049) inside it. Characterization tests first, covering what each site does today: forced removal, unlocked-removal refusal, dirty-tree keep, branch delete vs branch keep. The refactor commit must leave every existing row passing unchanged.

This is the carrier for M1 — one place to prune, not two.

### Rulings

- **Owner 2026-11-08** — (1) when a worktree is removed or reaped, delete its `target/` (a real dir, not a symlink) and its artifacts in the shared cargo target dir *if they can be told apart*; (2) a finished worktree kept for gating loses its `target/` once its branch lands or is abandoned; (3) bound `~/.cache/cargo-target/<repo>`, by size or by pruning artifacts for dead worktrees.
- **Recorder's call (this order, stated as required): the bound is 20 GB per clone's shared dir.** Enforcement order below. Over the bound after both passes is **reported, not force-cleaned**.
- **Owner 2026-11-08** — rows: a reaped worktree leaves no target; a live one keeps it. The reaper's cost is measured, not asserted.

### Mechanism

**M1 — the worktree's own target, in one place.** `removeWorktreeTarget(worktreePath: string): boolean` in a new `extensions/lib/build-output-reaper.ts`: `lstat(<wt>/target)`; return false and delete nothing unless it is a directory and not a symlink; `rmSync(recursive, force)`. Called from `removeWorktreeTree` after a successful `git worktree remove`, and from the reap's successful-removal path. Best-effort: a failed unlink is recorded in `ReapResult.detail`, never thrown.

**M2 — the shared dir's per-worktree share.** `pruneCargoArtifactsFor(cargoTargetDir, worktreePath)`:
1. *Exact route, preferred*: scan `<cargoTargetDir>/<profile>/deps/*.d` (the dep-info files; they list every source path of the crate they describe). A `.d` whose content contains `worktreePath` as a path prefix owns that crate's artifacts: delete the `.d`, its sibling artifacts with the same stem (`.rmeta`, `.rlib`, `.so`, `.a`, `.d`), and the matching `<profile>/.fingerprint/<pkg>-<hash>` and `<profile>/build/<pkg>-<hash>` dirs.
2. *Coarse route, when the exact route finds nothing*: `cargo clean -p <member>` for each workspace member of the parent repo, run in the parent checkout. This drops every copy of that workspace crate — including other worktrees' — while leaving registry-crate artifacts, which are the expensive half the shared dir exists to keep. Workspace members come from the parent's `Cargo.toml`; a repo that is not a cargo workspace skips this step.

State which route ran in the report, with the `.d` count that decided it.

**M3 — the bound.** `<cargoTargetDir>` over 20 GB when the reap runs: (a) run M2 for every worktree path under the subagent namespace that no longer exists on disk; (b) if still over, one coarse pass (M2 route 2) per repo. Re-measure and report both numbers. A dir still over after (b) is reported as over-bound. **Never a full `cargo clean`** — that is precisely the registry rebuild the shared dir exists to avoid.

**M4 — kept for gating.** In `reapFinishedWorktrees`, a worktree kept because its child or its tree is not reapable gets its `target/` dropped (M1) when its `isolationBranch` is merged into the parent's current HEAD (`git branch --merged HEAD`) or no longer exists (`git rev-parse --verify` fails). The tree itself stays; only the build output goes. This is the owner's ask (2): landing or abandoning ends the build output's claim on disk.

### Scope

Files: `extensions/lib/build-output-reaper.ts` (new), `extensions/subagent-async/index.ts` (both removal sites, the reap, the bound call), tests for the new lib plus rows at the reap level.

Out of scope: hand-made worktrees under `~/Developer/wt/*` (the guard's business, not the reaper's); anything under `.pi/checkpoints` (WO-2026-091's sibling landed at `1f94025`); pruning cargo artifacts of a repo that has no parent checkout on this box.

### Prohibitions

- No second removal path: M1 is called from `removeWorktreeTree` only, after the refactor.
- Never delete a symlinked `target/` — the owner said a real dir, and a symlink may point at a shared or hand-built tree.
- Never delete a live child's target: the reap's existing adoption and terminal-footer gates decide liveness; M1 runs after a *successful* removal only.
- No full `cargo clean`.
- Nothing outside the subagent namespace and its clone's shared dir.
- No new always-on cost per spawn: the bound is checked in the reap (once per session start), not on the spawn path.

### Verification Criteria

- **R1** a reaped worktree leaves no `target/` — after the reap, the path has neither the tree nor `<wt>/target`.
- **R2** a live worktree keeps its `target/` — a running child's tree is untouched.
- **R3** a symlinked `<wt>/target` is left in place (lstat, not stat).
- **R4** attribution deletes only the dead worktree's artifacts: a fake `<shared>/debug/deps` with two `.d` files, one naming the dead path, one naming a live path → only the dead one's stem and fingerprint/build dirs go.
- **R5** the bound is a plan, testable without cargo: entries over 20 GB produce the M3 action list; under the bound produce none; after both passes still over → reported, no `clean`.
- **R6** a kept-for-gating worktree loses `target/` once its branch is merged or gone, and keeps it while the branch is live.
- **R7** the preparatory refactor: every existing row for both removal sites passes unchanged at the refactor commit.

Each row needs its mutation: name the one-line change that reds it, and show it red.

### Cost — measure, do not assert

- `reapFinishedWorktrees` wall time on this box with the 36 worktrees present, before and after the change; report ms. It runs on every session start, so a regression is an always-on cost.
- `du -sk` of each `~/.cache/cargo-target/*` and of `~/Developer/wt/subagents/*/target` before and after one reap; report GB.
- If the coarse route runs, its `cargo clean -p` wall time per member.

### Stop reports

- `PREMISE FALSIFIED` if neither route can attribute artifacts — say what you probed and why the exact route found nothing (`.d` absent, different layout) and the coarse route is unavailable (no parent checkout, not a workspace).
- `PLAN MISMATCH` if a third removal path exists that the two sites do not cover; name it and land nothing.
- A failed prune is reported in `ReapResult.detail`, not swallowed; if you find yourself wanting to swallow it to keep a row green, stop.

---

## Gate-back record — 2026-11-08

### Owner question Q-091-a (raised 2026-11-08) — RULING PENDING

**Ask:** must `createWorktree`'s stale-leftover cleanup route through
`removeWorktreeTree`, or is it out of this order's scope?

**The site.** `extensions/subagent-async/index.ts:969` at `f0bb295`
(`createWorktree`'s stale-leftover cleanup): an `await git(["worktree",
"unlock", ...])`, then `Promise.allSettled` of `git worktree remove --force`
and `git branch -D`, with no lock handling and no build-output pass. It is the
third `git worktree remove` in product code —
`rg -n '"worktree", "remove' extensions/subagent-async/index.ts` → 3 lines in 2
sites; the other is `removeWorktreeTree`'s (`:1369`, `:1370`).

**Why a ruling and not a review.** This order's §Stop reports names exactly
this case: "`PLAN MISMATCH` if a third removal path exists that the two sites
do not cover; name it and land nothing." The implementer disclosed the site and
landed the rest of the order at `6b16d45`. Both directions are mechanically
sound; they differ in what the harness does afterwards, which no test can
settle.

**Option A (recorder's recommendation, not a ruling) — out of scope; record it.**
Git's own removal takes an ignored `target/` with the tree, and the same
function recreates the path immediately afterwards, so the shared-dir artifacts
are reused rather than orphaned: no build output survives a path that is gone.
Costs nothing; leaves the third sequence as the one place a future target-drop
would have to be added by hand. Recorded in `decisions/subagents/048-…`.

**Option B — route it through `removeWorktreeTree`.** One sequence, one place
to prune. The branch half does not fit as-is: the cleanup deletes the branch
unconditionally, where the shared sequence deletes it only when
`finalCommit === parentHeadCommit` (WO-2026-049), so either the cleanup calls
the sequence with a branch policy that does not exist yet, or it keeps its own
`git branch -D` and only the remove moves — a partial move, with the sequence's
unlock/relock contract bolted onto a path whose tree is being replaced anyway.

**State this round:** the site is unchanged and no code routes it. The claim in
`048` that the harness has one removal path is corrected there to name this
site and this question; the ruling, whichever way it goes, replaces that note.

### Owner question Q-091-b (raised 2026-11-08) — RULING PENDING

**Ask:** route 1 *can* fire — the probe below makes it delete real artifacts —
so the owner's deletion instruction (048 §Rulings, "if route 1 can never fire,
delete it") has no condition to act on. Keep route 1, delete it on a narrower
premise, or widen its scan?

**Probe** (cargo 1.96.0-nightly, 2026-11-08, `~/Developer/probe-depinfo`;
verbatim `.d` dumps in `PROBE.md` beside it). A workspace at `W/ws` whose member
`app` has `inside-lib = { path = "../../inside-lib" }`, `CARGO_TARGET_DIR`
outside the tree, `W` standing in for a worktree root:

| build | `.d` under `deps/` naming a path | route 1 on `W` |
|---|---|---|
| workspace root = `W` (no out-of-workspace dep), from the root | relative `app/src/main.rs` | no |
| same, via `--manifest-path` from outside the tree | relative | no |
| workspace at `W/ws`, dep at `W/inside-lib`, from `W/ws` | `/…/W/inside-lib/src/lib.rs` | **yes: 2 scanned, 1 matched, 4 files + 1 dir deleted** |
| same, via `--manifest-path` from outside the tree | absolute | **yes: 1 matched, 4 files + 1 dir** |
| same, cwd = the member dir | absolute | **yes: 1 matched, 4 files + 1 dir** |
| dep outside the worktree entirely | absolute, outside `W` | no |

Cargo writes a source path relative to the **workspace root it built**, and
absolute for a crate outside that root. Route 1 fires when the workspace root is
a subdirectory of the checkout and a path dependency sits elsewhere in the
checkout — a normal cargo layout, not a synthetic one.

**What is true on this box.** Every cargo repo here roots its workspace at the
checkout root (`tfd/Cargo.toml`; `editors/zed` is a standalone `[workspace]` with
no out-of-workspace path dep), so no `<profile>/deps/*.d` names a worktree: 0 of
3 `.d` files across the three shared dirs. The shape that fires does not exist
here yet, which is why 048's measurement found nothing.

**Also found: route 1 reads the wrong `.d` files.** Absolute worktree paths do
exist in the shared dirs — 25 source-rule `.d` (12 in `tfd-d-487`, 13 in
`tfd-gate-424-prep`; 10 + 10 under `examples/`, 2 + 3 at the profile root) and 12
build-script `.d` under `<profile>/build/**/out/` whose only worktree-naming line
is a `# env-dep:CARGO_MANIFEST_DIR=` one — three dead worktrees across two
crates: `tfd-d-487-210bf89ad757` (parser 2, codegen 2), `tfd-d-487-7a3db341ffc7`
(codegen 1), `tfd-gate-424-prep-74be735f6e04` (codegen 5, parser 2). All of them
sit outside `<profile>/deps/`, which is all `pruneExactArtifacts` reads — and the
12 build-script ones are outside option C's proposed width too. Route 1 is
inert on this box because of its scan scope, not because cargo writes relative
paths everywhere. A dead worktree of `tfd-d-487` (`210bf89ad757`) still has
artifacts in the shared dir today, and its paths are at `examples/`.

**In the layout where route 1 fires, route 2 does not run and cannot.** Two
separate reasons, both measured on the probe:

- `pruneCargoArtifactsFor` returns early when `exact.depInfoMatched > 0`
  (`build-output-reaper.ts:308`), so route 1 firing *suppresses* route 2.
- `cleanCargoWorkspaceMembers` reads `<parentCwd>/Cargo.toml`, and a checkout
  whose workspace lives in a subdirectory has no manifest at its root:
  `cleanCargoWorkspaceMembers(W)` → `{"membersCleaned":[],"problems":["no /…/W/Cargo.toml:
  not a cargo workspace"]}`, 0 cargo calls. A nested-workspace checkout with no
  out-of-workspace dep gets *neither* route.

Three consequences the option costs have to carry:

1. Keeping route 1 removes only the out-of-workspace path-dependency units. The
   workspace members' own artifacts survive either way, because their `.d` paths
   are relative and route 2 is what would drop them.
2. "Route 2 is what every removal pays anyway" is false in this layout.
3. Deleting route 1 leaves the order's **R4** (`:79`, attribution deletes only
   the dead worktree's artifacts) with no mechanism, and the owner's "if they can
   be told apart" clause with nothing that tells them apart. A ruling for B
   changes an acceptance row, which the owner has to do knowingly.

**Options.**

- **A (recorder's recommendation, not a ruling) — keep route 1, correct the
  claim.** In the only layout where it can fire, it is the only mechanism that
  exists, and it is what R4 and "if they can be told apart" rest on. Its cost is
  the per-removal dep-info scan (measured at ~50 ms for 700 `.d`) and a claim in
  `048` that has to be scoped to a workspace-root checkout. Its limit is real and
  belongs in the record: it clears only out-of-workspace units, and it reads
  `deps/` where this box's absolute worktree paths are not.
- **B — delete it.** Argument for: no repo on this box has the layout that fires,
  so it costs a scan per removal and buys nothing here. Code cost: the route-1
  section is `:65-:182` (118 lines including its banner) plus 32 lines outside it
  that name a route-1 symbol —
  `rg -n 'pruneExactArtifacts|ExactPruneResult|depInfoScanned|depInfoMatched|worktreePaths|worktreePathsPruned|filesDeleted|dirsDeleted|"exact"' extensions/lib/build-output-reaper.ts`,
  minus that section. Argument against: it
  retires R4 and the "told apart" clause, and it leaves a nested-workspace
  checkout with no attribution at all. Blast radius, read off the rows at this
  tip: **4 deleted** — `tests/build-output-reaper.test.ts:156`, `:199`, `:226`,
  `:648` (`:199` tests a predicate that would no longer exist; it does not red,
  it goes with the function) — and **9 rewritten**, because the behaviour they
  pin survives: `tests/build-output-reaper.test.ts:179` (`describePrune`'s
  "problems:" arm — the sole row for that function), `:387` and `:412`
  (`planCargoBound`'s `worktreePaths`, and the namespace filter that moves to
  `parentCwdFor`), `:435` (drop `worktreePathsPruned`, keep the over-bound
  verdict and the never-a-full-clean assertion), `:465` (a bound verdict, not a
  route-1 one), `:573` (assertion at `:605`: its `.d` fixture and
  `existsSync(depInfo)` are route-1-only, and its `parentCwd: ""` blocks a coarse
  pass — drop them, or give it a workspace `parentCwd` and assert the coarse
  clean), `tests/subagent-worktree-lock.test.ts:510` (R1 asserts `(exact)` and
  the `.d`/`.rlib`/`.fingerprint` deletions — assert the coarse pass instead),
  `:567` (an unreadable `.d` reaches `detail` only because route 1 reads it), and
  `:597` (the bound's per-dead-path pass), plus two call-site-only arity edits
  where a row's assertions survive untouched: `:396` (call at `:400`) and `:403`
  (calls at `:406`, `:408`). Mechanically `planCargoBound`'s `dead`
  argument goes (calls at `:391`, `:400`, `:406`, `:408`, `:419`), and `route`
  keeps its `"coarse"`/`"none"` arms — `"coarse"` asserted at `:249`, `:459`,
  `:568`, `"none"` at `:266`, `:277` — while
  the `"exact"` arm (`:233`, `:491`, `:662`) goes. Mutation behind the list: with
  `pruneExactArtifacts` returning zeros, `bun test tests/build-output-reaper.test.ts`
  → 6 fail (`:156`, `:179`, `:226`, `:465`, `:573`, `:648`); `:199` stays green
  and vacuous.
- **C — widen the scan** to `<profile>/*.d` and `<profile>/examples/*.d`, where
  the 25 source-rule `.d` carrying absolute worktree paths actually are. The only
  option that makes attribution do something on a workspace-root checkout, and
  the only one that would reach `210bf89ad757`'s leftovers. Its reach stops short
  of route 2's: the workspace members' relative `deps/` units stay unattributable
  under C too, because route 2 still cannot run in this layout, so C is not a
  substitute for the coarse pass — it is what would cover the bins, examples and
  profile-root units. M2's mechanism names
  `deps/*.d`, so it is an order the current one does not carry; it would also
  need non-`deps` fixtures, since `fakeSharedDir` builds only `debug/deps/*.d`.

**Why a ruling and not a review.** The owner's instruction was conditional on a
probe; the probe came back the other way. A reviewer cannot rule on it, and
landing the deletion anyway would be a departure (APPEND_SYSTEM §Spec
authority). **State this round:** route 1 is unchanged and nothing is deleted.

**Doc edits each outcome owes**, so the ruling and the docs move together:
A — `decisions/subagents/048-…:57` (Rulings bullet, scoped not rewritten) and
`:72`, plus the fixture comment at `tests/build-output-reaper.test.ts:238-239`,
which states the falsified generalisation flatly. B — the row rework above, R4
rewritten, and 048's §*Route 1 is inert* becoming the deletion record. C — the
scan change plus its fixtures.
