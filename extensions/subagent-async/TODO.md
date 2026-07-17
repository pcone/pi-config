# subagent-async TODO

## Root cause of "0 turns, exit 1" on every subagent dispatch

Three connected bugs. Fix in this order; each unblocks the next.

---

### Bug 1 — Child `pi` stderr is silently discarded (`extensions/subagent-async/index.ts:917-919`)

**Symptom (reproducible 2026-07-17):** Any subagent call aborts with
`Stopped (0 turns, exit 1)`. The log file shows only the spawn header and
the failure footer. No stderr from the child is captured. The orchestrator
sees no signal about *why* the child died.

**Code (current):**
```ts
proc.stderr.on("data", (data: Buffer) => {
    // Accumulate stderr for debugging; don't surface to parent unless needed.
});
```

The comment says "accumulate" but the body is empty. The handler is a
no-op. Every line of stderr from the child `pi` process is dropped on
the floor.

**Why this is the "hidden-cause amplifier":** With this bug in place, ANY
subagent startup failure (broken extension in user config, missing binary,
malformed args, model unavailability, etc.) is invisible. The user has
no way to debug the failure. The orchestrator just sees "exit 1" and
gives up.

**Fix:**
- Capture stderr into `rs.stderrLines: string[]` (or similar).
- On `proc.on("close", ...)`, write a single line to the log file:
  `[stderr:N lines]` so the volume is visible in the header.
- When `rs.progress.turns === 0` AND stderr is non-empty, prepend the
  last ~30 lines of stderr to the result delivered to the parent (via
  `deliverResult` or `resolveOnStop`). Surface early-failure stderr
  inline; otherwise, just record it.
- Keep "don't surface to parent unless needed" — only surface on early
  exit (turns < 1, or exit code != 0 with no turns).

**Scope:** ~20 lines, mechanical. Single file.

**Verification:** With Bug 2 fixed, dispatch a one-word "pong" and check
that the log file contains the agent's normal output, not just an exit
footer.

---

### Bug 2 — `modes.ts` template-literal parse error blocks ALL `pi` sessions (`~/.pi/agent/extensions/modes.ts:50-51`)

**Symptom:** `pi --mode rpc ... < /dev/null` exits immediately with:
```
Error: Failed to load extension "/Users/scott/.pi/agent/extensions/modes.ts": Failed to load extension: ParseError: Unexpected token, expected ","  
 /Users/scott/.pi/agent/extensions/modes.ts:51:38
Hint: Start without extensions using "pi -ne".
```

**Root cause:** The `orchestrate` mode string in `MODE_FULL` is itself
a template literal. The orchestrator-mode instructions were recently
updated to include the work-order-tooling example, which uses backticks
to format code (`\`review_policy: "skip"\`` and `\`subagent\``). Those
inner backticks close the outer template literal early, leaving the
parser with `review_policy:` (an unexpected token where a `,` is
expected).

**Code (current, modes.ts:50-51):**
```ts
	orchestrate: `## Mode: orchestrate

You are in orchestration mode. Prefer dispatching implementation work
to subagents. For substantial tasks, generate a work order (load the
work-order-template skill) and dispatch to the appropriate agent
(implement-flash for mechanical work with explicit invariants,
implement-pro for non-trivial feature work, scout-code/scout-web
for research). For trivial changes, pass `review_policy: "skip"` on the `subagent` call
```

The line that breaks: `pass \`review_policy: "skip"\` on the \`subagent\``
— inner backticks terminate the outer template literal, then the parser
hits `review_policy:` and fails.

**Fix:** Escape the inner backticks (`\\\``) or use single quotes around
inner code spans. Note: the parent session is currently working, so
either (a) the parent already loaded modes.ts before the broken version
was written, (b) pi tolerates the error gracefully for the parent and
only fails the child, or (c) something else — needs to be confirmed
once the file parses cleanly.

**Scope:** ~1 line change. Trivial.

