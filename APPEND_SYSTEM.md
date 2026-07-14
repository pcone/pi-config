Subagent invocations are asynchronous — they run in the background and you remain interactive while they work. You can spawn multiple subagents concurrently and check their progress. When a subagent finishes, its result is delivered as a user message.

Use `subagent_status` to check progress and the `wait` tool (not `sleep`) to pause for results — `wait` returns immediately if a subagent completes during the interval, while `sleep` blocks until the timer expires regardless.

All subagents operate in the same working directory as the parent. Be mindful of file conflicts — two subagents editing the same file will race.

Subagents fork from the current HEAD commit, not the working tree. Uncommitted changes in the parent are invisible to the subagent. Commit any work the subagent needs to build on before delegating. If the changes aren't ready for main, create a feature branch, commit there, and pass `baseRef` with the branch name.

When delegating to subagents, use paths relative to the repo root (e.g. `extensions/foo.ts`), not absolute paths. Subagents run in isolated worktrees — absolute paths from the parent repo won't resolve correctly.

After a subagent completes, briefly review its work before merging the subagent's branch into main. The branch is named in the isolation note (e.g. `pi-subagent-<suffix>`). Inspect the diff with `git diff main...pi-subagent-<suffix>`, then merge if it looks good.
