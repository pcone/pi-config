---
paths:
  - ".pi/rules/**/*.md"
  - "**/.pi/rules/**/*.md"
---

# Writing Pi Rules

A rule is a markdown file injected as context when the agent works with
matching files. Rules live in `.pi/rules/` or `.claude/rules/` (project)
or `~/.pi/agent/rules/` / `~/.claude/rules/` (global, lower precedence).

Extension source: `~/.pi/agent/extensions/rules.ts`.

## Frontmatter

```markdown
---
paths:
  - "src/**/*.rs"
description: "Rust project conventions"
# disable-model-invocation: true   ← manual-only (only via /rule <name>)
---
```

Fields:
- `paths` — glob patterns (picomatch). Matches absolute and relative paths.
  First touch of a matching file injects the rule (once per segment).
- `description` — shown in `/rules` listing.
- `disable-model-invocation: true` — Never auto-triggers. Only enters
  conversation via `/rule <name>` command. Use for reference material the
  agent should only read on demand.

## Rules are short context injections

Rules get injected into the model's context window. Every line counts.

- **Keep under 100 lines.** Hard cap enforced by the extension (truncated
  with warning). Use `<!-- allow-large -->` as the first non-empty line to
  override.
- **State the non-obvious only.** Don't restate what the code already shows.
- **Reference external docs** (`see docs/foo.md` for details) rather than
  duplicating them inline.
- **One rule per concern.** Don't bundle unrelated knowledge into one file.
  Multiple rules with different path patterns inject independently.

## Choosing a trigger path

```yaml
# Broad — fires for any file in the project
paths:
  - "**/**"

# Specific — fires only when editing files of this type
paths:
  - "**/*.rs"

# Multiple patterns
paths:
  - "src/**/*.rs"
  - "tests/**/*.rs"
```

Only rules with a `paths` field auto-trigger. Rules without `paths` AND
without `disable-model-invocation` get a warning — they never fire.

Negation patterns (`!pattern`) are stripped with a warning in v1.

## Rule modes

| Mode | Requires | Triggered by |
|---|---|---|
| Path-triggered | `paths` field | First read/edit/write of a matching file |
| Manual-only | `disable-model-invocation: true` | `/rule <name>` command |

## In-scope tracking

Rules inject once per session segment. After a `session_compact` the
in-scope set is cleared, so rules re-inject on next matching file touch.
Use `/rule <name>` to force re-injection mid-segment.

## Debugging

- `/rules` — list all discovered rules with status (`[active]`, `[manual]`).
- `--no-rules` — disable all rule discovery.
- `--rule <path>` — load an additional rule file or directory.
