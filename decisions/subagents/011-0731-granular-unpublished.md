---
title: "0731 granular benchmarks unpublished — hold implement-pro/oracle, ship flash slots"
type: decision
status: done
date: 2026-08-01
---

# 0731 granular benchmarks unpublished — hold implement-pro/oracle, ship flash slots

**What:** As of 2026-07-31, **no non-agentic benchmark has been published for the
DeepSeek V4 Flash 0731 checkpoint by any party**. The fleet changes split into
"ship now" (flash/scout/compaction → 0731) and "hold" (implement-pro, oracle),
per the evidence below.

**Why:**

- DeepSeek's 0731 launch published **only agentic evals** (Terminal-Bench 2.1,
  DeepSWE, NL2Repo, CyberGym, Toolathlon-Verified, Agents' Last Exam,
  AutomationBench, DSBench-FullStack, DSBench-Hard). None of the granular
  composites — SWE-bench Pro, LiveCodeBench, IMO/HMMT, Terminal-Bench 2.0,
  SWE-bench Verified — appear.
- BenchLM's July-31 snapshot explicitly flags its "DeepSeek V4 Flash" (no-variant)
  rows as the **April-24 Preview checkpoint's Table 7 snapshot**, retained as
  historical evidence: "the values on this Non-Think row remain the April 24
  Preview checkpoint's exact Table 7 snapshot, not fresh 0731 measurements."
  0731 weights were not public when checked, so fresh evals were impossible.
- morphllm: no contamination-free independent SWE-bench re-run of Flash as of
  July 2026.
- The served-model **AA indices** (OpenRouter/AA benchmarks API, keyed to the
  20260731 canonical slug) *are* measured on 0731: int 49.9 / cod 69.1 / agt 45.7
  — above V4 Pro on all three. These support shipping the flash slots now; they
  do **not** resolve the implementer/oracle granular calls (AA-Coding ×4 in
  Implementer, but SWE-Pro ×5 and LCB ×5 are the load-bearing weights and both
  are unpublished).

**Decision:**

1. **Ship:** `implement-flash`, `scout-code`, `scout-web`, compaction →
   `deepseek/deepseek-v4-flash-0731`. Free upgrade: same prompt price ($0.14/M),
   10× cheaper cache-read ($0.0028 vs $0.028), served-model AA indices clear old
   flash on every axis. No granular data needed for these — they were already the
   cheap tier.
2. **Hold:** `implement-pro` (DeepSeek V4 Pro) and `math-algo-oracle` stay on
   Pro until 0731's SWE-bench Pro / LiveCodeBench / IMO-HMMT land. Under the
   old-flash reasoning-variant floor 0731 scores ~45.8 IMPL ≈ Pro High's 48.8 at
   ~⅓ the price — but that's a floor, not a measurement, and Pro's slot exists
   precisely for the implicit-invariant work where a broken first pass is
   expensive. The escape-hatch routing (report `invariant_exhaustiveness:
   implicit` → re-route to implement-pro) is the safety net if a trial is wanted.
3. **Re-check cadence:** BenchLM expected to ingest 0731 within days of its
   snapshot. `python3 docs/data/fetch_benchlm.py --check-0731` reports when rows
   appear. The `implement-pro` collapse and oracle-move calls resolve the moment
   SWE-Pro + LCB are measured.

**Alternatives considered:**

- **Assume 0731 ≈ old-flash granular and collapse the tiers now.** Rejected:
  the whole point of Pro's tier is resilience on implicit invariants; an
  unmeasured upgrade on the ×5 weights is exactly the failure mode the tier
  guards against. The data gap is days, not months — wait.
- **Wait on the flash slots too.** Rejected: no downside to shipping them
  (same price, better measured AA indices, cheaper cache-read), and the fleet
  stops paying old-flash's 10× cache penalty immediately.

**Tradeoffs:**

- The flash slots ship on served-model AA indices + price, which is solid but
  not granular-proven. Acceptable: flash tier failures are cheap and the
  escape hatch exists.
- Waiting on Pro/oracle means a few more days at Pro prices for those two slots.
  Bounded by the 24-48h recheck.

**Files changed:**

- `docs/data/fetch_benchlm.py` — added `--check-0731` mode
- `docs/model-role-scores.md` — refresh note 3, role review 3–4, unknown table,
  caveats 9–10: 0731 granular unpublished-anywhere provenance; BenchLM base
  flash rows flagged April-24 Preview

**Test coverage:** n/a (docs + fetch tooling). `fetch_benchlm.py --check-0731`
runs standalone.

> **Executed (2026-08-01):** the ship-now half landed — `agents/implement-flash.md`,
> `agents/scout-{code,web}.md`, `extensions/compaction-model.ts`, the
> subagent-async fallback default, the `models.json` `-0731` override (routing
> compat + maxTokens 131072), and the `.pi/auto-checkpoint.json` model key all
> moved to `deepseek/deepseek-v4-flash-0731`. Implement-pro and the oracle remain
> on Pro per the hold half.
