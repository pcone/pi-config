#!/usr/bin/env -S npx tsx
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { fetchCommits } from './commits.js';
import { groupCommits } from './group.js';
import { renderMarkdown, renderText } from './render.js';

const USAGE = `Usage: changelog-gen [repo] [options]

Generate a changelog from git history using conventional commits.

Arguments:
  repo                  Path to the git repository (default: .)

Options:
  --since <date>        Start from this date (ISO 8601 or git date format)
  --until <date>        End at this date (ISO 8601 or git date format)
  --format <md|text>    Output format (default: md)
  -h, --help            Show this help message
`;

export function getUsage(): string {
  return USAGE;
}

export function validateFormat(format: string): boolean {
  return format === 'md' || format === 'text';
}

async function main(): Promise<void> {
  let parsed: {
    values: { since?: string; until?: string; format?: string; help?: boolean };
    positionals: string[];
  };

  try {
    parsed = parseArgs({
      allowPositionals: true,
      strict: true,
      options: {
        since: { type: 'string' },
        until: { type: 'string' },
        format: { type: 'string', default: 'md' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err: unknown) {
    console.error(`changelog-gen: ${(err as Error).message}`);
    process.exit(1);
  }

  const { values, positionals } = parsed;

  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  if (!validateFormat(values.format ?? 'md')) {
    console.error(
      `changelog-gen: Invalid format '${values.format}'. Expected 'md' or 'text'.`,
    );
    process.exit(1);
  }

  const repo = positionals[0] ?? '.';
  const format = (values.format ?? 'md') as 'md' | 'text';
  const since = values.since;
  const until = values.until;

  try {
    const commits = await fetchCommits(repo, since, until);
    const gc = groupCommits(commits, { repoPath: repo, since, until });
    const output = format === 'text' ? renderText(gc) : renderMarkdown(gc);
    process.stdout.write(output + '\n');
  } catch (err: unknown) {
    console.error(`changelog-gen: ${(err as Error).message}`);
    process.exit(1);
  }
}

// Only run main() when cli.ts is the entry point (not when imported by tests)
const isEntryPoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntryPoint) {
  main().catch((err: unknown) => {
    console.error(`changelog-gen: ${(err as Error).message}`);
    process.exit(1);
  });
}
