---
title: "When the remote moves during a pre-push run, re-check only what the new commits can affect"
type: decision
status: done
date: 2026-11-23
---

# When the remote moves during a pre-push run, re-check only what the new commits can affect

**What:** When the remote moves during the suite run, the landing is rebuilt on the new tip. If no
new remote commit touches a file the landing touches, only the project's docs validator and the
tests covering the landing's files re-run. Otherwise the full suite re-runs. Stated in
`APPEND_SYSTEM.md` § Testing.

**Ruling:** owner, 2026-11-23. The owner's words were not captured. This record was written on
2026-11-27 from commit `4bc8094` ("Owner 2026-11-23."), after the owner agreed that rulings held
only by `APPEND_SYSTEM.md` and a commit message get records ("sure").

**Why:** each new remote commit was pushed green by its own seat, so a disjoint landing has
nothing new to prove against it.

**Related:** tfd R98 (same day) makes the rebuilt landing a rebase or a detached `--no-ff` merge,
never a merge of the remote into the landing.
