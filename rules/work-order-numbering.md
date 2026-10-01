---
paths:
  - "**/work-orders/**"
description: Reserve-then-dispatch for sequential work-order ids in multi-session repos — the push is the collision detector
---

# Work-order numbering: reserve-then-dispatch

Sequential work-order ids (`WO-<year>-<NNN>`) in a repo driven by multiple
concurrent sessions collide when a session allocates from a stale clone: it
reads the highest local number, another session lands the same number on the
shared remote, and both dispatch. (Real case, tfd 2026-08-29: two sessions
claimed `WO-2026-079` within hours; a peer caught it in flight by vigilance —
there was no mechanism.)

Git push atomicity already detects the race. The protocol makes dispatch wait
on it:

1. **Slug-only until dispatch.** Spec drafts use descriptive slugs
   (`WO-embed-ir-wiring.md`), no number. Numbering happens at dispatch, not
   at drafting.
2. **Reserve-then-dispatch.** Before spawning the implementer: commit the WO
   file (renumbered to the next free id, read after a fresh
   `git fetch <shared>`) and `git push <shared> <branch>`.
3. **Non-fast-forward rejection is the collision alarm.** On rejection:
   pull-merge; if the merge brought a WO holding your id, renumber to the new
   next-free id, rewrite the id inside the file (and any references), re-push.
   Repeat until the push lands.
4. **Dispatch only after the push lands.** The id exists on the shared remote
   before any work order reference escapes your session (dispatch task text,
   roadmap rows, decision links).

Why not alternatives: a central counter file adds a second source of truth git
already provides; per-session number bands break chronological reading;
session-prefixed ids break every existing reference format. The push IS the
atomic test-and-set — the protocol just refuses to proceed without it.

Same pattern for any shared sequential namespace across sessions: decision
record numbers, feature-dir numbering. Reserve by push, renumber on rejection.

Local-only work (spikes, docs edits, review rounds on an already-reserved WO)
needs no reservation — only the first dispatch of a new id does.
