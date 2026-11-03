# WO-2026-064 — a pending wait is session state, and a checkpoint continues only when none is pending

**Status: DISPATCHED 2026-11-02.**

### Metadata

- **work_order_id**: WO-2026-064
- **parent_plan_id**: [decision checkpoint/003](../../decisions/checkpoint/003-wait-state-survives-checkpoint.md)
- **routed_to**: implement
- **invariant_exhaustiveness**: implicit
- **priority**: high (the tfd seat resumed work a minute after being told to hold for a restart)
- **estimated_complexity**: moderate
- **review_policy**: required

### Task Summary

A session can be waiting on someone: the owner's ruling, a restart, a peer's reply, a subagent still to gate. Nothing carries that across a checkpoint today — it lives in prose the checkpoint discards — so the follow-up starts new work. Make the wait session state, and let it decide whether the checkpoint continues.

### Rulings

- [checkpoint/003](../../decisions/checkpoint/003-wait-state-survives-checkpoint.md), owner 2026-11-02: "Yes, add it (Recommended)". A seat sets a wait itself through a `wait` tool or a `wait: true` checkpoint flag; running subagents and unanswered outbound `expectReply` sends count as waits automatically; `continue` left unset continues only when no wait is pending, and an explicit `true` or `false` overrides. The choice between a tool and a flag is left to the implementer — Mechanism 2 pins it.
- Same decision, owner 2026-11-02: "Don't hold mail (Recommended)". Mail still starts a turn while a seat waits. The wait carries across that turn; a waiting seat answers and goes back to waiting. Do not gate peer-link.
- Same decision, owner 2026-11-03: "Any msg from peer (Recommended)". Any envelope from the peer a wait names ends that peer's waits; `inReplyTo` stays the fast path. External sends are recorded; `external.ts` is untouched.
- Same decision, owner 2026-11-03: "Copy the wait (Recommended)". `checkpoint_fork` copies the source's manual-wait snapshot into the new session.
- [checkpoint/003](../../decisions/checkpoint/003-wait-state-survives-checkpoint.md): wording alone is rejected as the fix. The wait is never inferred from `nextSteps` or any other prompt text.

### Premises (verify first; on a false one stop with `PREMISE FALSIFIED`)

- **P1.** `pi.appendEntry(customType, data)` writes a durable entry that is in the session branch, survives compaction, and never enters LLM context; `ctx.sessionManager.getEntries()` reads the branch back on a later process. Confirmed for `auto-checkpoint` (idle toast) and `session-trim` (`TRIM_MARKER`), which is why the state store is built on it rather than a new file.
- **P2.** `subagent-async` can answer "which children of this session are still running" outside a checkpoint (`listInFlightSubagents` with a live session id).
- **P3.** `peer-link` can tell an outbound `expectReply` send from its reply: replies carry `inReplyTo`, and the same scan that delivers mail can match them.

### Mechanism

1. **One place a wait lives.** New `extensions/lib/waits.ts`. A wait is `{ id, kind, reason, since, source }` with `kind ∈ {owner, peer, restart, subagent, other}` and `source ∈ {manual, derived}`. Manual waits are persisted; derived waits are computed on demand.
2. **Surface — a tool, not a checkpoint flag.** Register `wait_for` (why not `wait`: pi already ships a `wait` tool that collects subagents). Two shapes:
   - `wait_for({ reason, kind? })` — add a manual wait; returns the full pending list.
   - `wait_for({ clear: true, id? })` — drop one manual wait, or all of them; returns what remains.
   An explicit wait outside a checkpoint matters: a seat told "hold, I'll restart you" has not necessarily checkpointed yet.
3. **Persistence.** Every change writes a full snapshot with `pi.appendEntry("checkpoint-wait", { waits })`, and the store rebuilds from the branch by taking the last such entry (P1). Full snapshot, not deltas: replay is then order-insensitive and a lost entry costs nothing. Compaction keeps the entry; a restart reads it back.
4. **Derived waits.** Extensions register their own sources into `waits.ts`; nothing is imported across features.
   - `subagent-async` registers one `subagent` wait per child in this session's running map (P2).
   - `peer-link` registers one `peer` wait per outbound `expectReply` with no reply yet: record the id when sending, drop it when an inbound envelope with that `inReplyTo`, or any envelope from that peer, arrives in the delivery scan (P3; checkpoint/003 ruling 3).
   A derived wait clears when its source ends. A manual wait clears only through `wait_for({clear:true})` — no inbound message clears it, because the owner's ruling says a waiting seat answers mail and goes back to waiting.
