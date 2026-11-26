---
title: "One install script for a pi-config checkout, on macOS and Debian"
type: decision
status: done
date: 2026-11-26
---

# One install script for a pi-config checkout, on macOS and Debian

**What:** `bin/setup` (formerly `tests/setup.sh`) is the one script that makes a checkout runnable,
and it is platform-neutral (owner-approved work, relayed 2026-11-26 by the session setting up
tfd-box, Debian 13). Four gaps found on that box, and what each became:

- **Themes.** `extensions/subagent-async/watch-session-v2.ts` hard-coded
  `/Users/scott/Developer/pi-config/themes` as a second theme search dir. Removed: `~/.pi/agent/themes`
  is a link into this repo, so the first entry already reaches the same dir, and a repo path with a
  user's home in it only works on one machine.
- **`node_modules`.** The links into the globally installed pi were hand-made on the Mac, with no
  tracked file creating them, so on a fresh clone `bun extensions/peer-link/external.ts` failed with
  `Cannot find module @earendil-works/pi-coding-agent`. The script now resolves pi from
  `npm root -g` (not a Homebrew prefix) and links `@earendil-works/{pi-coding-agent,pi-agent-core,pi-ai,pi-tui}`
  plus `typebox` into the checkout's `node_modules`.
- **baba.** `extensions/baba` is a tracked symlink to the baba-pi repo, which needs the Apple ANE.
  Where that repo is absent, pi starts without the extension and says nothing. The install now states
  it: one line naming what is unavailable on Linux, and on any other platform a failed install, since
  there it is a broken setup rather than a platform limit. Three states, because `extensions/baba` can
  be a link, a real directory (cloned in place), or nothing: the line names the link target, names the
  path when it is in place, and names what is missing when the link dangles.
- **`/tmp`.** `APPEND_SYSTEM.md` § Scratch locations described macOS's `tmp_cleaner` only. It now
  says Debian's `/tmp` is tmpfs (RAM-backed, empty after a reboot) and that `$TMPDIR` does not exist
  there.

**Why:** Two of the four are the no-fallback rule applied to a state a hand-built box had already
reached: a resource behind a dead link is loaded or not by the loader's default, and a machine with
no baba repo is a machine where `semantic_search` quietly is not there. Both now have one stated
answer, produced by the install, instead of a default nobody chose.

**The `~/.pi/agent` list is twelve entries, not the README's seven.** The Mac's agent dir links
`agents`, `auto-checkpoint.json` (from `.pi/auto-checkpoint.json`), `keybindings.json`, `prompts` and
`trust.json` as well, all created by hand and none of them listed. `bin/setup`'s `AGENT_LINKS` is the
list; the README names it rather than copying it, because a copy is what went stale.

`.gitignore`'s `bin/*` rule gains `!bin/setup`, so the list keeps describing what is tracked in `bin/`.

**Alternatives rejected.**

- *A second install script beside `tests/setup.sh`*: the old script already did the pi links and the
  `extensions/` install, so a new one would duplicate both. It was renamed to `bin/setup` instead, and
  the test headers now name it.
- *`ln -sf` over whatever is in `~/.pi/agent`, as the README's manual commands did*: that replaces a
  real `settings.json` with a link and loses it. The script reports the path and stops.
- *Remove the old link, then check the new target*, the obvious order: a run that fails on a missing
  target then leaves the agent dir one link short, and pi quietly falls back to defaults. The target
  is checked first, so a failed install reports and leaves the links it found (review round 1, probe
  E1).
- *Refusing to link `trust.json` because two machines share one file*: pi writes trust decisions into
  it, so a linked copy means the box's `/home/...` entries land in this repo's working tree and the
  Mac's `/Users/...` entries conflict. Kept linked: "all `~/.pi/agent` config under version control" is
  an earlier standing choice (`06607a3`), and dropping one entry from it is an owner question, not an
  install detail. Recording the wrinkle here is what this file can do.
- *A runtime notice when baba is missing*: user-visible surface, so it needs an owner ask first. The
  install-time line plus this record covers the state until someone asks for the notice.

**Tradeoffs:** the install rewrites all links on every run, so a hand-repointed link is reset. That is
what idempotent means here, and the script's own comment says so.

The links belong to one checkout at a time: the last run wins, so installing from a worktree repoints
the machine's live config at that worktree, and removing the worktree leaves all twelve dangling. On
a one-checkout box that is the whole point; the README states the consequence for the Mac, and a
script that refused instead would be new behaviour, so it is not this change.
