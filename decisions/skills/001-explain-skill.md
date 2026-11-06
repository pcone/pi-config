---
title: "Explain skill — literal explanation with prerequisites supplied"
type: decision
status: active
date: 2026-11-06
---

# Explain skill — literal explanation with prerequisites supplied

**Ruling.** `skills/explain` answers "ELI5" and "explain simply" requests for a
capable adult new to the topic. It maps the prerequisites, supplies them in
dependency order and explains in literal terms. An analogy is allowed only
after the literal text, with its mapping and breakdown stated. The owner: "often
involves some kinda tortured analogies and metaphors when really all I want is
a clear explanation of a concept with all needed context brought in" (owner,
2026-11-06).

**Why.** Analogies carry the source domain's wrong predictions into the target
unless the breakdown is stated (Evans; Glynn's Teaching-With-Analogies
model). LLMs reach for stock analogies that drop caveats, and Claude's system
prompt invites "examples, thought experiments, or metaphors"
(<https://simonwillison.net/2025/May/25/claude-4-system-prompt/>), so the skill
states the rule explicitly. The curse of knowledge does
not yield to effort (Pinker, ch. 3), so the skill gives a procedure: list
terms, recurse into the ones the reader lacks (Willison's repeated "explain
the jargon you just used" prompt), and order them. Recursion stops at a term
whose inner workings the main point does not need: it gets a one-line contract.
Unbounded recursion produced pedantic, overlong answers in review.

**Alternatives rejected.**

- *Analogy-led ELI5 or tutor skills* (e.g. JEFF7712/claude-tutor). They
  produce the output the owner reported as the problem.
- *Socratic quiz loop* (alexknowshtml/claude-skills `teach`). It checks
  understanding over many turns; the request is a one-shot explanation.
- *A blanket analogy ban.* A mapped analogy with its breakdown stated helps
  with structure the literal text cannot show.

**Portability.** Frontmatter holds only `name` and `description`, the
agentskills.io fields both pi and Claude Code read. Neither harness needs
`$ARGUMENTS`: each appends the invocation text to the skill body. The skill
lives in this repo and is symlinked into `~/.claude/skills/`, as `refactor` is.
