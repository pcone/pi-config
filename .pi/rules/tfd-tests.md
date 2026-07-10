---
paths:
  - "**/*.cases"
---

# Writing tfd Tests

`.cases` files are end-to-end behavioral tests for the compiler. Every test is
a self-contained tfd program with directives. Prefer `.cases` over unit tests.

Full format reference: `tests/run_tests.py` (parser at `_parse_cases_file`).
Conventions: `AGENTS.md` section "Testing".

## Quick template

```cases
# --- test: tested_behavior ---
// Comment explaining what this demonstrates.
let source = code;
print source
# --- expect ---
expected stdout

# --- test: error_case | reject ---
bad code
# --- reject ---
expected error message
```

## Directives

| Directive | What it asserts |
|---|---|
| `# --- expect ---` | stdout must match exactly |
| `# --- reject ---` | compilation must fail, stderr must contain this text |
| `# --- ir_contains ---` | emitted LLVM IR must contain this text |
| `# --- ir_excludes ---` | emitted LLVM IR must NOT contain this text |
| `# --- ir_count ---` | `N  PATTERN` — pattern appears exactly N times |
| `# --- matrix ---` | parameterized template (see runner for syntax) |
| `# --- skip --- [reason]` | always passes |

Flags (after `|` in test name):
- `| nyi` — Not Yet Implemented; runs but doesn't affect exit code.
- `| reject` — shorthand for `# --- reject ---`.

Use `//` line comments in source (token trivia). Use `#` comments in
`ir_contains`/`ir_excludes` sections (skipped by runner).

## Key conventions

- **Tests are documentation.** Start every test with a comment explaining
  what it demonstrates. Happy-path first, then edge cases.
- **IR tests prove codegen.** Always pair with `# --- expect ---` for
  correctness. An empty `# --- ir_excludes ---` means "no exclusions."
- **NYI for gaps.** Write `| nyi` tests for planned features before
  implementing them. For partial optimizations, NYI IR tests cover the
  unoptimized states; when they start passing, remove the flag.
- **Be precise in reject patterns.** Match enough to distinguish the error.

## Running

```bash
python3 tests/run_tests.py                  # all tests
python3 tests/run_tests.py <filter>         # substring filter on name
tfd run tests/fixtures/some-file.cases      # single file
```
