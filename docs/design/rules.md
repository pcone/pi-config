---
title: "Path-Scoped Rules"
type: design-plan
status: draft
date: 2026-07-10
feature: rules
---

# Path-Scoped Rules

A `rules` mechanism injects context into the agent's working set based on file path. Rules are markdown files with optional YAML frontmatter. Rules with a `paths` field only apply when the agent is working with files matching the glob; rules with `disable-model-invocation: true` never auto-trigger and only enter the conversation via `/rule:<name>`. See *Rule modes* below.

This is a complement to skills, not a replacement. Skills answer "do X when Y" and stay loaded by description; rules answer "when editing file of type Z, here is the convention / syntax / constraint" and only enter context when the matching file is touched.

## Goals

- Inject narrow, file-type-specific context (syntax cheatsheets, file-format conventions, project-specific best practices) without paying for it in every session.
- Keep the rule format portable across agent harnesses (Claude Code, pi, others) by mirroring its `.claude/rules/` model — markdown + `paths` frontmatter, glob patterns.
- Compose with existing skills: a path-scoped rule does not displace a relevant skill, both apply.
- Preserve prompt caching. The system prompt and earlier turns must stay byte-stable after a rule is injected; rule content joins the conversation at the trigger point and stays there for the rest of the session segment.

## Non-goals

- Not a replacement for skills. Multi-step procedures, scripts, setup instructions stay as skills.
- Not a permission or enforcement layer. Rules are context, not policy.
- Not a runtime hook. Rules don't trigger on tool use in general — only on file-path-bearing operations against `read`, `edit`, `write`.
- Not a versioned config format. The frontmatter is intentionally tiny.
- Not a global context reflow. Once a rule is injected it stays put; we never remove rule content from the conversation.

## Discovery

### Locations

- Global: `~/.pi/agent/rules/`
- Global (cross-harness): `~/.claude/rules/` — same parser, so a rule file is portable.
- Project: `.pi/rules/` and `.claude/rules/`, where `.pi/rules` may be a symlink to `.claude/rules` (mirroring the skill convention). When both exist, `.pi/rules/` takes precedence over `.claude/rules/` on name collision. Project-level rules beat user-level rules. Explicit `--rule` paths beat all discovery.
- CLI / settings: `--rule <path>` flag and `rules` array in settings.json, additive like `--skill`.
- Disable discovery with `--no-rules`; explicit `--rule` paths still load.

### File format

Each rule is a single `.md` file. Filename is the rule's identity (e.g. `tfd-syntax.md`, `cases-format.md`); a flat directory or shallow subdirectory grouping by concern (`frontend/`, `backend/`) is supported and discovered recursively.

```markdown
---
paths:
  - "**/*.tfd"
  - "tests/**/*.tfd"
---

# tfd Source Syntax

- Blocks use `{ }`, not `begin/end`. ...
- `T on heap` allocates in the caller's arena; auto-derefs on read. ...
- `let` bindings are immutable; use `var` for reassignment. ...
```

Rules with `paths` are path-triggered: they inject on the first `read`/`edit`/`write` of a matching file. Rules with `disable-model-invocation: true` never auto-trigger (see *Rule modes*). A rule with neither `paths` nor `disable-model-invocation: true` has no trigger — it is warned and skipped.

A rule file with only frontmatter and no body is empty — it is skipped with a warning. There is nothing to inject.

### Frontmatter schema

| Field | Required | Type | Purpose |
|---|---|---|---|
| `paths` | no | `string[]` | Glob patterns; rule applies only when an in-scope path matches. |
| `description` | no | `string` | One-line summary. Shown in `/rules` listing. Not used for matching. |
| `disable-model-invocation` | no | `boolean` | When true, the rule never auto-triggers by path match. Only `/rule:<name>` injects it. Marked as `[manual]` in `/rules`. |

If `description` is absent, the first line of the rule body (stripped of heading `#` markup) is used as the summary in `/rules`.

