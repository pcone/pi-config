---
name: decision-log
description: Workflow for logging implementation decisions during non-trivial tasks. When to log, what to log, and templates. Schema and conventions are in the docs skill.
---

# Decision Log

Record significant decisions during implementation so future developers understand *why* things are the way they are.

## When to Use

Before and during any non-trivial implementation task. Log decisions that required reasoning — not mechanical changes.

## Workflow

1. **Before implementing**, create `decisions/<feature>/` if it doesn't exist
2. Create the `README.md` index (see template below)
3. As decisions are made, add numbered entries: `001-short-name.md`, `002-short-name.md`, ...
4. Update the README table after each entry
5. Use the `docs` skill for frontmatter schema, type taxonomy, and status values

## README Template

```markdown
---
title: "<Feature Name>"
type: decision-index
status: active
date: YYYY-MM-DD
feature: <feature-slug>
---

# <Feature Name>

One-line description of what this feature is about.

## Decisions

| File | Summary | Status |
|------|---------|--------|
```

## Decision Entry Template

```markdown
---
title: "Short descriptive title"
type: decision
status: done
date: YYYY-MM-DD
feature: <feature-slug>
---

# Short descriptive title

**What:** One sentence describing the decision.

**Why:** Why this approach was chosen.

**Alternatives considered:**

- **Alternative A**: Description. Why rejected.
- **Alternative B**: Description. Why rejected.

**Tradeoffs:** What costs this decision incurs.
```

Update the README table:

```markdown
| [NNN-short-name.md](./NNN-short-name.md) — Summary | ✅ done |
```

## What to Log

- Design choices with meaningful tradeoffs
- Approaches rejected and why
- Architectural decisions
- Pivots from the original plan
- Performance tradeoffs accepted
- New primitives or abstractions introduced

## What NOT to Log

- Obvious mechanical changes
- Trivial refactors
- Bug fixes with clear root causes
- Changes where there was only one reasonable option
