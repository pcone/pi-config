---
title: "Claude Code reaches baba through a daemon-client CLI and a skill"
type: decision
status: accepted
date: 2026-11-03
---

# baba for Claude Code (external-tools/009)

**Ruling (owner, 2026-11-03, in Claude session 8f90746f).** Asked how baba should be made available to Claude sessions, Scott picked "Wrapper + skill (Recommended)": a small `baba-search` script that talks to the shared per-repo daemon, the same socket the pi seats use, plus a skill telling Claude when to reach for it. The change touches `~/.claude`, which that answer approves.

**Why.** No Claude surface names baba: no MCP server, no skill, no instruction line. The engine's one-shot `baba query` works from Bash only with `BABA_EMBEDDER` set to the venv's python and `server.py`, and it loads the embedder per query. The pi extension (`extensions/baba/src/index.ts`) already resolves the main repo root across worktrees, starts the daemon on `<repo>/.baba/daemon.sock` and speaks its JSON-line protocol.

**Rejected: the MCP layer.** baba plans one (`~/Developer/baba/README.md`), but it is more work in the engine and registers an MCP server in Claude's config.

**Rejected: an instruction line with the env incantation.** Every query reloads the embedder on an 8 GB box.

**Constraint.** The CLI reuses the extension's daemon client, not a copy of it. The recorder reads the skill as living in `pi-config/skills/` and symlinked into `~/.claude/skills/`, as `refactor` is.

**Ruling (owner, 2026-11-03, in Claude session 8f90746f), the landing repo.** WO-2026-068 stopped `PLAN MISMATCH`: `extensions/baba` is a symlink to the separate repo `~/Developer/baba-pi` (`pcone/baba-pi`), so the client extract and the CLI cannot be committed in pi-config. Asked where the work lands, he picked "baba-pi owns code+tests (Recommended)": the extract, the CLI and their tests land in baba-pi, with its own bun test harness, and pi-config carries the skill and docs only. The answer approves pushing to `pcone/baba-pi`. Rejected with it: tests in pi-config reaching baba-pi's live checkout through the symlink, and moving baba-pi's source into pi-config.