Unknown fields are ignored. The `paths` field uses `picomatch` glob syntax with case sensitivity following the host filesystem. Brace expansion (`*.{ts,tsx}`) is supported because `picomatch` provides it for free. Negation (`!`) patterns are stripped with a warning in v1 — see *Triggering* for the rationale. Backslashes are normalized to forward slashes at parse time; rules that use `\` in patterns are warned about and rewritten.

### `allow-large` escape hatch

Rules have a strict per-rule line cap (100 lines by default) to keep the working set from growing unboundedly. A rule can opt out by including the directive `<!-- allow-large -->` as the first non-empty line of the body, immediately after the closing `---` of the frontmatter:

```markdown
---
paths:
  - "**/*.tfd"
---
<!-- allow-large -->

# Comprehensive tfd Language Reference

(… a long, intentionally detailed reference …)
```

The directive is the first thing checked, so the rule body can be arbitrarily long without warning. Rules without the directive that exceed the cap are loaded with a warning, truncated at 100 lines, and the truncation is surfaced to the user via `/rules`. The on-disk file is never modified.

### Symlinks

Symlinked rule files and symlinked rule directories resolve and load normally. This lets a single shared rules tree (`~/shared-rules/`) be linked into multiple projects. Path matching operates on the **literal** path the tool was called with, not the resolved real path — see *Triggering* for the rationale.

## Rule modes

Every rule is in exactly one of two injection modes:

| Mode | `paths` field | `disable-model-invocation` | When it injects |
|---|---|---|---|
| Path-triggered | present | `false` (default) | On first `read`/`edit`/`write` of a matching path |
| Manual-only | any | `true` | Only via `/rule:<name>` command — never auto-triggers |

Manual-only rules are never triggered by path matching, even if they have a `paths`
field. The only way they enter the conversation is a user invoking `/rule:<name>` or
the agent reading the rule file directly.

The `/rules` listing marks manual-only rules (e.g. `[manual]`) so the user knows they
need to be explicitly requested.

## Triggering

### Decisions

1. **Which tool calls count as "referencing a path"**: `read`, `edit`, and `write` only. `grep`/`find`/`glob` are deliberately excluded — the use case is "when the agent is *acting on* a file," not "when the agent is *searching around* a file." `bash` output path extraction is not attempted; it's too noisy and the agent can `read` the file directly when the rule context matters.

2. **Glob library**: `picomatch`. Brace expansion supported, negation not, case sensitivity follows the host filesystem, paths normalized to forward slashes. Rules can be authored by extension alone (`**/*.tfd`) or by directory (`tests/**/*`); both are the common case.

3. **Symlink resolution**: literal path only. If a project lives at `/work/foo` via a symlink, the tool receives `/work/foo/bar.tfd` and rules with `**/*.tfd` match. The user is expected to launch pi from the path they intend to reason about, which is also the path rules are written against. Real-path matching is an unnecessary second axis.

4. **First-match-injects-and-stays**: a rule is injected the first time a matching path appears in a `read`/`edit`/`write`, and is recorded in the in-scope set for the rest of the session segment. When multiple rules match the same path, they are injected in alphabetical order by filename. Subsequent operations on matching paths do not re-inject. **On checkpoint and on compact, the in-scope set is cleared** — rules re-inject as paths are re-encountered in the new segment. This is the correct behavior because compaction replaces the conversation history with a summary, and the rule content (which lives in the conversation, not the system prompt) is gone with the history.

5. **Prompt slot for path-scoped rules**: not the system prompt. Rules are **appended to the tool-result message** that triggered the match, so the model sees the file content and the rule body in the same message. Once injected, the rule text becomes part of the conversation from that turn onward, and subsequent turns see it in their prompt prefix. This preserves prompt caching for the system prompt and earlier turns, which stay byte-stable. See *Injection point* below.

6. **Stale rules and missing files**: a rule whose `paths` patterns match no file in the working tree at session start is dormant. It does not inject until the agent touches or creates a matching file. This is the same as Claude Code and avoids paying for rules the user is not yet using.

7. **Limits**:
   - **Per-rule line cap**: 100 lines default, lifted by `<!-- allow-large -->`. No upper bound once the escape hatch is set.
   - **No pattern cap**: rules can have as many `paths` entries as the author wants. We trust the author; rules are project-local config, not a hostile input vector.
   - **No eviction**: once a rule is in the conversation, it stays. Eviction would invalidate the prompt cache for every subsequent turn and is forbidden. If the user wants to free context, they compact — which clears the in-scope set and lets the next round of file touches re-inject only the rules that are still relevant.

### Injection point

The injection is a per-message append at trigger time, not a system-prompt mutation. Concretely:

1. The agent calls `read` on `src/foo.tfd`.
2. Before returning, the runtime checks the in-scope set. `tfd-syntax` is not in scope; its `paths: ["**/*.tfd"]` matches `src/foo.tfd`. So the rule is triggered.
3. The rule body is appended to the tool-result message after the file content, in a clearly delimited block:

   ```
   [file content for src/foo.tfd]

   ---
   <rule name="tfd-syntax" paths="**/*.tfd, tests/**/*.tfd">
   [rule body]
   </rule>
   ```

