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
