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
    const trimmed = record.trim();
    if (!trimmed) continue;

    const fields = trimmed.split('\x00');
    if (fields.length < 5) continue;

    const [hash, date, author, subject, ...bodyParts] = fields;

    // Guard: reject records with non-hex hash (protects against leading \n
    // producing an empty-string hash for the first record)
    if (!/^[0-9a-f]+$/.test(hash)) continue;
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

/** Refs that git resolves to a commit — not valid date-like values. */
const GIT_REF_LIKE = new Set([
  'HEAD',
  'FETCH_HEAD',
  'ORIG_HEAD',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
]);

/**
 * Validate a date parameter passed to --since / --until.
 *
 * Rejects values that look like git refs rather than dates:
 * - Values containing `~` or `^` (ref-prefix operators)
 * - Values that are exact matches for well-known ref names
 * - Values that are all-hex and 7+ characters long (likely hashes)
 */
export function isValidDateParam(value: string): boolean {
  if (value.includes('~') || value.includes('^')) return false;
  if (GIT_REF_LIKE.has(value)) return false;
  if (/^[0-9a-f]{7,}$/i.test(value)) return false;
  return true;
}

/**
 * Fetch commits from a git repository using `git log`.
 *
 * @param repoPath - Path to the git repository.
 * @param since    - Optional `--since` value (date string).
 * @param until    - Optional `--until` value (date string).
 * @throws         - If `since` or `until` look like git refs rather than dates.
 * @returns Promise resolving to an array of parsed Commit objects.
 */
export function fetchCommits(
  repoPath: string,
  since?: string,
  until?: string,
): Promise<Commit[]> {
  if (since !== undefined && !isValidDateParam(since)) {
    return Promise.reject(
      new Error(`Invalid --since value '${since}': expected a date, not a git ref`),
    );
  }
  if (until !== undefined && !isValidDateParam(until)) {
    return Promise.reject(
      new Error(`Invalid --until value '${until}': expected a date, not a git ref`),
    );
  }

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
