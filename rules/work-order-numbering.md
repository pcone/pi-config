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
   brings it over, so two sessions can allocate the same id 103 seconds apart
   with both reservations already pushed. `git ls-tree --name-only
   origin/<other-line> work-orders/` is part of allocating, not an optional
   precaution.
   **The gate enforces it — in pi-config.** `bin/pre-push` refuses a push that
   adds a work-order file whose id a live ref of an unrelated line already
   holds, and names the holding ref. It is installed here as
   `.git/hooks/pre-push` (WO-2026-103, owner ruling 2026-11-18 on pi-config#20
   option A).

   The same hook refuses a push that carries the mainline ref without pushing
   `HEAD`, a push that carries a non-`HEAD` mainline commit, and a landing that
   pushes nothing at all from a detached `HEAD` — the last is how
   WO-2026-102's first push left two commits stranded (`Q-103-a`).

   **The mainline is per repo**, read from `git config pi.mainline`; unset is a
   hard error, not a default. Set it once per clone:
   `git config --local pi.mainline main` (pi-config) or `hamster` (tfd).

   **tfd runs the same file.** Its `.githooks/pre-push` pipes the push into
   this one before its own early exits, so a side-branch push carrying no
   mainline ref is gated by the id rule while the docs validator keeps its R33
   skip (tfd WO-2026-525). Any clone without `pi.mainline` refuses every push.

   **Two refusal markers, and the difference is load-bearing.** `NOT LANDED:`
   means the gate ran and refuses this push as a landing. `pre-push: …` followed
   by `Push aborted; nothing was checked.` means the gate could not run at all —
   `pi.mainline` unset, a git call failed, a ref unreadable. Matching on
   `NOT LANDED` alone scores a broken gate as a clean pass.

   The holding ref is named as `%S` shows it: `rival`, `origin/rival`, never
   `refs/heads/rival`. A log scraper that needs the qualified name has to
   qualify it.

   **What it cannot see, so the fetch is still part of allocating:** a ref this
   clone has not fetched, and a claim in another session's detached HEAD or
   unpushed branch. Rule (B) is a backstop, not the allocation.
3. **Collisions with landed history: the claim with landed references
   keeps the id.** Reserve-by-push can't see un-rebased parallel lineages
   — a fifth board's WOs are invisible until their lineage lands (observed:
   `WO-2026-081` landed on a side line concurrent with a mainline 081; the
   side line's landed claim kept the id and the mainline's in-flight claim
   renumbered to 089). Resolution:
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
5. The id exists on the shared remote
   before any work order reference escapes your session (dispatch task text,
   roadmap rows, decision links).

Alternatives already rejected, so they are not re-proposed: a central counter
file adds a second source of truth that git already provides; per-session
number bands break chronological reading; session-prefixed ids break every
existing reference format.

Same pattern for any shared sequential namespace across sessions: decision
record numbers, feature-dir numbering.

Local-only work (spikes, docs edits, review rounds on an already-reserved WO)
needs no reservation — only the first dispatch of a new id does.
