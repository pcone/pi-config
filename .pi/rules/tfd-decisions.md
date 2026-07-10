---
paths:
  - "decisions/**"
---

# Decision Records

## Directory structure

```
decisions/
  <feature>/
    README.md        # decision-index: overview table of all decisions for this feature
    001-slug.md      # decision: first decision
    002-slug.md      # decision: second decision
    ...
```

`<feature>` is a short slug for the area or component the decision affects.

## Frontmatter

### `decision-index` (README.md)

```yaml
---
title: "Human-readable feature name"
type: decision-index
status: active        # active | superseded
date: 2026-04-11      # creation date
---
```

### `decision` entry

```yaml
---
title: "Short decision title"
type: decision
status: done          # draft | planned | in-progress | done | superseded | deferred
date: 2026-04-11      # creation date — set once, never updated
---
```

## Decision entry body

```markdown
# Short decision title

**What:** One sentence describing the change.

**Why:** The reason this approach was chosen over alternatives.

**Alternatives considered:** (optional) What else was tried or rejected.

**Tradeoffs:** (optional) Known downsides or caveats.

**Files changed:** What files were affected and how.

**Test coverage:** Relevant test names.
```

## Workflow

### Starting a new feature

1. Create `decisions/<feature>/README.md` with `type: decision-index`, `status: active`
2. Add a row in the index table for each decision as you make them

### Recording a decision

1. Create `decisions/<feature>/NNN-slug.md` (sequential numbers, zero-padded to 3 digits)
2. Fill in frontmatter and the decision body
3. Add a row to the feature's `README.md` index table

### Completing a feature

Set `status: done` on all decision files. The `README.md` stays `status: active` — it's a living index.
