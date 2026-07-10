---
paths:
  - "**/*.tfd"
---

# tfd Syntax Cheatsheet

Brief overview of tfd syntax for editing `.tfd` files. Full reference in
`docs/language/` and `docs/design/`.

## Bindings

- `let x = expr` — sequential binding; RHS sees only names above. Shadowable.
- `def f = expr` — forward-visible within its scope. **Cannot be shadowed** by
  `let` or `def` in the same scope. Use for mutual recursion.
- `x := expr` — sugar for `let x: T = expr`. Does **not** escape `{}` blocks;
  the reshadow is local to the enclosing scope.

## Blocks and expressions

Everything is an expression; no statements. Semicolons separate, don't terminate.

- `{ ... }` — scope boundary. New binding scope, new arena. Block's value is
  its trailing expression, OR a struct assembled from `field: value` and
  `...expr` spread lines. Mixing is a compile error.
- `if (cond) then expr else expr` — **not** a scope boundary. `:=` in a branch
  persists. Use `{ }` in the branch for an explicit scope boundary.
- `match x { pat: T => expr, ... }` — pattern match. Multi-expression arm
  bodies go in a `{ }` block. `_` is a wildcard; use `is` for inline narrowing.

## Types

- Primitives: `i8`–`i128`, `u8`–`u128`, `f16`/`f32`/`f64`, `bool`, `String`.
- Struct types: `{ x: f64; y: f64 }`. In annotation position, `struct` may
  be omitted. `nothing` is the unit type, equivalent to `struct {}`.
- `Union(A, B)` — tagged union, narrowed via `match` or `is`.
- `let nominal Name = T` — nominal wrapper, distinct from other nominals over
  the same `T`. Constructed via `Name(value)`.
- `(x: T) => bool` — refinement predicate; erased at codegen.
- `T on heap` — heap-allocate the value in the caller's arena; auto-derefs on
  read. `@c_struct` attribute on a struct types it for FFI to C.

## Lambdas, methods, impl blocks

- `(args) => expr` — single-expression body. `(args): T => expr` adds the
  return type. `(args) -> { ... }` — block body. Parameter types required.
- Methods are struct function fields called via dot syntax: `c.inc()` desugars
  to `c.inc(c)`. Standalone functions don't enable dot dispatch.
- `impl TypeName { def m = (self) => ... }` — attach methods to a type. Use
  `Self` for the type inside the impl body. `impl T for U` for traits.

## Struct literals and field access

- `{ x: 1, y: 2 }` — struct literal. Field order doesn't matter; all fields
  must be specified. `...expr` spreads all fields of `expr` into the result.
- `p.x` — field access. `line.start.x` — nested access (zero-copy).
- Struct types are structural: same fields = same type, regardless of
  declaration name. `let nominal` opts out of structural identity.

## Strings, comments, print

- `"text"` — string literal. Concatenate with `++`: `"hello " ++ name`.
- `// line comment`, `/* block comment */` — comments.
- `print expr` — write to stdout. No newline appended.

## Arrays

- `[1, 2, 3]` — array literal. `arr[i]` — index. `arr.len` — length.
- `[N x T]` — type with compile-time dimension. `N` must be a comptime const.
- Multi-dim: `[3 x 3 x f64]`. Layout specifiers: `, row_major` (default) or
  `, col_major`; `, soa` for struct-of-arrays storage. Specifier-less types
  accept arrays of any layout.

## Imports

- `import stdlib.ffi;` — import a module path. `use path::name` brings a
  specific binding into scope. `use path::name as alias` for an import alias.

## Effects and attributes

- `~[Effect]=>` — annotate a function with the effects it performs.
  `~[FFI]=>` marks a function as calling C code; required on user `@extern`
  declarations and propagates to callers.
- `@extern("symbol", arg_types)` — declare a binding backed by a C symbol.
  Must be in a `use`d module with effect `FFI`.
- `@policy(...)` — attach a static policy to a binding (e.g. `FfiPolicy`
  listing allowed C libraries and their expected capabilities).
- `~[Effect]=>` appears both on function definitions and on function types:
  `(args) ~[FFI]=> T` is the type of an FFI-effectful function returning `T`.

## Common gotchas

- `let` cannot shadow a `def` in the same scope (and vice versa).
- A `{}` block that mixes field pairs and a trailing expression is an error.
- Non-function `def` initializers run in topological dependency order; cycles
  are a compile error. Function `def` bodies don't run until called.
- `if/then/else` is not a scope boundary — `:=` in a branch persists.
- `match` arms must be exhaustive over the input type.
