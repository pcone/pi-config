---
title: "Implementer rename — implement-pro → implement"
type: decision
status: done
date: 2026-08-02
---

# Implementer rename — implement-pro → implement

**What:** Rename the sole implementation agent from `implement-pro` to `implement`:
file `agents/implement-pro.md` → `agents/implement.md`, frontmatter `name:` updated,
and every live-config reference (orchestrator `allowedSubagents` + routing prose,
reviewer/scout rejection sections, work-order skill `routed_to`, `extensions/modes.ts`
mode strings, extension comments, README, docs tables, ROADMAP) updated in lockstep.
No behavioral change to the agent prompt, model, or reviewer contract.

**Why:**

- After decision 012 collapsed the two tiers, the "pro" suffix is a misnomer: there
  is one implementation tier, no hierarchy — nothing is "pro" relative to anything.
  The name invites the question "pro versus what?" every time it appears in routing,
  commit subjects, and docs.
- Decision 012 line 62 rejected exactly this rename, citing the embedded references
  (test-subject.cjs, watch-session-v2.ts comments, the orchestrator's
  `allowedSubagents`, reviewer rejection sections) and the "do not edit tests" rule.
  The user has overruled that rejection. The churn objection is weaker post-collapse:
  the two-tier reference surface shrank, and the commit-subject fixture is a
  regression pin whose expected subjects derive from `subagent(${agentName}):` — the
  rename changes the runtime value, so the fixture must track it in the same commit.
  Comment churn in extension source is cosmetic.

**Alternatives considered:**

- **Keep `implement-pro`.** Zero churn, but the misnomer persists and every new
  reader asks what it is "pro" relative to. Rejected: the collapse removed the
  two-tier premise the suffix described.
- **Alias both names** (register `implement` while keeping `implement-pro` as a
  legacy resolver). Avoids breaking historical references, but leaves two names for
  one agent indefinitely — recreating the two-tier ambiguity the collapse removed.
  Rejected: agent discovery reads `name:` frontmatter; a second alias would keep
  both names alive in commit subjects and routing forever.

**Tradeoffs:**

- Git history and future auto-commit subjects change: `subagent(implement-pro):` →
  `subagent(implement):`. Historical commits, work orders (WO-2026-013..032), and
  decisions (004/006/007/009/011/012) keep the old name as point-in-time records —
  per the tfd-decisions rule, history files are not edited. Only decision-012 gets a
  supersession footnote (its line-62 rejection is the claim now reversed).
- The fixture update is atomic with the rename: `test-subject.cjs` expected subjects
  change in the same commit, or the regression pin and the runtime derivation
  disagree.

**Files changed:** `agents/implement-pro.md` → `agents/implement.md` (frontmatter
`name:` + worktree-relative path example); `agents/orchestrator.md`
(`allowedSubagents` + routing prose); `agents/review-{code,tests}{,-deep}.md` and
`agents/scout-{code,web}.md` (routing / rejection sections);
`skills/work-order-template/SKILL.md` (`routed_to` + description);
`extensions/modes.ts` (mode strings); `extensions/subagent-async/SYSTEM_PROMPT.md`
(routing table), `test-subject.cjs` (commit-subject fixture), `agents.ts`, `index.ts`,
`watch-session-v2.ts` (comments); `README.md`; `docs/model-role-scores.md`,
`docs/thinking-levels.md`; `apps/changelog-gen/ROADMAP.md`; decision-012 supersession
footnote; `decisions/subagents/README.md` index row for 013.

**Test coverage:** `node extensions/subagent-async/test-subject.cjs` — 9/9 pass with
the new `subagent(implement):` subjects (pins the runtime commit-subject derivation).
`bun test tests/` — no new failures vs HEAD baseline (identical failure set, all
pre-existing module-resolution/typebox issues unrelated to this rename).
