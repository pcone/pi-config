# Roadmap: changelog-gen

A self-contained TypeScript CLI that reads conventional-commits from a git
repo's history and emits a grouped changelog (markdown / plain text).

This is the **validation build for 007 (super-orchestration)**. It is built
by `orchestrator`-subagents dispatched by the super-orchestrator (SO). The SO
owns this doc and reconciles it after every item lands.

---

## Resolved policy

Locked — applies to all items. Orchestrators must not re-litigate these.

- **Stack:** TypeScript / Node. Runtime via **`tsx`** (no build step required;
  a `build` script using `tsc` is optional).
- **Test framework:** **Vitest** (configured by ITEM-0; items 1–4 just write
  `*.test.ts`). Tests required per item.
- **Package:** self-contained package at `apps/changelog-gen/` with its own
  `package.json`, `tsconfig.json`, vitest config, and `.gitignore`.
- **Isolation (hard):** do NOT touch any file outside `apps/changelog-gen/`.
  Specifically never modify pi-config root `package.json`, `settings.json`,
  `extensions/`, root `tsconfig.json`, `models.json`, or `agents/`.
- **Shared files are frozen during parallel work:** `src/types.ts`,
  `package.json`, `tsconfig.json`, and the vitest config are owned by ITEM-0.
  Items 1–3 MUST NOT modify them. If an item needs an extra field, it defines
  a module-local type or flags the need to the SO in its completion report —
  it does not edit the shared files.
- **Review depth:** **standard (shallow)** per implementer pass. (The 007
  validation also exercises the new `xiaomi/mimo-v2.5-pro` shallow reviewers
  live.)
