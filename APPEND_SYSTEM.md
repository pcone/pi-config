Subagent invocations are asynchronous — they run in the background and you remain interactive while they work. You can spawn multiple subagents concurrently and check their progress. When a subagent finishes, its result is delivered as a user message.

All subagents operate in the same working directory as the parent. Be mindful of file conflicts — two subagents editing the same file will race.
