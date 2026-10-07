---
title: "Orphaned tool results: repair by re-anchoring the declaration"
type: decision
status: active
date: 2026-10-08
---

# Orphaned tool results: repair by re-anchoring the declaration

**Ruling.** An orphaned `toolResult` (one the provider replay reaches without a
preceding assistant message declaring its `toolCallId`) is repaired in the
session file by re-anchoring a declaring assistant message immediately before
the result — reusing one if it exists, inserting a synthetic one if not. The
acceptance check is a **replay walk**, not an orphan count. A repaired file only
takes effect for a session that is restarted or resumed; a running process keeps
its in-memory context.

**Why it matters.** Every request replays the file, so one orphan 400s forever:
`Messages with role 'tool' must be a response to a preceding message with
'tool_calls'`. Nothing self-heals; each retry appends another error entry.

**Observed (2026-10-08, tfd session `01a0f603`).** 6,773 entries, exactly one
orphan: the assistant message declaring a still-running `subagent_stop` call was
never persisted, and the late result was chained to the compaction entry
(`069c344d`) that the checkpoint tool wrote two minutes earlier. The replay view
(`summary + entries after firstKeptEntryId 483a12cb`) contains the result and not
the declaration, so the request after the next reload 400s. Same signature in
`tfd-triage` (`01a0f605`).

**Cause, and why the fix was not at fault.** The damaging compaction ran under
`checkpoint.ts` as loaded at process start — pid 82348 started Oct 1, the fix
(compaction deferred to `turn_end`) landed Oct 7 04:46:50Z. The pre-fix code
called `ctx.compact()` from inside the tool's `execute()` and had no `turn_end`
hook, which is exactly the mid-batch compaction that drops a sibling's
declaration. The session was never reloaded, so the fix never ran; and even
reloaded, a prevention fix cannot repair history.

**Alternatives rejected.**

- *Delete the orphan result.* Loses real tool output the later transcript refers
  to, and rewrites model-visible history rather than completing it.
- *Restore from the checkpoint archive.* Its archive predates the whole
  post-checkpoint span; the repair loses 17 minutes of turns, this loses two
  entries and nothing else.
- *Reload and retry.* Deterministic failure: the replay is rebuilt from the same
  corrupted file.
- *Wait for upstream tolerance.* Filed as an ask, not available.

**Acceptance check (why not a count).** An orphan *count* passes when a
declaration exists anywhere in the file — including off the replayed path. The
first repair attempt inserted the declaration but aliased the result, leaving it
parented to the compaction entry; the count said 0, the provider walk said 1.
The walk is the check: replay the leaf path from the last compaction's
`firstKeptEntryId` and require every `toolResult` to follow its declaring
assistant message.

**Durability.** pi appends per entry (`appendFileSync`, no held descriptor), so
an atomic temp-file + `rename` repair is safe against a live process and does
not disturb subsequent appends. Verified across a live 400-looping session.

**Upstream ask (open, unfiled).** pi should tolerate or self-repair an orphaned
tool result on replay, or fail with a named error — not 400-loop indefinitely.
Filing needs a pi issue channel; none is reachable from this repo.
