---
title: "Clean task identity vs. the worktree-isolation prompt wrapper"
type: decision
status: done
date: 2026-07-27
---

# Clean task identity vs. the worktree-isolation prompt wrapper

**What:** `RunningSubagent.task` holds the clean task the orchestrator asked for (no harness boilerplate). The worktree-isolation preamble and `review_policy: skip` annotation are delivery wrappers that reach the child process only, via a new `promptMessage` arg to `spawnSubagent`. The isolation auto-commit subject is derived from the clean task's first non-empty line (`subjectFromTask`), never from the prompt.

**Why:** The auto-commit subject was built as `subagent(${name}): ${rs.task.slice(0,72)}`, but `rs.task` was the *full delivery payload* — the `## Worktree isolation` preamble followed by the real task. The subject therefore read `subagent(implement-pro): ## Worktree isolation You are running inside an isolated git worktree at` and conveyed nothing about the work. Reproduced in this repo's own history: commit `5feef34` and the `pi-subagent-*` branches. The handoff framed this as a harness bug, but the `subagent` tool is this extension (`extensions/subagent-async`), not built-in pi — so the fix is local.

The subject mechanics were subtle enough to be worth recording: `git log --format='%s'` is the first **paragraph** (blank-line-delimited), with internal newlines collapsed to spaces — not the first line. The current preamble has no blank line after the header, so the whole boilerplate collapses into one long subject (the handoff's evidence shape). The older preamble (blank line after the header) collapsed to just `## Worktree isolation` (the `5feef34` shape). Either way the preamble leaked; the fix removes it from the subject entirely.

**Alternatives considered:**
- **Regex-strip the preamble from `rs.task` before slicing.** Rejected — fragile (couples the subject to the exact preamble format), and leaves `rs.task` semantically dirty for every other reader (the `deliverResult` "Task:" line, the metadata file). The metadata already stored the clean `params.task`; the in-memory `rs.task` was the outlier.
- **Derive the subject from the subagent's completion report / `work_order_id`.** Rejected for now — `preCommitSteps` runs *before* `deliverResult`, the completion summary is fuzzy to extract, and tasks don't always carry a work-order id. The clean task's first line is deterministic and always available. Open to revisiting if subjects still feel low-signal.
- **Keep `rs.task` dirty; add a separate `rs.taskTitle` for the commit.** Rejected — two overlapping fields invite the next reader to grab the wrong one. Making `rs.task` the clean identity matches the metadata and fixes both the commit subject and the delivered "Task:" display with one change.

**Tradeoffs:**
- `spawnSubagent` gains a parameter (`promptMessage?`); its contract is now "the clean task identity, plus optionally the exact bytes to send the child." Callers that omit `promptMessage` (notably `subagent_resume`) behave exactly as before — the child receives the clean task.
- The child's log header (`/tmp/pi-subagent-<sid>.log`) now shows the full prompt (preamble included) rather than the clean task — a debuggability improvement, since the log reflects what was actually sent.

**Files changed:**
- `extensions/subagent-async/index.ts` — added `subjectFromTask`; `preCommitSteps` uses it; `spawnSubagent` takes `promptMessage?` and sends `promptForChild = promptMessage ?? task` to the child while keeping `rs.task` clean; the main spawn call passes `params.task` as the identity and the preamble-wrapped `taskForAgent` as `promptMessage`.
- `extensions/subagent-async/test-subject.cjs` — regression test: `subjectFromTask` unit cases, plus an end-to-end `git log --format='%s'` repro of the OLD leak vs. the NEW subject (pins the paragraph-collapse semantics).

**Test coverage:** `node extensions/subagent-async/test-subject.cjs` — 9 cases, including the OLD-vs-NEW git subject repro.
