# WO-2026-069 — baba as an MCP server for Claude Code

**Status: DRAFT 2026-11-03.**

### Metadata

- **work_order_id**: WO-2026-069
- **parent_plan_id**: [decision external-tools/009](../decisions/external-tools/009-baba-for-claude-code.md), § Superseded in part
- **routed_to**: implement
- **invariant_exhaustiveness**: implicit
- **priority**: normal
- **estimated_complexity**: moderate
- **review_policy**: required

### Task Summary

baba-pi gains a stdio MCP server exposing one `search` tool over the existing daemon client
(`src/client.ts`). The planning seat registers it at user scope in Claude Code, then deletes the
`baba-search` skill. The CLI stays.

### Rulings

- external-tools/009 § Superseded in part, owner 2026-11-03: "yeah can we do this - rework baba pi
  so that it also includes the mcp integration", accepting the recommendation recorded there (MCP
  server in baba-pi over `src/client.ts`; user-scope registration; CLI kept; skill deleted).
- 009, landing-repo ruling: code and tests land in `pcone/baba-pi` with its bun harness; pi-config
  carries docs only.
- 009, Constraint: one daemon client. The server imports `src/client.ts`; no protocol code is
  copied.

### Premises

- **P1.** The client's request path runs without the pi runtime: the CLI already proves it
  (`bin/baba-search.ts`). Probe: the CLI's imports.
- **P2.** Claude Code launches a user-scope stdio server with the session's working directory as
  cwd, so `resolveMainRoot(process.cwd())` finds the repo as the CLI does. Probe: cite the Claude
  Code MCP docs on the launch cwd. Do not start a Claude session to test it (no `claude -p`, no
  headless session); the planning seat verifies live at registration. If the docs say the cwd is
  not the session's, stop with `PREMISE FALSIFIED`.
- **P3.** `~/Developer/baba-pi` holds another session's 11 uncommitted lines in `src/index.ts`
  (two `_onUpdate` progress calls). Probe: `git -C ~/Developer/baba-pi status --short`. Work in a
  separate worktree or clone of `pcone/baba-pi`; never write in that checkout. The planning seat
  pulls it after landing, preserving those lines.

### Preparatory refactor

The CLI and the server share every step of a query: resolve the root, ensure the daemon (with its
status lines), send one request, format. If the CLI holds any of that beyond argument parsing and
printing, move it into one client function (for example `search(cwd, query, k, onStatus)`) the CLI
calls, behind the existing CLI rows, which pass unchanged at that commit. If the CLI already calls
the client for each step, write `none` with the `rg` that shows it.

### Mechanism

- `bin/baba-mcp.ts`, `#!/usr/bin/env bun`, executable. Stdio transport.
- Use the official TypeScript SDK `@modelcontextprotocol/sdk`, pinned to an exact version, with
  `bun.lock` committed. A hand-rolled JSON-RPC loop is rejected: protocol version negotiation and
  framing are the SDK's job, and a second implementation drifts.
- One tool, `search`: inputs `query` (string, required) and `k` (integer, optional, default the
  CLI's `DEFAULT_TOP_K`). Its description says what the skill's frontmatter says: semantic search
  over the repo's docs and code, for questions spanning files; not for exact strings. Output: the
  `formatResults` text, byte-identical to the CLI's stdout for the same query.
- The daemon starts on the first call, not at server start: an idle Claude session spawns nothing
  but the server.
- While `ensureDaemon` waits, the server sends MCP progress notifications when the request carries
  a progress token, carrying the client's status lines. The cold start is 77–95 s, so a silent tool
  reads as a hang.
- Failure (no repo, daemon error): a tool result with `isError: true` and the client's message.
  The server stays up.
- Nothing on stdout except protocol frames; diagnostics on stderr.

### Acceptance rows (bun test, baba-pi)

1. `tools/list` returns exactly one tool, `search`, with the schema above.
2. `tools/call` against the fake daemon socket returns text equal to the CLI's stdout for the same
   canned response.
3. Server start spawns no daemon (the fake spawn hook or socket is untouched until the first call).
4. A call outside a repo returns `isError: true` naming the cause, and a following `tools/list`
   still answers.
5. With a progress token and a daemon that is not yet up, at least one progress notification
   arrives before the result.
6. Nothing but valid JSON-RPC frames reaches stdout across rows 1–5.

Each row, run alone, goes red under a mutation that breaks its behaviour; show the mutation.
The existing 25 rows pass unchanged.

### Prohibitions

- No second daemon client or copied protocol code. Check: `rg -n 'daemon.sock|JSON.parse|net\.' bin/ src/`
  with each hit in `src/client.ts` or shown not to speak the protocol.
- No writes in `~/Developer/baba-pi` (P3), `~/.claude.json` or `~/.claude/settings.json`. The
  planning seat does the registration.
- No new tool beyond `search`, no new CLI flag.
- Cost: record the server's idle RSS and startup wall time; the first-call and warm-call wall time
  against the live daemon for pi-config's index.

### Docs to update

- baba-pi `README.md`: the server, how it is registered, the one tool.
- pi-config `README.md`: the `extensions/baba` line names the MCP server beside the CLI; the
  `skills/baba-search` line goes when the planning seat deletes the skill.
- 009's Outcome gains this order's landing.

### After landing (planning seat)

1. Pull `~/Developer/baba-pi`, keeping the 11 pending lines.
2. `claude mcp add --scope user baba -- /Users/scott/Developer/baba-pi/bin/baba-mcp.ts`; verify in
   the next session that `search` is listed and answers from `~/Developer/tfd`, and confirm P2's
   cwd.
3. Delete `skills/baba-search` and `~/.claude/skills/baba-search`.

### Completion report

Commits (repo, hash, subject); the Preparatory refactor result; each row with its mutation; each
prohibition's check; the cost figures; departures, if any, as owner questions.
