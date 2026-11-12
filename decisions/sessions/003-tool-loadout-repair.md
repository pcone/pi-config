---
title: "A transcript that lost its built-in tool declaration is repaired at session start"
type: decision
status: active
date: 2026-11-13
---

# A transcript that lost its built-in tool declaration is repaired at session start

**Ruling.** `extensions/session-trim.ts` re-activates `read`, `write`, `edit` and
`bash` on `session_start` when all four are missing from the active set and no
tool-selection flag is on argv. The repair appends to whatever is active and
notifies with a warning, and appends a `tool-loadout-repair` entry carrying the
names, because a toast issued at that point can land before the view is up. It
never fires for a partial set.

**Why.** pi restores the tool loadout by replaying `toolsAdded`/`toolsRemoved`
from the system messages on the branch, and built-in tools follow that replay
where extension tools do not
(`agent-session.js#_restoreToolsFromTranscript`, 1.4.0). A message recording the
built-ins as removed therefore disables them on every later resume, and the next
run records the same loss again — the loss is self-confirming. The tfd-d session
(`01a114c8`) carried exactly such an entry and resumed with no `bash` for two
days: replay yielded `checkpoint, checkpoint_fork, subagent,
subagent_review_status, wait_for`, extension tools came back, built-ins did not.
After the repair ran once, pi wrote a system entry with `toolsAdded: [read,
write, edit, bash]` and the replay includes them, so the transcript heals and
later relaunches need nothing.

**Why the whole set, and only without a flag.** One missing built-in is what
`--exclude-tools bash` looks like, and an operator who disabled a tool meant it.
The same applies to `--tools`, `-t`, `--exclude-tools`, `-xt`, `--no-tools`,
`-nt`, `--no-builtin-tools` and `-nbt`, so any of them on argv stands the repair
down entirely.

**Rejected.** Editing the session file to delete the `toolsRemoved` entry: it
repairs one session and leaves the next one to lose its tools silently. That the
repair lives in the trim extension rather than a new one: the replay rule is
already documented there (`planTrim`'s loadout comment), and the runtime half
belongs beside it.

**Test.** `tests/session-trim.test.ts` — `builtinsToRepair` rows (whole set,
partial set, no tools, every flag in both spellings) and two wiring rows driving
`session_start` (repairs and notifies; healthy loadout untouched). Each row was
proven red by its mutation.
