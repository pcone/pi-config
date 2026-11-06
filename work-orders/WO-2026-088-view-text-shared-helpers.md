# WO-2026-088 — the viewers' text helpers are one module, and the manual scan is the one

### Metadata

- **work_order_id**: WO-2026-088
- **parent_plan_id**: review triage 2026-11-06 (review `notes/review-2026-11-06/pi-config.md`, MEDIUM "two copies of the viewer's text helpers")
- **sequence_position**: 3 of 3 (after WO-2026-087)
- **routed_to**: implement
- **invariant_exhaustiveness**: implicit — the census below is a lower bound; enumerate every call site of each helper in both viewers before moving it.
- **priority**: normal
- **estimated_complexity**: moderate
- **review_policy**: required
- **turn_budget**: 55 turns. At 80 without a completion report, stop and report. Targeted rows only — never the full `bun test` (box-wide `flock` slot; the orchestrator gates it). Tell any reviewer you spawn the same.
- **base**: `170db64` (`origin/main`)

### Task Summary

**One-sentence description**: `plainLen`, `padRight`, `timeAgo`, `stripAnsi` and `truncate` move to `extensions/lib/view-text.ts`, both viewers import them, and the `.cjs`'s regex-based `plainLen` is replaced by v2's manual scan — the ruling below says which is authoritative and what that changes.

### Ruling — which `plainLen` is authoritative (measured, not preferred)

The two viewers compute visible width differently. Measured with both implementations over the same inputs:

| input | `.cjs` (regex) | v2 (manual scan) |
|---|---|---|
| `""`, `"abc"` | 0, 3 | 0, 3 |
| `ESC[31mredESC[0m` | 3 | 3 |
| `ESC[31mred` (unterminated) | 3 | 3 |
| `ESC[` alone | **2** | **0** |
| `abESC[` | **4** | **2** |
| `ESC[31` | **4** | **0** |

They differ **only** on an escape sequence that never terminates. **The manual scan is authoritative.** An
escape sequence moves the cursor; an unterminated one moves nothing visible, so it occupies no column, and
that is the reading the `.cjs`'s own `truncate` already assumes when it walks the string character by
character (`watch-session.cjs:60-78`). The regex form double-counts exactly the bytes it fails to strip.

**The disclosed consequence:** the `.cjs`'s visible width for a *truncated* escape sequence changes
(`"abESC["` 4 → 2). Nothing else changes. Commit 1 pins today's `.cjs` answer for that input; commit 2
flips it with this reasoning at the site. **Any other divergence between the two implementations is a
`PREMISE FALSIFIED`** — do not adjust a row to fit it.

### Scope

**Helpers and their call sites** (`rg -c '<name>\(' `):

| helper | `.cjs` | v2 | notes |
|---|---|---|---|
| `plainLen` | 3 | 2 | bodies differ; the manual scan wins |
| `padRight` | 4 | 3 | equivalent |
| `timeAgo` | 2 | 2 | byte-identical |
| `stripAnsi` | — | 5 | the `.cjs` calls its copy `plainLine` (2 uses, `:56`, `:272`) |
| `truncate` | 3 | 0 | `.cjs` only; it must use the shared `plainLen` |

**Also a consumer:** `extensions/subagent-async/test-viewer.cjs:51-53` imports `plainLen`, `padRight` and
`timeAgo` **from the `.cjs` viewer**. Keep those names exported from the `.cjs` (re-exported from the
shared module) so the harness keeps working; do not edit the harness to reach into `lib/` instead — its
imports are its contract with the viewer.

**Files expected to change**:

- `extensions/lib/view-text.ts` (new)
- `extensions/subagent-async/watch-session.cjs`, `watch-session-v2.ts`
- `tests/watch-view-vocabulary.test.ts` or a new `tests/view-text.test.ts` for the shared helpers
- `docs/investigations/structure-trend.md` (chunk snapshot)

**Files NOT to modify**: `extensions/subagent-async/watch-session.ts`, `test-viewer.cjs`, any other
viewer row, `extensions/lib/subagent-discovery.ts`, and the two helpers' *behaviour* beyond the one ruling.

### Prohibitions

1. **No helper is defined twice at the tip.** `rg -n 'function (plainLen|padRight|timeAgo|stripAnsi|truncate)' extensions/subagent-async/watch-session.cjs extensions/subagent-async/watch-session-v2.ts` → no output; `rg -c 'export function (plainLen|padRight|timeAgo|stripAnsi|truncate)' extensions/lib/view-text.ts` → **5**.
2. **Rendering does not move.** Every existing row passes unchanged — `bun extensions/subagent-async/test-layout.ts` (27), `node extensions/subagent-async/test-viewer.cjs` (100), `bun test tests/watch-view-vocabulary.test.ts`, `subagent-abnormal-stop`, `subagent-state-vocabulary` — with **one** exception: the commit-1 row that pins the `.cjs`'s truncated-escape width. `git diff` on those files is that single row.
3. **`test-viewer.cjs` is unedited** and still imports `plainLen`, `padRight`, `timeAgo` from the `.cjs`.
4. **One name for one thing**: the `.cjs`'s `plainLine` becomes `stripAnsi` at both its call sites; no alias of a second name survives (`rg -n 'plainLine' extensions/` → no output).
5. **The shared module imports nothing** but its own types — no `@earendil-works/*`, no viewer, no fs. It must load under plain `node` (the `.cjs` viewer does).
6. **`truncate` keeps its exact output**, including the `…` and the reset sequence it appends — its rows in the `.cjs` harness pin that, and `plainLen`'s change must not alter any output for a *complete* escape sequence.
7. **No spawn in a new test file without `env: childEnv()`.**

