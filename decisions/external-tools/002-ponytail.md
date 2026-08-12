---
title: "Ponytail — principles adopted, tool not installed"
type: decision
status: deferred
date: 2026-08-10
---

# Ponytail — principles adopted, tool not installed

**What:** Evaluated [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) (pure-prompt "lazy senior dev" skill: a 7-rung ladder the model climbs before writing code — need-to-exist? → reuse in codebase → stdlib → native platform → installed dep → one line → minimum that works; validation/security/error-handling/accessibility explicitly preserved). **Tool not installed.** The one additive idea (the dependency-preference ladder) was folded into `APPEND_SYSTEM.md` as a one-line extension of the existing "Investigate existing mechanisms" rule.

**Why:** Unlike rtk, ponytail genuinely works. [JetBrains' paired A/B](https://blog.jetbrains.com/ai/2026/07/ponytail-skill-claude-tested/) (80 tasks, SkillsBench, Sonnet 5, medium effort): advertised −54% code / −20% cost; **measured −15% code, −10.3% cost (p=0.004), −11% time, no quality difference detected.** First tool in their 3-part series with a statistically solid cost-*saving* signal. It works where rtk didn't because it attacks the *output* side (what the model writes), which is where the money actually moves — not the input/tool-output side rtk compressed.

But three things make wholesale install wrong for this config:

1. **Model-regime risk.** Default here is `glm-5.2` + high thinking. Ponytail's README admits the catch: "a terse reasoning model that spends thinking tokens deliberating the rungs can go the other way (on GPT-5.5 it does)." JetBrains tested only Sonnet at *medium* effort. The thinking-token tax of deliberating 7 rungs could offset the output savings in exactly the regime this config runs.
2. **Already half-encoded.** `APPEND_SYSTEM.md` already has "Investigate existing mechanisms," "Share code, don't parallel it," "Write terse docs," "No unproven fallbacks." The only missing piece was the explicit *dependency-preference ordering* — now added.
3. **Workload + install mismatch.** Benchmark targets FastAPI+React feature code with over-build traps (date picker → flatpickr wrapper). This is a config/meta repo — less over-build surface. The tool's install (Claude Code/Codex plugin + node lifecycle hooks) doesn't map to pi; hand-porting to always-on `APPEND_SYSTEM.md` costs tokens every turn, and on-demand as a skill self-activates 0/10 (verified by JetBrains).

**Refuting the obvious framing:** "if it saves 10%, install it." The 10% was measured on Sonnet at medium effort on feature-code tasks; the README's own caveat and the high-thinking default here make the sign of the effect uncertain for this setup. Folding in the ladder captures the portable value at zero per-turn tax and zero new deps.

**Alternatives considered:**

- **Install the plugin wholesale.** Rejected (model-regime risk, workload mismatch, install doesn't map to pi).
- **Port to a pi skill (`skills/minimal/SKILL.md`), on-demand.** Deferred — justified for repos with heavy greenfield feature-codegen; this repo isn't one. Revisit if a target repo is.
- **Fold the ladder into `APPEND_SYSTEM.md` (one line).** **Adopted.** Minimal, terse, additive to existing discipline.

**Tradeoffs of adopting only the ladder:**

- Loses the ~10% measured savings *if* they were to materialize on this model/workload — which is unproven in this regime.
- Always-on injection costs a few tokens per turn; bounded, and the rule pays for itself in over-build avoidance.

**Files changed:**

- `APPEND_SYSTEM.md` — extended the "Investigate existing mechanisms" rule with the preference ladder.

**References:**

- JetBrains benchmark: <https://blog.jetbrains.com/ai/2026/07/ponytail-skill-claude-tested/>
- Ponytail repo: <https://github.com/DietrichGebert/ponytail>
- README's own regime caveat (GPT-5.5 goes the other way): README §"Numbers".
