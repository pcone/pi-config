---
title: "Checkpoint compactions own their summary text"
type: decision
status: active
date: 2026-10-31
---

# Checkpoint compactions own their summary text

**Ruling (owner, 2026-10-31).** A checkpoint's stored summary is the text
`checkpoint.ts` composes, verbatim: the authored fields
(`goal / filesTouched / decisions / triedAndFailed / constraints / nextSteps`)
followed by a machine block of facts only tooling knows. No model rewrites it.
`compaction-model.ts` returns `undefined` on the `[CHECKPOINT]` marker before
making any fleet call, so ownership is decided by a predicate, not by whether
the fleet call happens to fail.

`/compact` and auto-compaction (`threshold` / `overflow`) keep the fleet seat.
They have no authored text to preserve, so the ruling does not reach them.

The machine block appended to the authored text:

| Fact | Source |
|---|---|
| in-flight subagents — sid, agent, branch, state, resume call | `listInFlightSubagents` |
| git HEAD / branch / dirty / ahead-behind at the boundary | `captureGitBinding` (needs ahead-behind) |
| files read and modified, merged across preceding checkpoints | `preparation.fileOps` + last compaction's `details` |
| archive path and the `rg` hint | `archiveSession` return |
| `relevantPaths` injection text | `buildFileInjection` |
| token delta before/after | `preparation.tokensBefore`, result |

**Why not the fleet summary.** The fleet path writes a well-structured
summary and retains the authored facts, because the authored text arrives as
`customInstructions`. Measured on the three checkpoints of session
`01a190c3` (2026-10-31), that does not make it better:

- Every distinctive authored fact survived (`b90479617`,
  "unmeasured, not rejected", `C355`, `A19/A46`, `merge-base --is-ancestor`,
  `DEFERRAL_WITHOUT_CARRIER` …) — but no authored line survived verbatim
  (0/20 and 0/14), so the text the author wrote is rewritten, not carried.
- About half the extra volume was not information: 26% of checkpoint #3 was a
  `Turn Context (split turn)` re-narration of the same turn (46% in #2), and
  26% was rulings restated for the fourth time in the same document.
- The genuine additions were semantic — measurements, register rows, tool
  gotchas — and the archive already stores those in full and greppable, with
  the path printed in the summary. Paraphrase is not the only way to recover
  elided detail; it is the lossy one.

Determinism is the deciding argument. The same tool call produced two
different summary shapes in one session (#1 verbatim, #2/#3 fleet), with no
notice to the reader. The shape depended on a fleet call succeeding.

**N/A is explicit.** Every field is required and non-blank. The literal
`"none"` / `["none"]` is the N/A token, as the schema descriptions already
say; `[]` and omitted fields are rejected with a tool error naming every
offending field. A checkpoint whose fields are all N/A is a checkpoint that
had nothing to say.

**No `usage` on checkpoint entries (owner, 2026-10-31).** With no summariser
call there is no usage to record, and session totals correctly exclude
checkpoint summarisation.

**Rejected.**

- *Fleet rewrite for checkpoints* — current behaviour, non-deterministic, and
  it demotes the authored text to a summariser hint.
- *Hybrid: authored text as `customInstructions`, fleet text as the summary* —
  the shape #2/#3 took when the fleet call succeeded. Same defects as above
  plus a silent dependency on a network call.
- *Re-using the fleet summary's structure and generating the machine block
  separately* — a generated document and a machine block in one entry means
  two summarisation schemas to keep in sync, for no fact the block lacks.

**Supersedes.** `docs/investigations/checkpoint-sanity-check-2026-10.md` §5.2's
"the override never fires in this environment" (true on pi 0.83.0; the 1.4.0
fleet path succeeds, which is what armed the override) and §7 Q1. Mechanism
lands in WO-2026-061 (dispatch predicate) and WO-2026-062 (composition,
machine block, field validation).
