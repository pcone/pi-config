---
paths:
  - "docs/**"
  - "decisions/**"
  - "docs/glossary.md"
---

# Documentation & Decision Records

## Keeping docs in sync

When completing a feature or optimization, update tracking as part of the commit:

- **Design docs** (`docs/design/*.md`): Mark items done in status tables.
- **Decision records** (`decisions/*/README.md` and individual `*.md` files):
  Set `status: done`. Update the decision index table.
- **Glossary** (`docs/glossary.md`): Add any new terms introduced by the feature.
- **Checklists**: Mark items done (e.g. in `docs/current-plan.md`).

## Writing docs

Lead with what we're going to do. Strip historical narrative — how the bug was found,
what was tried in conversation, why a section exists — unless it's a sensible-looking
path we rejected; keep those, with the reason. One idea per sentence. Active voice.
Drop hedging and filler. Don't compress past the point of meaning.