- **Scope:** modest — each item is one implementer pass (`implement-flash` or
  `implement-pro` at the orchestrator's discretion).

### Data contract

ITEM-0 creates `src/types.ts` with exactly the following. Items 1–3 build
against it. The authoritative minimum:

```ts
/** Conventional-commit type precedence (highest first).
 *  Types not listed sort after these, alphabetically. */
export const TYPE_PRECEDENCE =
  ["feat", "fix", "perf", "refactor", "docs", "test", "build", "ci", "chore"] as const;

/** A single parsed commit. Items 1–3 must produce/consume at least these fields. */
export interface Commit {
  hash: string;        // abbreviated sha (git %h), 7+ chars
  date: string;        // ISO 8601 timestamp (git %aI)
  author: string;      // "Name <email>" (git %an <%ae>)
  type: string;        // lowercased conventional type; "" for non-conventional commits
  scope?: string;      // scope text without parens; undefined when absent
  subject: string;     // text after type/scope/breaking marker; full raw subject for non-conventional
  breaking: boolean;   // true if "!" before colon OR a "BREAKING CHANGE:" / "BREAKING-CHANGE:" footer
  raw: string;         // raw commit subject line, unmodified
}

/** A group of commits sharing a type. */
export interface CommitGroup {
  type: string;
  commits: Commit[];
}

/** Result of grouping commits for rendering. */
export interface GroupedChangelog {
  breaking: Commit[];        // all breaking commits (also still present in their type group)
  groups: CommitGroup[];     // ordered by TYPE_PRECEDENCE then type-name alpha; empty groups omitted
  meta: {
    repoPath: string;        // repo path used (as provided to the fetcher)
    since?: string;          // echoed since ref/date if provided
    until?: string;          // echoed until ref/date if provided
    totalCommits: number;    // sum of commits across groups
  };
}
```

---

## Active

### changelog-gen

- [x] **ITEM-0: Package scaffold + frozen data-contract types + vitest harness**
      — create `apps/changelog-gen/{package.json, tsconfig.json, vitest.config.ts, .gitignore, README.md, src/types.ts}` per the data contract above and resolved policy. **Sequential, FIRST.** Items 1–3 branch from the commit this item produces.
      — **Done:** merged `e8095a5` (scaffold impl `20d0a37`; deps: typescript ^5.6.3, tsx ^4.19.2, vitest ^2.1.8). SO-verified: gate clean (review-code + review-tests APPROVED_WITH_NOTES, 2 rounds, 1 HIGH fixed), `tsc --noEmit` clean, `npm test` 2/2 in main.
- [x] **ITEM-1: Commit fetcher + parser** — wrap `git log`, parse conventional-commit messages into `Commit[]` (pure module, `src/commits.ts` + `src/commits.test.ts`). *Parallel after ITEM-0.*
      — **Done:** merged `624afdb` (impl worktree `pi-subagent-fc1113cfc5f7`; gate: review-code + review-tests APPROVED_WITH_NOTES, 1 round each, all notes resolved). 24 test cases, `tsc --noEmit` clean, `npm test` 26/26. ⚠ used `@ts-expect-error` on `node:child_process` — `@types/node` missing from scaffold (ITEM-4 to fix).
- [x] **ITEM-2: Classifier/grouper** — `Commit[]` → `GroupedChangelog`, groups ordered by `TYPE_PRECEDENCE`, breaking flagged (pure module, `src/group.ts` + `src/group.test.ts`). *Parallel after ITEM-0.*
      — **Done:** merged `a575cb0` (impl `7511198`). Gate clean: review-code + review-tests both APPROVED, 1 round each; `invariant_exhaustiveness: explicit` (flash routing correct). SO-verified in main: `tsc --noEmit` clean, `npm test` 15/15 (13 group + 2 types).
- [x] **ITEM-3: Renderers** — `GroupedChangelog` → markdown + plain text (pure module, `src/render.ts` + `src/render.test.ts`). *Parallel after ITEM-0.*
      — **Done:** merged `9323ab2` (render impl worktree `pi-subagent-d7648ca3ba64`; 27 tests, 2 reviewers APPROVED, 1 round). SO-verified: gate clean, `tsc --noEmit` clean, `npm test` 29/29.
- [x] **ITEM-4: CLI** — wire fetcher→grouper→renderer, arg parsing (repo path, `--since`/`--until`, `--format md|text`), stdout output (`src/cli.ts` + bin entry in `package.json`). *After ITEM-1/2/3.*
      — **Done:** merged `81ad72d` (impl worktree `pi-subagent-20c69f380972`; gate: review-code + review-tests APPROVED_WITH_NOTES, 1 round, 5 LOW accepted + 1 MED fixed; `invariant_exhaustiveness: explicit`). `tsc --noEmit` clean, `npm test` 82/82, `--help` works, `@ts-expect-error` removed + `@types/node` added. No ROADMAP conflict (orchestrator left doc to SO — mitigation held). **⚠ SO end-to-end smoke FAILED:** real `git log` output corrupts every commit's `hash` field (latent `parseGitLog` separator bug → ITEM-5) and `--since <ref>` is silently date-only. CLI wiring itself is correct; defects live in `commits.ts`.
- [x] **ITEM-5: Parser + `--since`/`--until` correctness (fix-up)** — (1) **[HIGH]** `parseGitLog` mis-splits real `git log` output … (2) **[MED]** `--since`/`--until` date-vs-ref … (3) tighten `cli.test.ts` bullet assertions. *After ITEM-4; surfaced by the SO smoke test — the gate missed it.*
      — **Done:** merged `b5ce255` (impl worktree `pi-subagent-279bc95fde9c`; gate: review-code + review-tests APPROVED_WITH_NOTES, 1 round, 2 LOW accepted as documented validator tradeoffs; `invariant_exhaustiveness: explicit`). Fix: `parseGitLog` `trimEnd()`→`trim()` + hash guard `/^[0-9a-f]+$/`; `--since`/`--until` took the **doc-fix fallback** (help → `<date>`, `isValidDateParam()` heuristic rejects common refs loudly, exit 1); hermetic multi-record git fixture added; `cli.test.ts` asserts `/^- [0-9a-f]+: /`. `tsc --noEmit` clean, `npm test` **99/99**. **SO re-verified on real history** (did not trust the report after ITEM-4): `--since 2026-01-01 --format md` → clean single-line `- <hash>: <subject>` bullets; `--since main~5` → exit 1 + `changelog-gen: Invalid --since value…`. Stray `WO-ITEM-5.md` the orchestrator leaked to repo root was removed (`5f126e3`). **Accepted limitation:** the date validator is heuristic — arbitrary branch names can still slip through to git and yield silent empty output (2 LOW notes); full ref support via `git rev-parse` was intentionally deferred.

**✅ All items done. App builds end-to-end: `npm install && npx tsx src/cli.ts --since <date> --format md` produces a correct grouped changelog from real git history.**

**Dependencies:** ITEM-0 first (sequential). ITEM-1/2/3 parallel after ITEM-0
(they share only the frozen `src/types.ts`). ITEM-4 after ITEM-1/2/3 land. ITEM-5
after ITEM-4 (fix-up from the SO smoke test; defects are in `commits.ts` + `cli.ts`).

## Deferred / blocked

(none)
