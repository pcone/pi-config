# WO-2026-051 — Subagent spawn/completion latency micro-fixes + doc drift

### Metadata

- **work_order_id**: WO-2026-051
- **parent_plan_id**: N/A (ad-hoc latency audit of `extensions/subagent-async`, 2026-10-06)
- **sequence_position**: N/A
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit
- **priority**: normal
- **estimated_complexity**: moderate — several small, independent edits; the load-bearing risk is keeping the CJS mirror tests in sync with the carry I/O refactor
- **review_policy**: required — own-config harness code; decision 014's hard clause (harness/own-config work never auto-skips) applies

### Task Summary

**One-sentence description**: Remove three pieces of avoidable spawn/completion latency in `subagent-async` (always-no-op stale cleanup, serialized carry `git status`, blocking sync carry I/O) and fix two documentation drifts (stale `/tmp` work-order instructions, a false auto-checkpoint claim).

**Goal**: Behavior-preserving latency fixes with the mirror test scripts still green, plus doc text that matches how work orders actually live (`work-orders/`, reserved by push) and drops the nonexistent "auto-checkpoint the parent" behavior.

### Scope

**Files to modify**:
- `extensions/subagent-async/index.ts` — (A1) guard the stale-cleanup pair in `createWorktree`; (A2) prefetch the carry `git status` concurrently with `git worktree add`; (A3) convert carry copy/hash I/O from sync to async; (comment) update the now-stale "orchestrators are told to write these to /tmp" comment in `preCommitSteps`.
- `extensions/subagent-async/agents.ts` — (B1) skip the ancestor-directory walk when the discovery scope is `"user"`.
- `extensions/subagent-async/test-carry-uncommitted.cjs` — keep the mirrored carry/hash implementation in sync with A3.
- `extensions/subagent-async/test-completion-filter.cjs` — keep the mirrored filter implementation in sync with A3.
- `agents/orchestrator.md` — (D1) replace both `/tmp` work-order instructions with the committed `work-orders/` + reserve-by-push flow.
- `README.md` — (D2) remove the false "Subagents auto-checkpoint the parent before starting." claim.

**Files to read (reference only, do not modify)**:
- `rules/work-order-numbering.md` — the reserve-then-dispatch protocol the D1 replacement must point to.
- `skills/work-order-template/SKILL.md` ("Where it goes" / "Persistence") — the canonical work-order location text D1 must match.
- `extensions/subagent-async/TODO.md` — historical spawn-failure notes; do not reopen.

**Files NOT to modify**:
- `extensions/subagent-async/index.ts` `postDeliveryCleanup` (the real `git worktree remove --force` at the completion path) — A1's guard is for `createWorktree` only; cleanup must keep removing real worktrees.
- `extensions/auto-checkpoint.ts` / `tests/auto-checkpoint.test.ts` — another session's uncommitted work; not part of this WO.
- `decisions/**`, `settings.json`, `package.json` — no new decision or config is required.

**Out of scope**: the orphan-socket adoption behavior in `session_start`; per-event `appendFileSync` logging; `writeTempFile` caching; moving worktree creation off the spawn critical path; prompt-level suite scoping. Do not "fix" these.

### Implementation Specification

**A1 — Stale-cleanup guard (`createWorktree`, currently ~`:598-604`).**
The block

```ts
await Promise.allSettled([
    git(["worktree", "remove", "--force", worktreePath], parentCwd),
    git(["branch", "-D", branchName], parentCwd),
]);
```

runs two git subprocesses on every spawn, but `sessionId.slice(-12)` comes from a fresh `randomUUID()` per spawn and `createWorktree` is only called on fresh spawns (`subagent_resume` passes nulls and never calls it), so both commands are guaranteed no-ops. Wrap the block in `if (fs.existsSync(worktreePath))`. When the directory exists, behavior is unchanged (both commands still attempted via `Promise.allSettled`); when it does not, skip both. Keep the `PI_ASYNC_DEBUG` timing line working in both branches (log 0 or skip it when guarded — your call, but do not remove the debug instrumentation).

**A2 — Overlap carry `git status` with `worktree add` (`createWorktree` + `carryUncommittedState`).**
Today the carry stage runs after `worktree add` and re-spawns `git status`; the status only reads the parent and can run while the worktree is materializing. In `createWorktree`, before the `git worktree add` call, start:

```ts
const carryStatusPromise = carryUncommitted && !baseRef
    ? git(["status", "--porcelain=v1", "-uall", "-z"], topLevel)
    : undefined;
```

