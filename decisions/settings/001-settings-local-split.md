---
title: "Split settings.json into tracked and local-only parts"
type: decision
status: deferred
date: 2026-07-15
---

# Split settings.json into tracked and local-only parts

**What:** Split `settings.json` into two files following the Claude Code `settings.local.json` convention:

- `settings.json` (tracked) — project-meaningful fields: `theme`, `extensions`, `defaultThinkingLevel`, `hideThinkingBlock`, `shellCommandPrefix`.
- `settings.local.json` (gitignored) — volatile/preference fields: `defaultProvider`, `defaultModel`, `lastChangelogVersion`.

**Why:** `defaultProvider` and `defaultModel` change every time we switch models during evaluation. Currently we just don't commit those changes — but the working tree stays dirty, the change is easy to commit accidentally, and `git diff` always shows the same provider/model churn when switching.

Splitting via `.gitignore` removes that manual bookkeeping. Project-meaningful fields stay in version control; volatile fields live in a file that git never sees.

**Alternatives considered:**

- **Keep current behavior (don't commit provider/model):** Simple but leaves the working tree dirty after every switch. Easy to commit by accident. Each switch requires manually leaving the file unstaged.
- **Gitignore `settings.json` entirely:** Loses the project-meaningful fields (especially the `extensions` list). Not acceptable.
- **Per-field gitignore:** Not possible — gitignore works on file patterns, not JSON fields.
- **Settings.local.json split (this decision):** Matches an established convention. Clean separation of tracked vs local.

**Tradeoffs:**

- Pi's settings loader reads `settings.json` only. Until/unless pi natively supports `settings.local.json` (or an equivalent), one of the following must be true:
  - A bootstrap step copies/merges `settings.local.json` into `settings.json` before each session (manual or scripted).
  - A pre-session hook or extension reads `settings.local.json` and overrides fields.
  - The user maintains `settings.local.json` manually and a build/dev step merges it into the real `settings.json` (the `settings.json` would then need to be gitignored too, which loses the tracked parts — bad).
- One new file to maintain. Small cost.
- The Claude Code convention is widely understood; future contributors likely recognize the pattern.

**Implementation notes:**

- Investigate whether pi has any built-in support for local overrides (search docs, `~/.pi/agent/`, settings loading code). If yes, the implementation is just a file split + `.gitignore` line. If no, design the bootstrap step.
- `.gitignore` add: `settings.local.json`.
- Move fields from `settings.json` → `settings.local.json`: `defaultProvider`, `defaultModel`, `lastChangelogVersion`. Keep in tracked: `theme`, `extensions`, `defaultThinkingLevel`, `hideThinkingBlock`, `shellCommandPrefix`.
- If pi doesn't natively load local overrides, options:
  - **Build-step approach**: npm script `predev` that JSON-merges `settings.local.json` over `settings.json`. Simple, but `settings.json` would need to remain the actual loaded file.
  - **Extension approach**: an extension on `session_start` reads `settings.local.json` and applies overrides via... well, `pi` doesn't expose a "set provider" API. Would need a different mechanism.
  - **Wrapper approach**: a thin `pi` wrapper script (shell) does the merge before invoking the real binary. Cleanest separation but adds an entry point.
- The chosen bootstrap approach should be documented in the file itself (likely in a comment header on `settings.json`) so future contributors understand the contract.
- This decision can be revisited if pi adds native local-override support.

**Why deferred:** The current "leave it unstaged" approach works. Worth doing when the unstaged-churn becomes annoying (probably after the second or third model switch), not now.