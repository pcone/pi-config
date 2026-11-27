---
title: "The suite runs on the Debian box: five rows that were macOS-only"
type: decision
status: done
date: 2026-11-27
---

# The suite runs on the Debian box: five rows that were macOS-only

**What:** `bun test` on tfd-box (Debian 13, bun 1.4.5) at `99a7820` was 1584 pass / 10 fail, and none
of the ten was a test of the new machine's behaviour. Each was a place where a test or a module had
macOS baked in:

- **`resolveAnchor` kept a trailing separator.** `parentCwd: "/Users/scott/Developer/pi-config/"` never
  matched its own paths, because the comparison spells `parentCwd + "/"`. It passed on the Mac only
  because `realpathSync` normalizes the trailing slash when the path exists — and that path does not
  exist on a box which has never had it. The anchor is now stripped of trailing separators whether or
  not it resolves.
- **`followToJsEntry` read `$HOME` as a relative path.** The box's `~/bin/pi` wrapper is
  `exec $HOME/.local/bin/pi "$@"`; the helper built `/home/agent/bin/$HOME/.local/bin/pi` and the whole
  file died at import. It expands `$HOME`, `${HOME}` and a leading `~`, with the home passed in so a row
  proves the expansion without touching the real home.
- **The unused gate shelled out to `lsof`.** Debian does not install it, so every candidate failed
  closed with "lsof unavailable: not removing" and the reaper would never have removed anything on the
  box. `processCwdProbe` now picks the sweep the platform has: `lsof -d cwd -Fpn` on macOS, one
  `readlink` per pid over `/proc/<pid>/cwd` on Linux. Linux shows only this user's processes, so the
  count it could not read is a `problems` line in the report: a partial sweep is stated, not passed off
  as an empty one.
- **runpod's key reader was the Keychain and nothing else.** Six rows reached it through the extension,
  so they needed a Keychain holding two items. The reader is now a module seam the rows replace, and its
  two failure states are told apart: no `security` on PATH is the platform's limit, a failed read is a
  missing item with the command that adds it. The provider still cannot serve a request on Linux; where
  its keys live there is an owner question, not something this change guesses.
- **A row pinned bun's spawn default.** `childEnv` exists because bun 1.3.11 handed a spawn without
  `env` the startup snapshot; bun 1.4.5 hands it the live env, so the tripwire row reddened exactly as
  its own comment predicted. The row pins our contract instead — `childEnv()` carries the live env, with
  the override winning — which holds on either version and is what the code owes.

**Why:** a test that passes only on the machine it was written on tests that machine. Each of the five
either hid a real portability bug in the module (the anchor, the wrapper, the cwd sweep) or rested on a
platform the code is not entitled to assume (the Keychain, a bun build's default).

**Alternatives rejected.**

- *Install `lsof` on the box*: makes the suite green and leaves the reaper dependent on a tool Debian
  does not ship, so a fresh box would silently never reap again. `/proc` is the interface Linux offers.
- *Skip the Keychain rows when `security` is absent*: a skipped row says nothing about the six
  behaviours it covers, and those rows are about pod convergence, not credential storage.
- *Keep the bun row behind a version gate*: it would assert "bun 1.3.11 behaves like 1.3.11", from which
  no reader learns anything.

**Carried, not fixed here:** three places still reach the macOS Keychain directly — `registerProvider`'s
`apiKey` in runpod-bonsai (`:315`), `model-tiers`' OpenRouter read (`:131`), and the absence of a stated
Linux key source for either. `work-orders/WO-linux-provider-keys.md` carries them, with the key-source
choice marked as an owner question.

**Tradeoffs:** the cwd sweep sees only the invoking user's processes, on either platform: `lsof` without
root omits other users' processes too, so the Linux arm is not known to be weaker than the macOS one
(unmeasured — nobody has run `lsof` as a second user with a candidate tree as its cwd). What is known:
the Linux sweep reports how many processes it could not read, and a single-user box is the case this is
written for.