Pass it as an optional third argument to `carryUncommittedState(topLevel, worktreePath, carryStatusPromise)`. The function signature becomes
`carryUncommittedState(topLevel: string, worktreePath: string, statusPromise?: Promise<{stdout: string; stderr: string; exitCode: number}>)`,
and the body uses `const res = await (statusPromise ?? git([...]));`. `git()` never rejects (it resolves with `exitCode: 1` on spawn failure), so an unawaited failed prefetch cannot become an unhandled rejection. If `worktree add` fails, the function returns before the promise is consumed — fine. The two-argument call form used by the mirror tests must keep working (default path identical).

**A3 — Async carry I/O.**
Convert `copyCarriedFile` and `hashCarriedFile` to `fs.promises`:
- `hashCarriedFile(absPath): Promise<string | null>` — `fs.promises.lstat`, `readlink`, `readFile`; any throw → `null`.
- `copyCarriedFile(...): Promise<void>` — `mkdir(recursive)`, `lstat`, and the same three cases: symlink → `symlink(readlink(src), dst)`; directory → return; file → `copyFile` then `chmod(dst, st.mode & 0o7777)`.
- `carryUncommittedState`: `recordPresent` becomes async (`await hashCarriedFile`); `await copyCarriedFile(...)` and `await recordPresent(...)` at every call site. Keep the per-entry sequential order — deletes before copies for renames, etc. The win is not blocking the event loop between files; do not introduce `Promise.all` where ordering between rename/delete/copy of related paths could interleave.
- `preCommitSteps` carried-file filter (~`:815-825`): `await hashCarriedFile(abs)` instead of the sync call; the loop may stay sequential. Keep the try/catch degrade path and the "failure → treat as touched" semantics.
- Update the `preCommitSteps` comment that says orchestrators write work-order docs to `/tmp` — after D1, dispatch WOs are committed under `work-orders/`, so the comment should say the scratch filter is defense-in-depth for stray `WO-*.md` copies, not the primary mechanism.

**B1 — Scope-gate the project-agents walk (`agents.ts:269`).**
`discoverAgents` walks from `cwd` to `/` via `findNearestProjectAgentsDir(cwd)` before checking scope, so the `discoverAgents(cwd, "user")` call in the `subagent` tool pays the walk for a result it discards. Change to:

```ts
const projectAgentsDir = scope === "user" ? null : findNearestProjectAgentsDir(cwd);
```

Result shapes for all three scopes must be unchanged.

**D1 — `agents/orchestrator.md` work-order persistence.**
Two places instruct writing work orders to `/tmp`, contradicting `skills/work-order-template/SKILL.md` and `rules/work-order-numbering.md` (the doc also says "Always pass `workOrderPath`" at ~`:272`, which cannot resolve a `/tmp` path because the harness does `path.join(cwd, workOrderPath)`).

- In "### 3. Write work orders and dispatch implementers" (~`:118-124`): replace the bolded `/tmp` instruction with: write the work order to `work-orders/<id>-<slug>.md` at the target repo's root; commit it and push to reserve the id before dispatch (`rules/work-order-numbering.md`); pass that repo-relative path as `workOrderPath`. Keep the underlying warning — never leave an *uncommitted* work-order or scratch copy in a worktree, because the isolation auto-commit sweeps it into the branch; mention the 290-line leak as the precedent.
- In "What you do not do" (~`:265-266`): reword "Do not persist scratch or work-order files inside the worktree — write them to `/tmp`" so it forbids only *uncommitted* drafts: committed work orders under `work-orders/` are part of the base commit and are fine; drafts and scratch notes go to `/tmp`.

**D2 — `README.md:58`.**
Delete the trailing sentence `Subagents auto-checkpoint the parent before starting.` No such code path exists: `extensions/auto-checkpoint.ts` hooks `session_start`, `model_select`, `session_compact`, `turn_end`, `tool_result`, and `before_agent_start` only, and no extension hooks subagent spawn. Nothing else on that line changes.

**Required test boundary**: the CJS mirror scripts, which exercise the carry/completion logic end-to-end against real temp repos and real `git worktree add`/`remove`. `createWorktree`/`carryUncommittedState`/`preCommitSteps` are not exported, so the mirrors are the accepted boundary — they must be updated in the same commit and pass. B1 is covered by `tests/discover-agents-cache.test.ts`.

**Behavior and failure matrix**:

