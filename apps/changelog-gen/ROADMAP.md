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
- [ ] **ITEM-1: Commit fetcher + parser** — wrap `git log`, parse conventional-commit messages into `Commit[]` (pure module, `src/commits.ts` + `src/commits.test.ts`). *Parallel after ITEM-0.*
- [ ] **ITEM-2: Classifier/grouper** — `Commit[]` → `GroupedChangelog`, groups ordered by `TYPE_PRECEDENCE`, breaking flagged (pure module, `src/group.ts` + `src/group.test.ts`). *Parallel after ITEM-0.*
- [x] **ITEM-3: Renderers** — `GroupedChangelog` → markdown + plain text (pure module, `src/render.ts` + `src/render.test.ts`). *Parallel after ITEM-0.*
      — **Done:** merged `fe341ce` (render impl `pi-subagent-d7648ca3ba64`; 27 tests, 2 reviewers APPROVED, 1 round). SO-verified: gate clean (review-code + review-tests APPROVED), `tsc --noEmit` clean, `npm test` 29/29 in branch.
- [ ] **ITEM-4: CLI** — wire fetcher→grouper→renderer, arg parsing (repo path, `--since`/`--until`, `--format md|text`), stdout output (`src/cli.ts` + bin entry in `package.json`). *After ITEM-1/2/3.*

**Dependencies:** ITEM-0 first (sequential). ITEM-1/2/3 parallel after ITEM-0
(they share only the frozen `src/types.ts`). ITEM-4 after ITEM-1/2/3 land.

## Deferred / blocked

(none)
