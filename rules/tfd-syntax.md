---
paths:
  - "**/*.tfd"
---

# tfd Syntax Cheatsheet

Brief overview of tfd syntax for editing `.tfd` files. Full reference in
`docs/language/` and `docs/design/`.

## Bindings

- `let x = expr` — sequential; RHS sees only names above. Shadowable.
- `def f = expr` — forward-visible in its scope. Cannot be shadowed. Use for
  mutual recursion.
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
  `T as name =>` binds; `=> { }` for multi-expression arms. Exhaustive.
- `if (x is T) expr else expr` — sugar. Then-branch sees `x` narrowed.

## Arrows & types

- `(args) -> expr` — function body (ThinArrow). `(args): RetType -> expr`
  annotated. Match arms use `=>` (FatArrow).
- Effect rows: `(args) ~[E1, E2] -> expr`. `~[] ->` pure (default).
- Primitives: `i8–i128`, `u8–u128`, `f16/f32/f64`, `bool`, `String`,
  `usize`, `Never` (bottom), `nothing` (unit).
- Struct: `{ x: f64; y: f64 }`. Structural (same fields = same type).
  `let nominal` opts out. `@c_struct` for FFI.
- `Union(A, B)` — tagged union. Refinement: `(x: T) -> bool` (erased).
- `T on heap` — heap-allocated in caller's arena, auto-derefs on read.
- Literal suffixes: `42u64`, `1.0f32`, `2.0i32`.

```tfd
let add = (a: i32, b: i32) -> a + b;
let eff = (n: i32) ~[Write] -> { Write.write("hi"); n * 2 };
```

## Structs, methods, impl

- `impl Type { def m = (self) -> ... }` — attach methods. `impl structural T`
  for shape dispatch. `impl Pred for Target` for traits.
- `obj.=next()` — iterator advance: `let (val, obj) = obj.next()`.
- `_` for partial application: `add(5, _)` → `(b) -> add(5, b)`.

```tfd
impl Point { distance_to: (self, other: Point) -> ((self.x-other.x)**2 + ...)**0.5 };
```

## Strings, print, arrays

- `"text"` — string. `++` concatenation. `//` and `/* */` comments.
- `print expr` — stdout. `abort(msg)` — stderr + exit 1, type `Never`.
  `assert(cond)` — sugar for `if (!cond) abort(...) else nothing`.
- `[1, 2, 3]` — array. `arr[i]` index. `arr.len` length.
- `[N x T]` — compile-time dim. `[T]` — slice. `[N x T]` coerces to `[T]`.
- Multi-dim: `[3 x 3 x f64]`. Layout: `row_major` (default), `col_major`,
  `soa`. Spread: `[...a, 40, 50]`.

## Effects & imports

- `import stdlib.ffi;` — module (semicolon required). Modules: `prelude`
  (auto-imported), `ffi`, `arrays`, `strings`, `math`, `clock`, `display`.
- `~[E]` — effect annotation. `~[FFI]` for C calls, `~[]` pure (default).
- `let E = effect { op: (Arg) -> Ret };` — declare. `with (h) { body }` — discharge.
- `@extern("symbol", (args) ~[FFI] -> T)` — C binding.
- `@policy(FFI = { libraries: [LibrarySpec({ path: "..." })] })` — C libs.

## Comptime

- `comp expr` — JIT-evaluate at compile time. Explicit for comptime-dependent
  values; implicit in annotation position.
- `@must_tail f(args)` — assert tail call; error if not in tail position.

## Gotchas

- `let` cannot shadow `def` (and vice versa) in the same scope.
- `{}` mixing field lines and a trailing expression is a compile error.
- `def` init runs in topological order; cycles are compile errors.
- Tuples: multiple returns only. No `.0`/`.1`, no storage, no argument passing.
- `self` type inferred from impl target.
- `->` for function bodies, `=>` for match arms.
- `@must_tail` required for guaranteed tail recursion; plain tail calls
  may not be optimized.
