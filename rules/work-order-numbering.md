---
paths:
  - "**/work-orders/**"
description: Reserve-then-dispatch for sequential work-order ids in multi-session repos — the push is the collision detector
---

# Work-order numbering: reserve-then-dispatch

Sequential work-order ids (`WO-<year>-<NNN>`) in a repo driven by multiple
concurrent sessions collide when a session allocates from a stale clone: it
reads the highest local number, another session lands the same number on the
shared remote, and both dispatch.

Git push atomicity already detects the race. The protocol makes dispatch wait
on it:

1. **Slug-only until dispatch.** Spec drafts use descriptive slugs
   (`WO-embed-ir-wiring.md`), no number. Numbering happens at dispatch, not
   at drafting.
2. **Reserve-then-dispatch.** Before spawning the implementer: commit the WO
   file (renumbered to the next free id, read after a fresh
   `git fetch <shared>`) and `git push <shared> <branch>`.
   **Read the id from every live ref, not just the one you're on:** a
   divergent line's `work-orders/` is invisible to your fetch until a merge
   brings it over, which is how two sessions allocated `WO-2026-160` 103
   seconds apart (2026-10-07) with both reservations already pushed — tfd-d's
   at 22:20:10, the integration clone's at 22:21:53, because the integration
   line had not merged tfd-d since 156. `git ls-tree --name-only
   origin/<other-line> work-orders/` is part of allocating, not an optional
   precaution.
3. **Collisions with landed history: the claim with landed references
   keeps the id.** Reserve-by-push can't see un-rebased parallel lineages
   — a fifth board's WOs are invisible until their lineage lands (real case
   2026-08-30: tfd-d's `WO-2026-081` landed on `loop-ergonomics` concurrent
   with a mainline 081; the mainline claim renumbered to 089). Resolution:
   claims that exist only in an un-rebased lineage don't count until they
   land — a mainline push beats them. But a number that HAS landed anywhere
   is historical record and keeps the id regardless of which side landed
   first: renumbering it cascades through its decision refs and chained WOs
   (082-088 in the same case), rewriting history. The losing claim renumbers
   itself and fixes only its own live references (dispatch text, roadmap
   rows) — before its implementer lands anything. **If the loser is already
   dispatched when the collision surfaces** (the window is narrow but never
   zero: you dispatch by pushing, and the other session may allocate in
   between), the fix is mechanical: rename the file to the new id, steer the
   in-flight implementer with the new path, and write the record fixes
   (ledger, roadmap rows, dispatch text) into its gate commit rather than as
   a separate one — so the id and its references move together.
4. **Non-fast-forward rejection is the collision alarm.** On rejection:
   pull-merge; if the merge brought a WO holding your id, renumber to the new
   next-free id, rewrite the id inside the file (and any references), re-push.
   Repeat until the push lands.
5. **Dispatch only after the push lands.** The id exists on the shared remote
   before any work order reference escapes your session (dispatch task text,
   roadmap rows, decision links).

The push is the atomic test-and-set against other mainline sessions, but the
namespace resolves only at push, so lineage-invisible claims are handled by
clause 3 (landed history wins), not by the push.

Same pattern for any shared sequential namespace across sessions: decision
record numbers, feature-dir numbering. Reserve by push, renumber on rejection.

Local-only work (spikes, docs edits, review rounds on an already-reserved WO)
needs no reservation — only the first dispatch of a new id does.
