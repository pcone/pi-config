---
title: "One orchestrator role: retire the super-orchestrator (`plan` mode), cap nesting at one level"
type: decision
status: done
date: 2026-10-07
---

# One orchestrator role: retire the super-orchestrator, cap nesting at one level

**What:** The `plan` mode and the super-orchestrator (SO) role are
retired. `orchestrate` mode and the `orchestrator` agent become the
single orchestration role, used at any scale: an orchestrate-mode
session owns its workstream and dispatches implementers directly, or
`orchestrator` subagents for large, separately parallelizable chunks.
An orchestrator subagent may itself dispatch orchestrator children —
exactly one nesting level — but only from the top level
(`PI_SUBAGENT_DEPTH=1`); a nested orchestrator (`PI_SUBAGENT_DEPTH=2`)
delegates straight to implementers and the harness refuses its
orchestrator spawns. The "no cross-item planning" prohibition is
removed: orchestrators may read the whole roadmap and reason across
chunks. They still must not re-plan their parent's work or write a
roadmap doc they don't own — the one-writer rule preserves decision
007's conflict-avoidance finding under nesting.

**Why:** Decision 007 split planning (SO in `plan` mode) from execution
(orchestrator subagents) to keep planning judgment out of an
execution-polluted context. In practice the split did not hold:

1. **The handoff framing doesn't match use.** `agents/orchestrator.md`
   opens with "you receive from the SO" and a three-part SO handoff,
   but orchestrator subagents are dispatched directly from
   orchestrate-mode sessions and ad-hoc user requests; there is no SO
   in most runs. The prompt contracts with an actor that usually isn't
   there.
2. **The separation duplicates what nesting already provides.** The
   SO's property is clean planning context. A top-level orchestrator
   that delegates a large chunk to a child orchestrator gets the same
   isolation without a distinct role, mode, or handoff schema. The
   user's session is already the planning layer; a second one added
   relay cost without additional separation.
3. **`plan` mode held provisions orchestrate mode needs anyway.**
   Roadmap contract, reconcile rule, and `/attach` reframe guidance
   lived only in the `plan` prompt — so nested work ran from the mode
   with less guidance, and users had to enter `plan` just to get them.
4. **"No cross-item planning" caused over-serialization.** An
   orchestrator forbidden from looking at neighboring chunks cannot
   notice conflicts, ordering problems, or shared work. The coherence
   the guardrail protected (whole-picture ownership) is preserved by
   the roadmap doc, the one-writer rule, and parent reconciliation —
   not by blinding children.

**Design:**

| Actor | Owns | Dispatch rights |
|---|---|---|
| orchestrate-mode session | workstream / roadmap | implement, scouts, orchestrator subagents (top level) |
| `orchestrator` subagent, depth 1 | one chunk (may own the roadmap) | implement, scouts, review-plan, orchestrator children (one level) |
| `orchestrator` subagent, depth 2 | one sub-chunk | implement, scouts, review-plan — no orchestrators |

- **Nesting cap is mechanical.** `buildSubagentEnv` stamps
  `PI_SUBAGENT_DEPTH = parent depth + 1` on every spawn; the subagent
  tool refuses `orchestrator` when the current depth is ≥ 2 (malformed
  stamps parse as at-cap: they deny, never grant). Prompt guidance
  mirrors it: depth 1 may nest, depth 2 must not.
- **Most work does not nest.** A single orchestrator dispatching
  implementers is the default; nesting is for large multi-step
  workstreams whose chunks are themselves large and independently
  parallelizable.
- **Cross-chunk awareness.** Orchestrators may read the roadmap and
  other chunks, and must flag cross-chunk dependencies in
  `notes_for_orchestrator`. They do not reorder their parent's items or
  change another chunk's scope.
- **One writer per roadmap doc.** The doc's owner (the dispatcher, or
  the orchestrator the workstream was handed to) reconciles it as
  chunks land; children report results instead of writing.
- **Gate under nesting.** Each orchestrator gates its own implementers
  (decision 004). A parent verifies a child orchestrator's reported
  gate evidence mechanically via `subagent_review_status(<implementer
  inner session id>)`, does not re-run the child's reviewers, and keeps
  the `baseRef` isolated-review escape hatch for suspect claims.

**Alternatives considered:**

- **Keep the SO split.** Rejected: relay cost and the prompt/usage
  mismatch above; the clean-context property is achievable with one
  role plus nesting.
- **No nesting at all.** Rejected: workstreams whose chunks are large
  and independently designable — the shape decision 007's validation
  exercised — would need the user's session to hold the outer layer
  permanently. One bounded nesting level keeps that optional.
- **Unlimited nesting.** Rejected: the 007 validation already observed
  agents drifting into deeper nesting on their own (the role-confusion
  bug); deeper trees multiply gate chains, roadmap-writer races, and
  worktree sprawl, and nothing observed needs depth 3.
- **Keep `plan` as an alias or renamed mode.** Rejected: scope
  (workstream vs chunk) is a property of the work, not of the session;
  a mode split reintroduces the role split under another name.

**Tradeoffs:**

- Gate chains grow one link when nesting is used: a parent must verify
  a child orchestrator's gate evidence. Mitigation: same mechanical
  `subagent_review_status` check, no duplicate reviews.
- Roadmap-doc ownership must be explicit. Mitigation: one-writer rule
  in the prompt; children report instead of writing.
- Migration: a persisted `plan` mode is no longer valid — the project
  file parses to `null`, falls through the global file, and defaults to
  `implement`; the user re-selects `orchestrate`. One-time, not silent
  data loss.
- `subagent_resume` stamps the resumed process at resumer depth + 1, so
  it can create a depth-3 orchestrator *process*. It cannot gain
  orchestrator-spawn rights (the dispatch gate keys on the process's own
  stamped depth), so the invariant holds; this is why the prompt says
  spawns are refused, not that depth-3 processes can't exist.
- Rollout: an orchestrator process still running pre-deploy code spawns
  unstamped children for one process generation; restart in-flight
  sessions on deploy. Self-resolving after one generation.

**Validation result:** Not yet validated in a live multi-chunk
workstream. First use lands with this change; revisit if the single-role
prompt degrades into execution (the failure mode decision 007 guarded
against) or if one nesting level proves too shallow in practice.
