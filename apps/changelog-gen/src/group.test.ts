import { describe, it, expect } from 'vitest';
import { groupCommits } from './group.js';
import { TYPE_PRECEDENCE } from './types.js';
import type { Commit } from './types.js';

/** Build a minimal Commit object for testing. All unspecified fields get safe defaults. */
function commit(overrides: Partial<Commit> & { type: string }): Commit {
  return {
    hash: overrides.hash ?? '0000000',
    date: '2024-01-01T00:00:00Z',
    author: 'Test <test@example.com>',
    subject: 'a commit',
    breaking: false,
    raw: 'a commit',
    ...overrides,
  };
}

describe('groupCommits', () => {
  // ── Empty input ────────────────────────────────────────────────
  it('returns empty groups and breaking for empty input', () => {
    const result = groupCommits([], { repoPath: '/test' });
    expect(result.groups).toEqual([]);
    expect(result.breaking).toEqual([]);
    expect(result.meta.totalCommits).toBe(0);
  });

  // ── Ordering by precedence ─────────────────────────────────────
  it('sorts known types by TYPE_PRECEDENCE order', () => {
    const commits: Commit[] = [
      commit({ type: 'chore', subject: 'chore work' }),
      commit({ type: 'fix', subject: 'fix work' }),
    ];
    const result = groupCommits(commits, { repoPath: '/test' });
    expect(result.groups.map((g) => g.type)).toEqual(['fix', 'chore']);
  });

  it('places feat before fix, and fix before refactor', () => {
    const commits: Commit[] = [
      commit({ type: 'refactor' }),
      commit({ type: 'feat' }),
      commit({ type: 'fix' }),
    ];
    const result = groupCommits(commits, { repoPath: '/test' });
    expect(result.groups.map((g) => g.type)).toEqual(['feat', 'fix', 'refactor']);
  });

  // ── Unknown type alpha-sort ────────────────────────────────────
  it('sorts unknown types alphabetically after known types', () => {
    const commits: Commit[] = [
      commit({ type: 'zebra' }),
      commit({ type: 'fix' }),
      commit({ type: 'apple' }),
    ];
    const result = groupCommits(commits, { repoPath: '/test' });
    // fix (known) → apple (unknown) → zebra (unknown)
    expect(result.groups.map((g) => g.type)).toEqual(['fix', 'apple', 'zebra']);
  });

  it('places unknown types between known types and the "other" group', () => {
    const commits: Commit[] = [
      commit({ type: 'other_thing' }),
      commit({ type: 'fix' }),
      commit({ type: '' }),
    ];
    const result = groupCommits(commits, { repoPath: '/test' });
    expect(result.groups.map((g) => g.type)).toEqual(['fix', 'other_thing', 'other']);
  });

  // ── "other" group last ─────────────────────────────────────────
  it('places the "other" group last after all known and unknown types', () => {
    const commits: Commit[] = [
      commit({ type: '' }),
      commit({ type: 'fix' }),
      commit({ type: 'zzz' }),
    ];
    const result = groupCommits(commits, { repoPath: '/test' });
    expect(result.groups.map((g) => g.type)).toEqual(['fix', 'zzz', 'other']);
  });

  it('groups non-conventional commits (type "") into "other"', () => {
    const commits: Commit[] = [commit({ type: '' })];
    const result = groupCommits(commits, { repoPath: '/test' });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].type).toBe('other');
    expect(result.groups[0].commits).toHaveLength(1);
  });

  // ── Breaking collection ────────────────────────────────────────
  it('collects breaking commits in both result.breaking and their type group', () => {
    const commits: Commit[] = [
      commit({ type: 'feat', subject: 'breaking feat', breaking: true }),
      commit({ type: 'fix', subject: 'normal fix', breaking: false }),
      commit({ type: 'fix', subject: 'breaking fix', breaking: true }),
    ];
    const result = groupCommits(commits, { repoPath: '/test' });

    // breaking list contains both breaking commits
    expect(result.breaking).toHaveLength(2);
    expect(result.breaking.map((c) => c.subject).sort()).toEqual([
      'breaking feat',
      'breaking fix',
    ]);

    // breaking commits also still in their type groups
    const featGroup = result.groups.find((g) => g.type === 'feat')!;
    expect(featGroup.commits).toHaveLength(1);
    expect(featGroup.commits[0].breaking).toBe(true);

    const fixGroup = result.groups.find((g) => g.type === 'fix')!;
    expect(fixGroup.commits).toHaveLength(2);
  });

  // ── Empty groups omitted ───────────────────────────────────────
  it('omits types not present in the input', () => {
    // Only feat commits — no fix, no chore, etc.
    const commits: Commit[] = [
      commit({ type: 'feat' }),
      commit({ type: 'feat' }),
    ];
    const result = groupCommits(commits, { repoPath: '/test' });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].type).toBe('feat');
  });

  // ── totalCommits correctness ───────────────────────────────────
  it('meta.totalCommits equals commits.length for mixed input', () => {
    const commits: Commit[] = [
      commit({ type: 'fix' }),
      commit({ type: 'feat' }),
      commit({ type: '' }),
      commit({ type: 'unknown' }),
    ];
    const result = groupCommits(commits, { repoPath: '/test' });
    expect(result.meta.totalCommits).toBe(commits.length);
    // Verify sum of group sizes matches too
    const sum = result.groups.reduce((acc, g) => acc + g.commits.length, 0);
    expect(sum).toBe(commits.length);
  });

  // ── meta fields echoed ─────────────────────────────────────────
  it('echoes repoPath, since, and until from opts', () => {
    const result = groupCommits([], {
      repoPath: '/my/repo',
      since: 'v1.0.0',
      until: 'v2.0.0',
    });
    expect(result.meta.repoPath).toBe('/my/repo');
    expect(result.meta.since).toBe('v1.0.0');
    expect(result.meta.until).toBe('v2.0.0');
  });

  it('omits since/until from meta when not provided', () => {
    const result = groupCommits([], { repoPath: '/test' });
    expect(result.meta.since).toBeUndefined();
    expect(result.meta.until).toBeUndefined();
  });

  // ── Multiple commits in same type group ────────────────────────
  it('groups multiple commits of the same type together', () => {
    const commits: Commit[] = [
      commit({ type: 'feat', subject: 'feat A' }),
      commit({ type: 'fix', subject: 'fix B' }),
      commit({ type: 'feat', subject: 'feat C' }),
      commit({ type: 'feat', subject: 'feat D' }),
    ];
    const result = groupCommits(commits, { repoPath: '/test' });
    const featGroup = result.groups.find((g) => g.type === 'feat')!;
    expect(featGroup.commits).toHaveLength(3);
    expect(featGroup.commits.map((c) => c.subject)).toEqual([
      'feat A',
      'feat C',
      'feat D',
    ]);

    const fixGroup = result.groups.find((g) => g.type === 'fix')!;
    expect(fixGroup.commits).toHaveLength(1);
    expect(fixGroup.commits[0].subject).toBe('fix B');

    // Sort order still correct: feat before fix
    expect(result.groups.map((g) => g.type)).toEqual(['feat', 'fix']);
  });
});
