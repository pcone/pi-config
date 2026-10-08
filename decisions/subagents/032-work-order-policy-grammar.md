---
title: "Work-order review_policy grammar — dash-optional bold line, one resolver"
type: decision
status: active
date: 2026-10-07
---

# Work-order `review_policy` grammar — dash-optional bold line, one resolver

**Ruling (owner, 2026-10-07).** The bold declaration line accepts an optional
leading dash: `**review_policy**: skip` is a valid declaration, as is
`- **review_policy**: skip`. All three gate sites read the field through one
shared grammar — `POLICY_BOLD_RE` (dash optional) plus `POLICY_YAML_RE`, with
first-word-after-colon semantics — and the task-text declaration uses a single
`taskDeclaresPolicySkip`, so a new site reading the field has one thing to call
and one place to change. Both task-text sites are pinned at the real `subagent`
execute boundary (`tests/work-order-policy-wiring.test.ts`), not only through
the exported detector. The `test-workorder-policy.cjs` mirror is synced in the
same change.

The bold line keeps the pre-ruling leading-whitespace tolerance (`^\s*`, which
the dashed form always had) with or without its dash; YAML stays anchored at
column 0, because an indented `review_policy:` is a nested key, not frontmatter.
`extensions/modes.ts:79` had been advertising the bare `**review_policy**: skip`
form to orchestrators all along — in-repo evidence the spelling was intended
while the parser read it as `required`.

**Why.** A work order that declares the field the way a human writes a metadata
block — `**review_policy**: skip (documentation-only; …)`, no bullet — matched
neither accepted form and was silently read as `required`. Observed for real in
the tfd repo (WO-2026-172): the declaration said `skip`, both reviewers were
spawned anyway, and the caller could not rescue it — with a WO present,
`effectiveReviewPolicy = workOrderPolicy ?? params.review_policy` takes the
parsed WO value, by design (decision 014 makes the WO the single source of
truth). The failure direction is fail-safe (extra reviews, never a skipped
gate), but an inert declaration is exactly what decision 014 exists to prevent,
and the same class had already bitten once: before 2026-08-26 the parser matched
the bullet only, so YAML-declaring work orders were silently inert too.

Measured before the change (Node, one encoding per row):

| input | parse | gate fallback | injection detector |
|---|---|---|---|
| `- **review_policy**: skip` | skip | true | true |
| `**review_policy**: skip` (no dash) | required | false | false |
| `review_policy: skip` (YAML) | **skip** | false | false |
| `- **review_policy**: required` | required | false | false |

Two facts fall out of that matrix: the bare form was inert everywhere, and the
two task-text sites accepted only one of the parser's two encodings (the
comment claiming they "mirror" the parser was true for the bullet alone).

**Alternatives rejected.**

- *Freeze the grammar, add a lint.* The lint is a second implementation of the
  same knowledge and only helps where it runs; the harness has to read the file
  anyway, and the accepted spelling is a one-character class in the regex it
  already applies.
- *Warn when a WO mentions `review_policy` but nothing parses* (the "fix the
  silence instead" option). Rejected as the primary fix: it surfaces the
  problem without accepting an obviously-intended declaration, and it adds a
  new spawn-result output surface. The tolerance is the smaller change; the
  warning remains available if a future spelling problem appears.
- *Anchor the match to the file head (before the first `##` heading), closing
  the quoted-example hazard.* Refuted by measurement on this repo's 32 work
  orders (31 carry a bold declaration; 1 is YAML-only): under a `^##`-prefix
  anchor — which `### Metadata` also matches — **31 of 31** declarations sit
  after the cutoff; under exact-`^## ` it is 16, under `^### ` 15. No reading
  leaves a majority inside the window: the anchor would silently un-recognize
  most or all declarations. Trading a theoretical flip for a measured silence.
  Zero files here have a fence before their declaration and zero
  declaration-like lines exist inside fences, so the hazard it closed is not
  present in the corpus.
- *Add the dash-optional regex at the third site too* (a fourth regex). This is
  the duplication the audit flagged; one constant and one detector replace it.

**Tradeoffs, stated.**

- A bare declaration *quoted as an example* in a WO's prose can now flip a gate
  to skip, exactly as the bullet form already could — leading whitespace
  (already tolerated for the dashed form) reaches it the same way. Measured
  exposure: 0 occurrences across the 32 WOs here; first-match-wins means an
  early example line already had this power for the bullet form.
- The task-text detector moves from `:\s*skip\b` to first-token equality, so
  `- **review_policy**: skip,` (punctuation attached to the token, no space) no
  longer counts as a declaration — fail-safe direction (gate stays live), and
  it now matches `parseWorkOrderPolicy`'s semantics exactly, which is the point
  of the unification. Pinned by test.
- YAML frontmatter stays **work-order scope only**: a task string is prose and
  never carries it, so `review_policy: skip` inside a task does not suppress the
  gate. Pinned by test on both sides (TS + mirror) so a future "consistency"
  edit has to argue with the pin.

**Scope.** Does not change: the fail-safe default (`required` unless a
declaration parses to `skip`), WO-over-param precedence, first-token semantics,
YAML precedence below the bold line, the missing/unreadable-WO hard failure.
The `.cjs` mirror had drifted further than the ruling required — its parser
never learned the YAML alternative (2026-08-26) — so this change also closes
that gap and adds rows for it.

**Also in this change (same ruling).** `agents/implement.md`'s
`allowedSubagents` gains `review-plan` (owner ruling, 2026-10-07): an implementer
may have the read-only plan reviewer check a task whose plan clears
review-plan's stated threshold (>3 files, IR invariants, uncertain file hints)
before coding. The **required** reviewer set —
`requires_parent_reviewers: implementation,tests` — is untouched, so decision
004's gate (review-code + review-tests before `complete`) is unchanged: the
allowlist widens what an implementer may dispatch, never what the gate demands.
`decisions/subagents/004` is amended in place.

**Reopening triggers.** A gate flips from a declaration quoted in prose →
anchor or ignore comments/fences. The mirror drifts again → make it consume
shared logic instead of a `KEEP IN SYNC` comment. A second field needs the same
"one declaration, several sites" treatment → extract the pattern rather than
copying it.

**Where it lives.** `extensions/subagent-async/index.ts` (`POLICY_BOLD_RE`,
`POLICY_YAML_RE`, `parseWorkOrderPolicy`, `taskDeclaresPolicySkip`, the gate
fallback and the injection call site); `agents/implement.md` (`allowedSubagents`,
its exact bound pinned through the real parser in
`tests/discover-agents-cache.test.ts`);
`agents/orchestrator.md` (review-gate routing prose);
`skills/work-order-template/SKILL.md` §Encoding (the grammar authors read);
`tests/work-order-policy.test.ts` (23 grammar rows);
`tests/work-order-policy-wiring.test.ts` (7 rows driving the two wiring sites
and WO-over-param precedence through the real `subagent` execute boundary —
round-1 probes that forced `index.ts:1830`/`:3429` dead went red there);
`extensions/subagent-async/test-workorder-policy.cjs` (31 call-site mirror rows
— manually run, `node extensions/subagent-async/test-workorder-policy.cjs`; no
runner wires it in, see `docs/investigations/structure-trend.md`).
