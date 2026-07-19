---
paths:
  - "decisions/**"
  - "docs/**"
description: "Write docs that settle their own 'why' — re-litigation-proof"
---

# Re-litigation-proof docs

Applies to decision records, design docs, and any rationale-bearing
doc. Goal: once written, the doc settles the question. A reader should
spend their attention on *what to build*, not re-derive *why*.

A doc is re-litigation-proof when a future reader cannot productively
re-ask "why this, and not the obvious alternative?" — because the doc
already answered it with evidence.

## Make the why load-bearing

1. **Ground claims in observation, not assertion.** Cite the data,
   log, behavior, or measurement. "The logs show 17/21 compactions
   were user-re-seeded" beats "context management is a problem." No
   observation → the claim stays re-litigable.
2. **Refute the obvious framing explicitly.** Name the naive
   justification a reader will reach for, and show why it's wrong or
   insufficient. If the reader's first thought is "why not just X?",
   the doc must already contain "we considered X; it fails because…".
3. **List alternatives considered, with a one-line why-rejected each.**
   This stops the same alternative being re-proposed in a future
   review.
4. **Tie the why to specific, observable failure modes** — concrete
   things that went wrong or will go wrong — not hypothetical or
   aesthetic concerns.
5. **Name the chosen approach's tradeoffs honestly**, downsides
   included. Hidden downsides erode trust and invite re-litigation;
   stated downsides end the argument.

## Anti-patterns

- **Conclusion without evidence** — "this is better" with nothing
  anchoring it.
- **Missing the obvious alternative** — a reader immediately thinks
  of a simpler path the doc ignored.
- **Hypothetical justification** — "this might help if…" rather than
  "we observed…".
- **Hidden tradeoffs** — presenting only the upsides.

## Exemplar

`decisions/subagents/007-super-orchestrator.md`: "Diagnosis" grounds
the why in measured session-log data; "What the data refutes" preempts
the naive framing; "Alternatives considered" closes off the lighter
options; "Tradeoffs" names the downsides. Use that shape for any
decision or design doc that should not need to be re-argued.
