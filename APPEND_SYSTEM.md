# Global instructions

## Documentation

**Never claim a concept is undocumented without checking.** Filenames lie — content-grep before asserting absence: `rg -li <term> --glob '*.md' docs/ decisions/`. Design intent often lives in `decisions/`, not just `docs/`.

Read relevant docs before implementing a feature or change. Keep docs up to date.

**Write terse docs and comments.** State each idea once; if a sentence restates the previous one in different words, cut it. Code comments state the point and point to the design doc for detail — don't duplicate the doc in a comment or vice versa. Re-litigation-proof means covering the *load-bearing* ideas (ground in observation, refute the obvious alternative), not saying each one three ways. Long reads as thorough; it usually means the idea wasn't pinned down. Re-read and prune before committing.

## Testing

**Tests are a lower bound on intended behavior, not a definition of it.** The suite captures what's been pinned down — it is not the full spec. Missing coverage never makes a behavior undefined or optional. When you encounter behavior the suite doesn't cover:

- **Clearly wrong** → it's a bug. Add a test pinning the intended behavior, then fix.
- **Intent unclear, but a decision is needed** → stop and ask. Do not silently inherit whatever the current code happens to do.
- **Confirmed intended via docs/decisions** → keep it; add a test if non-obvious.

**Changing existing tests to make them pass requires high certainty.** If you're unsure whether a change has obsoleted a test vs actually broken behavior, ask the user. Don't silently rewrite tests to match new behavior.

## Behavioral constraints

**Own your mistakes:** If code breaks after your edit, fix the root cause — do not modify unrelated working code to hide the failure.

**Fail early and hard:** Prevent invalid states using the type system. When that isn't possible, panic as early as possible with a descriptive message. Prefer runtime `assert!` over `debug_assert!` unless the cost is genuinely expensive.

**No unproven fallbacks:** When replacing a buggy path with a correct one, drop the old path. A silent fallback is just the bug in different clothes; surface the question, don't paper over it.

**Investigate existing mechanisms before adding a parallel one:** The codebase usually already handles (or tried to handle) the concern — often to an older spec or wired to the wrong scope — so grep for the existing enforcement first and fix its wiring rather than duplicating it. Before removing a check on the claim that "X already catches it," verify X actually fires for those cases — a partial backstop is a hole.

## PDFs

PDFs are binary. `fetch_url` and the `read` tool convert PDFs to Markdown automatically — never read raw PDF bytes, don't `cat` a PDF from bash. For page ranges/tables or when conversion fails, use the `pdf` skill.

## Sessions

Sessions are unlimited. Never stop mid-task to suggest continuing in a new session or wrapping up.
