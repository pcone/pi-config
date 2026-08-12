---
title: "RTK (Rust Token Killer) — rejected, no expected savings on this setup"
type: decision
status: done
date: 2026-08-10
---

# RTK (Rust Token Killer) — rejected

**What:** Evaluated [rtk-ai/rtk](https://github.com/rtk-ai/rtk) (CLI proxy that rewrites `bash` commands to `rtk`-prefixed equivalents and compresses their output before the LLM reads it) for integration via its official pi extension (`rtk init -g --agent pi`). **Rejected. Not adopted.**

**Why:** Not snake oil — real Rust binary, Apache-2.0, clean and idiomatic pi extension (delegates to `rtk rewrite` via `pi.exec`, mutates `event.input.command` in place, fails open on every error path, version-gated, opt-in telemetry). But an independent paired A/B benchmark shows it does not save money on agentic coding work, and the structural reasons it fails apply at least as strongly to this pi config.

The decisive evidence is [JetBrains' SkillsBench A/B](https://blog.jetbrains.com/ai/2026/07/rtk-claude-code-token-savings/) (86 tasks, Claude Code 2.1.201, sonnet-5, paired, pre-registered endpoints, ~$320 of compute):

- Advertised 60–90%. **Measured: +7.6% MORE expensive at low effort (p=0.004), flat zero at high effort. Quality unchanged.**
- rtk's own scoreboard reported **96.2M tokens "saved" (99.8% of what it touched) while the actual bill went *up***. "A tool's self-reported savings are a claim about its counterfactual, not about your bill."

Three structural reasons the savings have nowhere to live, all verified against this config:

1. **The hook only sees the `bash` tool (~20% of tool-output chars).** pi's `read`/`grep` tools bypass it — rtk's pi extension explicitly narrows to `isToolCallEventType("bash", …)`. Half of shell commands are uncovered; pipes/heredocs are refused.
2. **pi already truncates.** `bash` output caps at 2000 lines / 50KB; `read` at 2000 lines / 50KB. The "320k-token `cat` of a 1.2MB CSV" that rtk's scoreboard brags about would have been truncated to a few KB anyway. rtk is grading against a counterfactual that doesn't exist here.
3. **This config solves long-context via compaction, not per-command compression.** `checkpoint.ts` / `auto-checkpoint.ts` / `compaction-model.ts` handle the actual context-growth problem. Adding per-command compression on top is a near-zero-marginal-value layer, with real downside: each rewrite is a place for a subtle bug (JetBrains found compound-`find` predicates turned into usage errors → retries → more turns → higher cost).

**Refuting the obvious framing:** rtk's README is unusually honest — it explicitly says "up to 90% of bash output… is not the same as cutting your bill by 90%." The marketing site (`rtk-ai.app`, "cut token costs by 60-90%") is not. The README's candour does not rescue the tool: the JetBrains data shows the *bash-output* reduction (which is real) does not translate into a bill reduction, which is the only number that matters. Default model here is `glm-5.2` + high thinking — the regime where JetBrains found rtk is a flat zero (no penalty, no savings).

**Alternatives considered:**

- **Adopt only the test-runner collapse (`cargo test` / `pytest` keeping failures, collapsing passes).** This is the one place rtk genuinely beats dumb last-N-line truncation: a 5000-line test run can scroll early failures off the top of pi's truncation window. **Rejected as a standing dependency:** the cheaper, lower-indirection fix is teaching the agent to run `pytest --tb=short -q` / `cargo test 2>&1 | rg -A5 'FAIL'` when suites are large. No new binary, no rewrite layer, no debugging-indirection.
- **Install globally, set `RTK_DISABLED=1`, enable per-project.** Rejected — adds a global extension + PATH dependency for a measured-negative expected return; the escape hatch existing doesn't fix the base case.

**Tradeoffs of rejecting:**

- Forgets the one genuine correctness win (large test-suite failure capture) — addressed via the agent-level flags alternative above.
- Loses ~0 expected token savings, because there are ~0 to be had on this setup.

**References:**

- JetBrains benchmark: <https://blog.jetbrains.com/ai/2026/07/rtk-claude-code-token-savings/>
- rtk repo + pi extension source: <https://github.com/rtk-ai/rtk/blob/develop/hooks/pi/rtk.ts>
- rtk's own savings caveat: README §"How Savings Work" (acknowledges bash-output ≠ bill).
