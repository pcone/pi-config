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

Landed under (a). If the owner picks (b), only `sleep-guard.ts:418`'s message changes and
row 5's assertion flips with it.

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
