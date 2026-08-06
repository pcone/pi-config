---
title: "Review-skip single source of truth — WO as first-class spawn parameter"
type: decision
status: done
date: 2026-08-04
---

# Review-skip single source of truth — WO as first-class spawn parameter

**What:** The `subagent` tool gains a `workOrderPath` parameter. At spawn, the harness reads the referenced work order from the parent checkout, parses its canonical `- **review_policy**: skip` bullet, and uses that value for the review-gate suppression decision. The parsed policy is injected into the child's task so the implementer's agent-level reasoning and the harness gate share one source. A missing/unreadable work order hard-fails the spawn with a loud error. The `review_policy` tool param remains as the fallback for dispatches that don't reference a work order (ad-hoc tasks, scouts). `agents/orchestrator.md` gains the skip-routing rule; work-order-template SKILL.md metadata is unchanged.

**Why:** WO-2026-036 (2026-08-04) — skip was declared in the work order and in dispatch prose, but the tool param was not set and the task text lacked the canonical bullet. The gate stayed live and the implementer was steered into spawning both reviewers: two wasted LLM sessions. Root cause: three sources of truth (tool param, task text, WO file) with the gate decision keyed on the task string (`extensions/subagent-async/index.ts:1038`), which the harness otherwise treats as opaque text — no WO parsing exists anywhere in the extension. Making the WO file the source of truth by construction removes the LLM copy step and the prose convention ("Execute work order `path`" is orchestrator convention, not a harness contract).

**Alternatives considered:**
- Prompt-only rule "always pass the review_policy param" — rejected: the fragility being fixed is an LLM-step (the orchestrator forgetting), and a rule adds another LLM step.
- Mandate the canonical bullet in task text via dispatch template — rejected: requires the orchestrator to copy the bullet into the task (the same LLM step), stays a failure mode (safe but wasteful).
- Regex-parse the WO path out of the task string — rejected: the reference phrasing is a convention, not a contract; misphrasing silently falls back to param behavior, moving the fragility instead of removing it.

**Failure-direction note:** the unsafe direction (gate wrongly skips) has never existed — forgetting skip declarations defaults to `required`, which is wasteful but safe. This change optimizes the reliability of a deliberate skip declaration, not a correctness hole.

**Tradeoffs:**
- New tool parameter + spawn-time file read (parent checkout; the WO is committed or carried before dispatch per the WO-2026-034/035 carry machinery).
- When both `workOrderPath`'s WO and the `review_policy` param disagree, the WO wins (single source of truth); documented behavior.
- The hard harness clause (below) is orchestrator-enforced, not mechanical — a prompt rule, so its enforcement quality depends on the orchestrator.

**Routing rule (added to `agents/orchestrator.md`):**
- Skip (`review_policy: skip` + `workOrderPath`) when: `estimated_complexity: trivial` AND `invariant_exhaustiveness: explicit` AND mechanical (no new API surface, no control-flow logic) AND no test-surface change AND no error-handling/recovery paths AND no prior rejections on the code area. Complexity is the measure — file/line counts are explicitly NOT criteria (a 5-file rename can be more trivial than a 1-file harness change).
- Require the full gate when ANY of: new API surface/entry points; error handling/recovery; implicit invariants; test-surface changes; prior rejections; user asks; **or the WO touches the harness/own config** (`extensions/subagent-async/`, `modes.ts`, agent config) — the hard clause: that bug class (silent wiring failures, e.g. the WO-2026-034 `topLevel` bug and the WO-2026-004 `review_status` id-keying bug) is exactly what the gate exists to catch, so own-config work is never auto-skipped regardless of declared complexity.

**Deferred:** graded review — a middle `review_policy` tier spawning only `review-code` for testless mechanical changes. Deliberately not built now; the parallel-review-is-faster argument (tmp/subagent-speed-investigation.md:35) applies to big tasks, and the skip path covers the small end.

**Files changed:** `extensions/subagent-async/index.ts` (new param, WO read+parse+inject, loud fail), `agents/orchestrator.md` (routing rule), this decision, index.

**Test coverage:** real-dispatch E2E is mandatory for createWorktree-adjacent harness changes (WO-2026-034/035 lesson — the mirror/unit boundary cannot catch object-vs-string wiring bugs). Matrix: skip-declared-in-WO → gate suppressed without param; missing WO path → loud spawn failure; param-only (no WO) → current behavior; WO declares required → gate live even with param absent; harness-touching WO → gate live.