### Verification Criteria

```
bun test tests/view-text.test.ts            # or the file you add the rows to
bun test tests/watch-view-vocabulary.test.ts
bun test tests/subagent-abnormal-stop.test.ts
bun test tests/subagent-state-vocabulary.test.ts
bun extensions/subagent-async/test-layout.ts
node extensions/subagent-async/test-viewer.cjs
node --check extensions/subagent-async/watch-session.cjs
bun build --target node --outdir /tmp/wo088 extensions/subagent-async/watch-session-v2.ts
bun test tests/subagent-boundary-hermeticity.test.ts -t 'explicit env'
```

**Acceptance rows** (Y):

| # | Case | Expected |
|---|---|---|
| Y1 | `plainLen` over well-formed input: `""`, `"abc"`, `ESC[31mredESC[0m`, `ESC[31mred`, `aESC[1;2Hb` | 0, 3, 3, 3, 2 — the same table the ruling measured, from the shared function, and identical to **both** viewers' old answers |
| Y2 | `plainLen("abESC[")` | **2** at the tip. Commit 1 pins the `.cjs`'s current **4** through the viewer's own export; commit 2 flips that row to 2 with the ruling cited at the row |
| Y3 | `truncate(long, width)` | unchanged bytes: the `…` plus `ESC[0m`, cutting at `width - 1` visible characters |
| Y4 | `padRight("ab", 5)` / `padRight("abcdef", 3)` | `"ab   "` / `"abcdef"` |
| Y5 | `timeAgo` boundaries: 59 s, 60 s, 59 m, 60 m | `59s ago`, `1m ago`, `59m ago`, `1h ago` |
| Y6 | one definition each | prohibition 1's two `rg`s |
| Y7 | both viewers still render a footered session identically | the existing layout + harness rows, unchanged |

**Mutations**, each alone with the file reverted: make `plainLen` count a lone `ESC[` as one byte (regex
arm restored in the shared module) → Y2 reds; drop `truncate`'s `width - 1` for `width` → Y3 reds; make
`padRight` return the input unchanged → Y4 reds; drop the `< 60` guard in `timeAgo` → Y5 reds.

**Report**: `files_modified`; the Y table with mutation evidence; prohibitions 1–7 with their `rg`/`git diff`;
the call-site census you enumerated for each helper; the exact diff of the one flipped row.

### Stop reports

- **`PREMISE FALSIFIED`** — the two `plainLen` implementations differ on any input other than an
  unterminated escape; or `truncate`'s output changes for a complete escape sequence.
- **`PLAN MISMATCH`** — `test-viewer.cjs` cannot keep its imports without editing it.
- **`REFACTOR FIRST`** — a helper turns out to depend on viewer state (an injected theme, a width from a
  TUI object) and cannot be a pure function.

### Q-B1 — raised 2026-11-06 by the implementer's `PREMISE FALSIFIED`; **needs an owner ruling**

**The stop clause fired, and the evidence is sound.** This order's §Ruling said the two `plainLen`
forms differ *only* on an escape sequence that never terminates, and that "any other divergence is a
`PREMISE FALSIFIED`". The implementer classified the input space instead of sampling it: over 597,871
strings of length ≤ 6 from `ESC [ m 1 ; a ? < space`, **28,002 differ**, and every one contains an
`ESC [` the regex cannot strip. Zero diverge where every `ESC [` starts a matchable
`ESC [ [0-9;]* <letter>`. I re-derived the classification independently over a smaller alphabet (7,380
strings, 219 differing, **0 unexplained**), so the claim holds at both sizes.

**The true class is "every escape sequence the regex fails to strip"**, one term wider than my table:
a CSI body byte outside `[0-9;]`, e.g. `ESC[?25l` (cursor hide) and `ESC[<64;3;5M` (mouse report), which
real terminals do emit. Measured by me, base vs branch tip, `truncate(…, 8)`:

| input | visible (base, regex) | base output | visible (tip, scan) | tip output |
|---|---|---|---|---|
| `ESC[?25labcd` | 10 | `ESC[?25labcd…ESC[0m` | 4 | `ESC[?25labcd` (fits, unchanged) |
| `abcESC[?25l` | 9 | `abcESC[?25l…ESC[0m` | 3 | `abcESC[?25l` |
| `ESC[31mabcdefghijESC[0m` | 10 | `ESC[31mabcdefg…ESC[0m` | 10 | identical |

So the second stop trigger ("`truncate`'s output changes for a complete escape sequence") is real: the
base *truncated a line that fits*, because it counted a hide-cursor sequence as ten columns.

**Options, for the owner:**
- **(a) In scope — the class is the ruling's intent** (recommended). "An escape sequence occupies no
  column" applies to any sequence, not only the SGR-shaped ones my table happened to sample; the regex
  was wrong for every body byte outside `[0-9;]`. Prohibition 6 narrows to "no output moves for a
  complete **SGR** sequence". Remaining work: two rendering rows (the `truncate`/`padRight` output for a
  non-SGR sequence) and one doc line. ~10 turns.
- **(b) Out of scope** — revert `6dfb404..6e74f37`, keep `5c65ca5`'s pins, and the scan needs a rule for
  bodies outside `[0-9;]` (what to do with a sequence it does not recognise). ~15 turns, and the `.cjs`
  keeps counting hide-cursor sequences as columns.
- **(c) Land as it is** — the mechanism as ruled, the wider class documented and pinned, no further rows.

**Status: blocked, awaiting the owner.** The branch is green, unpushed, and touching no merged file.
