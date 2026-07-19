# Work Order: ITEM-5 — Parser + `--since`/`--until` correctness (fix-up)

## Metadata

- **work_order_id**: WO-ITEM-5
- **parent_plan_id**: super-orchestration-007-validation
- **sequence_position**: 1 of 1
- **routed_to**: implement-flash
- **invariant_exhaustiveness**: explicit
- **priority**: critical
- **estimated_complexity**: moderate
- **review_policy**: required
- **review_depth**: standard

## Task Summary

**One-sentence description**: Fix two defects discovered by SO smoke test — `parseGitLog` corrupts every commit's hash with a leading `\n` on real git output (HIGH), and `--since`/`--until` CLI help text says `<ref>` but only accepts git date values (MED) — plus tighten `cli.test.ts` integration assertions to catch broken bullet format.

**Goal**: Produce a correct, well-tested implementation where (1) `parseGitLog` parses real multi-commit `git log` output with all hashes matching `/^[0-9a-f]+$/`, (2) the CLI help text honestly says `<date>` and `fetchCommits` rejects ref-like values with a clear error, and (3) integration tests assert the exact `- <hash>: <subject>` bullet format with clean hashes in rendered output.

## Scope

**Files to modify**:
- `apps/changelog-gen/src/commits.ts` — Fix `parseGitLog` record parsing (Defect 1) + add since/until date-validation in `fetchCommits` (Defect 2)
- `apps/changelog-gen/src/commits.test.ts` — Harden `parseGitLog` fixtures with real git byte output + add since/until tests (Defect 1 & 2)
- `apps/changelog-gen/src/cli.ts` — Change help text from `<ref>` to `<date>` (Defect 2)
- `apps/changelog-gen/src/cli.test.ts` — Tighten bullet-format assertions (Defect 3)

**Files to read (reference only, do not modify)**:
- `apps/changelog-gen/src/types.ts` — Commit type definition; verify hash field is `string`
- `apps/changelog-gen/src/render.ts` — Understand the `- ${commit.hash}: ${commit.subject}` bullet format being corrupted
- `apps/changelog-gen/src/group.ts` — Understand data flow (fetcher → grouper → renderer)

**Files NOT to modify**:
- `apps/changelog-gen/src/types.ts` — Frozen shared file
- `apps/changelog-gen/src/render.ts` — Not defective; the corruption is upstream
- `apps/changelog-gen/src/group.ts` — Not defective
- `apps/changelog-gen/src/group.test.ts` — Not in scope
- `apps/changelog-gen/src/render.test.ts` — Not in scope
- `apps/changelog-gen/ROADMAP.md` — Owned by SO; do NOT touch
- `apps/changelog-gen/package.json` — No new deps
- `apps/changelog-gen/tsconfig.json` — No config changes
- `apps/changelog-gen/vitest.config.ts` — No config changes

**Out of scope**: Refactoring unrelated code, changing renderer output format, adding new CLI flags, modifying `group.ts` or `render.ts`, touching `package.json`.

## Implementation Specification

### Defect 1 — Fix `parseGitLog` hash corruption (HIGH)

