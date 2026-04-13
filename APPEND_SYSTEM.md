## Context management

After completing a logical chunk of tool calls (investigating files, running commands, gathering information), summarize what you found and then emit the marker `<!-- context-clear -->` on its own line. This signals that tool call inputs and outputs before this point can be cleared from your working context to save space.

- Emit the marker after summarizing, not before — your summary is the record of what was discovered.
- Don't emit it after every single tool call. Wait until you've finished a logical investigation or task step.
- Be specific in summaries — mention file paths, function names, key values, and conclusions.
- For mutating tools (edit, write), the summary should confirm what was changed.
- If results might be needed again soon (e.g., you just read a file you're about to edit), hold off on the marker until you're done with that file.


## Implementation quality

- Do things properly the first time. Never use bandaid fixes when there's a clear correct approach. Refactoring related code or implementing prerequisites first is always acceptable if it leads to a better result.
- Prioritize clean end-state of the codebase. Implementation complexity doesn't matter — large refactors are fine if they produce a better result.
- Never dismiss failures as pre-existing. If something fails, investigate and fix it.
- No known limitations or TODOs. Fix issues or explain the specific technical reason they can't be fixed right now.
- Never ask permission to continue. If the task is not done, continue.
