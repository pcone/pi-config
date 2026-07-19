import { describe, it, expect } from 'vitest';
import { renderMarkdown, renderText } from './render.js';
import type { GroupedChangelog } from './types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCommit(hash: string, subject: string, type = 'feat', breaking = false) {
  return {
    hash,
    date: '2024-01-01T00:00:00Z',
    author: 'Test User <test@example.com>',
    type,
    subject,
    breaking,
    raw: `${type}${breaking ? '!' : ''}: ${subject}`,
  };
}

function makeGroup(type: string, ...hashesAndSubjects: [string, string][]) {
  return {
    type,
    commits: hashesAndSubjects.map(([hash, subject]) =>
      makeCommit(hash, subject, type, false),
    ),
  };
}

function makeChangelog(overrides?: Partial<GroupedChangelog>): GroupedChangelog {
  return {
    breaking: [],
    groups: [],
    meta: { repoPath: '/test/repo', totalCommits: 0 },
    ...overrides,
  };
}

// ─── renderMarkdown ───────────────────────────────────────────────────────────

describe('renderMarkdown', () => {
  // Case 1: Empty changelog (no breaking, no groups, no since/until)
  it('case 1: renders title only for empty changelog', () => {
    const gc = makeChangelog();
    const result = renderMarkdown(gc);
    expect(result).toBe('# Changelog');
  });

  // Case 2: Empty changelog WITH since/until
  it('case 2: renders title + range line for empty changelog with range', () => {
    const gc = makeChangelog({
      meta: { repoPath: '/test/repo', since: 'v1.0', until: 'v2.0', totalCommits: 0 },
    });
    const result = renderMarkdown(gc);
    expect(result).toContain('# Changelog');
    expect(result).toContain('_From v1.0 to v2.0_');
    // No sections
    expect(result).not.toContain('##');
  });

  // Case 3: Breaking changes only
  it('case 3: renders breaking section when groups are empty', () => {
    const gc = makeChangelog({
      breaking: [makeCommit('abc1234', 'fix critical bug', 'fix', true)],
    });
    const result = renderMarkdown(gc);
    expect(result).toContain('## ⚠ Breaking changes');
    expect(result).toContain('- `abc1234`: fix critical bug');
    expect(result).not.toContain('## fix');
  });

  // Case 4: Groups only (no breaking)
  it('case 4: renders group sections when breaking is empty', () => {
    const gc = makeChangelog({
      groups: [makeGroup('feat', ['aaa111', 'add login']), makeGroup('fix', ['bbb222', 'fix crash'])],
      meta: { repoPath: '/test/repo', totalCommits: 2 },
    });
    const result = renderMarkdown(gc);
    expect(result).toContain('## feat');
    expect(result).toContain('## fix');
    expect(result).toContain('- aaa111: add login');
    expect(result).toContain('- bbb222: fix crash');
    expect(result).not.toContain('⚠ Breaking');
  });

  // Case 5: Breaking + groups
  it('case 5: breaking section appears before group sections', () => {
    const gc = makeChangelog({
      breaking: [makeCommit('ccc333', 'breaking API change', 'feat', true)],
      groups: [makeGroup('feat', ['ddd444', 'new feature'])],
      meta: { repoPath: '/test/repo', totalCommits: 2 },
    });
    const result = renderMarkdown(gc);
    // Breaking section should come first
    const breakingIndex = result.indexOf('⚠ Breaking changes');
    const featIndex = result.indexOf('## feat');
    expect(breakingIndex).toBeGreaterThan(-1);
    expect(featIndex).toBeGreaterThan(-1);
    expect(breakingIndex).toBeLessThan(featIndex);
  });

  // Case 6: Multiple groups
  it('case 6: groups rendered in gc.groups array order', () => {
    const gc = makeChangelog({
      groups: [
        makeGroup('docs', ['e00', 'update readme']),
        makeGroup('feat', ['f11', 'add feature']),
        makeGroup('fix', ['g22', 'fix bug']),
      ],
      meta: { repoPath: '/test/repo', totalCommits: 3 },
    });
    const result = renderMarkdown(gc);
    const docsIndex = result.indexOf('## docs');
    const featIndex = result.indexOf('## feat');
    const fixIndex = result.indexOf('## fix');
    expect(docsIndex).toBeLessThan(featIndex);
    expect(featIndex).toBeLessThan(fixIndex);
  });

  // Case 7: since present, until absent
  it('case 7: renders "Since <since>" when only since is present', () => {
    const gc = makeChangelog({
      meta: { repoPath: '/test/repo', since: 'v1.0', totalCommits: 0 },
    });
    const result = renderMarkdown(gc);
    expect(result).toContain('_Since v1.0_');
    expect(result).not.toContain('until');
  });

  // Case 8: until present, since absent
  it('case 8: renders "Until <until>" when only until is present', () => {
    const gc = makeChangelog({
      meta: { repoPath: '/test/repo', until: 'v2.0', totalCommits: 0 },
    });
    const result = renderMarkdown(gc);
    expect(result).toContain('_Until v2.0_');
    expect(result).not.toContain('Since');
  });

  // Case 9: Special characters in subject
  it('case 9: renders special characters in subject verbatim', () => {
    const gc = makeChangelog({
      groups: [makeGroup('feat', ['h99', 'support `code` and *bold* and _underscore_'])],
      meta: { repoPath: '/test/repo', totalCommits: 1 },
    });
    const result = renderMarkdown(gc);
    expect(result).toContain('support `code` and *bold* and _underscore_');
  });

  // Case 10: Multiple commits in a single group
  it('case 10: lists all commits under the group heading', () => {
    const gc = makeChangelog({
      groups: [
        makeGroup(
          'feat',
          ['a1', 'first'],
          ['a2', 'second'],
          ['a3', 'third'],
        ),
      ],
      meta: { repoPath: '/test/repo', totalCommits: 3 },
    });
    const result = renderMarkdown(gc);
    expect(result).toContain('- a1: first');
    expect(result).toContain('- a2: second');
    expect(result).toContain('- a3: third');
  });

  // Case 11: Single commit, single group
  it('case 11: renders a single commit under the group heading', () => {
    const gc = makeChangelog({
      groups: [makeGroup('fix', ['z99', 'single fix'])],
      meta: { repoPath: '/test/repo', totalCommits: 1 },
    });
    const result = renderMarkdown(gc);
    expect(result).toMatch(/^# Changelog\n\n## fix\n- z99: single fix\n?$/);
  });

  // Additional: no trailing blank line
  it('does not have a trailing blank line', () => {
    const gc = makeChangelog({
      breaking: [makeCommit('b1', 'break', 'feat', true)],
      groups: [makeGroup('feat', ['f1', 'feat'])],
      meta: { repoPath: '/test/repo', totalCommits: 2 },
    });
    const result = renderMarkdown(gc);
    // Should not end with double newline (blank line)
    expect(result).not.toMatch(/\n\n$/);
  });

  // Additional: breaking commit that also appears in its group
  it('breaking commits appear in breaking section even if also in groups', () => {
    const breakingCommit = makeCommit('b99', 'breaking change', 'feat', true);
    const gc = makeChangelog({
      breaking: [breakingCommit],
      groups: [{
        type: 'feat',
        commits: [
          makeCommit('b99', 'breaking change', 'feat', true),
          makeCommit('f00', 'normal feat', 'feat', false),
        ],
      }],
      meta: { repoPath: '/test/repo', totalCommits: 2 },
    });
    const result = renderMarkdown(gc);
    expect(result).toContain('## ⚠ Breaking changes');
    expect(result).toContain('- `b99`: breaking change');
    // Also present in group section
    expect(result).toContain('- b99: breaking change');
  });
});

// ─── renderText ───────────────────────────────────────────────────────────────

describe('renderText', () => {
  // Case 1: Empty changelog
  it('case 1: renders title only for empty changelog', () => {
    const gc = makeChangelog();
    const result = renderText(gc);
    expect(result).toBe('CHANGELOG');
  });

  // Case 2: Empty changelog WITH since/until
  it('case 2: renders title + range line for empty changelog with range', () => {
    const gc = makeChangelog({
      meta: { repoPath: '/test/repo', since: 'v1.0', until: 'v2.0', totalCommits: 0 },
    });
    const result = renderText(gc);
    expect(result).toContain('CHANGELOG');
    expect(result).toContain('From v1.0 to v2.0');
    expect(result).not.toContain('BREAKING');
    expect(result).not.toMatch(/^(?!CHANGELOG$)[A-Z]{2,}$/m); // no uppercase headings besides CHANGELOG
  });

  // Case 3: Breaking changes only
  it('case 3: renders breaking section when groups are empty', () => {
    const gc = makeChangelog({
      breaking: [makeCommit('abc1234', 'fix critical bug', 'fix', true)],
    });
    const result = renderText(gc);
    expect(result).toContain('BREAKING CHANGES');
    expect(result).toContain('- abc1234: fix critical bug');
    // No backticks in text version
    expect(result).not.toContain('`abc1234`');
  });

  // Case 4: Groups only (no breaking)
  it('case 4: renders group sections when breaking is empty', () => {
    const gc = makeChangelog({
      groups: [makeGroup('feat', ['aaa111', 'add login'])],
      meta: { repoPath: '/test/repo', totalCommits: 1 },
    });
    const result = renderText(gc);
    expect(result).toContain('FEAT');
    expect(result).toContain('- aaa111: add login');
    expect(result).not.toContain('BREAKING');
  });

  // Case 5: Breaking + groups
  it('case 5: breaking section appears before group sections', () => {
    const gc = makeChangelog({
      breaking: [makeCommit('ccc333', 'breaking API change', 'feat', true)],
      groups: [makeGroup('feat', ['ddd444', 'new feature'])],
      meta: { repoPath: '/test/repo', totalCommits: 2 },
    });
    const result = renderText(gc);
    const breakingIndex = result.indexOf('BREAKING CHANGES');
    const featIndex = result.indexOf('FEAT');
    expect(breakingIndex).toBeGreaterThan(-1);
    expect(featIndex).toBeGreaterThan(-1);
    expect(breakingIndex).toBeLessThan(featIndex);
  });

  // Case 6: Multiple groups
  it('case 6: groups rendered in gc.groups array order', () => {
    const gc = makeChangelog({
      groups: [
        makeGroup('docs', ['e00', 'update readme']),
        makeGroup('feat', ['f11', 'add feature']),
      ],
      meta: { repoPath: '/test/repo', totalCommits: 2 },
    });
    const result = renderText(gc);
    const docsIndex = result.indexOf('DOCS');
    const featIndex = result.indexOf('FEAT');
    expect(docsIndex).toBeLessThan(featIndex);
  });

  // Case 7: since present, until absent
  it('case 7: renders "Since <since>" when only since is present', () => {
    const gc = makeChangelog({
      meta: { repoPath: '/test/repo', since: 'v1.0', totalCommits: 0 },
    });
    const result = renderText(gc);
    expect(result).toContain('Since v1.0');
    expect(result).not.toContain('until');
  });

  // Case 8: until present, since absent
  it('case 8: renders "Until <until>" when only until is present', () => {
    const gc = makeChangelog({
      meta: { repoPath: '/test/repo', until: 'v2.0', totalCommits: 0 },
    });
    const result = renderText(gc);
    expect(result).toContain('Until v2.0');
    expect(result).not.toContain('Since');
  });

  // Case 9: Special characters in subject
  it('case 9: renders special characters in subject verbatim', () => {
    const gc = makeChangelog({
      groups: [makeGroup('feat', ['h99', 'support `code` and *bold* and _underscore_'])],
      meta: { repoPath: '/test/repo', totalCommits: 1 },
    });
    const result = renderText(gc);
    expect(result).toContain('support `code` and *bold* and _underscore_');
  });

  // Case 10: Multiple commits in a single group
  it('case 10: lists all commits under the group heading', () => {
    const gc = makeChangelog({
      groups: [makeGroup('feat', ['a1', 'first'], ['a2', 'second'])],
      meta: { repoPath: '/test/repo', totalCommits: 2 },
    });
    const result = renderText(gc);
    expect(result).toContain('- a1: first');
    expect(result).toContain('- a2: second');
  });

  // Case 11: Single commit, single group
  it('case 11: renders a single commit under the group heading', () => {
    const gc = makeChangelog({
      groups: [makeGroup('fix', ['z99', 'single fix'])],
      meta: { repoPath: '/test/repo', totalCommits: 1 },
    });
    const result = renderText(gc);
    expect(result).toMatch(/^CHANGELOG\n\nFIX\n- z99: single fix\n?$/);
  });

  // Additional: no trailing blank line
  it('does not have a trailing blank line', () => {
    const gc = makeChangelog({
      breaking: [makeCommit('b1', 'break', 'feat', true)],
      groups: [makeGroup('feat', ['f1', 'feat'])],
      meta: { repoPath: '/test/repo', totalCommits: 2 },
    });
    const result = renderText(gc);
    // Should not end with double newline (blank line)
    expect(result).not.toMatch(/\n\n$/);
  });

  // Additional: no backticks in text output
  it('does not include backticks in commit hashes', () => {
    const gc = makeChangelog({
      breaking: [makeCommit('abc', 'critical', 'feat', true)],
      meta: { repoPath: '/test/repo', totalCommits: 1 },
    });
    const result = renderText(gc);
    expect(result).not.toContain('`');
  });

  // Additional: breaking commit that also appears in its group
  it('breaking commits appear in breaking section even if also in groups', () => {
    const breakingCommit = makeCommit('b99', 'breaking change', 'feat', true);
    const gc = makeChangelog({
      breaking: [breakingCommit],
      groups: [{
        type: 'feat',
        commits: [
          makeCommit('b99', 'breaking change', 'feat', true),
          makeCommit('f00', 'normal feat', 'feat', false),
        ],
      }],
      meta: { repoPath: '/test/repo', totalCommits: 2 },
    });
    const result = renderText(gc);
    expect(result).toContain('BREAKING CHANGES');
    expect(result).toContain('- b99: breaking change');
  });
});
