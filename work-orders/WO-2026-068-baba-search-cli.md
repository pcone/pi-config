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

---

### BLOCKED 2026-11-03 — three premises false, and repo topology decides it

Dispatched off `0130a0c`, nothing landed on the branch. Three owner questions, all
created by this order's text rather than by the code:

- **Q1 (topology). `extensions/baba` is a tracked symlink, not a directory.**
  `git ls-files -s extensions/baba` → `120000 … extensions/baba` →
  `/Users/scott/Developer/baba-pi`, whose only source file is `src/index.ts`. So
  `extensions/baba/bin/baba-search.ts` cannot be added to this repo at all
  (`fatal: pathspec … is beyond a symbolic link`), and the order's own path was
  unsatisfiable. Options: (A) two-repo landing — extract + CLI + tests in `baba-pi`, with
  pi-config keeping the symlink and the skill; (B) move the source into pi-config and drop
  the symlink; (C) a pi-config CLI that speaks the socket directly — rejected by 009's
  "reuse the client, don't copy it".
- **Q2 (public surface). `baba-pi/src/index.ts` exports exactly one symbol**
  (`rg -n '^export'` → `561:export default function babaExtension`). Characterization rows
  that run *before* the extract must import `resolveMainRoot`, `daemonRequest` and
  `formatResults`, which means new exports. Options: (A) export them; (B) a test-only
  re-export shim in `baba-pi`; (C) characterize through the registered tool via the
  factory, which cannot pass unchanged across the extract.