**Root cause** (do NOT re-derive; it's confirmed): git's `%h%x00%aI%x00%an <%ae>%x00%s%x00%b%x00%n` format emits an extra newline between records. The actual byte layout for two empty-body commits is:

```
<hash1>\x00<date>\x00<author>\x00<subject>\x00\x00\n\n<hash2>\x00<date>\x00<author>\x00<subject>\x00\x00\n\n
```

`parseGitLog` splits on `'\x00\n'`, which consumes only ONE of the two newlines, leaving `'\n'` at the start of every record after the first. The code then does `record.trimEnd()` (only strips trailing whitespace), so the leading `'\n'` passes through to `fields[0]` (the hash field). Result: `hash = "\n81ad72d"` instead of `"81ad72d"`.

**Fix in `parseGitLog`**: Change `record.trimEnd()` to `record.trim()` on line ~55 of `commits.ts`. This strips leading whitespace (including the stray `'\n'`) before splitting fields. This is the minimal, correct fix.

**Additional defense**: After extracting the `hash` field, add a guard: if the hash does not match `/^[0-9a-f]+$/`, skip the record (do not push to `commits`). This prevents any future separator issues from producing corrupted commits. The `continue` skip should happen right after the `if (fields.length < 5) continue;` check.

### Defect 2 — Fix `--since`/`--until` help text and add date validation (MED)

**Decision**: Fallback approach — change help text to `<date>` and add validation that rejects ref-like values. Full ref-support is too invasive for the modest scope and risks breaking the date path.

**Fix in `cli.ts`**: In the `USAGE` string, change:
- `--since <ref>         Start from this git ref or date` → `--since <date>        Start from this git date`
- `--until <ref>         End at this git ref or date` → `--until <date>        End at this git date`

**Fix in `fetchCommits` in `commits.ts`**: Add validation at the top of the function (before the `execFile` call). For each of `since` and `until`, if provided:

Detect ref-like values (anything that looks like a git ref rather than a date). Reject with a clear `Error`:

```
<flag> value "<value>" looks like a git ref. --since/--until accept git date expressions (e.g. "2025-01-01", "2.weeks.ago", "yesterday"). For commit ranges, use git directly: git log <ref>..<other-ref>
```

The detection heuristic (apply to each value):
1. If the value contains `~` or `^` → REJECT (definite ref pattern: `main~20`, `HEAD^`)
2. If the value is all hex characters (7+ chars, matching `/^[0-9a-f]{7,}$/`) → REJECT (looks like a commit hash)
3. If the value exactly matches `HEAD`, `FETCH_HEAD`, `ORIG_HEAD`, `MERGE_HEAD`, `CHERRY_PICK_HEAD` (case-insensitive) → REJECT
4. Otherwise → PASS THROUGH (let git handle it as a date; many date formats exist and we can't validate them all)

This catches the most common ref-passing mistake while letting valid dates through. A date like `2025-01-01` passes rule 2 because it's not all-hex (contains `-`). A date like `yesterday`, `2.weeks.ago`, `last Monday` all pass through.

The validation happens BEFORE `execFile`, rejecting synchronously via `reject(new Error(...))`.

### Defect 3 — Tighten CLI integration assertions

**Fix in `cli.test.ts`**: In the existing `happy path --format md` test (and `--format text` test), add assertions that check the exact bullet format:

For `--format md`:
```
const lines = result.stdout.split('\n');
const bulletLines = lines.filter(l => /^- [0-9a-f]+: /.test(l));
expect(bulletLines.length).toBeGreaterThan(0);  // at least some bullets
for (const bl of bulletLines) {
  expect(bl).toMatch(/^- [0-9a-f]+: .+/);  // exact format: "- <hash>: <subject>"
}
```

For `--format text`: same pattern but with text output.

Also add a specific assertion that NO line contains `\n` inside a hash (like `- \n<hash>:`) — this would catch the Defect 1 regression. The regex `/^- [0-9a-f]+: /` naturally enforces no leading whitespace/newline in the hash portion.

Additionally, add a **new test** that creates a temp repo with multiple commits (including empty-body via `--allow-empty-message` or just normal commits) and verifies every bullet's hash is clean:
```
it('rendered bullets have clean hashes in multi-commit repo', () => {
  // Create temp repo with 5+ commits
  // Run CLI with --format md
  // Filter for bullet lines: lines matching /^- [0-9a-f]+: /
  // Assert: every bullet has exactly the format "- <hex>: <non-empty subject>"
  // Assert: no hash has leading whitespace
});
```

## Required test boundary

The **primary test boundary** for Defect 1 is `parseGitLog()` — a pure function that takes a string and returns `Commit[]`. Tests must call `parseGitLog` with real `execFileSync('git', ...)` output (captured from a hermetic temp repo). The **secondary boundary** is the full CLI via `spawnSync('npx', ['tsx', 'cli.ts', ...])` for Defect 3.

For Defect 2, the test boundary is `fetchCommits()` for the date-validation rejection, and the CLI for the `--help` text change.

## Behavior and failure matrix

### parseGitLog

| # | Case | Expected |
|---|------|----------|
| 1 | Empty string input | Returns `[]` |
| 2 | Single commit, empty body | Hash clean (`/^[0-9a-f]+$/`), 1 commit |
| 3 | Multiple commits (3+), all empty body | All hashes clean, N commits returned |
| 4 | Multiple commits, mix of empty-body + single-line body + multi-line body | All hashes clean, all commits parsed |
| 5 | Commit with `BREAKING CHANGE:` footer in body | `breaking: true`, hash clean |
| 6 | Real git output from a temp repo with 5+ commits of varying types | All hashes match `/^[0-9a-f]+$/`, no corruptions |
| 7 | Record with corrupt hash (non-hex after trim) | Record skipped (not included in output) |
| 8 | Body containing NUL bytes that look like field separators | Fields parsed correctly via 5-field minimum check |

### fetchCommits since/until validation

| # | Case | Expected |
|---|------|----------|
| 9 | `since='2025-01-01'` | Accepted, passed to git |
| 10 | `since='2.weeks.ago'` | Accepted, passed to git |
| 11 | `since='yesterday'` | Accepted, passed to git |
| 12 | `since='main~20'` (contains `~`) | **Rejected** with clear error message |
| 13 | `since='HEAD^'` (contains `^`) | **Rejected** with clear error message |
| 14 | `since='81ad72d123'` (all-hex, 7+ chars) | **Rejected** with clear error message |
| 15 | `since='HEAD'` (exact match) | **Rejected** with clear error message |
| 16 | `until='FETCH_HEAD'` | **Rejected** with clear error message |
| 17 | `since='20250101'` (all-hex, 8 chars) | **Rejected** — ambiguous, treat as hash. (If this is a date, user should use ISO format `2025-01-01`) |
| 18 | `since='2025'` (all-hex, 4 chars) | Accepted, passed to git (under 7-char threshold) |
| 19 | `since='last Monday'` | Accepted, passed to git |
| 20 | `since='2025-07-19T12:00:00'` | Accepted, passed to git |

### CLI help text

| # | Case | Expected |
|---|------|----------|
| 21 | `--help` output | Contains `--since <date>`, NOT `--since <ref>` |
| 22 | `--help` output | Contains `--until <date>`, NOT `--until <ref>` |

### CLI integration bullet format

| # | Case | Expected |
|---|------|----------|
| 23 | `--format md` on multi-commit temp repo | All commit bullets match `- [0-9a-f]+: .+` |
| 24 | `--format text` on multi-commit temp repo | All commit bullets match `- [0-9a-f]+: .+` |
| 25 | `--format md` on multi-commit temp repo | No hash has leading whitespace/newline |
| 26 | `--format md` on multi-commit temp repo | Breaking changes section bullets also clean |

### Regressions

| # | Case | Expected |
|---|------|----------|
| 27 | All existing tests still pass | `npm test` — all 82 existing tests green |
| 28 | `tsc --noEmit` | Clean, no new type errors |
| 29 | Real repo CLI smoke: `npx tsx src/cli.ts --since 2026-01-01 --format md \| head -15` | Well-formed `- <hash>: <subject>` bullets, single-line, no stray newlines |
| 30 | Invalid date input: `npx tsx src/cli.ts --since main~5` | Exit 1, stderr contains clear error message, NOT silent empty output |

## Representation-level checks

- Every `Commit.hash` produced by `parseGitLog` must match `/^[0-9a-f]+$/` (no leading/trailing whitespace, no NUL bytes, no other garbage).
- The `fields.length < 5` guard must remain — do not weaken it.
- `fetchCommits` must NOT change its return type or Promise contract — it still returns `Promise<Commit[]>`.

## Integration contract

- `parseGitLog` is called by `fetchCommits` → both are in `commits.ts`, so internal changes are fine.
- `fetchCommits` is called by `cli.ts` `main()` → the function signature (`(repoPath: string, since?: string, until?: string): Promise<Commit[]>`) must remain unchanged. The new validation rejects via the existing `reject(err)` path; the CLI already catches and prints.
- `USAGE` string is exported via `getUsage()` → `cli.test.ts` asserts against it; update test assertions to match new text.

## Reference patterns

- Follow the existing test style in `commits.test.ts` for `fetchCommits` (uses `new URL('../..', import.meta.url).pathname` for repo path).
- Follow the existing test style in `cli.test.ts` for `createTempGitRepo()` / `runCli()` helpers.
- For the real-git-output test, use `execFileSync` from `node:child_process` synchronously to capture git output from a hermetic temp repo (create with `mkdirSync`, `spawnSync('git', ['init'], ...)`, etc. — same pattern as `cli.test.ts`'s `createTempGitRepo`).

## Invariants

### Cross-file conventions
- All imports use `.js` extensions (ESM/NodeNext): `'./types.js'`, `'./commits.js'`, etc.
- All tests use vitest (`describe`/`it`/`expect` from `'vitest'`).
- No `any` types; use proper TypeScript types.
- `npx tsc --noEmit` must stay clean.

### Default values to preserve
- `parseGitLog('')` returns `[]` (empty string → empty array).
- `fetchCommits` without since/until fetches all commits (no date filtering).
- `--format` defaults to `'md'`.
- The `USAGE` string is the single source of truth for help text.

### Ordering assumptions
- `parseGitLog` runs after `execFile` callback receives stdout.
- `fetchCommits` validation runs BEFORE `execFile` (fail fast, no git subprocess for known-bad input).

### Error handling conventions
- `fetchCommits` rejects with `Error` objects. The CLI catches and prints `changelog-gen: <message>` to stderr + exits 1.
- `parseGitLog` never throws; it returns `[]` for unparseable input and skips individual unparseable records.
- No `console.error` inside library code (`commits.ts`); only in CLI (`cli.ts`).

### Specified invariants
- Hash field always matches `/^[0-9a-f]+$/` after `parseGitLog`.
- `fetchCommits` rejects ref-like since/until values before spawning git.
- Help text uses `<date>`, not `<ref>`.
- CLI integration assertions check exact bullet format with clean hashes.

## Verification Criteria

### Entry points that must work
- `parseGitLog(realGitOutput)` → `Commit[]` with all clean hashes.
- `fetchCommits(repoPath, 'main~5')` → rejected Promise with descriptive error.
- `fetchCommits(repoPath, '2025-01-01')` → resolves with git-filtered commits.
- `npx tsx src/cli.ts --help` → shows `--since <date>` and `--until <date>`.
- `npx tsx src/cli.ts <repo> --since main~5` → exit 1, stderr message.

### Tests that must pass
- `npm test` — all existing 82 tests still pass.
- New tests for: parseGitLog real-git-output, fetchCommits date validation, CLI bullet format.

### Test surface requirements
- The real-git-output test must capture output via `execFileSync('git', ['log', '--format=...', ...])` from a hermetic temp repo with **at least**: one empty-body commit, one single-line-body commit, one multi-line-body commit, and one commit with `BREAKING CHANGE:` footer. All hashes must be asserted clean.
- CLI tests must use `spawnSync` to run the actual CLI (not import and call internal functions).

### Build requirements
- `npx tsc --noEmit` in `apps/changelog-gen/` must be clean (exit 0, no errors).
- No new npm dependencies.
- No changes to `package.json`, `tsconfig.json`, or `vitest.config.ts`.

## Structural Risks

- [x] **Route/path correctness**: Only the 4 files listed in "Files to modify" are changed. No new files.
- [x] **Input validation scope**: The date-validation heuristic must not reject valid git date expressions. The heuristic is conservative: only rejects clear ref patterns.
- [x] **Test surface**: Real-git-output test calls `parseGitLog` with real bytes. CLI tests run the actual CLI. No internal-function-only tests for new behavior.
- [x] **Recovery logic**: N/A — no retry or recovery logic in this work order.
- [x] **No unrequested changes**: Do not refactor `parseCommitSubject`, `groupCommits`, `renderMarkdown`, or any other function not listed above.
- [x] **Build config untouched**: Do not modify `package.json`, `tsconfig.json`, `vitest.config.ts`.
- [x] **No unsolicited features**: Do not add ref-support for `--since`/`--until`, do not change the renderer bullet format, do not add new CLI flags.

## Context

### Prior work orders completed in this plan
1. ITEM-0 through ITEM-4 are DONE and merged on `main`. The baseline is `npm test` 82/82 green, `tsc --noEmit` clean.
2. ITEM-4 merged the CLI wiring (`81ad72d`) — the CLI calls `fetchCommits` → `groupCommits` → `renderMarkdown`/`renderText`.

### Upcoming work orders
None — this is the final item in the plan.

### Relevant decisions from planning session
- The SO root-caused both defects; the implementer must not re-derive.
- The SO chose the fallback approach for Defect 2 (doc-fix + validation, not ref-support).
- The review policy is `required` with `standard` depth (Mimo-V2.5-Pro reviewers).

## Escape Hatch

If you discover implicit invariants — e.g., the date-validation heuristic rejects a valid git date format, or a test fixture produces unexpected byte layouts — stop and report `invariant_exhaustiveness: implicit` in your completion report. Do not guess.

## Completion Report Format

Use the `implement-flash` completion report schema (status, invariant_exhaustiveness, files_modified, tests, structural_checks, deviations_from_spec, notes_for_orchestrator) PLUS the review-gate fields (assumptions_made, unexpected_changes, issues_encountered, test_coverage, adversarial_reviews with both reviewer verdicts and session IDs, review_cap_reached, accepted_notes).

### Required real-history verification

Before reporting complete, run this exact command and include the output in your report:

```bash
cd apps/changelog-gen && npx tsx src/cli.ts --since 2026-01-01 --format md | head -15
```

Every bullet must be single-line `- <hash>: <subject>` with a clean hash. If you see `- \n` patterns or empty bullets, the fix is incomplete.
