---
title: "Implementer tier collapse — single implement-pro on 0731 flash"
type: decision
status: done
date: 2026-08-01
---

# Implementer tier collapse — single implement-pro on 0731 flash

**What:** Collapse the two implementation tiers (`implement-flash` + `implement-pro`)
into a single `implement-pro` agent running `deepseek/deepseek-v4-flash-0731`. Delete
`agents/implement-flash.md`.

**Why:**

- Decision 011 held `implement-pro` on Pro until 0731's granular benchmarks (SWE-bench
  Pro, LiveCodeBench) landed. They still haven't — but the case for the two-tier split
  has weakened:
  1. **Price gap widened further.** 0731's cache-read is $0.0028/M vs Pro's $0.0036/M,
     and prompt is $0.14/M vs $0.55/M. At 95/5 I/O with 98% cache, 0731 is $0.019/M
     blended vs Pro's $0.055/M — nearly 3× cheaper.
  2. **AA indices decisively favor 0731.** Served-model measurements (int 49.9 / cod
     69.1 / agt 45.7) clear Pro (44.3/59.4/36.4) on all three axes. These are the
     primary evidence — measured by OpenRouter/AA on the live 0731 endpoint, not
     self-reported.
  3. **Agentic suite — directional, not verified.** DeepSeek's 0731 launch table
     reports DeepSWE 54.4 (vs old preview 7.3) and Terminal-Bench 2.1 82.7. These are
     DeepSeek-run jobs, not independently reproduced. DeepSWE *is* a credible
     third-party benchmark — built by DataCurve (deepswe.datacurve.ai) with strong
     methodology: original authored tasks on immutable commits, evaluated with
     `mini-swe-agent` (the SWE-bench authors' own harness) held fixed across models,
     verifier audited for false positives/negatives, contamination-resistant design.
     It is also a harder corpus than SWE-bench Pro (prompts half the length, solutions
     5.5× more code; DataCurve's own runs: GLM-5.2 max 43.8%, Kimi K3 max 68.5%, Luna
     max 67.2%), so a 54.4 would be roughly mid-pack among frontier models *if*
     independently reproduced. But the 54.4 figure is NOT on DataCurve's public
     leaderboard (v1.1, generated 2026-07-25 — before the 0731 launch — has no
     DeepSeek V4 Flash row at all; its only DeepSeek entry is v4-pro at 7.5% on the
     older v1 corpus). The 54.4 shares the same epistemic status as TB2.1 82.7:
     DeepSeek self-run, directional, supporting-but-unverified.
- **The collapse rests primarily on the served-model AA indices + price.** The AA
  Coding Index (69.1 vs Pro's 59.4, a ×4 weight in the implementer composite) is
  measured on the live endpoint, not self-reported. At ~⅓ Pro's price, 0731 would need
  to be *worse* at coding to justify keeping Pro — and the measured evidence says it's
  better. The agentic suite (DeepSWE, TB2.1) is directional supporting evidence, not
  the load-bearing beam.
- The two-tier split was always a cost play: cheap flash for mechanical work, expensive
  Pro for implicit invariants. But 0731 at $0.019/M is cheaper than old flash was (old
  flash's 10× cache penalty made it $0.043/M blended — more than Pro), and its AA
  indices exceed Pro's. The tiers no longer map to a price/quality tradeoff.
- The `implement-pro` agent's invariant-enumeration step already covers the resilience
  concern that justified Pro's tier. The model handles the coding; the prompt handles
  the caution. If 0731 proves inadequate on implicit-invariant tasks, re-split is a
  days-of-work rollback — but the measured AA evidence says it won't be needed.

**Alternatives considered:**

- **Keep Pro on standby as a fallback.** Rejected: adds complexity (two agent files,
  routing split, documentation overhead) for a fallback that hasn't been needed. If 0731
  proves inadequate on implicit-invariant tasks, re-split is days of work — but the
  evidence says it won't be needed.
- **Rename `implement-pro` to `implement`.** Rejected: the name `implement-pro` is
  embedded in extension code (test-subject.cjs, watch-session-v2.ts comments), the
  orchestrator's allowedSubagents, and reviewer rejection sections. Renaming would touch
  test code (against the "do not edit tests" rule) and comments in extension source.
  Rename later if the "pro" suffix becomes misleading.
- **Keep the two-tier split and wait for granular.** Rejected: the case for waiting
  evaporated when 0731's AA Coding Index cleared Pro's. The remaining uncertainty is
  on SWE-Pro/LCB specifically, but the AA Coding Index is a strong proxy and the price
  gap is too large to ignore.

**Tradeoffs:**

- Single point of failure: one model for all implementation. Mitigated by the existing
  escape-hatch (report `invariant_exhaustiveness: implicit` for re-routing) and the
  orchestrator's ability to dispatch `math-algo-oracle` for reasoning-heavy subtasks.
- Lost the ability to route trivial work differently from complex work. Acceptable:
  0731 at $0.019/M is cheap enough that "overpaying" for trivial work is not a material
  concern.
- Decision 011's hold-half (keep `implement-pro` on Pro) is effectively superseded by
  this decision, though 011's ship-half (flash/scout/compaction → 0731) already landed
  and is unchanged.

**Files changed:**

- `agents/implement-flash.md` — **deleted**
- `agents/implement-pro.md` — model changed from `deepseek/deepseek-v4-pro` to
  `deepseek/deepseek-v4-flash-0731`; description and body updated to remove all
  contrastive references to `implement-flash`; routing-feedback section simplified
- `agents/orchestrator.md` — frontmatter `allowedSubagents` list: `implement-flash`
  removed; body: all routing/bifurcation language collapsed to single `implement-pro`
  path
- `agents/review-code.md`, `agents/review-tests.md` — rejection-section routing
  references updated
- `agents/review-code-deep.md`, `agents/review-tests-deep.md` — same
- `agents/scout-code.md`, `agents/scout-web.md` — same
- `skills/work-order-template/SKILL.md` — `routed_to` field collapsed; escape hatch
  section removed; description and routing language updated
- `extensions/subagent-async/SYSTEM_PROMPT.md` — routing table: two-row split
  collapsed to single `implement-pro` row
- `extensions/modes.ts` — mode description strings: `implement-flash`/`implement-pro`
  split collapsed to single `implement-pro`
- `apps/changelog-gen/ROADMAP.md` — scope line updated
- `docs/thinking-levels.md` — fleet-roles column: `implement-flash` → `implement-pro`
- `docs/model-role-scores.md` — assignment table, TL;DR notes, role review item 3:
  two-tier references collapsed
- `decisions/subagents/011-0731-granular-unpublished.md` — supersession footnote added
- `decisions/subagents/012-implementer-collapse.md` — this file
- `decisions/subagents/README.md` — row for 012 added

**Test coverage:** `bun test tests/` — 29 pass, 8 pre-existing failures (missing
`@earendil-works/pi-*` packages in the isolated worktree, unrelated to this change).
No new failures. Verification: `grep -rn "implement-flash"` over agents/, extensions/
non-comment, skills/, docs/ current-state tables returns zero hits.
