# WO-2026-068 — `baba-search`: a CLI and a skill for Claude Code

**Status: DISPATCHED 2026-11-03.**

### Metadata

- **work_order_id**: WO-2026-068
- **parent_plan_id**: [decision external-tools/009](../../decisions/external-tools/009-baba-for-claude-code.md)
- **routed_to**: implement
- **invariant_exhaustiveness**: implicit
- **priority**: normal (no Claude surface names baba, and the one-shot path reloads an embedder per query on an 8 GB box)
- **estimated_complexity**: moderate
- **review_policy**: required

### Task Summary

Give Claude Code a way to reach baba: a `baba-search` CLI that speaks the existing per-repo daemon socket, and a skill in `pi-config/skills/baba-search/` symlinked into `~/.claude/skills/` that tells Claude when to use it. The daemon client is extracted from the pi extension, not copied.

### Rulings

- [external-tools/009](../../decisions/external-tools/009-baba-for-claude-code.md), owner 2026-11-03: "Wrapper + skill (Recommended)" — a small `baba-search` script talking to the shared per-repo daemon, plus a skill telling Claude when to reach for it.
- Same decision: the change touches `~/.claude`, and that answer approves it. **Scope of that approval: a skills symlink only.** No `~/.claude.json`, no `~/.claude/settings.json`, no launch command, no MCP registration. If the work appears to need any of those, stop and report — that is an owner question.
- Same decision, **Constraint**: the CLI reuses the extension's daemon client, not a copy of it. The skill lives in `pi-config/skills/` and is symlinked into `~/.claude/skills/`, as `refactor` is (`~/.claude/skills/refactor -> /Users/scott/Developer/pi-config/skills/refactor`).

**Rejected alternatives** (owner): the MCP layer; an instruction line carrying the `BABA_EMBEDDER`/`server.py` incantation, which reloads the embedder per query.

### Premises

- **P1.** The daemon protocol is reachable from a plain script with no pi runtime: `ensureDaemon(mainRoot)` spawns on demand and returns a socket path, `daemonRequest` sends one JSON line and awaits one response. Probe: read those functions and the `ServeRequest`/`ServeResponse` types; confirm nothing in the request path touches `ExtensionAPI` or pi's session objects. If the client is entangled with the extension host, stop with `PREMISE FALSIFIED` — the extract would be a rewrite.
- **P2.** A daemon is live on this box for the main repo (semantic_search works), so the CLI can be verified against a real daemon, not only a fake one. Probe: `ls ~/Developer/pi-config/.baba/daemon.sock` and one successful query through the CLI before reporting.
- **P3.** `bun` is on PATH for a Claude Code Bash tool call, so the CLI can run without a compile step. Probe: `command -v bun`. If it is not, the CLI is a `#!/bin/sh` wrapper around `node --experimental-strip-types` or a compiled file — decide from the probe, and say which in the report.

### Preparatory refactor

**Refactor commit, behaviour-preserving.** `extensions/baba/src/index.ts` is 692 lines and holds both the extension surface and the daemon client. Extract the client into `extensions/baba/src/client.ts`:

- `resolveMainRoot(cwd)` (the `git rev-parse --git-common-dir` walk across worktrees)
- `ensureDaemon(mainRoot)` with its spawn/poll machinery and `DAEMON_*` constants
- `getSocket` / `daemonRequest` / `daemonRequestOnce` and the request queue
- `formatResults(results)` and the `SearchResult` / `ServeRequest` / `ServeResponse` types it needs
- the root/env resolution the client needs (`findBabaHome`, `resolveCoreBin`, `embedderCmd` — whichever sign the extract cannot avoid)

`index.ts` keeps the extension: the tool registration, its schema and its prompt guidance, calling the client. The file should end materially smaller; report both line counts.

**No baba tests exist** (`ls tests/ | grep -i baba` → empty), so step 0 is characterization, written and green **before** the extract:

- `resolveMainRoot` from a linked worktree returns the main checkout root (build the worktree in a temp dir with `git worktree add`).
- The protocol: a fake unix socket in a temp dir that answers one `ServeRequest` with a canned `ServeResponse`; assert the client sends exactly one JSON line and parses the reply. This pins framing without the embedder.
- `formatResults` over zero, one and three results, byte-for-byte.

These rows must pass unchanged at the extract commit. If one must change, behaviour changed — stop.

### Mechanism

**The CLI.** One file, one query, exit status reflecting success:

