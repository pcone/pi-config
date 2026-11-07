---
title: "Every seat on :high — orchestrator drops :max; scouts and compaction stay :low"
type: decision
status: done
date: 2026-11-07
---

# Every seat on `:high`

**What:** The orchestrator seat drops `:max` → `:high` on `opencode-go/deepseek-v4.1-flash`, so every reasoning seat in the fleet runs `:high`: implementer, three reviewers, orchestrator. Scouts and compaction stay `:low`. The math-algo-oracle keeps `opencode-go/deepseek-v4-pro:max` untouched. `agents/orchestrator.md` changes in two places: the `model:` line's level suffix (it is the level donor for dispatch without a caller model) and the prose sentence that describes a nested orchestrator inheriting "your own `:max` level". Supersedes 021's and 022's seat-level rows — 021's fleet-wide ban on `low` for reasoning seats and 022's model choice stand.

Owner, 2026-11-07: *"yeah lets put all the seats on high"*, after the seat's research review.

**Why:** The effort ladder above `:high` does not buy quality on this model, and it buys runaways:

1. **Quality is indistinguishable between `:high` and `:max`** on the V4.1 Flash effort study (3,738 jobs). The measured difference sits inside run-to-run variance; no seat-level metric separated them.
2. **`:max` produced more runaway sessions** — long tail runs that overshoot their useful work, which is the failure this repo is currently building a turn cap for. Paying more for a level whose characteristic failure is burning turns inverts the trade.
3. **The vendor's own guidance says most of the accuracy is recovered by 60–80% of the thinking budget.** A level that spends 100% to recover the last slice is the wrong default for seats that run on every dispatch.

**Alternatives considered:**

- **Keep the orchestrator at `:max`, move the rest to `:high`.** Rejected by the owner's wording ("all the seats"), and the evidence above does not distinguish the orchestrator from the other seats — if `:max` bought anything, 021's argument for the complex tail is where it would show, and the study found nothing.
- **Move scouts and compaction to `:high` too.** Rejected: they are not reasoning seats. Scouts summarize; compaction rewrites context. `:low` there is not a quality trade, it is the right tool, and 021's audit already settled it.
- **Move the oracle to `:high`.** Rejected: it runs a different model (`v4-pro`), so this study says nothing about it, and the seat is used for math/algorithms where the level has no measured substitute.

**Consequences:**

- Fewer runaway orchestrator runs and a lower token bill on the highest-fanout seat.
- If a future study separates `:high` from `:max` on a reasoning seat, the level is a one-line change per agent file; no mechanism depends on it.
- `low` stays banned for reasoning seats (021), unchanged.

**Files changed:** `agents/orchestrator.md` (two `:max` → `:high`), this decision, the index row, and a supersession note in 021 and 022.

**Evidence source:** the effort study and the vendor guidance were reviewed by the planning seat and reported to the owner on 2026-11-07; this record cites their findings rather than re-deriving them.

## Routing rule: which models may use opencode-go

Owner 2026-11-07: *"opencode go is **just** for deepseek flash because of good pricing — basically
every other model is better served via openrouter."* So opencode-go serves `deepseek-v4.1-flash`
only; every other model routes through OpenRouter. The oracle is the fleet's only other model and
moved the same day: `opencode-go/deepseek-v4-pro:max` → `openrouter/deepseek/deepseek-v4-pro:xhigh`.

Two facts the move depends on, both recorded here so the next person does not re-derive them:

- **`xhigh`, not `max`.** OpenRouter's top thinking level for v4-pro is `xhigh`, which maps to
  DeepSeek's max; `:max` returns 400 there (pi #4055).
- **The routing pin.** `models.json` carries `providers.openrouter.modelOverrides."deepseek/deepseek-v4-pro"`
  → `only: ["deepseek"]`, `allow_fallbacks: false`, the same first-party guard 022 wrote for Flash.
  Without it OpenRouter may serve a cheaper quantized host, and nothing in the repo would show it.

## The oracle's file tools stay

Owner 2026-11-07, on the observation that a file-reading agent with network egress can carry
`~/.ssh` or `~/.pi/agent/auth.json` to a third-party provider: *"we don't need to be so precious about
this — we're already using opencode go and openrouter in the existing pi seats for full development of
the project."* No tool change: the seat keeps `read, grep, find, ls`, and the Claude-side skill of the
same oracle runs plain read-only tools.

What that ruling settled about the seat's *contract*: reading files the caller names is in scope. The
description previously said "The caller must provide all necessary context inline in the task" and
"Do NOT use for repo navigation", which contradicted keeping the tools; both now say the caller names
the files and the oracle does not go hunting for ones they did not.
