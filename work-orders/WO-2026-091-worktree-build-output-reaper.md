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

**Also found.** Absolute worktree paths *are* in the shared dirs' `.d` files —
17 in `tfd-d-487`, 20 in `tfd-gate-424-prep` — at `<profile>/*.d` and
`<profile>/examples/*.d`, which route 1 does not scan: `pruneExactArtifacts`
reads `<profile>/deps/*.d` only. Route 1 is inert on this box because of its
scan scope, not because cargo writes relative paths everywhere.

**Options.**

- **A (recorder's recommendation, not a ruling) — keep it, correct the claim.**
  Record route 1 as inert for a workspace-root checkout, not inert in general.
  Costs nothing; fires correctly if a repo ever nests its workspace. `048`
  §Rulings' "Route 1 is inert" bullet and §*Route 1 is inert for workspace-root
  builds* then need the probe cited, which is a doc edit awaiting this ruling.
- **B — delete it, on the narrower true premise.** No repo on this box has the
  shape that fires, and route 2 is what every removal pays anyway. Removes the
  118-line route-1 section plus 34 lines of `exact`/`depInfo`/`worktreePaths`
  plumbing outside it (`pruneCargoArtifactsFor`, `describePrune`,
  `CargoBoundAction`, the bound's per-dead-path pass, the report line); M2
  becomes route 2 only. Rows that go with it, all in
  `tests/build-output-reaper.test.ts`: `pruneExactArtifacts (M2 route 1)` (3
  rows, `:156`, `:179`, `:199`), "stops at route 1 when a .d named the dead
  worktree" (`:226`), "uses route 1 when the dead worktree's artifacts can be
  attributed" (`:648`). One row is rewritten rather than dropped: "reports an
  over-bound dir that route 1 brought under as under, not as unmeasured"
  (`:465`) pins a bound verdict, not route 1, and survives with its prune done
  by route 2. Every other row stays: route 2's fallback, no-workspace,
  gone-parent and failed-clean rows, and all `dirSizeBytes` / bound-verdict
  rows.
- **C — widen the scan** to `<profile>/*.d` and `<profile>/examples/*.d`, where
  this box's absolute worktree paths actually are. The only change that makes
  attribution per-worktree on a workspace-root checkout, and so the only one
  that makes M2 route 1 do anything here — but M2's mechanism names `deps/*.d`,
  so this is an order the current one does not carry.

**Why a ruling and not a review.** The owner's instruction was conditional on a
probe; the probe came back the other way. A reviewer cannot rule on it, and
landing the deletion anyway would be a departure (APPEND_SYSTEM §Spec
authority). **State this round:** route 1 is unchanged and nothing is deleted.
