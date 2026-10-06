---
title: "Global append prompt for subagents — inject shared APPEND_SYSTEM.md explicitly"
type: decision
status: done
date: 2026-10-06
---

# Global append prompt for subagents

**What:** Every subagent spawn now passes the shared global prompt
(`~/.pi/agent/APPEND_SYSTEM.md`) as an additional `--append-system-prompt`
argument, **before** the agent-body temp file. The path is derived from
`getAgentDir()` and is emitted only when the file exists. Composition lives in
`buildSubagentArgs` via a new `appendSystemPrompts?: string[]` field; the caller
passes `[globalPath, tmpPath]` with missing entries filtered out.

**Why.** pi's resource loader discovers `<agentDir>/APPEND_SYSTEM.md` only when
no explicit append source was supplied — `dist/core/resource-loader.js`:
`let appendSources = this.appendSystemPromptSource; if (!appendSources) {
… discoverAppendSystemPromptFile() … }`. The spawner
(`extensions/subagent-async/index.ts`) always passes the agent body as
`--append-system-prompt` when the body is non-empty, which sets
`appendSystemPromptSource` and suppresses discovery. A probe subagent confirmed
its assembled prompt contained `<project_context>`/AGENTS.md but not the global
file. Since repo-independent process rules have moved into the global
`APPEND_SYSTEM.md` (repo-independent rules live in the shared prompt; project
rules stay in AGENTS.md), subagents silently lost every one of them.

**Alternatives rejected.**
- *Keep relying on project AGENTS.md:* the rules no longer live there — they are
  repo-independent and shared — and subagents only see the project file because
  the parent context injects it, not because the child loads it.
- *Rely on agent bodies telling the child to read project docs:* `review-*` and
  `implement` bodies do; the orchestrator body does not, and steering a child to
  read its own prompt is not a general fix.
- *Fix it upstream in pi (preferred long term):* an explicit
  `--append-system-prompt` arguably should not suppress global discovery. That is
  worth an upstream issue, but it is not available now and not blocking.
- *Mirror `<cwd>/.pi/APPEND_SYSTEM.md` too:* rejected. pi gates that project file
  on a project-trust check (`isProjectTrusted`) the spawner cannot re-run, so
  injecting an untrusted repo's file would bypass the trust gate.

**Tradeoffs.**
- ~2.5k extra prompt tokens per child, mostly cache-hit after the first turn.
- Parent-role bullets in the global prompt are now visible to children. Agent
  bodies are role-scoped and win on conflict, which is why the global prompt is
  passed first and the agent body last.

**Reopening triggers.** pi upstream changes discovery so an explicit agent-body
flag no longer hides the global file → drop the explicit injection. Token cost
measured as material (not cache-hit) → reconsider splitting the global prompt.
Children observed following parent-only bullets → revisit ordering / splitting.

**Files changed:** `extensions/subagent-async/index.ts` (`buildSubagentArgs`
`appendSystemPrompts`, `resolveGlobalAppendPrompt`, spawn-time composition),
`tests/subagent-global-append.test.ts`, `README.md`, this decision, index.

**Test coverage:** `buildSubagentArgs` global-before-agent ordering and
undefined/empty filtering; `resolveGlobalAppendPrompt` path derivation from
`getAgentDir()` and the absent-file case.