- Path: `extensions/baba/bin/baba-search.ts`, `#!/usr/bin/env bun`, executable bit set.
- Usage: `baba-search "<query>" [-k N]`. `-k` defaults to 10, matching the tool. Bare `baba-search` with no argument prints usage to stderr and exits 2.
- It resolves the root from **cwd** (`process.cwd()`), so it works from any worktree or subdirectory of the repo, calls `ensureDaemon`, sends one request, prints `formatResults` to stdout and nothing else. Diagnostics (spawn progress, warnings) go to **stderr** so a caller can pipe stdout.
- No daemon, no repo: clear stderr message naming the reason, exit 1.
- It must not load the embedder: its only work is `git rev-parse`, socket connect and one request. Verify by timing: report the wall time of a warm query against the daemon, and confirm no python process is spawned by the CLI itself (`ps` before/after, or the daemon's own log if it records requests).

**The skill.** `skills/baba-search/SKILL.md`, YAML frontmatter with `name` and `description` in the shape the other skills in the tree use (`skills/refactor/SKILL.md`). Content, terse:

- When to use it: a question about this repo's docs or code where you would otherwise grep with three guessed spellings; anything the pi seats would answer with `semantic_search`.
- The command, in a form that works from any cwd — absolute path to the CLI, which is stable because the repo is at a fixed location on this box. Say plainly that it needs the repo's daemon and that the first call may take a few seconds to spawn it.
- What it costs: nothing per query beyond one socket round trip; the embedder lives in the daemon.
- One worked example with real output shape (numbered, score, path, heading, excerpt).
- When not to use it: exact-string lookup, a file you already know, anything outside the repo.

**The symlink.** `ln -s /Users/scott/Developer/pi-config/skills/baba-search ~/.claude/skills/baba-search`, matching the `refactor` symlink's absolute-target form. Verify with `ls -l` and by reading the file through the symlink. This is the only `~/.claude` write this order permits.

### Acceptance rows

| # | case | red without |
|---|---|---|
| 1 | `resolveMainRoot` from a linked worktree → the main checkout | drop the `--git-common-dir` walk |
| 2 | client sends exactly one JSON line and parses a canned reply over a fake socket | split the write, or drop the parse |
| 3 | `formatResults` over 0 / 1 / 3 results, byte-for-byte | any formatting change |
| 4 | CLI warm query against the live daemon returns ranked results on stdout | the CLI not connecting |
| 5 | CLI from a subdirectory of the repo resolves the same daemon | resolving from the script's own path instead of cwd |
| 6 | CLI with no argument prints usage to stderr, exit 2, nothing on stdout | a default query |
| 7 | CLI outside any repo exits 1 with a message naming the reason | a fallback to the home directory |
| 8 | stdout carries results only: a warm run's stdout parses as the expected shape, with no spawn chatter | writing progress to stdout |
| 9 | the skill file exists at its path, has `name` and `description`, and the symlink resolves to it | a broken or relative symlink |

Rows 4, 5, 7, 8 need P2's live daemon; if it is not live, spawn it once at the start of the row (the first call may take seconds) rather than skipping. Rows 1–3 and 9 are hermetic.

### Prohibitions

- No copy of the client: after the extract, `rg -n 'daemon.sock' extensions/ skills/` hits `client.ts` and any doc, never a second implementation.
- No MCP server, no `~/.claude.json` or `~/.claude/settings.json` edit, no launch-command change: `git diff --stat` on the repo shows no such file, and the only filesystem change outside the repo is the one symlink.
- No new dependency and no `package.json` change.
- The pi tool's behaviour is unchanged: `semantic_search`-equivalent calls return the same shape and the same default `top_k`; its schema and prompt guidance are untouched.
- No embedder invocation from the CLI: `rg -n 'BABA_EMBEDDER|server\.py' extensions/baba/bin/` → no match.
- No polling loop in the CLI: it does one request and exits; the wait-for-daemon machinery stays in `ensureDaemon` where it already is.

### Docs to update

- `decisions/external-tools/009-baba-for-claude-code.md` — Outcome with commit ids, the CLI's path, and the measured warm-query wall time.
- `extensions/baba/README.md` (or create it if thin) — the CLI as the second entry point, one paragraph, pointing at the skill.
- `README.md` — one line where the other extensions are listed.
- `docs/investigations/structure-trend.md` — a snapshot under both lenses, including the `index.ts` → `client.ts` split's line counts.

### Completion report

The standard schema. Additionally: both line counts for `index.ts` before/after; the warm-query wall time and the evidence that no python process was spawned by the CLI; the characterization rows' pass at the refactor commit with that commit's id; and the `ls -l` output for the symlink.

`review_cap_reached` is hard: **3 rounds maximum**. A fourth round is refused and escalated to the orchestrator, not entered.
