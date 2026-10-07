# WO-2026-052 — Checkpoint compaction safety + peer-link lossless delivery

### Metadata

- **work_order_id**: WO-2026-052
- **parent_plan_id**: N/A (incident follow-up: bug-triage session poisoned by checkpoint compaction, 2026-10-06)
- **sequence_position**: N/A
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit
- **priority**: critical
- **estimated_complexity**: moderate
- **review_policy**: required — harness/own-config code; decision 014's hard clause applies

### Task Summary

**One-sentence description**: Stop the checkpoint tool from triggering compaction while its own tool result (or any parallel tool result) is still in flight, and make peer-link delete inbox envelopes only after successful injection instead of on read.

**Goal**: Two harness fixes. (A) `checkpoint` must never produce a session branch where a `toolResult` survives without its assistant `toolCall` — the defect that poisoned a live session into a permanent upstream 400 loop (evidence: `tmp/bug-triage-incident/session.jsonl`, orphan at line 2384, `toolCallId=call_00_ojwZ56uXn5sRUM5x2foy3099`, matching call absent from the entire 2465-line log). (B) peer-link must not lose a message when `sendUserMessage` throws — ack the envelope only after injection succeeds.

### Scope

**Files to modify**:
- `extensions/checkpoint.ts` — move the `ctx.compact()` trigger out of the checkpoint tool's `execute()` to a post-tool-results boundary (`turn_end`), preserving archive/injection/continue behavior.
- `extensions/peer-link/mailbox.ts` — make `readIncoming` non-destructive; add an explicit ack; update the header comment that documents at-most-once "consumed on read".
- `extensions/peer-link/index.ts` — `consumeInbox` acks each envelope only after `pi.sendUserMessage` succeeds; leaves it on throw.
- `tests/peer-link.test.ts` — update the consumption-semantics test and add a failure-leaves-envelope test.
- `tests/e2e-checkpoint.test.ts` — assert no orphan toolResults / dangling checkpoint call after a checkpoint.

**Files to read (reference only, do not modify)**:
- Incident evidence: `tmp/bug-triage-incident/session.jsonl` (gitignored), `tmp/bug-triage-incident/reconstruct-context.mjs` (SDK context reconstruction + pairing audit; run with `node`).
- Installed SDK: `dist/core/agent-session.js` `compact()` (~L1360-1440; `_disconnectFromAgent()` + `await abort()`), `dist/core/extensions/types.d.ts` (`TurnEndEvent` ~L555, `CompactOptions` ~L245), `dist/core/session-manager.js` `buildContextEntries` (~L198-226, no pairing filter), `appendMessage` (~L766-775).
- `extensions/peer-link/mailbox.ts` current read path (~L148-171), `extensions/peer-link/index.ts` `consumeInbox` (~L215-229).

**Files NOT to modify**:
- The pi SDK under `/opt/homebrew/lib/node_modules/@earendil-works/` — upstream; record findings instead.
- `extensions/auto-checkpoint.ts` / `tests/auto-checkpoint.test.ts` — another session's uncommitted work.
- Other extensions, settings, `package.json`.

**Out of scope**: repairing already-poisoned session files; SDK-side orphan filtering; peer-link TTL/dead-letter beyond the ack fix; any change to sender gating, identity, or heartbeat.

### Implementation Specification

**A — Checkpoint: never compact with tool results in flight.**
Today `checkpoint`'s `execute()` calls `ctx.compact({customInstructions: MARKER+summary, onComplete, onError})` directly. The SDK's compact path runs `_disconnectFromAgent()` then `await abort()` before appending the compaction entry, so the checkpoint call's own result is never persisted (all 20 checkpoint calls in the incident log have no result) and a tool result that completes after the compaction is appended with `parentId` = the compaction entry — an orphan `toolResult` whose call was summarized away. The next compaction then inserts the older summary between the assistant `tool_calls` and the orphan, and every provider request 400s forever.

Required behavior:
1. In `execute()`: keep archiving, keep stashing `pendingCheckpoint` (for the `session_before_compact` MARKER path and preserved-file injection), keep returning the "Checkpoint queued." tool result. Do NOT call `ctx.compact()` here. Stash the compaction request instead.
2. Trigger `ctx.compact(...)` from `pi.on("turn_end", ...)` — the SDK emits `TurnEndEvent` with the turn's `toolResults` after tool execution, so the checkpoint result is persisted and no sibling tool execution is still in flight. Verify the emit ordering against the installed SDK (`dist/core/agent-session.js` / the agent loop) before relying on it; if `turn_end` does not fire after result persistence, pick another documented boundary that does and state the evidence in the report.
3. At most one pending compaction request; a later checkpoint call replaces an earlier pending one. Clear the pending request when it fires and in both `onComplete`/`onError`.
4. Preserve exactly: archive-before-compaction, `pendingCheckpoint` injection via `getPreservedPaths`/`buildFileInjection`, the `continue` follow-up (`pi.sendUserMessage(followUp, { deliverAs: "followUp" })`), `onError` notification, and the tool's response text.
5. `checkpoint_fork` must not regress.