**Verification:** `pi --mode rpc --model deepseek/deepseek-v4-flash < /dev/null`
starts cleanly (no `Failed to load extension` error). Then dispatch a
subagent to confirm end-to-end.

---

### Bug 3 — Worktree contamination in parallel subagent dispatches

**Symptom:** See
`/Users/scott/Developer/tfd/decisions/agent-orchestration/001-worktree-contamination-parallel-dispatch.md`.

**Status:** Investigation blocked by Bugs 1 + 2. Once subagent dispatch
works, dispatch `scout-code` to read the worktree-handling code in
detail. Until then, cannot use scout to investigate.

**Investigation steps (pending dispatch fix):**
- [ ] Trace worktree creation (`createWorktree`, ~line 343).
- [ ] Trace auto-commit on completion (`cleanupWorktree`, ~line 380).
- [ ] Search for `stash` usage anywhere in the extension.
- [ ] Trace `isolate: false` reviewer path (~line 1380–1450).
- [ ] Identify concurrency hazards (parent process side effects, worktree
      path collisions, race between concurrent `worktree remove` calls).
- [ ] Determine if the contamination is reproducible or a one-off.
- [ ] If reproducible, identify the exact mechanism and fix it.

---

## Routing

- Bug 1 (stderr logging): **implement-flash** after scout has confirmed
  scope. Or directly if user wants speed (mechanical, ~20 lines, single
  file, explicit invariants).
- Bug 2 (modes.ts parse): **implement-flash** — trivial, but the file is
  global pi config (not in this repo), so the implementer would need
  to write the absolute path explicitly.
- Bug 3 (worktree contamination): **scout-code** for investigation,
  then **implement-pro** if the fix is non-trivial (state machine,
  new error handling, etc.) or **implement-flash** if it's mechanical.

## Note

Bugs 1 and 2 must be fixed before Bug 3 can be investigated, because
all subagent dispatch is currently broken. This is a hard prerequisite,
not just a convenience.

---

## Bug 3 — scout findings (2026-07-17)

`scout-code` investigation of `extensions/subagent-async/index.ts`.
Full report archived. Key conclusions:

**Verdict:** No-bug in the harness. The contamination was caused by an
external mechanism (a child `pi` process reading from a sibling worktree
via absolute paths), not by the worktree-handling code itself.

**Ruled out (harness is clean):**
- No `git stash` usage anywhere in the extension (zero hits).
- Worktree paths are unique (48 bits of entropy from a UUID).
- `git add -A` and `git commit` run inside `worktreePath`, not parent cwd.
- Per-session closures in `cleanupWorktree`; no cross-session access.
- No parent-process `git` in `parentCwd` that mutates worktree contents.

**Plausible external mechanisms:**
- MEDIUM — child reads sibling worktree via absolute path (21-minute
  reviewer could enumerate `/tmp/pi-subagent-wt-*/`).
- LOW — shared `git stash` survives worktree removal (no `stash clear`
  in `cleanupWorktree`).

**Real harness gaps to fix (regardless of the incident):**
- No `git stash clear` in `cleanupWorktree` after `git worktree remove`.
- Auto-commit message shows only the task, not the file list — so a
  contaminated commit looks identical to a clean one.
- Worktree preamble does not warn children about other concurrent
  worktrees.

**Unrelated observations from scout:**
- `clearParentTracker` (`index.ts:136-140`) is dead code — defined
  but never called. Memory growth across long sessions.
- `discoverAgents(ctx.cwd, "user")` re-scans the agents directory on
  every subagent tool call. Latency wart.

**Proposed fix (3 mechanical changes, single file):**
1. `cleanupWorktree`: add `git stash clear` in `parentCwd` after
   `git worktree remove`. Closes the LOW stash mechanism.
2. `cleanupWorktree`: append a file-list summary to the auto-commit
   message. Cheap observability for contamination.
3. Worktree preamble (`index.ts:1439-1440`): warn children that
   other concurrent worktrees may exist and must not be read or
   written to.

Status: awaiting user decision on scope.
