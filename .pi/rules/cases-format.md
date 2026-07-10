---
paths:
  - "**/*.cases"
---

# .cases Test Format Reference

A `.cases` file is a behavioral test suite for the tfd compiler. Each test
is a self-contained program with directives delimiting stages.

## Test structure

```
# --- test: test_name ---
[source code]
# --- expect ---
[expected stdout output]

```

A test may have directives:
- `# --- expect ---` — stdout must match exactly.
- `# --- expect_regex ---` — stdout must match the given regex.
- `# --- reject ---` — compilation must fail with the given error message.
- `# --- reject_regex ---` — compilation must fail matching the given regex.
- `# --- ir_contains ---` — emitted IR must contain the specified text.
- `# --- ir_excludes ---` — emitted IR must NOT contain the specified text.
- `# --- ir_count ---` — count of a pattern in emitted IR, with a count header.
- `# --- skip --- [reason]` — skip the test (always passes).

| nyi directives:
- `| nyi` suffix on `# --- test:` marks a Not-Yet-Implemented test.
  NYI tests run but don't affect exit code. When one passes, the output says
  "remove the '| nyi' directive".
- Use `| nyi` for planned syntax/behavior not yet implemented. When the
  feature ships, the NYI test starts passing and prompts cleanup.

## File-level directives

- `//` line comments in the source become token trivia — ignored.
- `/* */` block comments are also parsed as trivia.

## Running

```bash
tfd run tests/fixtures/comments.cases    # Run specific file
python3 tests/run_tests.py               # Run entire suite
```