| # | Case | Expected |
|---|---|---|
| 1 | Fresh spawn, no stale worktree dir | No `worktree remove` / `branch -D` subprocesses; `worktree add` proceeds |
| 2 | Fresh spawn, stale dir exists at `worktreePath` | Both cleanup commands still attempted, then `worktree add` (unchanged) |
| 3 | `carryUncommitted: false` or `baseRef` set | No status prefetch, no overlay (unchanged) |
| 4 | Carry with modified/untracked/staged files | Snapshot hashes byte-identical to the sync implementation; overlay contents unchanged |
| 5 | Carry with delete / rename / copy / symlink / exec-bit entries | Same handling as before (all existing mirror rows) |
| 6 | Carry where `git status` fails | Empty snapshot, HEAD-only worktree (unchanged) |
| 7 | Completion filter: untouched carried file | Unstaged, not committed (unchanged) |
| 8 | Completion filter: carried file modified by child | Committed (unchanged) |
| 9 | `discoverAgents(cwd, "user" / "project" / "both")` | Identical agent lists/dir result to pre-change |

**Integration contract**: `createWorktree` returns the same `{worktreePath, branchName, parentHeadCommit, carried?}`; `CarriedSnapshot` entries keep `{state:"present", hash}` / `{state:"absent"}` shapes and hash values; `preCommitSteps` still returns `{note, finalCommit, hadChanges}` and never throws.

**Reference patterns**: follow the existing `async` style around `carryUncommittedState`/`preCommitSteps`; `git()` stays the only subprocess helper.

### Invariants

**Cross-file conventions**:
- The CJS mirrors in `test-carry-uncommitted.cjs` and `test-completion-filter.cjs` are duplicated logic pinned to the source; when either side changes, the other changes in the same commit.
- `fs.promises` I/O only in the converted functions; the surrounding code may keep sync fs where it is not on the spawn/completion blocking path.
- No new dependencies; `package.json` untouched.

**Default values to preserve**:
- `carryUncommitted` default stays `true` (the tool handler's `?? true`).
- Mirror scripts run with `node`, no test framework.

**Ordering assumptions**:
- Carry status may be *fetched* concurrently with `worktree add`, but the overlay must only *apply* after `worktree add` succeeds.
- Within the carry loop, per-entry ordering (rename delete → copy, etc.) is preserved.

**Error handling conventions**:
- Carry failure still degrades to HEAD-only (never fails dispatch); `preCommitSteps` failures still produce a note, never throw; `hashCarriedFile` failure still yields `null` → entry treated as touched.
- `git()` never rejects, so the prefetched promise needs no `.catch`.

**Unspecified invariants**: none — the enumerated list is complete.

### Verification Criteria

**Entry points that must work**:
- `node extensions/subagent-async/test-carry-uncommitted.cjs` — every row passes.
- `node extensions/subagent-async/test-completion-filter.cjs` — every row passes.
- `bun test tests/discover-agents-cache.test.ts` — passes.
- `bun test tests/subagent-global-append.test.ts tests/subagent-review-status.test.ts tests/subagent-session-lifetime.test.ts tests/work-order-policy.test.ts` — pass.

**Input shapes that must be accepted**: the pre-existing mirror matrix (untracked/modified/staged/deleted/renamed/copied/symlink/exec-bit/space-in-path).

**Tests that must pass**: all commands above; report exact pass counts.

**Test surface requirements**: mirrors keep exercising real `git` against temp repos (they already do); do not replace with mocked-`git` unit tests.

**Build requirements**: no new warnings; `package.json` unchanged. If a TypeScript check is available (`bun test` compiles the touched files), report it.

### Structural Risks

- [ ] **Route/path correctness**: edits land in the functions named above, not near-duplicate helpers; `postDeliveryCleanup` is untouched.
- [ ] **Input validation scope**: no carry-entry type or handling is dropped or narrowed.
- [ ] **Test surface**: mirrors updated and actually executed, not just edited.
- [ ] **Recovery logic**: degraded paths (status failure, hash failure, copy failure) still behave as before.
- [ ] **No unrequested changes**: do not touch the out-of-scope items listed above.
- [ ] **Build config untouched**: no `package.json`/config edits.
- [ ] **No unsolicited features**: no new abstractions, no exports added for testing, no refactors beyond the specified conversions.

### Context

**Prior work orders completed in this plan**: N/A — this is an ad-hoc audit follow-up; the relevant prior art is commit `6736ae2` (WO-2026-014 latency pass: parallel `rev-parse`, agent cache, deliver-before-cleanup), which already fixed the items not in scope here.

**Upcoming work orders**: an orphan-socket adoption fix (unassigned) will touch `session_start`; do not preempt it.

**Relevant decisions from planning session**: none — this is an ad-hoc audit follow-up dispatched from the parent session; no decision record accompanies it. The behavior-preservation contract is fully specified above.

### Completion Report Format

Standard implementer format (status / invariant_exhaustiveness / files_modified / tests / structural_checks / deviations_from_spec / notes_for_orchestrator), plus for the required review: assumptions_made, unexpected_changes, issues_encountered, test_coverage, adversarial_reviews (both verdicts + session ids + rounds), review_cap_reached, accepted_notes.
