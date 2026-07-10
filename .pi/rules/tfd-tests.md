---
paths:
  - "**/*.cases"
---

# Writing tfd Tests

`.cases` files are end-to-end behavioral tests for the compiler. Every test is
a self-contained tfd program with directives.

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

## Philosophy

- **100% coverage goal.** Every supported path and failure mode should have a
  `.cases` test. Prefer descriptive happy-path examples first, then exhaustive
  edge cases.
- **`.cases` over unit tests.** `.cases` tests only assert on `tfd run`/`tfd
  emit-ir`'s observable behavior, so they're portable to any future
  implementation. Unit tests are tied to this Rust codebase and become debt
  if it's ever reimplemented. Reach for a unit test only when "no `.cases`
  test would catch a regression here" is genuinely true.
- **IR tests prove codegen paths.** Tests for non-semantic codegen behavior
  (LUR, in-place mutation, no-copy optimizations) belong in IR tests
  (`tests/fixtures/ir/`), alongside a `.cases` test with same input/output:
  `.cases` verifies correctness, IR verifies the fast path was actually taken.
- **Partial optimizations need NYI gap tests.** When an optimization fires
  for some valid states but not all, add `| nyi` IR tests covering the
  unoptimized states. When the gap is closed, the NYI test passes and prompts
  removal of the directive.

## Running

```bash
python3 tests/run_tests.py                  # all tests
python3 tests/run_tests.py <filter>         # substring filter on name
tfd run tests/fixtures/some-file.cases      # single file
```
