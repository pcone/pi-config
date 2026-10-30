---
title: "Pre-compaction session history moves to an archive file"
type: decision
status: active
date: 2026-10-30
---

# Pre-compaction session history moves to an archive file

**Ruling.** `extensions/session-trim.ts` rewrites a session file down to its
header, the retained tail of the latest compaction and everything after it. The
prefix moves to `<session>.history<N>` beside the session. It runs on `/trim`, and
automatically after a compaction once the file passes 8 MB.

The cut comes from `sessionManager.buildContextEntries()`, so pi's compaction rule
stays the single definition of dead history rather than being re-derived. Model,
thinking level and session name are carried across the cut: they live outside the
kept region and would otherwise silently reset.

**Why.** A pi process costs ~180 MB before it reads a session, then ~3× the
session's JSONL bytes, because `SessionManager.fileEntries` keeps every parsed
entry for the process's life and the file is append-only. Compaction shrinks what
the model sees and nothing else, so a session that has compacted 199 times still
carries all 199 prefixes. Measured in `docs/investigations/pi-memory-2026-10.md`.

On a copy of the live 61 MB `tfd-d` session: 24 330 of 24 648 entries moved out,
61.01 MB → 0.42 MB on disk, `buildSessionContext()` byte-identical (same 288
messages, same `max` thinking level, same model), load peak RSS 210 MB → 121 MB. On
the 127 MB `tfd` session: 127.3 MB → 0.7 MB, context hash unchanged.

**What is given up, and its guard.** The prefix stays readable on disk but is out of
reach inside pi: `/tree` rewind, fork-from-point and `--export` can no longer see
it. `session_before_tree` cancels a rewind whose target was trimmed and names the
archive file, so the loss is stated rather than silent. The ordinary transcript is
unaffected — it already renders from `buildContextEntries()`, so pre-compaction
history was never displayed there.

**Safety rules, both structural.**

- The rewrite is fully synchronous, and pi persists with `appendFileSync`, so it
  cannot interleave with this process's own append.
- Only the session's own process may trim it. Session files are unlocked (pi locks
  auth, settings and trust only), so a second live pi holding the untrimmed session
  would append entries referencing archived ids and lose its retained tail on its
  next compaction. No bulk sweep over other sessions ships for that reason.

**Alternatives rejected.**

- *Keep skeleton entries and strip their payloads.* A rewind onto a skeleton
  restores neither content nor a summary: `buildContextEntries` applies only a
  compaction that is an ancestor of the target, and `ctx.sessionManager` is
  read-only, so payloads cannot be rehydrated on navigation. It buys a tree that
  renders and cannot be used, for more code.
- *Delete the prefix instead of archiving it.* The file is the only record of the
  work; an archive beside it is recoverable by hand.
- *V8 heap tuning as a session-cost fix.* `--max-semi-space-size=2` cuts startup
  RSS ~25% but makes no measurable difference on a large session charge. Kept only
  for the startup saving, in the `pi` wrapper.
- *Trim on every compaction regardless of size.* Below 8 MB the rewrite churns the
  file for a saving inside the parse noise.
