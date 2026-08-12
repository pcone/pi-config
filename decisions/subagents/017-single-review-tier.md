---
title: "Single review tier — Luna standard, deep tier formally dormant (kept as insurance)"
type: decision
status: done
date: 2026-08-04
---

# Single review tier — Luna standard, deep tier formally dormant (kept as insurance)

**What:** The review system is formally a single tier. Standard reviewers (`review-code`, `review-tests`, `review-plan` on `openai/gpt-5.6-luna`) are the only tier in use; the `-deep` agents (GLM-5.2) are kept as **dormant escalation insurance — not deleted**, with a one-line policy note that the orchestrator does not route to them. The `review_depth` WO field is retained for historical WOs but documented as informational.

**Why:** Three facts converge. (1) The deep tier has never been invoked — 85 tracked reviewer spawns all standard, and `review_depth: thorough` was declared 3× (WOs 018/037/038) yet all spawned standard reviewers because no routing or launch logic for deep exists anywhere (orchestrator prompt, harness, implementer protocol all silent). (2) Decision 005's rationale for the deep tier — GLM's quality edge justifying its 39× cache cost on complex work — is gone: Luna's agentic index (45.6) now exceeds GLM-5.2's (43.1) at a fraction of the price, and the deep tier's slow member is the whole reason the fleet moved to high-TPS models. (3) The user's one reservation — Luna's hallucination profile (GPT-5.6 family trend: Sol documented fabrication incidents, OpenAI's own "smaller models worse on factuality" line) — is addressed by keeping the deep agents as dormant escalation rather than deleting them, and by the watch-list probes below, not by a second active tier that never fires.

**Alternatives considered:**
- Delete the deep agents outright — rejected: they're the escalation path if the Luna watch list flags fabricated findings; deletion is a harder reversal than dormancy.
- Wire the deep tier up properly (add orchestrator routing + implementer launch logic) — rejected: Luna ≥ GLM on the quality axis that justified the tier; building routing for a tier with no quality advantage is machinery for nothing. Revisit only if the watch list shows Luna verdict regressions.
- Keep the two-tier fiction undocumented — rejected: the `review_depth: thorough` field + selection criteria in 005 actively mislead (WOs declare thorough, get standard).

**Tradeoffs:** Dormant agents can rot (drift from the standard tier's prompt updates) — accepted; if ever escalated, they'd be refreshed first. The `review_depth` field lingers as a fossil in the WO template — documented as informational so WOs stop declaring it meaningfully.

**Hallucination watch list (operationalized from the code-grounded-eval research, 2026-08-04):**
- **Mechanical citation-resolution check (primary):** reviewer `file:line` claims validated by interval arithmetic against the diff — mechanically, never by an LLM (GhostCite: LLMs are worse-than-random citation validators, 38%).
- **"Prove each finding":** reviewers must quote the cited evidence in each finding (prompt tweak, this decision).
- **Patch-vs-spec audit on implementation:** fabricated identifiers (referenced but never defined), hunks beyond scope, test edits (#1 reward-hacking signal per benchmark audits), claimed-vs-actual reconciliation (re-run the suite on the final tree).
- Trigger: if the watch list surfaces fabricated findings in standard review, escalate the affected WO to the dormant deep tier manually (orchestrator action) and re-evaluate.

**Files changed:** this decision, README index, `agents/review-code.md`/`review-tests.md`/`review-plan.md` (prove-each-finding instruction), `skills/work-order-template/SKILL.md` (review_depth note). Deep agent files untouched (dormant).

**Test coverage:** gate runs standard reviewers — which are the Luna reviewers post-WO-2026-041; this WO runs the gate per the keep-hard clause.

> **Partial supersession (2026-08-11):** the "Luna standard" model choice is superseded — standard reviewers now run `deepseek/deepseek-v4-flash-0731` (same-lab accepted for cost; Luna was ~50% of spend at <1/5 of tokens). The single-tier / deep-dormant structure stands, but the deep tier is now the config's *only* decorrelated reviewer — see [decision 019](019-standard-reviewers-flash-0731.md).
