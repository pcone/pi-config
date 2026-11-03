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

## Outcome

WO-2026-068 committed in two repos, in this order.

**baba-pi**: pushed to `origin/main` at `46bb86d`. `27d9902` extracts the daemon client into
`src/client.ts` (repo resolution, spawn, socket protocol, formatting) and adds the bun
harness; `58495b5` adds `bin/baba-search.ts`; `ced1513` covers its failure paths; `46bb86d`
names the two follow-ups the extract carries. `src/index.ts` keeps one export,
`babaExtension`. The client is the seam: the CLI imports it, so there is one implementation of
the protocol.

**pi-config** (this record's commit): `skills/baba-search/SKILL.md`, symlinked into
`~/.claude/skills/baba-search` as `refactor` is, plus the README note that `extensions/baba`
is a tracked symlink into `pcone/baba-pi` rather than a directory. The symlink resolves once
this branch is on `main`.

CLI: `/Users/scott/Developer/baba-pi/bin/baba-search.ts "<query>" [-k N]`. Exit 0 results,
1 no repo, no daemon or a daemon error, 2 usage; results on stdout, diagnostics on stderr.
It needs a pull in `~/Developer/baba-pi` before that path exists there.

Cost, measured on this box against the live daemon: warm query 0.38–0.58 s wall end to end
(bun start, `git rev-parse`, socket round trip 0.16–0.18 s); one query after the daemon had
been idle 27 minutes took 13.9 s — a single observation, not a distribution. The CLI spawns
no python: the embedder stays the daemon's one long-lived child (pid unchanged across five
runs), and the CLI's source names neither `BABA_EMBEDDER` nor `server.py`.

## Superseded in part (owner, 2026-11-03, in Claude session 8f90746f): MCP replaces the skill

Asked whether the skill was the best integration or only the easiest, the recorder answered that the MCP rejection above rested on effort alone, and its premise was wrong: an MCP server needs no engine work, being a thin stdio layer over `baba-pi/src/client.ts`. On the merits MCP wins: a typed tool rather than a shell command, its own permission entry rather than Bash, and listed for every agent including subagents, which a skill reaches only when loaded. Its cost is one idle bun process per Claude session. Scott answered "yeah can we do this - rework baba pi so that it also includes the mcp integration".

What it settles, in the recorder's reading of the recommendation he accepted:
- baba-pi gains a stdio MCP server with one `search` tool, built on `src/client.ts`; one daemon client stays.
- It is registered once at user scope (`claude mcp add --scope user`). The answer approves that change to Claude's user config.
- The CLI stays, for pi seats and scripts.
- The skill and its `~/.claude/skills` symlink are deleted once the server is registered and answers, so Claude has one way to search.

Carrier: [WO-2026-069](../../work-orders/WO-2026-069-baba-mcp.md).
