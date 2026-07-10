---
paths:
  - "**/*.cases"
  - "tests/**"
---

# tfd Test Writing Guide

Patterns and conventions for writing `.cases` behavioral tests for the tfd
compiler. Verified against `tests/run_tests.py` and `AGENTS.md`.

Behavioural tests are the primary test mechanism (preferred over unit tests).
Every `.cases` file is a suite of self-contained test programs compiled and
run by tfd.

## Quick reference

```cases
# --- test: descriptive_name ---
// One or more lines of tfd source code.
// Test directives follow.
# --- expect ---
expected stdout output

# --- test: compile_error | reject ---
let x = "hello" + 42
# --- reject ---
type mismatch

# --- test: ir_optimization ---
let x = 42;
print x
# --- expect ---
42
# --- ir_contains ---
@llvm.return_with_phi(...)
# --- ir_excludes ---
store i32
```

## Test kinds

Each test is classified by which directives it contains:

| Kind | Directives | What it asserts |
|---|---|---|
| `run` | `# --- expect ---` | Compile + run the program, compare stdout exactly |
| `reject` | `# --- reject ---` | Compiler must fail with exact stderr patterns |
| `ir` | `# --- ir_contains ---` / `ir_excludes` / `ir_count` / `ir_equals` | Assert on emitted LLVM IR. Usually paired with `# --- expect ---` for correctness |
| `dump-comptime` | `# --- dump-comptime ---` | Run `tfd dump-comptime`, compare output |
| `arena-dump` | `| arena-dump` flag | Exercise the `arena-dump` feature flag |

The runner infers the kind from whichever directives are present (an `| reject`
flag also counts; `| arena-dump` flag also counts). A test with both
`# --- expect ---` and `# --- ir_contains ---` is an `ir` kind that also
verifies runtime correctness.

## All directives

| Directive | Used in | Description |
|---|---|---|
| `# --- expect ---` | run, ir | Expected stdout (exact match) |
| `# --- expect_regex ---` | run, ir | Expected stdout (regex match) |
| `# --- reject ---` | reject | Expected compile error message in stderr |
| `# --- reject_regex ---` | reject | Expected compile error (regex) |
| `# --- stderr ---` | run, dump-comptime | Expected stderr patterns for *successful* run |
| `# --- ir_contains ---` | ir | Pattern that must appear in emitted LLVM IR |
| `# --- ir_excludes ---` | ir | Pattern that must NOT appear in emitted IR |
| `# --- ir_count ---` | ir | `N  PATTERN` — pattern must appear exactly N times |
| `# --- ir_equals ---` | ir | A second source block whose IR must match the first exactly |
| `# --- dump-comptime ---` | dump-comptime | Run `tfd dump-comptime`, compare output |
| `# --- matrix ---` | any | Parameterized test via template substitution |
| `# --- skip --- [reason]` | any | Skip this test (always passes) |

Test flags (after `|` in test name):

| Flag | Effect |
|---|---|
| `| nyi` | Not Yet Implemented — runs but doesn't affect exit code. Remove when it starts passing. |
| `| reject` | Shorthand for compile-error test (same as `# --- reject ---`) |
| `| arena-dump` | Test is for arena-dump feature flag |

## File organization

```
tests/fixtures/
├── <feature>.cases        # Feature tests (preferred location)
├── ir/                    # Codegen optimization tests (ir_contains/excludes/count)
│   ├── alloc.cases
│   ├── arrays.cases
│   └── ...
├── data/                  # Non-test data files
├── *.tfd                  # Individual .tfd files for manual runs
├── *.expected             # Expected output snapshots (paired with *.tfd)
└── bench/                 # Benchmarks
```

Naming convention: `<feature>.cases` for feature tests (e.g. `arrays.cases`,
`effects.cases`). Use the feature's concise name (from the glossary), not
a long description.

## Naming tests

```
# --- test: descriptive_snake_case ---
```

- Use `snake_case` names.
- Be specific: `abort_never_returning_makes_else_reachable` not `abort_test`.
- Group conceptually: keep related tests in the same file.

## Tests as documentation

The primary audience for test files is future developers reading them to
understand the language. Every test should serve as a clear example.

```cases
# --- test: abort_in_branch ---
// abort as a branch in an `if` expression — the type widens to Never.
let classify = (n: i32): String ->
    if (n < 0) abort("negative")
    else if (n == 0) "zero"
    else "positive";
print classify(0);
print classify(5)
# --- expect ---
zero
positive
```

Guidelines:
- **Start with a comment** explaining what the test demonstrates and why.
- **Prefer descriptive happy-path examples first**, then exhaustive edge cases.
- **Use `//` line comments** in the source block (not `#` comments) —
  these become token trivia and are valid tfd syntax.
- **First test in a file** should be the simplest possible example. Later
  tests add nuance.

## IR test patterns

IR tests verify codegen behavior. Structure:

