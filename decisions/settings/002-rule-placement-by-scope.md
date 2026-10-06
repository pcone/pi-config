---
title: "Rule placement: repo-independent process rules live in APPEND_SYSTEM.md"
type: decision
status: done
date: 2026-10-06
---

# Rule placement: repo-independent process rules live in APPEND_SYSTEM.md

**What:** Instruction rules are placed by scope, not by where they were first written:

- `APPEND_SYSTEM.md` (global, injected into every session in every repo) — process rules that hold
  regardless of project: doc/comment discipline, decision records, testing norms, the behavioral
  constraints, landing work (green-before-handoff, refactors-behind-tests, structural audits), and
  subagent dispatch.
- `<repo>/AGENTS.md` — only what is specific to that project: its commands, paths, rules,
  terminology, design priorities, domain semantics.

Applied 2026-10-06 by relocating six rules out of tfd's `AGENTS.md`: decision logging,
green-before-handoff, refactors-land-behind-tests, the chunk-boundary structural audit
(decision 024), the brief-resolution/dispatch gate, and share-code (already duplicated in
`APPEND_SYSTEM.md`). TFD's `AGENTS.md` now carries a one-line boundary statement at the top.
Leaks the other way were genericized in place: the Rust-specific `assert!` phrasing and a
`.cases` path in the bug-triage handoff bullet.

**Why:** The two files have different blast radii — `AGENTS.md` binds one repo, `APPEND_SYSTEM.md`
binds every repo — so a process rule placed in `AGENTS.md` is either lost to every other repo or
silently duplicated there. Recent process work (024's audit convention, the refactor and brief
gates) landed in tfd's `AGENTS.md` because that is where the work was happening, not because it was
TFD-specific. The cost is not cosmetic: a rule in the wrong layer gets different answers depending
on which repo the session opened.

**Alternatives rejected.**
- *Per-repo copies of shared process rules*: divergence over time, and each new repo starts without
  them — the failure mode being fixed.
- *Move everything global, including TFD's design priorities*: the global prompt is paid for by
  every session in every repo; compiler priorities and language-design gates there are noise in a
  non-compiler repo.
- *Keep `AGENTS.md` as the de-facto shared layer*: only works if the rules are re-copied per repo,
  i.e. the first alternative.

**Tradeoffs:** A global rule costs tokens in every repo's sessions, so `APPEND_SYSTEM.md` stays
small and its rules must be phrased repo-agnostically — no project paths in rule text, and a
per-repo artifact (`docs/investigations/structure-trend.md`) is named as a convention the repo
adopts rather than as an existing file.

**Reopening triggers.** The global file grows past readability and its rules start being ignored →
split it by concern into multiple appended fragments. A repo needs materially different process
from the global rules → the rule was not repo-independent after all; move it back down with the
specialization. A global rule acquires a project-specific parenthetical → the boundary is leaking
again; fix the phrasing rather than adding an exception clause.
