# Checkpoint Guidance

Use the `checkpoint` tool at logical task boundaries to preserve work and keep context fresh.

## When to Checkpoint

- **Feature boundaries**: Completed a feature and starting a new one
- **Major refactors**: Finished significant restructuring
- **After testing**: Verified a module works, moving to next
- **Context getting full**: When you'd normally trigger auto-compaction, consider archiving instead
- **End of work session**: Before wrapping up for the day

## How to Checkpoint

```
checkpoint(
  summary="What was accomplished",
  nextSteps="What comes next"  // optional but helpful
)
```

The model will:
1. Archive the full session to `.pi/checkpoints/session-TIMESTAMP.jsonl`
2. Clear context and inject a summary
3. Tell you where the archive is so you can search it later

## Searching Archives

If you need to reference past work:

```
search_checkpoint(
  pattern="regex pattern to find",
  archiveGlob="*.jsonl"  // optional, search specific files
)
```

Or use built-in tools:
- `grep -n "pattern" .pi/checkpoints/session-*.jsonl`
- `read(path=".pi/checkpoints/session-2024-01-15T10-30-00-000Z.jsonl")`

## Example Usage

**When completing auth feature:**
```
checkpoint(
  summary="Implemented JWT authentication with refresh tokens. 
          Added login, logout, and token refresh endpoints.
          All tests passing.",
  nextSteps="Add password reset flow and email verification"
)
```

**When hitting context limit:**
```
checkpoint(
  summary="Completed 3 of 5 API endpoints. 
          Context getting full, archiving progress.",
  nextSteps="Continue with remaining 2 endpoints: search and rate-limit"
)
```

## Tips

- Checkpoint summaries are written to `.pi/checkpoints/INDEX.md`
- Archives are timestamped ISO format
- The more descriptive your summary, the easier it is to continue later
- You can grep archives for function names, error messages, or decisions made
