---
title: "Super-orchestrator (plan mode): role separation for multi-workstream work"
type: decision
status: done
date: 2026-07-19
---

# Super-orchestrator (`plan` mode): role separation for multi-workstream work

**What:** A third parent mode `plan` (super-orchestrate) is added
alongside `implement` and `orchestrate`. In `plan` mode the parent
session acts as a **super-orchestrator (SO)**: it owns a canonical
roadmap doc and dispatches **orchestrator-subagents** (a new
`orchestrator` agent — today's orchestrate-mode behavior, scoped to
one item) per line item, in parallel where independent. A new
**foreground/attach** primitive in `subagent-async` lets the user
converse directly with a running orchestrator-subagent when
implementation surfaces a reframe that the user↔SO↔O relay cannot
carry. `orchestrate` and `implement` modes are unchanged.

**Why:** See "Diagnosis" and "Why this design" below. The short
version: the logs show the current orchestrator already handles long
horizons (via deliberate ~250k-token compaction) and parallelism
(107/110 dispatches batched) well; its real, repeated failure is that
**the user is the compaction-boundary scheduler and the coherence
layer**, and **planning judgment degrades under execution load**. The
fix is role separation — keep the planning context clean of execution
noise — plus a first-class way to reach a subagent directly when a
design conversation is needed.

## Diagnosis (from tfd orchestrator-mode session logs)

Two long-horizon `orchestrate`-mode sessions in `~/Developer/tfd`
were analyzed:

- `019f64a6` (2026-07-15→19, effect-row-typing + comptime eval): 110
  subagent dispatches, 107 launched while another was in flight, peak
  ~20 concurrent, 21 compactions, 2032 `bash` / 408 `read` / 164
  `edit` / 297 `wait` / 288 `subagent_status`.
- `019f5978` (2026-07-13, effect-handler monomorphization): 22
  dispatches, 21 parallel-batched, 24 compactions.

Three observations that **refute** the naive justification and three
that **support** this decision.

### What the data refutes

1. **"The orchestrator can't parallelize."** False — 107/110
   dispatches were launched while another was in flight. Aggressive
   parallel dispatch is already happening; `plan` mode's value is not
   "enabling parallelism."
2. **"Context is the binding constraint / thrashing."** False.
   Compactions cluster at 125k–345k tokens, with several deliberately
   low (51k / 57k / 85k = clean resets before model switches or phase
   changes). The cadence is a chosen ~250k operating point for cost +
   model-quality reasons (degraded performance at large context), not
   distress. Compaction summaries are good (the #1 summary is a tight
   state-of-the-merged-world).
3. Therefore **neither "longer horizon" nor "parallelism" nor
   "context budget" is the real problem.** The orchestrator already
   does all three.

### What the data supports

4. **The user is the compaction-boundary scheduler.** Of 21
   compactions in `019f64a6`, ~17 are immediately followed by a user
   message that is really a planning directive ("Dispatch #2 (009
   alias collapse)", "Start Phase 1: flip auto-comp default",
   "Continue Phase 2 … dispatch WO-2026-024"). Compaction #17's first
   message is literally "what's next?" — the orchestrator did not
   know, and the user had to prompt it. Post-compaction re-orientation
   costs ~5–7 `read`/`bash` calls each (~100+ re-orientation
   round-trips across the session).
5. **Doc/reality drift recurs.** "I suspect those 'planned' tasks are
   really done, just not updated in the docs"; "is our todolist up to
   date?"; the inferred-effects regression ("I was under the
   impression we fixed that already"). The orchestrator-in-execution
   does not reliably reconcile the canonical plan against merged
   reality.
