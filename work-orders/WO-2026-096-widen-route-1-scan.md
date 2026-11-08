# WO-2026-096 — route 1 scans every profile-level dep-info file, not only `deps/`

### Metadata

- **work_order_id**: WO-2026-096
- **parent_plan_id**: owner 2026-11-08, `Q-091-b` — *"Widen the scan (Recommended)"*. Route 1 also scans `<profile>/*.d` and `<profile>/examples/*.d`.
- **sequence_position**: 1 of 1. Small: one scan change plus three rows.
- **routed_to**: implement
- **invariant_exhaustiveness**: implicit — three rows below; the implementer names any dep-info location outside them that cargo writes.
- **priority**: normal
- **estimated_complexity**: small
- **review_policy**: required
- **turn_budget**: planned **35** turns, cap **60**. Report `planned / cap / actual`. Targeted rows only — never the full `bun test` (box-wide `flock` slot; the orchestrator gates it).
- **base**: `origin/main` at dispatch

### Task Summary

**One-sentence description**: route 1's dep-info scan covers the whole profile directory instead of `deps/` alone, so attribution works in the nested-workspace layout and for the absolute paths this box already holds outside `deps/`.

**Goal**: the mechanism the owner kept fires wherever cargo writes an absolute worktree path, not just in one subdirectory.

### Premise

`pruneExactArtifacts` scans `<profile>/deps/*.d`. Cargo absolutizes a source path outside the workspace root it built, so route 1 fires when a checkout nests its workspace and a path dep sits elsewhere in the checkout — and those `.d` files can sit at `<profile>/` or `<profile>/examples/`. Measured on this box (2026-11-08): of the `.d` files naming a worktree, **37** exist — 25 source rules and 12 build-script `env-dep:` lines — and **none** is under `deps/`, which is why the mechanism is inert here today (0 of 3 `deps/*.d` matched).

### Mechanism

In `extensions/lib/build-output-reaper.ts`, `pruneExactArtifacts` scans three locations per profile:
`<profile>/deps/*.d`, `<profile>/*.d`, `<profile>/examples/*.d`.

The attribution rule does not change: a `.d` whose content names `worktreePath` as a path prefix owns that crate's artifacts, and only those artifacts are deleted (the `.d`, its same-stem siblings, the matching `.fingerprint/<pkg>-<hash>` and `build/<pkg>-<hash>`). A `.d` that names no worktree, or names a different one, is never touched.

A build-script `env-dep:`-only `.d` names the worktree without a source rule. Handle it as attribution only where the same `.d` also carries a source rule; a file whose only mention is `env-dep:` is counted in `depInfoScanned` and left alone, with the count reported. State which you chose and why.

### Prohibitions

- Do not change what "owns" means: the path-prefix match is the rule, unchanged.
- Do not widen to `~/.cargo` or outside the profile directory.
- Do not delete a `.d` that names no worktree.
- No new scan location beyond the three named; a fourth is a `PLAN MISMATCH`.

### Verification Criteria

- **R1 (nested layout)** — a workspace at `W/ws` with a path dep at `W/inside-lib`, built with `CARGO_TARGET_DIR` outside the tree: `pruneExactArtifacts(target, W)` deletes the dep's artifacts, and the `.d` it matched is found outside `deps/`. Mutation: revert the scan to `deps/` only → red.
- **R2 (box layout)** — a fixture reproducing this box's shape: absolute worktree paths in `<profile>/*.d`, none under `deps/`. The dead worktree's share is deleted; mutation as R1.
- **R3 (nothing else)** — in the same fixture as R2, a `.d` naming a *different, live* worktree and a `.d` naming no worktree both survive, and their sibling artifacts are untouched. Mutation: match every `.d` regardless of the path → red.
- **R4 (env-dep-only)** — a `.d` whose only mention of the worktree is an `env-dep:` line: whatever the implementation chose in §Mechanism, the row pins it and the count is reported.

### Cost — measure, do not assert

Route 1 runs once per removal. Measure `pruneExactArtifacts` on this box's real `<profile>` (707 `.d` files, 2 under `deps/`) before and after the widened scan; report ms and the files scanned. Route 2 remains the fallback and its cost is unchanged.

### Stop reports

- `PREMISE FALSIFIED` if cargo writes no `.d` at `<profile>/` or `<profile>/examples/` in either layout — say what you probed.
- `PLAN MISMATCH` if a cargo-writable dep-info location exists outside the three named.