4. The rule is added to the in-scope set.
5. The model sees file content + rule in the same response cycle, and both are in the conversation from this turn onward.

The wrapping in a `<rule>` tag is so subsequent turns can identify rule boundaries if they need to (e.g. for `/rules` listing or future tooling). The tag is invisible to the model's reasoning — it's just text.

This is the only viable injection point that preserves prompt caching for the system prompt. Putting the rule in the system prompt (a "growing block" model) would invalidate the cache every time a new rule is triggered. Putting it in a *new* message after the tool result would work but separates the rule from the file content, which is exactly the adjacency we want — the model should see the syntax cheatsheet *next to* the file it describes. The chosen design is the only one that satisfies both.

### Session lifecycle

- **Start**: in-scope set is empty. No rules have been injected yet.
- **Mid-session**: as the agent reads/edits/writes files, matching rules are appended to the relevant tool-result messages and added to the in-scope set.
- **Checkpoint**: snapshot the session. The in-scope set is **cleared** as part of the snapshot — it is session-segment state, not session state. Rules persist in the snapshot only as far as they appear in the conversation history; on resume, they re-inject on the next matching tool call.
- **Compact**: replace the conversation history with a summary. The in-scope set is cleared before compaction. Rules that were in the old history are gone with the history; they re-inject as paths are re-encountered in the post-compact segment.
- **End**: in-scope set is discarded with the session.

## Composition with skills

A path-scoped rule **stacks** with any skill that is also relevant. They are not alternatives. The two operate on different axes and different prompt slots:

- **Skills** are matched by description at session start. Their *descriptions* sit in the system prompt; their *full bodies* load on demand via `read` or `/skill:<name>`. They describe workflows and procedures: "when reviewing code, do X."
- **Rules** are matched by file path on first `read`/`edit`/`write`. Their *bodies* are appended to the triggering tool-result message and stay in the conversation. They describe file-type conventions: "when editing `.tfd` files, the binding syntax is Y."

The agent can have both a `.tfd` rule and the `review-code` skill in context at the same time. They don't compete: the rule is the file-type reference, the skill is the review workflow.

Because rules live in the conversation history (not the system prompt), they don't shift the system-prompt cache. They grow the conversation history in a forward-only direction, which is the same growth direction as the conversation itself, and the cache key for the conversation prefix stays stable from the trigger turn onward.

