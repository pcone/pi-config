# WO-2026-071 — post-upgrade audit: is the fleet summary override live, and what does 1.3/1.4 need

### Metadata

- **work_order_id**: WO-2026-071
- **routed_to**: orchestrator
- **invariant_exhaustiveness**: explicit
- **estimated_complexity**: large
- **review_policy**: required

### Task Summary

pi is **1.4.0** on this box (`node_modules/@earendil-works/pi-coding-agent/package.json`); the
research behind the upgrade (`docs/investigations/pi-upgrade-2026-10.md` §7) said GO **after** the
summary-ownership fix, because upgrading arms a dormant fleet override for compaction summaries.
The upgrade happened anyway (1.3.0, then 1.4.0). Establish what that means **with evidence from a
real compaction**, port what 1.3/1.4 need, and retire the stale drafts.

### What is already known — do not re-derive

- `CompactionResult.reason` does not exist in 0.83.0 or 1.3.0 (pi-upgrade §2). Any plan built on
  `reason` is dead. Do not take that as read for 1.4.0 — check the installed `.d.ts` and say which.
- The fleet path historically failed with a `MissingSessionID` 400 because compaction was called
  without a session id; `ctx.sessionManager.getSessionId()` passed as `compact(..., sessionId)`
  was the suspected fix (pi-upgrade §5.2, §7). Whether 1.4.0 still needs that call is **the
  question this order exists to answer**, and the answer must come from a run, not from the
  changelog.
- `docs/investigations/checkpoint-sanity-check-2026-10.md` §7 holds four owner questions from
  2026-10-21: Q1 summary ownership, Q2 pi upgrade timing, Q3 the uncommitted
  `auto-checkpoint.ts` WIP, Q4 April-era features removed by `9925257`.

### Step 1 — establish the override's state, from a real compaction

Produce a written finding, each claim carrying a probe:

1. **Which model served the last checkpoint summary**, and how you know. A one-run capture beats a
   reading: drive a real compaction in a scratch worktree (a checkpoint on a session above
   `keepRecentTokens`, or `ctx.compact()` from a test), then read the summary's identity out of
   what pi recorded — the session entry's `usage`/model field, the provider request in the child
   log, or a `compaction-model` path's own debug line. Say exactly which artefact you read.
2. **Whether `compaction-model.ts` fires at all today**, and whether it wins the summary. Two
   extensions returning `{compaction}` replace each other rather than merging (pi-upgrade §5) —
   check whether that is still true in 1.4.0's runner, and which extension wins now.
3. **Whether the marker-based split still discriminates**: `ctx.compact()` and `/compact` both
   reported `"manual"` on 0.83.0, so the `[CHECKPOINT]` marker in `customInstructions` was the
   only split. Confirm on 1.4.0 or report what replaced it.
4. **The failure path is still silent?** `compaction-model.ts` historically swallowed every fleet
   error into `undefined`. If it still does, that is a defect to fix whatever the ownership ruling
   says, and a loud error is not a behaviour change in any direction.

If the override is **live** and rewriting checkpoint summaries, stop and report immediately as an
owner question — that is summary content being replaced, and the ruling that would arbitrate it
(Q1) has never been given.

### Step 2 — port what 1.3/1.4 need

`docs/investigations/pi-upgrade-2026-10.md` §4/§5 list the in-scope files and their deltas. Port
what the audit shows is still needed on 1.4.0 — retried compaction, truncated-summary refusal
(whether a length-truncated summary now throws), malformed-tool-arg rejection, `read` label fixes,
`context_with_system`, any type mismatch in the four in-scope files. Each port gets its own order
and its own acceptance rows; do not fold.

### Step 3 — retire the stale drafts

Three drafts sit in `work-orders/`, all written against 0.83.0:

- `WO-pi-upgrade-1.3.0.md` — the upgrade it describes has happened (1.4.0). Rewrite as a port
  order if Step 2 leaves work, else delete with a note in the decision record that carries it.
- `WO-summary-ownership-dispatch.md` — blocked on Q1, and its premise table (`reason` dispatch)
  is dead: `reason` was not in `CompactionResult` in 0.83.0 or 1.3.0. Rewrite only if Q1 rules a
  mechanism that does not need `reason`; otherwise mark it superseded with the reason.
- `WO-drift-decision-record.md` — read it; if the drift it records is now closed, delete; if not,
  restate the live part.

Deleting a draft is a real outcome. A draft nobody can dispatch is a document that makes the repo
look busier than it is.

### Step 4 — the four open questions

For each of Q1–Q4: decide **live** or **stale**, with a citation. Then:

- **Q2 (upgrade timing)** looks stale — the upgrade happened. Confirm and say so with the version
  evidence, then close it in the doc.
- **Q3 (uncommitted `auto-checkpoint.ts` WIP)** looks answered by `decisions/checkpoint/002`.
  Confirm against that record, and close it if it is.
- **Q1 (summary ownership)** — if live, send it to the planning seat
  (`claude-8f90746f-e9aa-4dab-81ef-eb303ba0cb65`) with a fresh recommendation, in the form the
  seat can turn into a registry row: the question, the observed facts from Step 1, two or three
  options on their merits, and what each costs. Note that its old premise (`reason`) is dead.
- **Q4 (features removed by `9925257`)** — same treatment: if live, send with a recommendation.

Do not answer an owner question yourself, and do not implement against an unanswered one.

### Rows and gating

Every implementation order you dispatch carries its own acceptance rows with red-withouts; you
gate by re-running at the merged tip, never by reading a completion report. Review cap is hard at
**3 rounds**. Reserve ids from **WO-2026-073 upward** (070, 071, 072 are taken), pushing the
reservation before dispatching.

### Boundaries

- **Do not touch `tests/e2e-idle-compaction.test.ts`** — WO-2026-072 owns that file and runs in
  parallel with you. If your work changes that row's behaviour, say so in your report instead of
  editing it.
- Do not unilaterally change which model summarises anything. The audit reports; an owner ruling
  decides. The one exception is making a silent failure loud (Step 1 item 4).
- `models.json` and `settings.json` in the live checkout carry another session's uncommitted work.
  Leave them.

### Report

An audit finding in `docs/investigations/` (evidence-first: each claim with its probe), the
draft retirements, the dispatched orders with their ids, and the Q1/Q4 messages sent. Say plainly
whether the override is live — that single fact decides whether the summary content is currently
being rewritten by a model nobody ruled in.
