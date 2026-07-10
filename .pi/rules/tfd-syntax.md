---
paths:
  - "**/*.tfd"
---

# tfd Syntax Cheatsheet

Brief overview of tfd syntax for editing `.tfd` files. Verified against
compilable source in `tests/fixtures/` and `docs/llm/tfd-syntax-semantics.md`.
Full reference in `docs/language/` and `docs/design/`.

## Bindings

- `let x = expr` — sequential binding; RHS sees only names above. Shadowable.
- `def f = expr` — forward-visible within its scope. **Cannot be shadowed** by
  `let` or `def` in the same scope. Use for mutual recursion.
- `x := expr` — shadow-rebind sugar for `let x: T = expr` where T is the
  current declared type of `x`. `x += rhs` desugars to `x := x + rhs`.
  Cannot rebind a `def` (compile error). Does **not** escape `{}` blocks.

```tfd
let p = { x: 1; y: 2 };
p.x := 7;                      // field rebind
let n = 0;
n += 5;                        // compound assign sugar
```

## Blocks, expressions, separators

Everything is an expression; no statements. Semicolons separate, don't terminate.

- `{ ... }` — scope boundary. New binding scope, new arena. Block's value is
  its trailing expression, OR a struct assembled from `field: value` and
  `...expr` spread lines. Mixing is a compile error.
- `if (cond) expr else expr` — **no `then` keyword**. Not a scope boundary:
  `:=` in a branch persists. Use `{ }` in the branch for an explicit scope.
- `match x { T as name => expr, ... }` — pattern match on union types.
  `Type as name =>` binds matched value; `Type =>` auto-shadows; `_ =>`
  wildcard. Multi-expression arm bodies go in a `{ }` block.
- `if (x is T) expr else expr` — sugar for `match x { T => expr, _ => expr }`.
  The then-branch sees `x` narrowed to `T`.

```tfd
match opt {
    i32 as n => abort("zero not allowed"),
    String as s => s
}
```

## Arrows: `->` for functions, `=>` for match arms

- `(args) -> expr` — single-expression body with `->` (ThinArrow).
- `(args): RetType -> expr` — annotated return type.
- `(args) -> { ... }` — block body.
- Match arms use `=>` (FatArrow): `Type as name => expr`.
- Effect rows before `->`: `(args) ~[E1, E2] -> expr`.

```tfd
let add = (a: i32, b: i32) -> a + b;
let f   = (a: i32, b: i32): i32 -> { let s = a + b; s * s };
let pure_fn    = () ~[]-> 42;
let effectful  = (n: i32) ~[Write] -> { Write.write("hi"); n * 2 };
```

## Types

- Primitives: `i8`–`i128`, `u8`–`u128`, `f16`/`f32`/`f64`, `bool`, `String`,
  `usize`, `Never` (bottom, no inhabitants), `nothing` (unit).
- Struct types: `struct { x: f64; y: f64 }` (semi-colons in type decls;
  commas also accepted). In annotation position, `struct` may be omitted.
- `Union(A, B)` — tagged union, narrowed via `match` or `is`.
- `let nominal Name = T` — nominal wrapper, constructed via `Name(value)`.
- `(x: T) -> bool` — refinement predicate; erased at codegen.
- `T on heap` — heap-allocate the value in the caller's arena; auto-derefs on
  read.
- `@c_struct` attribute on a struct types it for FFI to C.

Literal suffix pinning: `42u64`, `1.0f32`, `2.0i32`.

```tfd
let nominal UserId = i32;
let uid = UserId(42);
let Positive = (n: i32) -> n > 0;
```

## Lambdas, methods, impl blocks

- `(args) -> expr` — single-expression body. `(args): RetType -> expr` adds
  the return type with ThinArrow. `(args) -> { ... }` — block body.
  Parameter types required.
- Methods are struct function fields called via dot syntax: `obj.method()`
  desugars to `method(obj)`. Standalone functions don't enable dot dispatch.
- `impl TypeName { def m = (self) -> ... }` — attach methods to a type.
  `impl structural TypeName` for shape-based dispatch.
  `impl Predicate for Target` for trait conformance.
