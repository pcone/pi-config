---
title: "The orchestrator seat always runs on its caller's model"
type: decision
status: active
date: 2026-10-08
---

# The orchestrator seat always runs on its caller's model

**Ruling.** A child spawned as the `orchestrator` agent runs on the caller's
model — the caller's `provider/id` plus the orchestrator seat's own level suffix
(`agents/orchestrator.md` pins `:max`). Every other seat keeps the existing rule:
the agent frontmatter model, `inheritParentModel` as the explicit per-spawn
opt-in. Resume reproduces the recorded `meta.model` verbatim.

**Why.** Model resolution was uniform for every agent
(`extensions/subagent-async/index.ts`: `inheritParentModel ? parentModel :
agent.model ?? FLEET_MODEL`), and nothing branched on depth, so an orchestrator
child always took its own pinned seat model and never tracked the session that
dispatched it. That is wrong for the one seat whose job is to conduct the
caller's work: when a top-level session runs on a different model (Opus, MiMo),
its orchestrator children reasoned on the fleet flash seat instead. The fix is
scoped to that seat because it is scoped to that problem — the effort audit in
022 is per seat, and every other seat's model is a deliberate choice, not a
consequence of who called it.

**Why the level comes from the seat, not the caller.** pi keeps the level out of
the model id: a session records `model_change {provider, modelId}` plus a
separate `thinking_level_change {thinkingLevel}`, and the caller's spec here is
derived as `provider/id` with no level. `ctx.thinkingLevel` is documented
(`docs/extensions.md`, § ctx.modelRegistry / ctx.model / ctx.thinkingLevel) but
does not work — `extensions/footer-session-id.ts` records "Reading thinkingLevel
off the extension context always returns undefined (the ExtensionContext type
doesn't expose it)" and walks `sessionManager.getBranch()` for the last
`thinking_level_change` entry instead. Composing a bare `provider/id` would
therefore have silently dropped the seat's audited `:max` to pi's default level.
The rule takes the model from the caller and the level from the seat. pi still
clamps: observed 2026-10-08, an orchestrator spawned from a
`openrouter/xiaomi/mimo-v2.6-flash` caller received `…/mimo-v2.6-flash:max` and
recorded `thinking_level_change: high` — MiMo's ceiling, the same reason 023's
review seats pin `:high`.

**It is a no-op on today's fleet.** The composed spec
(`openrouter/deepseek/deepseek-v4.1-flash:max` — provider from `ctx.getModel()`,
which resolves OpenRouter's namespaced id) is a different *string* from the
seat's frontmatter literal (`deepseek/deepseek-v4.1-flash:max`), but names the
same provider, model and level. Nothing changes until a caller runs a different
model, which is exactly when the rule should fire.

**Alternatives rejected.**

- *Default `inheritParentModel` to true for every seat*: it discards the
  per-seat model choice (022) — a caller on a cheap model would drag reviewers,
  implementers and scouts onto it, and those seats' levels were audited for
  their own model.
- *Inherit the caller's level too*: the level is not in the caller's spec (see
  above), and a caller at `off`/`low` would silently disable reasoning on a seat
  whose `:max` is deliberate policy. Reading it would mean a branch scan on
  every spawn to reconstruct what the seat already states.
- *A frontmatter key (`inheritModel: caller`)*: new surface in the
  agent-definition language to express one seat's rule; the fleet has exactly one
  orchestrator (028 retired the super-orchestrator), so the name is the whole
  population.
- *Fold the level into the existing inherited spec for all seats*: `parentModel`
  is `provider/id` by construction and 020 rules that an explicit inherit passes
  the parent model through unsubstituted — changing that would alter seats this
  decision deliberately leaves alone.

**Downside, stated.** The seat's level is expressed for the fleet flash model;
on a foreign caller model the same suffix means whatever that model's ladder
means, clamped by pi. That is the intended trade — reasoning effort is the
seat's policy, the model is the caller's.

**Coverage.** `tests/subagent-model-inheritance.test.ts`: the resolver matrix;
spawns through the `subagent` tool for the orchestrator case and a
non-orchestrator control; and a real `subagent_resume`, asserting the resumed
turn's model against a resuming caller on a different model.

What each layer can see, and why. `meta.json` is written by the spawn's own
`execute`; the child process's `--model` argv is read from `ps` (synchronous
with the spawn); the model that produced a turn is read from the assistant
message envelope *after* a turn has completed. The envelope is the only record
that survives a resume: observed 2026-10-08, resuming a session recorded on
`xiaomi/mimo-v2.6-flash` with `--model openrouter/deepseek/deepseek-v4.1-flash`
answered on deepseek and appended **no** `model_change` entry, so a
change-list-based assertion would pass vacuously. Spawns assert the argv rather
than the session header because pi creates a session file **lazily** when
spawned with `--session-id`: observed 2026-10-08, a bare `get_state` left no
file behind, and header waits on the first spawned child timed out under load
(the 1-in-4 full-suite red a reviewer reported as an unidentified flake; the
failure dump added afterwards identified it as the header wait). A transcript
read after a completed turn has no such race.

Two things these layers deliberately do **not** observe, so nobody reads a
green suite as more than it is: the non-orchestrator control stops at argv (its
pi-side boot model is not read — a bad frontmatter spec that pi silently falls
back on would surface in daily use, not here), and no pi-side thinking-level
evidence remains anywhere in the file (the level component of a composed spec is
pinned spawn-side only; pi clamps it, so it cannot distinguish `:max` from a
default for the orchestrator either).

Mutation-verified 2026-10-08, each against an absolute copy of the tree: spawn
args ignoring the resolved model → the orchestrator argv assertion red (and the
resume test's pre-turn model red); `meta.json` recording the seat model → both
meta assertions red; the resume path inheriting a caller model (`isResume`
dropped, `parentModel` supplied) → the resumed-turn assertion red; a
`splitModelSpec` that strips any last `:suffix` → the `:free` matrix row red.
Dropping `isResume` while passing no `parentModel` stays green: that is
equivalent code, because the resume call site supplies nothing to inherit —
`isResume` guards against someone later doing so. Mutations must be applied by
absolute path: one heredoc here ran with the repo as cwd and wrote its mutation
into the working tree (caught and restored before any commit — `cd` before the
heredoc is not enough discipline).

**Test seam for future real-spawn tests.** `getPiInvocation` re-invokes pi from
`process.argv[1]`, which under `bun test` is the test file — the "child" would
be `bun <testfile> --mode rpc …` and dies with 0 turns, silently. A spawn test
must point `process.argv[1]` at pi's real entry (the test above does this in
`beforeAll` and restores it in `afterAll`).