**B — Peer-link: ack after delivery, not on read.**
1. `readIncoming()` returns envelopes without unlinking. Add an ack function (e.g. `ackEnvelope(mailbox, name, env)`) used by `consumeInbox` only after `pi.sendUserMessage(text, { deliverAs: ... })` returns. On throw, leave the file in place so the 2-second scan retries; keep the existing `seen`/`pendingReplies` cleanup on failure.
2. Semantics become at-least-once (a crash between send and ack can duplicate) — duplicates are preferable to loss. Update the `mailbox.ts` header comment to say so.
3. Keep exported API backward-compatible where practical; update callers/tests in the same commit.

**Required test boundary**: `tests/peer-link.test.ts` (unit + integration) for B; `tests/e2e-checkpoint.test.ts` for A (real SDK session driving a checkpoint; run `bash tests/setup.sh` first if packages are unlinked).

**Behavior and failure matrix**:

| # | Case | Expected |
|---|---|---|
| 1 | Checkpoint tool called; turn ends normally | Compaction runs after the turn's tool results are persisted; checkpoint call has a matching toolResult; no toolResult parented to a compaction entry |
| 2 | Checkpoint tool called in a turn with another in-flight tool | Compaction waits for that turn's tool results; no late orphan |
| 3 | Second checkpoint call before the first fires | Last request wins; exactly one compaction |
| 4 | `ctx.compact` fails (e.g. already compacted) | `onError` path unchanged; no stuck pending state |
| 5 | Peer envelope injected successfully | Envelope acked (file removed) |
| 6 | `sendUserMessage` throws | Envelope remains on disk; next scan retries; in-memory dedup cleaned |
| 7 | Multiple envelopes, one send throws | Only the succeeded ones are acked |

**Integration contract**: `readIncoming`'s callers must ack explicitly; `checkpoint`'s user-visible behavior (archive, summary, relevantPaths injection, continue) is unchanged.

### Invariants

**Cross-file conventions**:
- Mirrored/existing test suites must stay in sync with behavior changes; no test may be weakened to pass.
- No new dependencies; no SDK edits.

**Default values to preserve**:
- `continue` defaults to true; `nextSteps` defaults to "Continue work"; injection budget fraction unchanged.

**Ordering assumptions**:
- Compaction trigger strictly after the turn's tool results are persisted; the checkpoint result must exist before the summary is prepared.
- Ack strictly after successful injection; never before.

**Error handling conventions**:
- Checkpoint compaction failures remain non-fatal (`onError` notify); peer-link send failures remain logged and retried, never silently dropped.

**Unspecified invariants**: none.

### Verification Criteria

**Tests that must pass**:
- `bun test tests/peer-link.test.ts` — updated consumption test + new failure-retention test.
- `bun test tests/e2e-checkpoint.test.ts` — with new post-checkpoint assertions: (a) every `toolResult` on the active branch has a matching assistant `toolCall`, (b) the checkpoint call has a `toolResult`, (c) no `toolResult`'s `parentId` is a compaction entry.
- Existing suites touching the changed files (e.g. `tests/auto-checkpoint.test.ts` must be left untouched but must not be broken by shared helpers).

**Test surface requirements**: B's failure test must exercise the real `consumeInbox` path (inject a throwing send), not a reimplementation; A's assertions run against a real SDK session.

**Build requirements**: no new warnings; `package.json` unchanged.

### Structural Risks

- [ ] **Route/path correctness**: edits land in the checkpoint trigger and the peer-link read/ack path, not in adjacent helpers.
- [ ] **Input validation scope**: envelope parsing unchanged; no message dropped due to ack changes.
- [ ] **Test surface**: both new tests exercise real paths.
- [ ] **Recovery logic**: retry-on-throw works; no duplicate ack losing a second envelope.
- [ ] **No unrequested changes**: out-of-scope items untouched.
- [ ] **No unsolicited features**: no new abstractions beyond the ack function.

### Context

**Prior work**: WO-2026-051 (subagent latency micro-fixes) landed; `tests/setup.sh` now installs extension deps for fresh worktrees. Incident investigation (2026-10-06) preserved at `tmp/bug-triage-incident/`.

**Upcoming**: SDK-side orphan-tolerance fix is upstream work, not this WO; the poisoned bug-triage session is repaired manually by its owner.

### Completion Report Format

Standard implementer format plus the required review fields (`assumptions_made`, `unexpected_changes`, `issues_encountered`, `test_coverage`, `adversarial_reviews` with both verdicts/session ids/rounds, `review_cap_reached`, `accepted_notes`). In `notes_for_orchestrator`, state the verified SDK event-ordering evidence for the chosen compaction trigger.
