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

- **Keep under 150 lines.** The extension warns past 150 and truncates past
  200. Use `<!-- allow-large -->` as the first non-empty line only when the rule
  genuinely cannot be split.
- **State the non-obvious only.** Don't restate what the code already shows.
- **Reference external docs** (`see docs/foo.md` for details) rather than
  duplicating them inline.
- **One rule per concern.** Don't bundle unrelated knowledge into one file.
  Multiple rules with different path patterns inject independently.

## Trigger paths

Use `paths` with picomatch globs. Only rules with `paths` auto-trigger; rules without `paths` AND without `disable-model-invocation` get a warning. Negation patterns (`!pattern`) are stripped with a warning in v1.

```yaml
paths:
  - "**/*.rs"          # specific file type
  - "src/**/*.rs"       # directory scoped
  - "src/**/*.rs"       # multiple patterns
  - "tests/**/*.rs"
```

## Rule modes

| Mode | Trigger |
|---|---|
| Path-triggered | First read/edit/write of a matching file |
| Manual-only (`disable-model-invocation: true`) | `/rule <name>` command |

Rules inject once per session segment. After `session_compact`, rules re-inject on next matching touch. Use `/rule <name>` to force re-injection.

## Debugging

`/rules` lists all discovered rules with status. `--no-rules` disables discovery. `--rule <path>` loads additional rules.
