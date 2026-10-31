---
title: "Writing guidance draws on Gopen & Swan, Diátaxis and tested examples"
type: decision
status: done
date: 2026-10-31
---

# Writing guidance draws on Gopen & Swan, Diátaxis and tested examples

**What:** `APPEND_SYSTEM.md` § Documentation gains three rules (owner request 2026-10-31):

- **Order for the reader:** known information opens a sentence, the new point ends it, the verb
  follows its subject (Gopen & Swan 1990).
- **Shape each page for one job:** tutorial, how-to, reference or explanation (Diátaxis); mark
  normative statements apart from explanation (the Rust Reference's practice, and its open issue
  rust-lang/reference#2044 on doing it inconsistently).
- **Examples are tested** (Go's `Output:` examples, rustdoc doctests).

**Why:** The existing rules came mostly from Google's developer style guide and the plain-language
tradition, and are almost all about cutting words. A survey of other respected sources (Microsoft
and Apple style guides, CPython's "Documenting Python", the Rust API Guidelines and Reference, Go
Doc Comments, Diátaxis, Gopen & Swan) found three ideas none of the rules covered: the order of
information within a sentence, the kind of page being written, and keeping examples correct.

**Alternatives rejected.**
- *Adopt the Microsoft or Apple guide wholesale*: their rules overlap Google's; what they add is
  word-level rulings, which cost global-prompt tokens for little gain.
- *Put the rules in a path-triggered rule file*: they apply to every doc, comment and commit
  message, so they belong with the other global writing rules (settings/002).

**Tradeoffs:** About 150 more words in a prompt every session pays for.
