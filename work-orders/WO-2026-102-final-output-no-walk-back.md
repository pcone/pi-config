# WO-2026-102 — the final output is the final message, not an earlier one

### Metadata

- **work_order_id**: WO-2026-102
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit
- **estimated_complexity**: small
- **review_policy**: required
- **order_source**: tfd seat, 2026-11-18, after its own confirmation of the diagnosis ("Your fix 1 is yours to make… Go ahead through your own order"), on the record-gate failures in tfd WO-2026-510 and WO-2026-513 ×2.

### Premise (established)

Three implementer completions on tfd failed the record gate with `completion report
has no deviations_from_spec field; nothing written`, on work that had no report to
give it. `getFinalOutput` (`extensions/subagent-async/worktree.ts:603`) scans
**backwards for the last assistant message that has a text part**, so a child whose
final assistant message carries only thinking/tool calls is answered with an earlier,
mid-work line.

Two session files, both on this box:

- `~/.pi/agent/sessions/--Users-scott-Developer-wt-subagents-tfd-7c26de525fba--/2026-11-17T06-35-36-550Z_subagent-29c58d83-551d-487b-922d-7c26de525fba.jsonl`
  (WO-2026-510): ends `['thinking','toolCall']` then `[]`; the walked-back text is 60
  chars, "Committing the green work first, then I'll write the record."
- WO-2026-513's implementer has the same shape; the reviewer session beside it ends with
  `['thinking','text']` and its entry landed — the discriminator is the session file.

So the walk-back is a fallback answering for a state that has an answer: no final
report. `records.ts:220` already says so ("implementer has no final report") and the
fallback makes it unreachable.

### Scope

`getFinalOutput` and its four call sites. Return the **last** assistant message's text
parts joined by `\n`; return `""` when that message has no text part. Delete the loop.

Call sites, each currently inheriting the walk-back:

| site | what it feeds |
| --- | --- |
| `spawn.ts:776` (`readFinal`) | the work-order record gate's completion text |
| `records.ts:104` (`readSessionExchange`) | a reviewer's recorded `output` |
| `sleep-guard.ts:386` | the stopped/recovered text |
| `sleep-guard.ts:418` | the delivered result text |

### Acceptance rows

1. **Unit, text-less final message.** `[{assistant, text "mid-work"}, {assistant,
   thinking+toolCall}]` → `""`. Red today (returns "mid-work").
2. **Unit, two text messages.** The last message's text only, not the first's.
3. **Record gate.** An implementer session whose final assistant message is text-less
   yields the "implementer has no final report" note and **no** `wo_record` failure
   naming a missing field. This is the regression the seat asked for.
4. **Delivery.** A reportless stopped child delivers the stopped/no-output text rather
   than a stale mid-work line.
5. **Reviewer exchange.** A reviewer whose final message is text-less records an empty
   `output` rather than an earlier line.

**Independent reproduction.** `bug-triage` measured the same session (365 messages, last
`{"role":"assistant","content":[],"stopReason":"aborted"}`) and filed **pi-config#19** with
a red pin at `bug-triage/final-output-walk-back-pin` (`e230137`). It also measured a
second loss the walk-back hides: the old `return` sat inside the part loop, so a message
of `[text, toolCall, text]` yielded only its first part — a report that arrives but
loses its tail. Row 3 covers it.

### Q-102-a (owner question) — does the delivery path want the earlier line?

The record side is settled: a reportless child is reportless, and `""` is the answer.
Delivery is a different question, raised by `bug-triage` and not decided here: the
delivered text for a killed child currently reads `(no output)` (row 5), where the last
thing the child said ("Committing the green work first…") is arguably more use to the
parent than nothing.

- **(a) Keep `(no output)`.** One function, one sense: the final text is the final
  message. The parent gets the kill marker, the task and the stderr note, and reads the
  child's log for progress. **Recommended:** the alternative silently substitutes a line
  the child did not write as its report, which is the fallback this order removes.
- **(b) Delivery keeps an earlier line, labelled.** `deliverResult` appends
  `no final message; last progress: <line>` when the final message carries no text — an
  explicit answer, not a substitution.

**Ruling (owner, 2026-11-18, relayed by the claude seat): "Labelled last progress
(Recommended)".** So (b), scoped as this order scoped it: `sleep-guard.ts:418`'s delivery
reports `no final message; last progress: <line>`, and the row that asserted `(no output)`
changed with it.

Landed shape, one producer answering all three states:

- final message has text → that text, unlabelled;
- final message has no text → `no final message; last progress: <last assistant text>`;
- no assistant text in the run → `no final message; no progress text`.

`getLastProgressText` walks back and is used by delivery **only**; the record path reads
`getFinalOutput`, so a reportless child is still reportless at the gate. Both readers
share one extractor, `messageText`.

### Q-102-b (owner ruling, 2026-11-19): the stop path takes the same label

Owner ruling, relayed by the claude seat: **"Same label on stop (Recommended)"**. Three
things changed under it:

- `deliverCloseResult`'s stop path (`sleep-guard.ts:386`) now resolves the waiter with the
  kill marker above the same text `deliverResult` sends — one producer, both paths, so a
  stopped child's last words are labelled progress rather than dropped or passed as a report.
- The last assistant message counts as a report only when it carries no tool call. A child
  killed during a tool call ends on `[text, toolCall]` (`stopReason: toolUse`) and its text
  is mid-work — treating it as the report is the 510 failure in a narrower shape. Rows for
  both, each red with its check removed.
- `deliverCloseResult`'s `commitNote` is required, so the old optional-append (which would
  interpolate `undefined` for a caller that passed nothing) cannot be reached.

### Debt named, not carried

Two `(no output)` defaults outside this order's scope, unchanged and named so they are not
mistaken for covered: `index.ts:2223` (`resolveOnStop`'s answer to a waiter) and
`recovery.ts:562` (an orphan's log with no readable output). Neither is on this order's
path; a later order that touches the stop path should decide them against Q-102-a's
reasoning.

### Sequencing

Standalone. The order's second half — the `deviations_from_spec` contract — is a
template edit (`skills/work-order-template/SKILL.md`), landed in the same push because
it is the other half of the same report-path complaint and pi-config owns both.

### Verification

- Rows 1-5 red before the change for the reason each names.
- `bin/heavy -- bun test` once; the suite is clean at `13c3a3f` (0 fail on pi 1.5.2) and
  must stay so.
- The template says the field is exactly `none`, or a list, and names the tfd reader
  that treats prose after `none` as departure D1.
- **Landed means `origin/main` holds the sha.** The first push of this order no-opped:
  the shared checkout was on a detached HEAD, so `git push origin main` pushed the
  branch (already up to date) and reported success while the two commits sat on no
  branch. `bug-triage` caught it by comparing `origin/main` against the sha I quoted.
  Verify with `git rev-parse origin/main`, never with the local `HEAD`.
