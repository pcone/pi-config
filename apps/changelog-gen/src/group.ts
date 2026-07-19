import type { Commit, CommitGroup, GroupedChangelog } from './types.js';
import { TYPE_PRECEDENCE } from './types.js';

/**
 * Return a sort-key tuple for a group type string.
 *
 * Known types (in TYPE_PRECEDENCE) get key [0, paddedIndex] → sorted first,
 * in precedence order. Unknown types get key [1, typeName] → sorted
 * alphabetically between known types and "other". The "other" group gets
 * key [2, ''] → sorted last.
 */
function groupTypeRank(type: string): [number, string] {
  const idx = TYPE_PRECEDENCE.indexOf(type as (typeof TYPE_PRECEDENCE)[number]);
  if (idx !== -1) return [0, String(idx).padStart(3, '0')];
  if (type === 'other') return [2, ''];
  return [1, type];
}

/**
 * Group commits by conventional-commit type, returning an ordered
 * GroupedChangelog suitable for rendering.
 *
 * This is a pure function — no I/O, no side effects.
 */
export function groupCommits(
  commits: Commit[],
  opts: { repoPath: string; since?: string; until?: string },
): GroupedChangelog {
  // Phase 1: partition commits into type groups, collecting breaking list.
  const groupsByType = new Map<string, Commit[]>();
  const breaking: Commit[] = [];

  for (const commit of commits) {
    // Determine the effective group type.
    const groupType = commit.type === '' ? 'other' : commit.type;

    // Add to type group.
    let bucket = groupsByType.get(groupType);
    if (!bucket) {
      bucket = [];
      groupsByType.set(groupType, bucket);
    }
    bucket.push(commit);

    // Collect breaking commits cross-cutting.
    if (commit.breaking) {
      breaking.push(commit);
    }
  }

  // Phase 2: build and sort the groups array.
  const groups: CommitGroup[] = [];
  for (const [type, bucket] of groupsByType) {
    groups.push({ type, commits: bucket });
  }

  groups.sort((a, b) => {
    const [rA, sA] = groupTypeRank(a.type);
    const [rB, sB] = groupTypeRank(b.type);
    if (rA !== rB) return rA - rB;
    if (sA < sB) return -1;
    if (sA > sB) return 1;
    return 0;
  });

  // Phase 3: assemble result.
  const totalCommits = commits.length;

  return {
    breaking,
    groups,
    meta: {
      repoPath: opts.repoPath,
      since: opts.since,
      until: opts.until,
      totalCommits,
    },
  };
}
