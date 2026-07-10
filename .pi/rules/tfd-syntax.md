---
paths:
  - "**/*.tfd"
---

# tfd Syntax Cheatsheet

Brief overview of tfd syntax for editing `.tfd` files. Full reference in
`docs/language/` and `docs/design/`.

## Bindings

- `let x = expr` — sequential; RHS sees only names above. Shadowable.
- `def f = expr` — forward-visible in its scope. Cannot be shadowed.
- `x := expr` — shadow-rebind. Does not escape `{}`. `x += rhs` desugars to
  `x := x + rhs`. Cannot rebind a `def`.

```tfd
let p = { x: 1; y: 2 };
p.x := 7;
n += 5;
```

## Blocks & expressions

Everything is an expression. Semicolons separate, don't terminate.

- `{ ... }` — new scope & arena. Value = trailing expression, OR struct from
  `field: value` lines and `...expr` spreads. Mixing both is a compile error.
- `if (cond) expr else expr` — no `then`. Not a scope boundary. Use `{ }`
  inside a branch for an explicit scope.
- `match x { T as name => expr, T => expr, _ => expr }` — pattern match.
  Auto-narrows `x`. Must be exhaustive (include `_`).
- `if (x is T) expr else expr` — sugar for `match x { T => expr, _ => expr }`.

## Arrows: `->` functions, `=>` match arms

- `(args) -> expr` — single-expression body. `(args): RetType -> expr` with
  return type. Match arms use `=>`.
- Effect rows: `(args) ~[E1, E2] -> expr`. `~[] ->` pure (default).

```tfd
let add = (a: i32, b: i32) -> a + b;
let eff = (n: i32) ~[Write] -> { Write.write("hi"); n * 2 };
```

## Types

- Primitives: `i8–i128`, `u8–u128`, `f16/f32/f64`, `bool`, `String`,
  `usize`, `Never`, `nothing`.
- Struct: `{ x: f64; y: f64 }`. `@c_struct` for FFI C layout.
- `Union(A, B)` — tagged union. `let nominal Name = T` — nominal wrapper.
- Refinement: `(x: T) -> bool` — erased at codegen.
- `T on heap` — heap-allocated in caller's arena, auto-derefs on read.

## Structs, methods, impl

- `impl Type { def m = (self) -> ... }` — attach methods. `impl structural T`
  for shape dispatch. `impl Pred for Target` for traits.
- `obj.=next()` — iterator advance: `let (val, obj) = obj.next()`.
- `_` placeholder for partial application: `add(5, _)` → `(b) -> add(5, b)`.

```tfd
impl Point { distance_to: (self, other: Point) -> ((self.x-other.x)**2 + ...)**0.5 };
```

## Strings, print, arrays

- `"text"` — string. `++` concatenation. `//` line comment, `/* */` block.
- `print expr` — stdout. `abort(msg)` — stderr + exit 1, type `Never`.
- `[1, 2, 3]` — array literal. `arr[i]` index. `arr.len` length.
- `[N x T]` — compile-time dim. `[T]` — slice type. Coerces implicitly.
- Multi-dim: `[3 x 3 x f64]`. Layout: `row_major` (default), `col_major`,
  `soa`. Spread: `[...a, 40, 50]`.

## Effects & imports

- `import stdlib.ffi;` — module import (semicolon required).
- `~[E]` — effect annotation. `~[FFI]` for C calls, `~[]` pure (default).
- `let E = effect { op: (Arg) -> Ret };` — declare. `with (h) { body }` — discharge.
- `@extern("symbol", (args) ~[FFI] -> T)` — C binding.

## Comptime

- `comp expr` — JIT-evaluate at compile time. Implicit in annotation position.
- `@must_tail f(args)` — assert tail call; error if not in tail position.

## Gotchas

- `let` cannot shadow `def` (and vice versa) in the same scope.
- `{}` mixing field lines and trailing expression is a compile error.
- `def` init runs in topological order; cycles are compile errors.
- Tuples: multiple returns only. No `.0`/`.1`, no storage, no argument passing.
- `self` type inferred from impl target.
- `->` for function bodies, `=>` for match arms.
- `@must_tail` required for guaranteed tail recursion; plain tail calls
  may not be optimized.
