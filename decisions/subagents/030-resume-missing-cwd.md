---
title: "Resume pre-check for a missing stored cwd"
type: decision
status: active
date: 2026-10-07
---

# Resume pre-check for a missing stored cwd

**Ruling.** `subagent_resume` checks the cwd recorded in the session file
before spawning, and refuses with a message naming both workarounds when it is
gone. We do not rewrite the session file, and we do not spawn a child that
cannot start.

**Why.** pi opens the session file, reads its stored cwd, and requires it to
exist (`dist/core/session-cwd.js`, `getMissingSessionCwdIssue`). Interactive
mode offers a choice (`promptForMissingSessionCwd`); every non-interactive mode,
including the rpc mode subagents run in, does `console.error` +
`process.exit(1)` (`dist/main.js:498-511`). `buildSubagentArgs` has no cwd
option, and the spawning process's own cwd is not consulted for this check.
Observed 2026-10-07: a resumed child whose recorded worktree had been removed
exited 1 before its first turn, and the parent side saw only "completed
(0 turns)" — the cause took forensics across session files and logs to find.

**Workarounds (carried in the refusal message).** `mkdir -p "<recorded cwd>"` —
the check is `existsSync` only, so any directory satisfies it; or
`ln -s "<live checkout>" "<recorded cwd>"` when the work should continue against
real code.

**Header acceptance.** `readSessionCwd` mirrors pi's own header test
(`type === "session"` and a string `id`, `parseSessionHeaderCandidate`) before
reading `cwd`. A line 1 pi does not recognize leaves pi reading its own cwd
(`?? process.cwd()`), so refusing on that line's `cwd` could block a resume pi
would accept. Every unreadable or unrecognized shape skips the pre-check: a
false null costs the old silence, never a wrong refusal.

**Adjacent gap (not covered here).** The *spawn* cwd
(`params.cwd ?? meta.parentCwd || ctx.cwd`) is a different path; when it names a
removed worktree the child dies with ENOENT rather than this message. For a
resumed session the stored cwd is usually that same worktree, so the check above
fires first — what remains is a resume with an explicit cwd override, or a
session started somewhere else than it was spawned.

**Alternatives rejected.**

- *Rewrite the session file's cwd header*: the file is pi's record, and its cwd
  is the path every tool call in the transcript was made against; silently
  rewriting it to make a resume work is worse than refusing.
- *Spawn and detect the exit-1*: that failure is visible only as exit 1 plus a
  line on the child's stderr; the parent would parse a log to reconstruct a
  condition it can check before spawning.
- *Pass `--cwd` to the child*: pi has no such flag — the check is on the stored
  value, so there is nothing to pass.

**Upstream ask (open, unfiled).** pi should honor an explicit cwd override for
`--session` in non-interactive modes, or at least surface
`MissingSessionCwdError` on the parent's stderr rather than only the child's log.
The pre-check here is the pi-config-side mitigation until then. Filing it
against pi needs the owner: no issue channel for the pi package is reachable
from this repo.

**Observed 2026-10-08 — the same ask at the harness layer.** The agent
harness's own `subagent_resume` fails identically on a worktree-isolated
session once the worktree is gone: the resume aborts with 0 turns and
`Stored session working directory does not exist: <worktree path>` on stderr.
Its `cwd` parameter does **not** bypass the check — pi validates the session
header's stored cwd, not the process cwd — so unlike the pi-config tool above
there is no harness-side workaround either. Second caller for the same ask
(found resuming round-2 reviewer sessions, 2026-10-08).
