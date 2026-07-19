import type { GroupedChangelog } from './types.js';

function formatRangeLine(gc: GroupedChangelog): string | null {
  const { since, until } = gc.meta;
  if (!since && !until) return null;
  if (since && until) return `From ${since} to ${until}`;
  if (since) return `Since ${since}`;
  return `Until ${until}`;
}

function trimTrailingEmptyLines(lines: string[]): void {
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
}

export function renderMarkdown(gc: GroupedChangelog): string {
  const lines: string[] = [];

  // Title
  lines.push('# Changelog');

  // Range line (optional)
  const rangeLine = formatRangeLine(gc);
  if (rangeLine) {
    lines.push(`_${rangeLine}_`);
  }

  // Blank line after header block
  lines.push('');

  // Breaking changes section
  if (gc.breaking.length > 0) {
    lines.push('## ⚠ Breaking changes');
    for (const commit of gc.breaking) {
      lines.push(`- \`${commit.hash}\`: ${commit.subject}`);
    }
    lines.push('');
  }

  // Group sections
  for (const group of gc.groups) {
    lines.push(`## ${group.type}`);
    for (const commit of group.commits) {
      lines.push(`- ${commit.hash}: ${commit.subject}`);
    }
    lines.push('');
  }

  // No trailing blank line
  trimTrailingEmptyLines(lines);

  return lines.join('\n');
}

export function renderText(gc: GroupedChangelog): string {
  const lines: string[] = [];

  // Title
  lines.push('CHANGELOG');

  // Range line (optional)
  const rangeLine = formatRangeLine(gc);
  if (rangeLine) {
    lines.push(rangeLine);
  }

  // Blank line after header block
  lines.push('');

  // Breaking changes section
  if (gc.breaking.length > 0) {
    lines.push('BREAKING CHANGES');
    for (const commit of gc.breaking) {
      lines.push(`- ${commit.hash}: ${commit.subject}`);
    }
    lines.push('');
  }

  // Group sections
  for (const group of gc.groups) {
    lines.push(group.type.toUpperCase());
    for (const commit of group.commits) {
      lines.push(`- ${commit.hash}: ${commit.subject}`);
    }
    lines.push('');
  }

  // No trailing blank line
  trimTrailingEmptyLines(lines);

  return lines.join('\n');
}