```cases
# --- test: scope_arena ---
// A large value inside a `{}` scope block should be automatically arena-allocated
// from a per-scope arena. The scope arena is initialised on entry, used for
// the allocation, and freed on block exit.
let BigStruct = struct { a: i32, b: i32, c: i32, d: i32, e: i32 };
let result = {
    let x: BigStruct = { a: 42; b: 0; c: 0; d: 0; e: 0 };
    x.a + 1
};
print result
# --- ir_contains ---
# A [3 x i64] scope arena is allocated on the stack.
%scope_arena = alloca [3 x i64]
# The scope arena is initialised with a 4 KiB capacity.
call void @arena_init(ptr %scope_arena, i64 4096)
# The on-heap value is allocated from the scope arena.
@arena_alloc_no_hdr(ptr %scope_arena
# --- ir_excludes ---

```

Patterns:
- **Always pair with `# --- expect ---`** to verify correctness in addition
  to IR assertions. The IR test proves the fast path was taken; the expect
  proves the result is correct.
- **Use `#` comments** inside `ir_contains`/`ir_excludes` sections to
  document each pattern. The test runner ignores these comment lines.
- **`ir_contains`** proves a codegen feature fires. Keep patterns minimal —
  just enough to be unique.
- **`ir_excludes`** proves a fallback path was NOT taken. An empty
  `ir_excludes` section (just `# --- ir_excludes ---`) means "no exclusions".
- **`ir_count`** asserts exact pattern count:
  ```
  # --- ir_count ---
  3  call void @llvm.memcpy
  ```
  The pattern must be `N  PATTERN` — N occurrences, then two spaces, then the pattern.

Where IR tests live:
- `tests/fixtures/ir/` for codegen optimization tests
- Main `tests/fixtures/` for feature tests that happen to have IR side-effects

## Matrix parameterization

When a test needs to run with multiple input values, use `# --- matrix ---`:

```cases
# --- test: add ---
# --- matrix ---
# variant=A | x=1 | y=2 | result=3
# variant=B | x=10 | y=20 | result=30
let a = {{x}} + {{y}};
print a
# --- expect ---
{{result}}
```

Rules:
- `variant` key is **required** — becomes the label suffix: `group/add{A}`.
- Each row produces a separate TestCase via `{{key}}` substitution in all
  sections (source, expect, reject, ir_*, etc.).
- Use `\|` to escape pipe characters inside values.
- Use `\\n` for multiline values (e.g. complex expect/ir blocks).
- The first non-comment line after the matrix rows transitions to the source
  section. Everything before that line (including blank lines with `#` prefix)
  is part of the matrix section.

## NYI tests (`| nyi`)

Use for planned syntax/behavior not yet implemented:

```cases
# --- test: planned_feature | nyi ---
// This syntax is planned but not yet implemented.
let x = planned_syntax();
# --- expect ---
42
```

When NYI tests pass, the runner prints `remove the '| nyi' directive from the
test case`. Remove the flag at that point.

Key rules:
- **Write NYI tests before implementing** the feature (test-driven).
- **A passing NYI test becomes a regular test** — the flag protects against
  accidental regression while the feature is in-progress.
- **Partial optimizations** (e.g. LUR fires for some types but not all):
  add NYI IR tests for the unoptimized states. When the gap is closed, the
  NYI test starts passing and prompts cleanup.

## Reject tests (compile errors)

```cases
# --- test: type_mismatch | reject ---
let x: i32 = "hello"
# --- reject ---
type mismatch
```

- Use `| reject` flag OR `# --- reject ---` section (both work).
- `# --- reject ---` patterns are matched against stderr. Each pattern must
  appear as a substring. Order doesn't matter.
- Be precise — match enough to distinguish the error from other errors.
- If the test name is self-documenting, a comment is optional but still
  preferred.

## Stderr patterns for successful runs

Use `# --- stderr ---` when a successful program produces expected stderr
output (e.g. diagnostic messages during compilation):

```cases
# --- test: generates_warning ---
// A program that compiles successfully but emits a warning to stderr.
let x = some_expression;
print x
# --- expect ---
expected_output
# --- stderr ---
expected warning text
```

## Running tests

```bash
# Run all tests
python3 tests/run_tests.py

# Run tests matching a filter (substring match on label)
python3 tests/run_tests.py abort

# Run a specific suite
python3 tests/run_tests.py --suite core
python3 tests/run_tests.py --suite arena-dump

# Force AOT (compile+link) instead of JIT
python3 tests/run_tests.py --aot

# Run with specific parallelism
python3 tests/run_tests.py --jobs=8

# Quick iteration on one test file
tfd run tests/fixtures/comments.cases
tfd emit-ir tests/fixtures/comments.cases

# Run all tests with filter
tfd run tests/fixtures/arrays.cases
```

## Common pitfalls

- **Blank lines in expect/reject sections matter.** Leading/trailing blank
  lines are trimmed by the parser, but interior blank lines are significant.
- **`//` line comments** are token trivia — they work inside source code
  but `#` comments are directive-level only (not in source).
- **`#` comments** in `ir_contains`/`ir_excludes` sections: lines starting
  with `#` are skipped by the test runner. Use them to document each pattern.
- **Multi-line expect/reject** — include the exact output including any
  newlines. Trailing blank lines are stripped.
- **`| reject` flag** at the test level means ALL source is expected to
  fail compilation. You can also use `# --- reject ---` section (no flag)
  when you want to test both compilation success and check stderr patterns.
