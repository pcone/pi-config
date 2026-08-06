# Todo extension: inject list into context + enforce brevity

## Problem (user report)

1. **List not followed.** Todo CRUD (add/edit/start/complete/defer/remove/clear/setDoc) all
   work, but sessions drift off the list — especially after compaction or in fresh sessions.
2. **Tasks are too long.** Sessions write whole-paragraph tasks instead of 1–2 short
   sentences, with detail that belongs in the plan doc.

## Root cause (confirmed by code read)

`extensions/todo.ts` keeps todo state in tool-result `details`, reconstructs it into an
in-memory `todos[]` on `session_start` / `session_tree`, and feeds that array to **two
UI-only surfaces**: a sliding-window widget (`ctx.ui.setWidget`) and a `/todos` command.
Neither is ever sent to the model. The model only sees the list when it explicitly calls
`todo list`, or while prior tool results are still in context. After compaction / a fresh
session, the list is gone from context and nothing re-injects it. That is the drift.

The brevity issue is a prompt gap: the tool `description` says "one-sentence summaries" but
models ignore it; there is no enforcement.

## Fix

### 1. Inject the current list into context, re-primed after compaction / resume / branch

Use the **one-shot message + re-prime** pattern from `extensions/modes.ts`
(`pendingInjection`): inject the list once as a `display:false` context message — **not** into
the system prompt every turn. The message then persists in the branch (so the model sees it
on every turn until it is compacted away), and we re-prime exactly when the model would
otherwise lose it: `session_start` (resume), `session_tree` (branch/switch), `session_compact`.

- `before_agent_start` consumes a `pendingTodoInjection` flag: when set and the rendered
  block is non-empty, emit `{ message: { customType: "todo-injection", content: renderTodoBlock(...), display: false, details: {...} } }` and clear the flag; else return nothing.
- Set the flag in the existing `session_start` / `session_tree` handlers (after
  `reconstructState`) when `todos.length > 0`, and in a new `session_compact` handler.
- `renderTodoBlock` is **pure + exported** so it is unit-tested — content is the only
  non-trivial part; the handler is a thin composition over it.
- Mirror the `list` action: non-done tasks (`in_progress` / `pending` / `deferred`), marks
  `[>]` / `[ ]` / `[-]`, include `#id`; one-line done-count footer when any are done; doc
  path in the heading when `doc` is set; one-line directive so the list reads as authoritative.
- **Do not call `reconstructState` on `session_compact`** — the compacted branch may have
  summarized away the tool results, which would reset `todos[]` to empty. The in-memory
  `todos[]` survives compaction unchanged; read it directly.
- **No `PI_IS_SUBAGENT` guard** (unlike modes.ts): todos are session-scoped; a subagent's
  own (usually empty) list injects nothing. Do not add a guard.

**Why message + re-prime, not system-prompt-every-turn:** mid-session the list is already
visible via recent `todo` tool results, so re-sending it in the system prompt every turn is
redundant and churns the cached prompt tail whenever tasks change. The message pattern
injects only when the model would otherwise lose the list; between those events the message
persists in context and tool results keep it current. This matches `modes.ts`'s convention
for full content that changes (vs. its tiny static `MODES_BRIEF`, which legitimately lives
in the system prompt).

### 2. Enforce 1–2 short sentences, detail in the doc

- Strengthen the tool `description`: each task is a title, not a spec — 1–2 short sentences
  max; full reasoning / sub-steps / context go in the plan doc; if a description grows past
  two lines, move detail to the doc and shorten the task.
- Soft non-blocking guard on `add` / `edit`: when the text exceeds a threshold (~200 chars),
  the result text appends a one-line nudge to move detail to the doc. Not a hard block
  (legitimate tasks may need 3 short sentences); the point is to make the instruction stick.

## Files

- `extensions/todo.ts` — add `renderTodoBlock` (exported, pure) + `pendingTodoInjection`
  flag + `before_agent_start` message handler + `session_compact` re-prime; strengthen
  `description`; add brevity nudge in `add`/`edit`.
- `tests/todo-render.test.ts` — new; golden tests for `renderTodoBlock` (empty, mixed
  statuses, doc set, done-count footer, ordering). Follow `tests/append-system-local.test.ts`
  / `tests/model-tiers-render.test.ts` (`bun:test`, import from `../extensions/todo`).

## Out of scope

- Changing the storage model (tool-result `details` + reconstruct) — it works.
- The widget, `/todos` command, or `renderCall`/`renderResult` — unchanged.
- `~/.pi/agent/todos.json` — unrelated stale data (old footer-session-id dev tasks); leave it.
- Hard-blocking long tasks.

## Follow-up (WO-2026-047): smoke test + tsc nit

Two loose ends after WO-046 landed:

1. **Smoke-test the wiring.** WO-046 proved `renderTodoBlock`'s *output* but not that the
   `before_agent_start` handler actually fires after compaction/resume (a runtime path
   unverifiable headlessly at the time). Add an integration test that loads the extension
   through a minimal fake `ExtensionAPI` (capture `on` handlers by event, capture the tool
   def — extend the `createPiStub` pattern in `tests/subagent-async-kill.test.ts`), then drives
   `session_start` / `session_compact` / `before_agent_start` and asserts the message is
   emitted, one-shot-cleared, and suppressed on empty/all-done.
2. **Pre-existing `tsc` nit, now in scope.** `TodoListComponent` is missing the `invalidate`
   method the custom-component interface requires (`render` + `invalidate` + optional
   `dispose`, per `extensions/footer-session-id.ts:1403`; `footer-session-id.ts:1161` is the
   no-op convention to copy). pi loads extensions at runtime with no typecheck, so there is no
   automated gate and no `tsconfig`/`tsc` in the repo — the fix is by-convention; verification
   is that the smoke test still passes.
