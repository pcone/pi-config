# Pi Agent Configuration

Global configuration for [pi](https://github.com/badlogic/pi-mono) coding agent at `@earendil-works/pi-coding-agent@0.80.3`.

Symlinks in `~/.pi/agent/` point into this repo:

```bash
ln -sf ~/Developer/pi-config/APPEND_SYSTEM.md ~/.pi/agent/APPEND_SYSTEM.md
ln -sf ~/Developer/pi-config/extensions ~/.pi/agent/extensions
ln -sf ~/Developer/pi-config/settings.json ~/.pi/agent/settings.json
ln -sf ~/Developer/pi-config/skills ~/.pi/agent/skills
ln -sf ~/Developer/pi-config/themes ~/.pi/agent/themes
ln -sf ~/Developer/pi-config/models.json ~/.pi/agent/models.json
```

## Structure

- `APPEND_SYSTEM.md` — Instructions appended to every system prompt (subagent guidance, implementation quality)
- `settings.json` — Global settings (default provider/model, thinking level, extensions)
- `models.json` — Custom provider overrides (currently empty; using pi's built-in `minimax` provider on the MiniMax Token Plan)
- `extensions/checkpoint.ts` — Archive-and-compact on demand; archives stored under `.pi/checkpoints/`
- `extensions/subagent-async/index.ts` — Non-blocking subagents via RPC mode: spawn, check progress (`/subagents`), steer, stop. Subagents fork from HEAD (not working tree) — commit first. Includes live log viewer (`/watch`), external viewer (`watch-session`).
- `extensions/subagent/` — (disabled) Original synchronous subagent extension, kept for reference.
- `extensions/footer-session-id.ts` — Replaces the footer with one that adds a themed, reversible identifier (e.g. `arcane-phoenix-archmage`) for the current session on the right side. The phrase is bijective with the first 4 hex chars of the UUID session ID — look up the words in the lists to recover the prefix. Each session also gets a per-session hue (derived from the same bits) and a staleness indicator (`●◐◌○`) that tracks time since the most recent entry — the words themselves fade along the same axis, so freshness reads at a glance.
- `extensions/modes.ts` — Toggles the parent session between `implement` (default — parent does work directly) and `orchestrate` (parent dispatches to subagents). Per-project state at `<cwd>/.pi/mode.json`. Commands: `/mode` toggles, `/mode <implement|orchestrate>` sets explicit. Footer shows current mode.
- `skills/decision-log` — On-demand skill instructions
- `themes/catppuccin-macchiato.json` — Color theme

## Extension caches

Three extensions cache data on disk under `~/.pi/cache/<extension>/`. This is outside the repo (under HOME, not in `~/Developer/pi-config`), so no `.gitignore` entries are needed for it. The dir is created on first write by the extension itself.

- `~/.pi/cache/fetch-url/` — large fetched pages (HTML→Markdown); 72h TTL
- `~/.pi/cache/kagi-search/` — Kagi API search responses; 72h TTL
- `~/.pi/cache/model-tiers/` — OpenRouter benchmarks and model info; 24h TTL

## Tools added

- **`subagent(agent, task, cwd?, inheritParentModel?, isolate?, baseRef?)`** — Spawn an async subagent that runs in the background. Subagents fork from HEAD — commit any uncommitted work the subagent needs before delegating. Use `/subagents` to check progress, `/watch <id>` for live output. Subagents auto-checkpoint the parent before starting.
- **`subagent_status(session_id)`** — Check progress of a running async subagent
- **`subagent_steer(session_id, message)`** — Inject a steering message into a running subagent
- **`subagent_stop(session_id, final_message?)`** — Tell a running subagent to wrap up and return
- **`checkpoint(summary, nextSteps?, continue?, newCwd?)`** — Archive the current session to `.pi/checkpoints/session-<timestamp>.jsonl`, override compaction with the supplied summary, optionally send a follow-up kickoff prompt. When `newCwd` is provided, fork to a fresh session in that directory instead of compacting: the archive is written, a new session file is created in the target cwd's session storage with the checkpoint summary as its initial context, and a `checkpoint_fork` entry is recorded on the old session.

## Not tracked

- `auth.json` — API keys (stored in macOS Keychain via `~/.pi/agent/auth.json`)
- `bin/` — Binary tools (rg, fd) — install separately
- `sessions/` — Session history
- `.pi/checkpoints/` — Per-project checkpoint archives
