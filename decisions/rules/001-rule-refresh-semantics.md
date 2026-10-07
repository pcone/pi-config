---
title: "Rule refresh — re-read at injection, re-discover on compact"
type: decision
status: active
date: 2026-10-07
---

# Rule refresh — re-read at injection, re-discover on compact

**Ruling.** A rule's body and `paths` are re-read from disk each time the rule
would be injected, and the discovered rule set is rebuilt on `session_compact`.
Discovery at `session_start` is a snapshot of *which* rules exist, not of what
they say.

**Why.** `docs/design/rules.md` pinned rule discovery to extension startup,
which is only sound if a rule file cannot change while a session runs. Sessions
here live for days: the tfd-d session (process up since 2 October) was served
the pre-edit body of `rules/work-order-numbering.md` after the file had been
fixed and committed. The injected text contained a sentence that exists only in
git history (`grep -c` on disk: 0). A rule fix that only reaches the next
process start is a dead fix for every session already running — the normal
case.

The pre-fix `session_compact` handler cleared the in-scope *set* and nothing
else, so re-injection rebuilt the prompt from the discovery-time `Rule`
objects: clearing the set reads like a refresh and is not one. The only state
that was ever refreshed was "which rules have been injected this segment".

**Alternatives rejected.**

- *Restart or compact is the refresh point* (the status quo): keeps a fix dead
  for every running session, which is what failed here.
- *Injection-time re-read only*: covers edits, but a rule file **added**
  mid-session stays invisible until a restart.
- *Compact re-discovery only*: no help to a session that never compacts, and
  the observed failure happened mid-segment, before any compact.
- *`/rules reload` command*: new user-facing surface for a step that should not
  be manual (mechanical over discipline, cf. decision 028).
- *`fs.watch` on the rule directories*: extra machinery and wakeups to replace
  a read that happens at most once per rule per segment.

**Consequences.** Every not-yet-injected candidate is re-read on each
`read`/`edit`/`write` for the rest of the segment — one sync read per candidate
per tool call, including candidates that will never match and ones no longer
loadable (their `dropped` warning fires once per segment). Rules already
injected this segment are not re-read (in-scope set unchanged). A rule whose
file is deleted, emptied, or unreadable mid-segment injects nothing and warns
once per segment — stale text is never injected. The manual paths re-read too:
`/rule <name>` serves the current body or refuses when the file no longer
loads, and `/rules` reports current line counts. Compact re-discovery is silent
(no startup-summary event, no UI notify; warnings to `console.warn`), so a
compact does not look like a startup.

**Supersedes** the "discovered at extension startup" wording in
`docs/design/rules.md`, updated there.

**Scope note (owner ruling, 2026-10-07).** Reloading *system-prompt* context
files (AGENTS.md / APPEND_SYSTEM.md) from disk on compaction is not critical —
manual `/reload` is the accepted mitigation, and this record does not extend to
core context files. Rule injection-time re-read is kept because it prevents
serving text that no longer exists on disk, not because staleness is
intolerable; compact re-discovery is kept as a cheap consistency step for the
rule set (newly added, renamed and deleted files), not as a substitute for
reloading core context.
