# WO-2026-110 — guard against agents starting Claude

> **Lane**: pi-config. A `PATH` shim and a documented settings block. [Decision external-tools/015](../decisions/external-tools/015-matrix-chat-for-peers.md) rule 39; [013](../decisions/external-tools/013-tos-line-credentials-not-turns.md) line 1.

### Metadata

- **work_order_id**: WO-2026-110
- **routed_to**: implement
- **priority**: high (a subagent started `claude` on 2026-11-28)
- **estimated_complexity**: small
- **review_policy**: required
- **status**: ready, after WO-2026-107 lands

### Task Summary

1. **The `claude` shim** (`bin/claude-guard`, installed by `bin/setup` as `claude` in a `PATH` directory ahead of the real binary).
   - It refuses with exit 1 and a message citing 013 when the environment marks an agent: `CLAUDECODE` set, or any `PI_` variable that pi sets for its sessions and subagents (enumerate them from the code).
   - Otherwise it `exec`s the real binary, found as the next `claude` on `PATH` after itself.
   - The owner's own shells set none of these, so his launches pass.
2. **The settings block**, in `docs/design/chat.md` § Claude launch guard, for the owner to apply to `~/.claude/settings.json`:
   - a `permissions.deny` entry for `Bash(claude:*)`;
   - a `PreToolUse` hook on `Bash` that refuses a command whose tokens run `claude` (bare, with arguments, after `env`, `exec`, `nohup` or `timeout`, or inside a `tmux new-session`/`send-keys` argument).
   - This order does not edit the file.

### Rows

- With `CLAUDECODE=1`, the shim exits 1 and the real binary is not run (a stub binary records whether it ran).
- With each pi-set `PI_` variable, the same.
- With a clean environment, the shim execs the stub with its arguments unchanged.
- The hook script refuses each listed form, and allows `ls`, `grep claude`, `cat claude.md` and `bun … claude-guard.test.ts`.

### Prohibitions

- No row starts the real `claude`: rows use a stub binary on a temp `PATH`.
- Do not edit `~/.claude/settings.json` or `~/.claude.json`.
