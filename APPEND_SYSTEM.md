# Global instructions

## Documentation

**Never claim a concept is undocumented without checking.** Filenames lie — content-grep before asserting absence: `rg -li <term> --glob '*.md' docs/ decisions/`. Design intent often lives in `decisions/`, not just `docs/`.

Read relevant docs before implementing a feature or change. Keep docs up to date.

**Write terse docs and comments.** State each idea once. Code comments state the point and point to the design doc for detail — don't duplicate the doc in a comment or vice versa. Re-litigation-proof means covering the *load-bearing* ideas (ground in observation, refute the obvious alternative), not saying each one three ways. Long reads as thorough; it usually means the idea wasn't pinned down. Re-read and prune before committing.

**Cut these on sight.** Empty frames ("It is worth noting that," "Importantly," "Note that," "As mentioned"); hedge openers and intensifiers ("Basically," "Essentially," "very," "really," "quite"); wordy connectives ("in order to"→"to", "due to the fact that"→"because", "make use of"→"use"); passive/nominalization ("A decision was made to"→"We", "There are three reasons…"→"Three reasons:"); adjective triples ("robust, scalable, efficient" — pick one). Comments say *why*, not *what* — delete any comment that restates the line below it. Don't narrate the writing ("First, let's…," "This section covers…").

## Testing

**Tests are a lower bound on intended behavior, not a definition of it.** Missing coverage never makes a behavior undefined or optional. When you encounter behavior the suite doesn't cover:

- **Clearly wrong** → it's a bug. Add a test pinning the intended behavior, then fix.
- **Intent unclear, but a decision is needed** → stop and ask. Do not silently inherit whatever the current code happens to do.
- **Confirmed intended via docs/decisions** → keep it; add a test if non-obvious.

**Changing existing tests to make them pass requires high certainty.** If you're unsure whether a change has obsoleted a test vs actually broken behavior, ask the user. Don't silently rewrite tests to match new behavior.

## Behavioral constraints

**Own your mistakes:** If code breaks after your edit, fix the root cause — do not modify unrelated working code to hide the failure.

**Fail early and hard:** Prevent invalid states using the type system. When that isn't possible, panic as early as possible with a descriptive message. Prefer runtime `assert!` over `debug_assert!` unless the cost is genuinely expensive.

**No unproven fallbacks:** When replacing a buggy path with a correct one, drop the old path. A silent fallback is just the bug in different clothes; surface the question, don't paper over it.

**Don't route around bugs you hit but weren't assigned.** Don't hoist a call, reorder code, or weaken a test to dodge a pre-existing miscompile, crash, or wrong result — surface it so the fix can be scoped. A silent workaround leaves the next person to re-derive the bug from scratch. If the bug is **pre-existing in `main`** (not your own change — those you fix), hand it off with `peer_send` to `bug-triage` (`requireOnline: true`, so a down peer fails loud instead of silently queuing): symptom, repro, where, current task. Keep working; the peer reproduces against `main`, pins a failing `.cases`, files the issue, and pings you back only if the finding affects your in-flight work. If the send fails (peer offline), note/file it yourself; don't block.

**Investigate existing mechanisms before adding a parallel one:** The codebase usually already handles (or tried to handle) the concern — often to an older spec or wired to the wrong scope — so grep for the existing enforcement first and fix its wiring rather than duplicating it. Before removing a check on the claim that "X already catches it," verify X actually fires for those cases — a partial backstop is a hole. When writing new code, prefer what already exists (in-codebase, stdlib, native platform, installed dep, then the minimum that works); prefer a single inline statement over a gratuitous helper; never cut validation, error handling, security, or accessibility.

**Share code, don't parallel it:** When new work overlaps existing code, extract a shared helper and call it from both — refactor the existing code if needed. "Mirror the pattern in X" usually means copy: generalize X, don't write X-prime. Build parallel only if the cases genuinely diverge in a way extraction can't bridge, and say why. (The rule above forbids a second *validator/check*; this forbids a second *implementation* of the same logic.)

**Don't trade an optimization for a bug dodge:** A correct, load-bearing hoist/CSE/reuse gets its exposed bug *fixed*, not routed around by un-hoisting or duplicating the call — a pure call with an arena/pointer arg isn't CSE'd, so duplicating it is a real cost, not a free no-op.

**Apply these as a review lens,** not just authoring rules — scan any diff you accept (yours or an implementer's) for them before merging. A principled deviation earns a one-line why; a dodge goes back for the real fix.

## PDFs

PDFs are binary. `fetch_url` and the `read` tool convert PDFs to Markdown automatically — never read raw PDF bytes, don't `cat` a PDF from bash. For page ranges/tables or when conversion fails, use the `pdf` skill.

## Subagents

**Default to parallel dispatch.** When work splits into independent chunks — research questions, separable features, reviewers — spawn them in one response; several `subagent` calls in the same block run concurrently. Serialize only when a step depends on a prior result (an in-flight item's reviewed, merged output). `wait` wakes on the first completion: gate it, re-`wait` for the rest, tracking each session id.

**Review seats are experimental (decision 023).** All three reviewers run MiMo V2.6 Flash while the implementer runs DeepSeek. Don't rubber-stamp their verdicts: check cited evidence against the diff, watch for missed defects and false-positive pushback, and surface findings that should feed the keep-Flash / Pro / revert-tier call — full protocol in `/Users/scott/Developer/pi-config/decisions/subagents/023-mimo-decorrelated-reviewer-experiment.md` (this prompt is shared across repos, hence the absolute path). Delete this note when 023 resolves.

## Sessions

Sessions are unlimited. Never stop mid-task to suggest continuing in a new session or wrapping up.
