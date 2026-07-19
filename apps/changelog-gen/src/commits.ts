// @ts-expect-error - @types/node not in project deps
import { execFile } from 'node:child_process';
import type { Commit } from './types.js';

/**
 * Parse a single conventional-commit subject line.
 *
 * Returns a parsed object with the type lowercased, scope extracted (if present),
 * breaking flag set, and subject extracted from after the colon.
 *
 * If the line is not a conventional commit, type is set to "" and the full
 * raw string becomes the subject.
 */
export function parseCommitSubject(
  raw: string,
): { type: string; scope?: string; subject: string; breaking: boolean; raw: string } {
  const pattern =
    /^(?<type>[a-zA-Z]+)(\((?<scope>[^)]+)\))?(?<breaking>!)?: (?<subject>.*)$/;
  const match = raw.match(pattern);

  if (!match || !match.groups) {
    return { type: '', subject: raw, breaking: false, raw };
  }

  const { type, scope, breaking, subject } = match.groups;

  const result: {
    type: string;
    scope?: string;
    subject: string;
    breaking: boolean;
    raw: string;
  } = {
    type: type.toLowerCase(),
    subject: subject ?? raw,
    breaking: breaking === '!',
    raw,
  };

  if (scope !== undefined) {
    result.scope = scope;
  }

  return result;
}

/**
 * Parse the NUL-delimited output of `git log --format=...` into Commit objects.
 *
 * Expected format:
 *   hash\x00date\x00author\x00subject\x00body\x00\n
 * (i.e. fields separated by NUL, records separated by NUL + newline)
 */
export function parseGitLog(stdout: string): Commit[] {
  if (!stdout) return [];

  const records = stdout.split('\x00\n');
  const commits: Commit[] = [];

  for (const record of records) {
    const trimmed = record.trimEnd();
    if (!trimmed) continue;

    const fields = trimmed.split('\x00');
    if (fields.length < 5) continue;

    const [hash, date, author, subject, ...bodyParts] = fields;
    let body = bodyParts.join('\x00');

    // Strip trailing newline from the body if present (git appends one)
    if (body.endsWith('\n')) {
      body = body.slice(0, -1);
    }

    const parsed = parseCommitSubject(subject);

    // Check body for breaking-change footers (case-sensitive)
    const hasBreakingFooter =
      body.includes('BREAKING CHANGE:') || body.includes('BREAKING-CHANGE:');

    commits.push({
      hash,
      date,
      author,
      type: parsed.type,
      scope: parsed.scope,
      subject: parsed.subject,
      breaking: parsed.breaking || hasBreakingFooter,
      raw: parsed.raw,
    });
  }

  return commits;
}

/**
 * Fetch commits from a git repository using `git log`.
 *
 * @param repoPath - Path to the git repository.
 * @param since    - Optional `--since` value (ref, date, etc.).
 * @param until    - Optional `--until` value (ref, date, etc.).
 * @returns Promise resolving to an array of parsed Commit objects.
 */
export function fetchCommits(
  repoPath: string,
  since?: string,
  until?: string,
): Promise<Commit[]> {
  return new Promise((resolve, reject) => {
    const args = [
      '-C',
      repoPath,
      'log',
      '--format=%h%x00%aI%x00%an <%ae>%x00%s%x00%b%x00%n',
    ];

    if (since !== undefined) {
      args.push(`--since=${since}`);
    }
    if (until !== undefined) {
      args.push(`--until=${until}`);
    }

    execFile('git', args, { maxBuffer: 10 * 1024 * 1024 }, (err: Error | null, stdout: string) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(parseGitLog(stdout));
    });
  });
}