- `obj.=next()` sugar: `let (val, obj) = obj.next()` — iterator state advance.
- Partial application with `_` placeholder: `add(5, _)` produces
  `(b: i32) -> add(5, b)`.

```tfd
impl Point {
    distance_to: (self, other: Point) ->
        ((self.x - other.x) ** 2 + (self.y - other.y) ** 2) ** 0.5
};

p.distance_to(other)
```

## Struct literals and field access

- `{ x: 1; y: 2 }` — struct literal (semi-colons). `field: value` lines
  interleave with arbitrary code. `{ ... }` is a scope block where the field
  statements are the block's "return value".
- `...expr` spreads all fields of `expr` into the result.
- `p.x` — field access. `line.start.x` — nested access (zero-copy).
- Struct types are structural: same fields = same type.
  `let nominal` opts out of structural identity.

```tfd
let p = {
    let ax = abs(x);
    { x: ax; y: ay }
};
```

## Strings, comments, print

- `"text"` — string literal. Concatenate with `++`: `"hello " ++ name`.
- `// line comment`, `/* block comment */` — comments.
- `print expr` — write to stdout. No newline appended.
- `abort(msg)` — print msg to stderr, exit 1, return type `Never`.
- `assert(cond)` — sugar for `if (!cond) abort(...) else nothing`.

```tfd
if (index < 0) abort("oob");
assert(x >= 0.0);
```

## Arrays & slices

- `[1, 2, 3]` — array literal. `arr[i]` — index. `arr.len` — length.
- `[N x T]` — type with compile-time dimension. `[T]` — slice type.
- `[N x T]` coerces to `[T]` implicitly when passed to functions.
- Multi-dim: `[3 x 3 x f64]`. Layout specifiers: `, row_major` (default) or
  `, col_major`; `, soa` for struct-of-arrays storage. Specifier-less types
  accept arrays of any layout.
- Spread (1D only): `[...a, 40, 50]`.

## Standard library imports

- `import stdlib.ffi;` — import a module path (semicolon required).
- `stdlib/` modules: `prelude` (auto-imported), `ffi`, `arrays`, `strings`,
  `math`, `clock`, `display`, `input`, `rng`, `audio`, `gpu`, etc.

## Effects and attributes

- `~[Effect] ->` — annotate a function with the effects it performs.
  `~[FFI] ->` marks a function as calling C code; required on user `@extern`
  declarations. `~[] ->` is pure (default).
- `let E = effect { op: (ArgType) -> RetType };` — declare an effect.
- `with (handler) { body }` — install handler to discharge effects.
- `@extern("symbol", (arg_types) ~[FFI] -> ReturnType)` — declare a C binding.
- `@policy(FFI = { libraries: [LibrarySpec({ path: "..." })] })` — policy on C libs.
- Effect rows appear both on function definitions and on function types:
  `(args) ~[FFI] -> T` is the type of an FFI-effectful function returning `T`.

## Comptime

- `comp expr` — evaluate expression by the built-in JIT at compile time.
- Required when constructing values of comptime-dependent types or calling
  type-constructing functions.
- Implicit in type-annotation position: `let p: Pair(i32) = ...` runs
  `comp Pair(i32)` automatically.
- `@must_tail f(args)` — assert a call is in tail position (compile error
  if not). Useful for loops via tail recursion.

## Key gotchas

- `let` cannot shadow a `def` in the same scope (and vice versa).
- A `{}` block that mixes field pairs and a trailing expression is an error.
- Non-function `def` initializers run in topological dependency order; cycles
  are a compile error. Function `def` bodies don't run until called.
- `if/then/else` — there is no `then` keyword. Write `if (cond) expr else expr`.
- `match` arms must be exhaustive over the input type (or include `_`).
- Tuples are for multiple returns only — must be destructured at the receiving
  site. No `.0`/`.1` access; no storage in variables; no argument passing.
- `self` inside an `impl` block — its type is inferred from the target type.
- Function bodies use `->` (ThinArrow). Match arms use `=>` (FatArrow).
- `@must_tail` is required for guaranteed tail recursion; plain tail-position
  calls may not be optimized without it.