Rules never invoke tools themselves (no `allowed-tools` field — the spec doesn't include one). If a rule needs to point at a script, it should be a skill instead.

## Implementation approach

This feature is implemented as a single pi extension. The extension maps the
design's abstract operations to pi's event hooks:

| Design operation | pi hook |
|---|---|
| Rule discovery — scan directories, parse frontmatter | Async extension factory (runs on load) |
| Path-triggered injection | `tool_result` event — watch `read`/`edit`/`write`, check path against rule registry, append rule body to `event.content` |
| Manual-only injection | `/rule:<name>` command reads the rule body from the registry and injects it into the conversation |
| In-scope set | In-memory `Set<string>` of rule filenames that have fired this segment |
| Clear in-scope set on compact | `session_compact` event resets the in-scope set |
| `/rules` listing | `pi.registerCommand("rules")` — reads rule registry, formats output |
| `/rule:<name>` | `pi.registerCommand("rule")` — handler receives the name as `args`, reads from registry |
| `--rule` / `--no-rules` flags | `pi.registerFlag()` — suppress or extend rule discovery |
| `settings.json` `rules` array | Extension reads from settings at startup |

### In-scope set lifecycle

- **Start**: empty. Rules are discovered at extension startup. No injection has happened.
- **Mid-session**: on first `read`/`edit`/`write` of a matching path, the rule is added to the in-scope set and its body is appended to the tool result.
- **Compact**: the in-scope set is cleared. Rules that were injected before the compact are gone from the history (replaced by the summary). A subsequent file touch re-injects them.
- **Session resume**: the in-scope set is not persisted. On resume it is empty. The old rule text is in the loaded history; a subsequent file touch re-injects the rule body, producing temporary duplication. This is acceptable for v1 and can be optimized later by scanning history for `<rule>` tags to rebuild the in-scope set.
- **End**: in-scope set is discarded with the session.

### Parallel tool execution safety

JavaScript is single-threaded, so `tool_result` events are serialized by the event
loop. The in-scope `Set` is accessed synchronously — no race condition exists.

## Listing and management

- `/rules` command lists all rules (name, paths, description, line count, in-scope indicator for the current session segment). Manual-only rules are marked `[manual]`.
- `/rule:<name>` reads the rule body, like `/skill:<name>`. Useful for forcing a read in segments where the matching path hasn't been touched yet, or for reviewing what a rule actually says.
- `--no-rules` flag disables discovery, matching `--no-skills`.

## Configuration

`settings.json` gains a `rules` array (paths to additional rule files or directories), analogous to the `skills` array. No `enableRuleCommands` toggle — always on, since rules are pure context.

## Rejected alternatives

- **Per-tool-call re-injection**: re-evaluating the rule set on every tool call is wasted work; rules don't change in-session. First-match-injects-and-stays gives the same behavior for less cost.
- **Putting path-scoped rules in a system-prompt block that grows over time**: invalidates the prompt cache every time a new rule is triggered. The per-message append is the only way to keep the system prompt byte-stable.
- **A single global `~/.pi/rules.md` file with glob sections inside**: the per-file model is easier to maintain, share via symlinks, and reason about. One file per rule.
- **Adopting the full Claude Code rules spec verbatim (`.claude/rules/` only)**: not portable to other harnesses. The pi-native path (`.pi/rules/`) is the primary, with `.claude/rules/` as a recognized alias.
- **Reusing the skill system with a new frontmatter field**: the trigger model is different (path glob vs description), the prompt slot is different (tool-result append vs system-prompt description), and the file shape is different (single file vs directory + `SKILL.md`). Forcing them together would compromise both.
- **Eviction of old rules to free context**: would invalidate the prompt cache for every subsequent turn. Compact is the correct mechanism for context reduction, and it re-injects only the rules that are still relevant on next touch.
- **Matching tool output for path references (e.g. `bash` printing a file path)**: too noisy, too easy to false-positive. The trigger is the agent's deliberate intent to act on a file, which `read`/`edit`/`write` represent cleanly.

## Status

- [x] Goals and non-goals
- [x] Discovery and file format
- [x] Frontmatter schema
- [x] Rule modes (path-triggered + manual-only; unconditional removed)
- [x] Triggering semantics — all 7 decisions locked
- [x] Injection point (per-message append at trigger)
- [x] Composition with skills (stacking, no prompt-prompt displacement)
- [x] `allow-large` escape hatch
- [x] `.pi/rules` vs `.claude/rules` precedence (`.pi/rules` wins at same level)
- [x] Negation — stripped with warning in v1
- [x] Multiple-rule injection order — alphabetical by filename
- [x] `description` fallback — first body line
- [x] Implementation approach mapped to pi extension hooks
- [ ] `/rules` and `/rule:<name>` commands
- [ ] `settings.json` `rules` array
