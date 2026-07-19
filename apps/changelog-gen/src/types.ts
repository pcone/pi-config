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
