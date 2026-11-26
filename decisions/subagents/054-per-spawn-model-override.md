# 054 — Per-spawn model override, gated by a per-seat allowlist

**Date:** 2026-11-25
**Status:** accepted — owner ruling (owner, 2026-11-25)

## Ruling (owner, 2026-11-25)

> "it shouldn't be one of our default seats, but we should make it available as a user selectable model, as well as an option for implementer sessions via a model override (default implementer seat shouldn't change)"

"It" is the self-hosted model `runpod/bonsai25-27b-v1`, registered by `extensions/runpod-bonsai/` (decision `providers/001`).

Recorder's reading: the model is not a default seat. It is an option in two places: as a user-selectable model, and as a per-spawn override for implementer spawns. The `implement` seat's own model does not change.

## What

- Agent frontmatter `allowedModels: provider/id, provider/id` lists the bare ids a spawn may request. An entry with a `:level` suffix is dropped with a warning.
- The `subagent` tool takes `model` (`provider/id[:level]`). The request is accepted only when the agent's `allowedModels` lists the bare id.
- An accepted request runs on the requested spec when it has a `:level`. Otherwise it runs on the bare id at the seat's own level.
- A refused request is a tool error (`isError`), with no spawn. It is refused when the id is unlisted, when `inheritParentModel` is also set, and on any seat without an allowlist, the orchestrator included.
- Resume keeps the recorded model and never reads `model`.
- `implement` lists `runpod/bonsai25-27b-v1`. Its `model:` is unchanged.

## Why

- A per-seat allowlist keeps review and implementer seats on audited models. Decisions 020, 022 and 031 pin each seat's model.
- The allowlist is per agent, so the override reaches only the seats the owner named.

## Alternatives rejected

- **A free-form per-spawn `model` with no allowlist.** Any spawn could move a review seat off its audited model, which decisions 020, 022 and 031 keep pinned.
- **Make the model a default seat.** The owner ruled against it (2026-11-25).

## Tradeoffs accepted

- The orchestrator cannot take an override. It has no allowlist, and its model tracks its caller (decision 031).
- `allowedModels` entries are matched as written. The loader does not check that an entry is provider-qualified.