- **Q3 (the skill's home).** 009 attributes `pi-config/skills/baba-search/` to the
  recorder, not to the owner ruling. Under Q1 option A the skill stays here and the CLI
  lives in `baba-pi`; under B both are here. Whichever is chosen decides the command line
  the skill documents.

**This order's own defects, on the record.** The path was taken from 009's prose without
checking the tree (`git ls-files -s` would have shown the symlink immediately). Two
prohibition probes were vacuous: `rg` skips symlinks, so `rg -n 'daemon.sock'
extensions/` exits 1 with no output whatever the code does. A control that cannot fail is
not a control; the check is `rg -nL` or `git ls-tree`.

**Ready to resume.** Client characterization rows are drafted and green (8 rows, per-row
mutation table: 6 mutations, each reddening its own row) at
`~/Developer/wt/wo068-drafts/`, outside any repo. Cold start measured at 77 s on a drifted
index; warm queries 116–210 ms against the live daemon; one long-lived embedder child, no
per-query load. CLI and skill rows are specified but unwritten.

---

### AMENDMENT 2026-11-03 — the landing repo is ruled; this section supersedes the paths above

**Ruling (owner, 2026-11-03, recorded in `decisions/external-tools/009`, commit `9d217f7`):
baba-pi owns code and tests.** The client extract, the `baba-search` CLI and their
characterization/acceptance rows land in `pcone/baba-pi`, which gains a bun test harness;
pi-config carries the skill and docs only. Rejected with it: rows in pi-config reaching
baba-pi's live checkout through the symlink, and moving baba-pi's source into pi-config.
Pushing to `pcone/baba-pi` is approved by that ruling.

Everything below that names `extensions/baba/...` or a pi-config test path is superseded.

**Work location.** A baba-pi worktree at `~/Developer/wt/baba-pi-wo068`, branched off
`origin/main` (`202cd0c`). **`~/Developer/baba-pi` is read-only for this order** — no
writes, no `git checkout`, no `git stash`, nothing. It holds another session's
uncommitted work (` M src/index.ts`, two `_onUpdate` progress messages, 11 insertions);
the previous dispatch destroyed and restored those lines once already. Verify untouched at
the end:

```
git -C ~/Developer/baba-pi status --short     # exactly: " M src/index.ts" and "?? .DS_Store"
git -C ~/Developer/baba-pi diff --stat        # exactly: 1 file changed, 11 insertions(+)
```

**Files.** baba-pi: `src/client.ts` (new — `resolveMainRoot`, `findBabaHome`,
`resolveCoreBin`, `embedderCmd`, `ensureDaemon`, the socket client and its request queue,
`formatResults`), `src/index.ts` (keeps the factory, imports the client; still **one**
export), `bin/baba-search.ts`, `test/client.test.ts`, `test/cli.test.ts`, and
`package.json` gaining only `"scripts": { "test": "bun test" }`. pi-config:
`skills/baba-search/SKILL.md`, the `~/.claude/skills/baba-search` symlink, and a docs
note recording the tracked-symlink arrangement.

**Q2 dissolved by the ruling, not answered.** Tests import the client through the new
module boundary the extract creates — that is the seam, not a widened public surface.
`src/index.ts` still exports nothing but `babaExtension`. No test-only shim.

**Two landings, in this order.** (1) baba-pi: commit and push to `origin/main`, `bun test`
green there. (2) pi-config: skill + docs, one commit, pushed. Name both shas in the
completion report; "committed at `<sha>`", never "landed".

**Prohibitions, with probes that can actually fail.** `rg` skips symlinks, so every path
claim is checked with `git ls-files -s`/`git ls-tree` and every content claim in
pi-config's `extensions/` with `rg -nL`. Specifically: no write of any kind under
`~/Developer/baba-pi`; no edit to `~/.claude.json`, `~/.claude/settings.json` or any
launch command (the ruling approves the skills symlink only); no daemon spawn from the
CLI path other than through `ensureDaemon`; no second copy of the socket protocol.

---

### Landing stamp (2026-11-03)

**baba-pi** `origin/main` = `46bb86d`, four commits: `27d9902` (extract the client into
`src/client.ts`, rows following in the same commit), `58495b5` (the CLI), `ced1513` (failure
paths and direct execution), `46bb86d` (two named follow-ups). `src/index.ts` 681 → 146
lines and one export; `src/client.ts` 570; `bin/baba-search.ts` 119 at mode `100755`;
`test/client.test.ts` 343 and `test/cli.test.ts` 442; `package.json` gains only
`"scripts": {"test": "bun test"}`.

**pi-config** `c620e7d`: the skill, two README bullets, decision 009's Outcome, the
structure-trend snapshot.

**Gate, re-run by me at the merged tip.** baba-pi `bun test` → 25 pass / 0 fail, clean tree,
and 25/0 again in the live checkout with the neighbour's 11 pending lines applied. My own
mutations, independent of the implementer's table: `findMainRoot` returning `cwd` instead of
`null` reds `findMainRoot > returns null outside any repo`; `DEFAULT_TOP_K = 3` reds
`prints ranked results on stdout and nothing else`. CLI run from outside a repo exits 1 in
0.53 s with the message naming the cause; from the main checkout, results on stdout and
diagnostics on stderr, exit 0. `~/.claude/skills/baba-search` → `pi-config/skills/baba-search`.
pi-config's suite is unchanged by this landing: since `22ebe0c` the only changed files are
`.md`, so no row can reach it.

**Spec defects, kept as written.** (a) The order placed tests in pi-config, which the ruling
reversed — recorded in the amendment above, not rewritten into the spec. (b) Acceptance row
9 could not be green from inside the dispatch, because pi-config's `main` and the live
baba-pi checkout are the orchestrator's to move; it went green only after the seat pulled
both. (c) The order's prohibition probes were vacuous for symlinked paths; every probe in
the completion report uses `rg -nL` or `git ls-tree`.

**Two decisions I accepted and record as mine.** `findMainRoot` is a new export from
`src/client.ts` — the module boundary the ruling blesses as the test seam, not a widened
public surface. And `findMainRoot`'s `execFileSync` sets `stdio: ["ignore","pipe","ignore"]`,
which suppresses git's own `fatal:` line on a not-a-repo directory; the tool's behaviour to
the model is unchanged, and the row pins the resulting stderr exactly.

**Corrected after measuring.** The skill claimed "a few hundred milliseconds warm". Measured
here: 0.53–0.66 s warm over pi-config's 700-file index (bun startup itself 0.03 s), 77–95 s
for the re-index that follows a changed tree. The skill now states those numbers.
