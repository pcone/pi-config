import { describe, it, expect } from 'vitest';
import { parseCommitSubject, parseGitLog, fetchCommits } from './commits.js';
import type { Commit } from './types.js';

// ---------------------------------------------------------------------------
// parseCommitSubject
// ---------------------------------------------------------------------------
describe('parseCommitSubject', () => {
  it('parses feat: add button', () => {
    const result = parseCommitSubject('feat: add button');
    expect(result.type).toBe('feat');
    expect(result.scope).toBeUndefined();
    expect(result.subject).toBe('add button');
    expect(result.breaking).toBe(false);
    expect(result.raw).toBe('feat: add button');
  });

  it('parses feat(api): add endpoint', () => {
    const result = parseCommitSubject('feat(api): add endpoint');
    expect(result.type).toBe('feat');
    expect(result.scope).toBe('api');
    expect(result.subject).toBe('add endpoint');
    expect(result.breaking).toBe(false);
  });

  it('parses fix!: breaking bugfix', () => {
    const result = parseCommitSubject('fix!: breaking bugfix');
    expect(result.type).toBe('fix');
    expect(result.scope).toBeUndefined();
    expect(result.subject).toBe('breaking bugfix');
    expect(result.breaking).toBe(true);
  });

  it('parses feat(api)!: break the api', () => {
    const result = parseCommitSubject('feat(api)!: break the api');
    expect(result.type).toBe('feat');
    expect(result.scope).toBe('api');
    expect(result.subject).toBe('break the api');
    expect(result.breaking).toBe(true);
  });

  it('handles non-conventional subject', () => {
    const result = parseCommitSubject('random commit message');
    expect(result.type).toBe('');
    expect(result.scope).toBeUndefined();
    expect(result.subject).toBe('random commit message');
    expect(result.breaking).toBe(false);
  });

  it('parses docs: fix typo in README', () => {
    const result = parseCommitSubject('docs: fix typo in README');
    expect(result.type).toBe('docs');
    expect(result.scope).toBeUndefined();
    expect(result.subject).toBe('fix typo in README');
  });

  it('parses chore(deps): bump lodash', () => {
    const result = parseCommitSubject('chore(deps): bump lodash');
    expect(result.type).toBe('chore');
    expect(result.scope).toBe('deps');
    expect(result.subject).toBe('bump lodash');
  });

  it('lowercases type', () => {
    const result = parseCommitSubject('FEAT: uppercase type');
    expect(result.type).toBe('feat');
    expect(result.subject).toBe('uppercase type');
  });

  it('subject with colon does not confuse parser', () => {
    const result = parseCommitSubject('feat: add something: important');
    expect(result.type).toBe('feat');
    expect(result.subject).toBe('add something: important');
  });

  it('Merge branch subject is non-conventional', () => {
    const result = parseCommitSubject("Merge branch 'main'");
    expect(result.type).toBe('');
    expect(result.subject).toBe("Merge branch 'main'");
    expect(result.breaking).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseGitLog
// ---------------------------------------------------------------------------
describe('parseGitLog', () => {
  it('handles empty string', () => {
    expect(parseGitLog('')).toEqual([]);
  });

  it('parses a single conventional commit with no body', () => {
    const stdout =
      'abc1234\x002025-01-01T00:00:00Z\x00Jane Doe <jane@example.com>\x00feat: add button\x00\x00\n';
    const commits = parseGitLog(stdout);
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      hash: 'abc1234',
      date: '2025-01-01T00:00:00Z',
      author: 'Jane Doe <jane@example.com>',
      type: 'feat',
      scope: undefined,
      subject: 'add button',
      breaking: false,
      raw: 'feat: add button',
    });
  });

  it('parses multiple commits with mix of conventional and non-conventional', () => {
    const stdout =
      'a1\x002025-01-01T00:00:00Z\x00A\x00feat(api): add endpoint\x00\x00\n' +
      'b2\x002025-01-02T00:00:00Z\x00B\x00random message\x00\x00\n' +
      'c3\x002025-01-03T00:00:00Z\x00C\x00fix!: fix it\x00\x00\n';
    const commits = parseGitLog(stdout);
    expect(commits).toHaveLength(3);

    expect(commits[0].hash).toBe('a1');
    expect(commits[0].type).toBe('feat');
    expect(commits[0].scope).toBe('api');

    expect(commits[1].hash).toBe('b2');
    expect(commits[1].type).toBe('');
    expect(commits[1].subject).toBe('random message');
    expect(commits[1].breaking).toBe(false);

    expect(commits[2].hash).toBe('c3');
    expect(commits[2].type).toBe('fix');
    expect(commits[2].breaking).toBe(true);
  });

  it('detects BREAKING CHANGE: footer in body', () => {
    const stdout =
      'abc\x002025-01-01T00:00:00Z\x00A\x00feat: add feature\x00some detail\n\nBREAKING CHANGE: drops old api\x00\n';
    const commits = parseGitLog(stdout);
    expect(commits).toHaveLength(1);
    expect(commits[0].breaking).toBe(true);
    expect(commits[0].type).toBe('feat');
  });

  it('detects BREAKING-CHANGE: footer in body', () => {
    const stdout =
      'abc\x002025-01-01T00:00:00Z\x00A\x00feat: add feature\x00BREAKING-CHANGE: removed\x00\n';
    const commits = parseGitLog(stdout);
    expect(commits).toHaveLength(1);
    expect(commits[0].breaking).toBe(true);
  });

  it('combines ! marker and BREAKING CHANGE: body footer', () => {
    const stdout =
      'abc\x002025-01-01T00:00:00Z\x00A\x00feat!: break now\x00also\nBREAKING CHANGE: break more\x00\n';
    const commits = parseGitLog(stdout);
    expect(commits).toHaveLength(1);
    expect(commits[0].breaking).toBe(true);
    expect(commits[0].subject).toBe('break now');
  });

  it('body with no breaking marker preserves subject-only breaking', () => {
    const stdout =
      'abc\x002025-01-01T00:00:00Z\x00A\x00fix!: major fix\x00multiline\nbody\ncontent\x00\n';
    const commits = parseGitLog(stdout);
    expect(commits).toHaveLength(1);
    expect(commits[0].breaking).toBe(true);
    expect(commits[0].type).toBe('fix');
    expect(commits[0].subject).toBe('major fix');
  });

  it('body with lowercase "breaking change:" does NOT trigger breaking', () => {
    const stdout =
      'abc\x002025-01-01T00:00:00Z\x00A\x00fix: minor fix\x00note: breaking change: not detected\x00\n';
    const commits = parseGitLog(stdout);
    expect(commits).toHaveLength(1);
    expect(commits[0].breaking).toBe(false);
  });

  it('subject with colon in non-type position is treated as non-conventional', () => {
    const stdout =
      'abc\x002025-01-01T00:00:00Z\x00A\x00Merge branch \'main\'\x00\x00\n';
    const commits = parseGitLog(stdout);
    expect(commits).toHaveLength(1);
    expect(commits[0].type).toBe('');
    expect(commits[0].subject).toBe("Merge branch 'main'");
    expect(commits[0].raw).toBe("Merge branch 'main'");
  });

  it('strips trailing newline from body', () => {
    const stdout =
      'abc\x002025-01-01T00:00:00Z\x00A\x00fix: a fix\x00some body\n\x00\n';
    const commits = parseGitLog(stdout);
    expect(commits).toHaveLength(1);
    expect(commits[0].breaking).toBe(false);
  });

  it('preserves scope when present and undefined when absent', () => {
    const stdout =
      'abc\x002025-01-01T00:00:00Z\x00A\x00chore(deps): update\x00\x00\n' +
      'def\x002025-01-02T00:00:00Z\x00B\x00chore: no scope\x00\x00\n';
    const commits = parseGitLog(stdout);
    expect(commits).toHaveLength(2);
    expect(commits[0].scope).toBe('deps');
    expect(commits[1].scope).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// fetchCommits (integration)
// ---------------------------------------------------------------------------
describe('fetchCommits', () => {
  it('returns commits from the repo at apps/changelog-gen', async () => {
    const root = new URL('../..', import.meta.url).pathname;
    const commits = await fetchCommits(root);
    expect(commits.length).toBeGreaterThan(0);
    for (const c of commits) {
      expect(c).toHaveProperty('hash');
      expect(c).toHaveProperty('date');
      expect(c).toHaveProperty('author');
      expect(typeof c.type).toBe('string');
      expect(typeof c.subject).toBe('string');
      expect(typeof c.breaking).toBe('boolean');
      expect(typeof c.raw).toBe('string');
      // hash should be a non-empty string
      expect(c.hash.length).toBeGreaterThan(0);
    }
  });

  it('respects since filter', async () => {
    const root = new URL('../..', import.meta.url).pathname;
    // Future date should return zero commits
    const empty = await fetchCommits(root, '2027-01-01');
    expect(empty.length).toBe(0);
  });

  it('respects until filter', async () => {
    const root = new URL('../..', import.meta.url).pathname;
    const all = await fetchCommits(root);
    const old = await fetchCommits(root, undefined, '2026-07-10');
    expect(old.length).toBeGreaterThan(0);
    expect(old.length).toBeLessThan(all.length);
  });
});
