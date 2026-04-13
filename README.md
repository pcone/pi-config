# Pi Agent Configuration

Global configuration for [pi](https://github.com/nicholasgasior/pi-coding-agent) coding agent.

## Structure

- `APPEND_SYSTEM.md` — Instructions appended to every system prompt
- `settings.json` — Global settings (model, compaction, etc.)
- `agents/` — Subagent definitions (explore, implement, reviewer)
- `extensions/` — Custom extensions (checkpoint archiving, subagent delegation, context management)
- `prompts/` — Prompt templates
- `skills/` — On-demand skill instructions
- `themes/` — UI themes

## Installation

Symlink or copy to `~/.pi/agent/`:

```bash
# Or selectively link individual files/dirs
ln -sf ~/Developer/pi-config/APPEND_SYSTEM.md ~/.pi/agent/APPEND_SYSTEM.md
ln -sf ~/Developer/pi-config/extensions/ ~/.pi/agent/extensions
# etc.
```

## Not tracked

- `auth.json` — API keys (secrets)
- `bin/` — Binary tools (rg, fd) — install separately
- `sessions/` — Session history
- `checkpoints/` — Archived session checkpoints
