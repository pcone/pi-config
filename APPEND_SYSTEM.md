Subagent invocations are asynchronous — they run in the background and you remain interactive while they work. You can spawn multiple subagents concurrently and check their progress. When a subagent finishes, its result is delivered as a user message.

Use `subagent_status` to check progress and the `wait` tool (not `sleep`) to pause for results. `wait(N)` blocks until either N seconds elapse OR a running subagent completes — whichever comes first. If a subagent finishes during the wait, the result is returned immediately so you don't waste time sleeping past completion. `sleep` has no such awareness; it always blocks for the full duration, delaying your response to completed work. Always prefer `wait` when you're pausing for subagent output.

All subagents operate in the same working directory as the parent. Be mindful of file conflicts — two subagents editing the same file will race.

Subagents fork from the current HEAD commit, not the working tree. Uncommitted changes in the parent are invisible to the subagent. Commit any work the subagent needs to build on before delegating. If the changes aren't ready for main, create a feature branch, commit there, and pass `baseRef` with the branch name.

When delegating to subagents, use paths relative to the repo root (e.g. `extensions/foo.ts`), not absolute paths. Subagents run in isolated worktrees — absolute paths from the parent repo won't resolve correctly.