6. **Planning judgment degrades under execution load.** Wrong-path
   excursions the user had to correct ("parallel tracing is completely
   the wrong approach"); serialized work that was actually independent;
   the orchestrator repeatedly "sucked into implementing" despite
   repeated corrections ("you should orchestrate", "are you doing work
   that should be delegated"). These are the signature of planning
   decisions made in a context polluted by ~250k tokens of execution
   detail.

## Why this design

The decision is justified on three legs:

1. **Clean planning context (role separation).** A SO that never
   executes keeps its planning context clean by construction. This is
   the irreplaceable property: lighter alternatives keep the
   orchestrator's *own* context polluted when it decides what to plan
   next, so its judgment stays the degraded thing the logs show.
2. **Owned canonical roadmap.** The ~80% of compactions the user
   manually re-seeds become the SO's job. The roadmap doc replaces the
   user as the cross-session memory (the workstream above spanned two
   parent sessions, held together only by the user + on-disk docs).
3. **Multi-workstream parallel allocation.** Near-term tfd work is
   large and independent — audio vs video vs filesystem capability
   handlers; stdlib (unicode, math). A SO dispatching several
   orchestrator-subagents concurrently in separate worktrees is a
   capability the single orchestrator session only approximates.

## Design

### Three modes (scope-of-ownership framing)

| Mode | Owns | Does |
|---|---|---|
| `implement` | one task | executes directly |
| `orchestrate` | one work item | designs + dispatches implementers + gates + merges |
| `plan` *(new)* | a whole roadmap / multiple workstreams | maintains the roadmap, dispatches orchestrator-subagents, reconciles, reallocates |

The modes **coexist and are chosen per work-shape** — `plan` does not
replace `orchestrate`:

- **Core type-system R&D** (effect-row-typing, comptime eval) → stays
  in `orchestrate`. That work wants tight, exploratory user↔agent
  loops; the relay would hurt it.
- **Large independent features** (audio/video/FS/stdlib) → `plan`.
  The SO dispatches orchestrator-subagents, often in parallel.

This is the key de-risking property: nothing about existing
`orchestrate` behavior changes. `plan` is purely additive.

### The `orchestrator` agent (`agents/orchestrator.md`, new)

Today's orchestrate-mode behavior, extracted and scoped to **one
item**: take a handoff (item spec + roadmap pointer + resolved
policy), do detailed design, dispatch `implement-flash`/`implement-pro`,
run the review gate, merge, return a completion report. Guardrails:

- **Forbidden from cross-item planning** — it sees exactly the item
  it was handed.
- **Forbidden from spawning sub-orchestrators** — nesting is capped at
  SO → O → implementer (3 levels). The role-confusion bug (subagents
  accidentally entering orchestrate mode and spawning sub-subagents)
  shows agents stumble into deeper nesting naturally; the prompt must
  forbid it explicitly.

### Roadmap doc contract

The load-bearing artifact between SO and O, and the thing that
survives across parent sessions. The convention half-exists already
(`decisions/*/TODO.md`, `tmp/TODO.md`). Canonical shape:

```
# Roadmap: <workstream>
## Resolved policy        ← decisions applying to all items; never re-litigated
## Active
### <workstream, e.g. stdlib-unicode>
  - [ ] ITEM-1: <one line> — spec: <doc>, design: pinned|open
  - [~] ITEM-2: in progress — O=subagent-<id>, branch=pi-subagent-<id>
  - [x] ITEM-3: done — merged <commit>
## Deferred / blocked
```

Doc-reconciliation after every item is a **hard step** in the SO's
prompt, not optional. This directly attacks the doc-drift observed in
the logs.

### The four flows

- **Clean item** (design pinned, just build): SO → O with spec → O
  gates + merges → reports → SO reconciles + picks next. Zero user
  touch. *The common case for audio/video/stdlib once designed.*
- **Item needs design**: SO → O with "design only, surface questions,
  don't build" → O returns `status: blocked` + questions → SO relays
  to user → user answers → SO resumes O (`subagent_resume`) → O
  builds. Relay cost lives here; mitigated because resolved policy
  pre-answers most questions.
- **Cross-item dependency** (item 3 affects item 7): the SO catches
  it *because it holds the whole roadmap* — reorders or marks the
  dependency. This is the cross-item coherence that justifies the
  layer.
- **Parallel items**: SO dispatches O-audio + O-video concurrently,
  each in its own worktree (cannot race on files), monitors both,
  reconciles both. *The new capability.*

### Review gate under nesting

Decision 004's gate keys to "whoever spawns the reviewers." Under
nesting, O spawns the implementers → O owns the gate → O's completion
report to the SO includes the gate evidence. The SO trusts O's gate
(the way the user today trusts the orchestrator's) and does **not**
re-run it (that would double the cost). The SO does the same
mechanical check the orchestrator does today
(`subagent_review_status`), and retains an escape hatch: it can spawn
its own isolated review of O's branch (`baseRef`) if a claim is
suspect. New failure mode — O misreports — is mitigated by the SO
reconciling against the repo/doc after every item.

### The foreground/attach primitive (the load-bearing piece)

Implementation regularly surfaces **reframes** — questions that
re-open the design and need genuine multi-turn conversation, not a
single structured fork. The user↔SO↔O relay cannot carry a reframe:
the SO can only translate (lossy) or pass verbatim (pointless hop),
and the SO's value (clean context, scheduling) is nil during one.

The missing capability is **`/attach <id>`**: repoint the TUI's
active conversation to a running subagent — user input flows to O's
RPC stdin, O's live output renders as the active view — until
`/detach` returns the user to the SO. Confirmed against the current
harness: the subagent is an RPC process with a writable `stdin`
(`rs.stdin`), and the *only* writer is the parent via
`rpcSend(stdin, {type:"prompt",…})` on steer or the soft-prompt
guard (`extensions/subagent-async/index.ts:505-507, 918-921,
1058-1059`). There is no attach/foreground/join/pty concept; the
subagent's output is summarized into `subagent_status` or injected as
a one-shot result on completion — the user never sees O's live
conversation. So "converse directly with O" is genuinely impossible
today; the transport exists, the foregrounding layer does not.

Framed correctly, attach is **not a bypass/hack** — it is the
mechanism that makes the clean-context separation work:

- The deep design loop runs in **O's** context (while attached), not
  the SO's.
- O writes the reframe's conclusions to the **roadmap doc**.
- On detach, the SO reads the updated roadmap — its context stays
  clean **and** it is fully informed.

Without attach, the first reframe either pollutes the SO's context or
suffers the relay. With it, the separation holds. Attach is also
independently useful in `orchestrate` mode (attach to a stuck
implementer).

Distinction that motivates it:

- **Tweak** = a single structured fork ("options A/B/C, which?").
  Relay handles it.
- **Reframe** = a multi-turn design conversation where the user must
  probe O's understanding and iterate. Relay fails; attach is
  required.

## What gets built

Two independent halves. `subagent-async` lives in this repo
(`extensions/subagent-async/index.ts`), so both halves are in-repo.

### Half A — config (lower-risk, immediately useful)

- `agents/orchestrator.md` (new) — extracted from APPEND_SYSTEM's
  orchestration sections, scoped to one item, with no-nesting /
  no-cross-item-planning guardrails.
- `extensions/modes.ts` — add `plan` to the `Mode` union, to
  `MODE_FULL`, and to `MODES_BRIEF`; make `/mode` a 3-way cycle or
  explicit `/mode <name>` instead of a 2-way toggle.
- `APPEND_SYSTEM.md` — new `## Super-orchestration` section: when to
  use `plan` vs `orchestrate` vs `implement`, the roadmap-doc
  contract, the SO↔O handoff/report schema, the "reconcile the doc
  after every item" hard rule.

### Half B — harness (`subagent-async` + TUI; higher-effort)

- The `/attach` / `/detach` foreground primitive: route user input to
  a running subagent's RPC stdin, render the subagent's event stream
  as the active TUI view, return to the parent on detach.

### Sequencing

Build **B first or in parallel**. B is independently shippable (helps
`orchestrate` mode today) and de-risks A: shipping A without B sets up
a known-bad reframe experience. If B must slip, two honest stopgaps
for v1:

- **SO does the redesign in-session** — works, but pollutes the SO's
  context (undermines its core property); acceptable only transiently
  with a checkpoint reset afterward.
- **`checkpoint_fork` a fresh orchestrator from a handoff doc** —
  zero new harness code (fork already exists), but loses O's
  accumulated context; the fresh orchestrator re-loads everything.

Both are visibly inferior to attach — they are stopgaps, not the
design.

## Risks

- **SO degrades into an executor.** Must be prompt-forbidden from
  touching code; if it implements, it loses its one advantage. Role
  separation (the SO has no reason to touch code) plus prompt
  discipline mitigate.
- **O misreports to SO.** Mitigated by SO reconciling against the
  repo/doc after each item and the optional SO-spawned review escape
  hatch.
- **Nesting depth.** SO → O → implementer is 3 levels and must be
  capped there. O must not spawn sub-orchestrators (prompt-enforced).
- **Roadmap doc itself drifts.** Doc-reconciliation after every item
  is a hard step in the SO prompt (this is the failure that recurs in
  today's logs).
- **Reframe without attach.** See stopgaps above; the design is
  incomplete until Half B lands.

## Alternatives considered

- **Disciplined roadmap doc + single orchestrator, checkpoint
  anchoring (no new role).** Helps doc-sync and cross-compaction
  coherence with existing tools, and is the right *discipline*
  regardless. Rejected as *sufficient*: the orchestrator's own
  context stays polluted when it plans, so its judgment stays the
  degraded thing the logs show. This remains a good habit and is
  subsumed by the SO's roadmap-ownership responsibility.
- **A `planner` subagent the orchestrator invokes between items.**
  Gives clean per-invocation context but no running narrative; the
  orchestrator still owns the (degraded) planning judgment under
  execution load. Rejected for the same reason.
- **Full layer without the attach primitive.** Rejected: the reframe
  case — which the logs show is semi-regular — falls back to the
  lossy relay, and the user will avoid `plan` mode for anything that
  might reframe. Attach is in-scope for v1, not deferred.
- **`plan` mode as a replacement for `orchestrate`.** Rejected: the
  two serve different work-shapes (tight-loop R&D vs large
  independent features). They coexist.

## Files changed (anticipated)

- `agents/orchestrator.md` (new)
- `extensions/modes.ts` — third mode
- `extensions/subagent-async/index.ts` — attach/foreground primitive
  (Half B)
- `APPEND_SYSTEM.md` — super-orchestration section
- `skills/` — possibly a roadmap-doc skill (TBD during Half A)

## Tradeoffs

- **Complexity.** A third mode + a new agent + a new harness primitive
  is substantial surface area. Justified because the three legs above
  are grounded in observed, repeated friction, not hypotheticals.
- **Relay cost on design negotiation.** Real, but amortized: most
  observed "design negotiation" was the user establishing *policy*
  (no redundant fallbacks, fail hard, comptime budgets aggregate)
  that, once captured in the roadmap, never re-needs negotiation.
  Early items relay a lot; later items relay little.
- **Nesting introduces new failure modes** (O misreports, nesting
  depth, attach state bugs). Each has a named mitigation above.

## Validation result (2026-07-19)

Validated live by building a self-contained app (`apps/changelog-gen/`, a
git-log → grouped-changelog TS CLI) as a 5-item roadmap: ITEM-0 scaffold
(sequential) → ITEM-1/2/3 (parser / grouper / renderers, dispatched in
**parallel**) → ITEM-4 (CLI) → ITEM-5 (fix-up). Six `orchestrator`-subagent
dispatches total — the first live use of `plan` mode and the `orchestrator`
agent. Every item passed a bounded parallel review gate (mimo-v2.5-pro
shallow reviewers); gate-keying via `subagent_review_status(<implementer
inner 019f… id>)` confirmed both reviewer kinds on all six, no cap reached.
Final artifact: `tsc` clean, 99/99 tests, and `npx tsx src/cli.ts --since
<date> --format md` produces a correct changelog from real history.

**Verdict: the machinery works.** Plan mode, the `orchestrator` agent,
parallel dispatch + reconcile, and the review gate all functioned under
real load. Ship as-is. The validation surfaced concrete harness improvements:

1. **The SO end-to-end smoke test is load-bearing; the per-module gate is
   not sufficient for integration correctness.** A real parser defect
   (`parseGitLog` left a stray `\n` on every commit's `hash` field on real
   `git log` output, corrupting all rendered output) survived **99 unit
   tests + converged review rounds across two items** — the unit fixtures
   didn't reproduce git's actual byte layout and the integration assertions
   were too loose. Only the SO's smoke test against real history caught it.
   *Action:* the SO smoke step is mandatory, not optional; consider feeding
   real I/O samples into implementer fixtures by default.
2. **Stall detector fires false positives on nested `wait` chains**
   (orchestrator parked in `wait` on an implementer parked in `wait` on its
   reviewers reads as "no turn in 5 min"). Recurred on most items. *Action:*
   the detector should treat nested-wait as activity, or raise a softer
   "nested-wait, probably fine" signal.
3. **Parallel orchestrators editing the shared roadmap churn merge
   conflicts.** Mitigation **proven**: instructing orchestrators to leave the
   roadmap to the SO (ITEM-4/5) eliminated all conflicts. *Action:* bake
   "do not edit the roadmap doc" into the `orchestrator` agent prompt.
4. **Orchestrator work-order scratch files leak into the repo** — the
   isolation auto-commit swept a 290-line `WO-ITEM-5.md` into the branch.
   *Action:* orchestrators should write scratch artifacts to `/tmp`, or the
   harness should exclude `WO-*.md` from the auto-commit.
5. **Benign worktree-guard blocks** — implementers repeatedly tried to read
   `skills/work-order-template/SKILL.md` (protected dir), got blocked,
   continued. *Action:* make skills readable in worktrees, or stop agents
   trying.
6. **mimo-v2.5-pro shallow reviewers validated** — thorough (ran their own
   bash checks on isolation, `@types/node` presence, test counts), verdicts
   converged in 1–2 rounds, no cap hits. The re-tier holds.

Open loose ends (non-blocking): unpushed commits on `main`; dead
`openrouter` minimax/minimax-m3 override in `models.json`; orphan
`pi-subagent-*` worktree branches from this validation (safe to delete).