5. **Continuation resolution.** One function, used by `checkpoint`, `checkpoint_fork` and the `/checkpoint` command path: `continue` unset → continue only when `collectWaits()` is empty; `true` → continue; `false` → stop. Never read `nextSteps`.
6. **The model must see it.** The checkpoint tool result lists the pending waits and the resolved outcome (`1 wait pending — peer reply from bug-triage → not continuing`). A model that forgot the wait still learns the session is holding.
7. **Kickoff carries the wait forward.** The follow-up sent after compaction, and the context injected at `session_start` after a restart or resume, both open with `WAITING ON: <kind> — <reason>` and state the rule: answer what arrives, start nothing else. That is how a restarted seat learns at kickoff that a wait is still pending.
8. **Mail is not held.** No change to `peer-link`'s delivery, no steering or queueing changes. A waiting session is still woken by mail, answers, and returns to its wait.

### Rejected alternatives

- **`wait: true` on `checkpoint` alone.** A wait has to exist before the checkpoint that carries it, and a seat told to hold without checkpointing would have no way to record it. The tool covers both; the checkpoint flag covers one.
- **Naming the tool `wait`.** It collides with pi's built-in `wait`, which collects subagent results; two tools with one name is a trap for the model and for `/`-completion.
- **Inferring the wait from `nextSteps` or from the last user message.** The confirmed incident passed `continue: true` with a 4 kB `nextSteps` that never mentioned the restart. Prose is the thing that failed; the decision forbids it.
- **Holding mail while a wait is pending.** Rejected by the owner 2026-11-02: the wake-up was not the defect, and holding mail would leave the very message that ends the wait unread.
- **Clearing the wait when any message arrives.** A waiting seat answers peer questions mid-wait; treating an answer as "work resumed" would clear the wait on the first message.

### Preparatory refactor

`checkpoint.ts` resolves continuation twice and assembles the kickoff twice — `checkpoint` around lines 600–680 and `checkpoint_fork` around 740–830. Extract one `resolveContinuation(params, waits)` and one `sendKickoff(parts, waits)` into the new module and call them from both, **before** any wait logic exists, so the rule is written once rather than copied into a second site.

Characterization: `tests/e2e-checkpoint.test.ts`, `tests/checkpoint-recoverability.test.ts`, `tests/checkpoint-meta.test.ts` pass unchanged at the refactor commit — the live-model rows in `e2e-checkpoint` are red on this account before and after, and the refactor commit must not change which rows are red.

### Acceptance

Each row fails with its mechanism reverted; show the revert. No row needs a live model: every one is driven through the extension API against a stub ctx.

1. `wait_for({ reason })` records a manual wait and the tool result lists it.
2. With a manual wait pending and `continue` unset, compaction sends **no** follow-up.
3. With a manual wait pending and `continue: true`, the follow-up is sent **and** names the wait.
4. With no wait present and `continue` unset, the follow-up is sent (the pre-existing default, pinned so the derivation cannot silently flip it).
5. A running subagent is a wait: `continue` unset sends no follow-up; the same call with the child gone from the running map continues.
6. An outbound `expectReply` is a wait until a reply carrying its `inReplyTo` arrives; before the reply, `continue` unset stops, after it, `continue` unset continues.
7. The wait survives the process: a snapshot written by one call is replayed from the branch by a fresh store instance, and the `session_start` context names it.
8. `wait_for({ clear: true })` drops it, and the next checkpoint with `continue` unset continues.
9. A peer envelope arriving during a wait starts a turn, does **not** clear a manual wait, and the next checkpoint with `continue` unset still stops.
10. The checkpoint tool result names the pending wait and the resolved outcome, including when the model passed `continue: true` against a pending wait.
11. An `expectReply` to an external peer is a wait, and an envelope from that peer without `inReplyTo` clears it; an envelope from a different peer does not.
12. `checkpoint_fork` with a manual wait pending writes the snapshot into the new session: a store on the new session's branch replays it.

### Docs

- New `docs/design/checkpoint-waits.md`: what a wait is, the two kinds (manual, derived), where it is stored and why that survives both compaction and restart, how it clears, and what the model sees at checkpoint and at kickoff. Reference text, not a tutorial.
- `extensions/checkpoint.ts` header and the `continue` parameter description: the derivation rule, replacing "if true (default)" with "unset continues only when no wait is pending".
- `decisions/checkpoint/003` § Outcome: commit ids, once landed.

### Prohibitions

- No wait inferred from prose — not `nextSteps`, not the last user message, not the summary.
- No change to peer-link delivery, steering or queueing: mail is not held (owner ruling 2026-11-02).
- No change to the compaction trigger (`agent_settled`), the archive path, or the read-injection machinery.
- No new dependency, no new timer or poll loop, no writes outside the session file and the repo.
- A manual wait is never cleared by an inbound message; only `wait_for({clear:true})` clears it.
