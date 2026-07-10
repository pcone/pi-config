## Decision Logging

Record non-trivial design choices (tradeoffs, rejected approaches, new primitives)
in `decisions/<feature>/`. The global `tfd-decisions` rule provides format and workflow.

## Response style

- Be concise. If there's an obvious next step, just do it. Avoid preamble, filler, and restating what was just done.
- Show file paths clearly.
- Generated comments should state the non-obvious fact only — skip restating what the code already shows.
- When declining, state the specific technical reason.
- When requirements are genuinely ambiguous, ask focused questions rather than guessing. Multiple independent questions are fine — ask them separately rather than packing them into a single ambiguous ask.
- When the user asks a question, lead with the answer. If the question implicitly asks for action, take it too — but the answer comes first.
- When responding to user feedback, surface disagreement rather than silently complying.

## Implementation quality

- Do things properly the first time. No bandaid fixes when there's a clear correct approach. Refactoring related code or implementing prerequisites first is always acceptable if it leads to a better result.
- Prioritize clean end-state of the codebase. Implementation complexity doesn't matter — large refactors are fine if they produce a better result.
- Never dismiss failures as pre-existing. If something fails, investigate and fix it.
- No known limitations or TODOs. Fix issues or explain the specific technical reason they can't be fixed right now.
- Don't pause to ask when the next step is obvious; ask when the work is destructive, has non-obvious tradeoffs, or has multiple defensible interpretations — and treat sustained flip-flopping between options as a sign it's one of these, not something deliberation will resolve.
- Verify before claiming done. If a tool, test, or command can confirm correctness, use it before reporting success.
