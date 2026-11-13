# WO-2026-098 — a parked session wakes when its subagent completes

### Metadata

- **work_order_id**: WO-2026-098
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit
- **estimated_complexity**: medium
- **review_policy**: required
- **order_source**: owner, 2026-11-10, relayed by seat `8f90746f` (quote: "The subagent wait does not wake on a nested child's completion. Make that a bug order of its own … with a row that reproduces a nested implement -> review wait.")

### Task Summary

A session that called `wait` stays parked after the subagent it waits for has finished.
Observed three times this week, most recently costing 2.5 days of wall clock:

- 2026-11-10 08:11Z: implementer `f8aac83f` called `wait` with two reviewer children
  running. Both finished (08:19Z review-tests, 08:27Z review-code, both with written
  verdicts on disk). It was still parked when killed at 2026-11-13 10:37Z.
- The parent of that implementer called `wait` too and stayed parked on it.
- 2026-11-0x: `d6707665`; and the 491 reviewers that died with their parent.

`wait` returns `terminate: true` and stops the turn. The wake-up is
`pi.sendUserMessage(…, { deliverAs: "steer" })` from the close handler
(`extensions/subagent-async/index.ts:975-1008`), the turn-cap path (`:1000`) and
`worktree.ts:578`. A parked session is exactly the receiver that must accept it.

### Scope

Diagnose, then fix the mechanism so a parked turn is woken by the child's completion.
The repro row is the deliverable's core; a fix without a row that fails today is not
this order's fix.

Start from: `extensions/subagent-async/index.ts` (`running` map, close handler,
`wait` tool at `:1966`), `extensions/subagent-async/rpc.ts`, `extensions/lib/waits.ts`,
and 1.4.0's steer delivery (`dist` of the installed pi, `sendUserMessage` /
`deliverAs` semantics for an idle or turn-terminated session).

### Acceptance rows

1. **Nested wait repro.** A session parks with `wait`, its child (an implement-shaped
   stub) parks with `wait` of its own on a grandchild, the grandchild finishes: the
   child's wait wakes, and the parent's wait wakes after the child's completion. The
   row drives the real `wait` tool and the real close path, not a helper that mimics
   them. Prove it red against the current code before the fix, and show the mechanism
   it exposed.
2. **Direct wait repro**, if the nested case is a separate cause: one child finishes
   while the parent is parked — the parent's next turn contains the completion
   delivery. This row failing alone means the nested shape is not the trigger, and
   the report must say so.
3. **The delivery is not duplicated.** A wake-up is one delivery: the row asserts the
   parent's next turn carries the completion once, not one steer per chained cause
   (close handler + turn cap + worktree path all call `sendUserMessage`).
4. **`wait`'s timer is unaffected.** `wait(seconds)` still wakes on time when no child
   completed, and a completion still cancels the timer.
5. **No live session → no crash.** The parked-session path whose `liveSessionCtx` is
   gone stays silent (the comment at `:963-966` names the crash this guards).

### Q-098-a (owner question, ANSWERED 2026-11-14) — row 4's second clause cannot be pinned end to end

> **Ruling (owner, 2026-11-14, session 8f90746f):** "Accept lower-level pin
> (Recommended)". Option (a) — row 4's second clause is satisfied by the timer and
> `clearActiveWait` pins plus the wiring assertion. The rewrite of row 4 was rejected.
> Carried by this order, landed with WO-2026-098.

Row 4 says "a completion still cancels the timer". Asked of the running code, that
sentence has no behavioural witness: on a completion `spawn.ts` removes the child from
`running` before delivery, so the timer callback's own `running.size === 0` guard skips
its steer whether or not `clearActiveWait()` ran. The delivered-message stream is
identical on both paths, and no row can tell them apart.

- **(a) Land the substitution.** Pin the timer's replace semantics and
  `clearActiveWait`'s behaviour on real timers, plus a wiring assertion that the close
  handler calls it. What lands is row 4 minus its second clause, at a lower level.
  **Recommended:** the outcome the row exists for is already pinned; the end-to-end
  witness it asks for needs a second child that outlives the deadline, which tests a
  different behaviour.
- **(b) Rewrite row 4** to say what is observable: "a completion before the deadline
  delivers once, and no timer steer follows it".

Landing record: `docs/investigations/subagent-wake-2026-11.md` § "Order row 4's second
clause, pinned a level lower". Row 4's second clause is read as satisfied at that level;
its wording is unchanged.

### Sequencing

Standalone. Reports `PLAN MISMATCH` with the evidence if the repro rows pass on
current `main` — that would mean the observed park is environmental (killed RPC
socket, a child that never wrote its completion) rather than a delivery bug, and the
order's premise needs the owner.

### Verification

- Each row fails before the fix for the reason it names, with the mutation or the
  pre-fix run shown.
- The report names the mechanism: why the steer never reached the parked turn, and
  which of the four `sendUserMessage` sites was involved.
- Full suite green (one `bin/heavy -- bun test` run) apart from the known pre-existing
  reds: `tests/subagent-model-inheritance.test.ts:493` and the hermeticity row derived
  from it.
- No new public surface: no tool, flag, config key or agent field. If the fix needs
  one, stop and ask.
