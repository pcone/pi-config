---
paths:
  - "**/*.cases"
---

# .cases Test Format — Quick Reference

For the full test-writing guide (patterns, IR tests, matrix, NYI, naming
conventions, documentation style) see `tfd-tests.md`.

```
# --- test: descriptive_name ---
[source code]
# --- expect ---
[expected stdout]
# --- reject ---
[expected compile error]
# --- ir_contains ---
[IR pattern expected]
# --- ir_excludes ---
[IR pattern NOT expected]
# --- ir_count ---
N  PATTERN
# --- ir_equals ---
[secondary source whose IR must match first exactly]
```

## Directives

| Directive | Use |
|---|---|
| `# --- expect ---` | Expected stdout (exact match) |
| `# --- expect_regex ---` | Expected stdout (regex) |
| `# --- reject ---` | Expected compile error stderr |
| `# --- reject_regex ---` | Expected compile error (regex) |
| `# --- stderr ---` | Expected stderr for successful run |
| `# --- ir_contains ---` | IR pattern must appear |
| `# --- ir_excludes ---` | IR pattern must NOT appear |
| `# --- ir_count ---` | `N  PATTERN` — exact count |
| `# --- ir_equals ---` | Secondary source, IR must match first |
| `# --- dump-comptime ---` | Run `tfd dump-comptime` |
| `# --- matrix ---` | Parameterized template rows |
| `# --- skip --- [reason]` | Skip test |

## Flags (after `|` in test name)

- `| nyi` — Not Yet Implemented. Runs but doesn't affect exit code.
- `| reject` — Shorthand compile-error test.
- `| arena-dump` — Exercise arena-dump feature flag.

## Comments in tests

- `//` line comments in source → token trivia.
- `/* */` block comments → token trivia.
- `#` lines in `ir_contains`/`ir_excludes` sections → skipped by runner.

## Running

```bash
python3 tests/run_tests.py                # All tests
tfd run tests/fixtures/comments.cases     # Single file
tfd emit-ir tests/fixtures/comments.cases  # Emit IR
```
