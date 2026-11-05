# WO-fleet-client-headers-env — fleet compaction client: null headers and `env` (pi 1.4.0)

**Status: DISPATCHED 2026-11-05** as `WO-2026-075`. WO-2026-061 landed (`b18e7c9`, merged with
073), so the blocker is gone.

**Citations re-derived at dispatch** (the originals pointed at a path that does not exist on this
box): pi 1.4.0 is installed at `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`,
its `compact()` signature is `dist/core/compaction/compaction.d.ts:144` — `env` is the **9th**
positional, after `streamFn` — and `ProviderHeaders = Record<string, string | null>` is
`node_modules/@earendil-works/pi-ai/dist/types.d.ts:41`. Caller census at dispatch:
`rg -n 'compact\(' extensions/` → one real call, `extensions/compaction-model.ts:58`.

### Metadata

- **work_order_id**: WO-2026-075
- **parent_plan_id**: WO-2026-071 step 2 (`docs/investigations/pi-1.4-compaction-override-2026-11.md` §7)
- **sequence_position**: after WO-2026-061
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit
- **priority**: low
- **estimated_complexity**: trivial
- **review_policy**: required

### Task Summary

**One-sentence description**: Make `compaction-model.ts` type-correct against pi 1.4.0's
`ProviderHeaders` and forward `auth.env` into `compact()`.

**Goal**: The fleet call forwards exactly the auth the registry resolved — no `null` header
values, and the credential-resolved environment pi supplies.

### Premise

On the installed 1.4.0, `ModelRegistry.getApiKeyAndHeaders()` returns `ProviderHeaders`
(`Record<string, string | null>`, pi-ai `dist/types.d.ts:41`), and `compact()` takes
`headers?: Record<string, string>` (`dist/core/compaction/compaction.d.ts`). `auth.env` is part of
the resolved request auth and is dropped by the current call. Probes:
`grep -n "ProviderHeaders =" <pi>/node_modules/@earendil-works/pi-ai/dist/types.d.ts` and
`grep -n "export declare function compact(" -A3 <pi>/dist/core/compaction/compaction.d.ts`.
This repo has no `tsc` (extensions are jiti-stripped), so the mismatch is review-visible only —
which is why the row below asserts behaviour, not types.

### Preparatory refactor

**none** — one call site's argument construction changes; no duplicated structure to fold. Census:
`rg -n "compact\(" extensions/` → one caller (`compaction-model.ts`).

### Rulings

- `decisions/checkpoint/005-summary-ownership.md` (owner 2026-10-31): "No model rewrites it.
  `compaction-model.ts` returns `undefined` on the `[CHECKPOINT]` marker before making any fleet
  call" — this order does not touch the ownership predicate, and every row keeps it green.
- Author's choice (recorder, WO-2026-071): filter `null` values with a local two-line helper
  rather than importing pi internals; the row pins the behaviour, not the mechanism.

### Scope

**Invariants**:

- **The ownership predicate stays**: a `[CHECKPOINT]` compaction still returns `undefined` before
  model resolution (061's row).
- **Failure surfacing stays**: the `compact()` catch still notifies at `error` level and returns
  `undefined`; the `signal?.aborted` arm stays silent.
- **No routing change**: the model still resolves from `FLEET_PROVIDER`/`FLEET_MODEL`, and no
  `sessionId` is passed — 1.4.0 attaches an `x-opencode-session` uuidv7 at dispatch and the
  provider accepts it (`docs/investigations/pi-1.4-compaction-override-2026-11.md` §4).
- The compaction boundary (`firstKeptEntryId`, `tokensBefore`) is untouched.

**Files expected to change**:
- `extensions/compaction-model.ts` — header filtering and `env` forwarding.
- `tests/summary-ownership.test.ts` — one row for the forwarded argument shape.

**Files to read (reference only, do not modify)**:
- `extensions/compaction-model.ts` at 061's tip — the handler this order edits.
- pi 1.4.0 `dist/core/compaction/compaction.d.ts` — `compact()`'s positional parameter list
  (`env` is the 9th, after `streamFn`).

**Files NOT to modify**: `extensions/checkpoint.ts` (WO-2026-062's file), `settings.json`,
`extensions/auto-checkpoint.ts`, `decisions/settings/**` — another session's WIP.

**Out of scope**: ownership dispatch (061), checkpoint composition (062), any pi upgrade.

### Prohibitions

- No second request builder: the fleet call stays one `compact(...)` call site —
  `rg -n "compact\(" extensions/compaction-model.ts` → 1.
- No new user-facing surface (no setting, flag, or tool parameter).
- No `sessionId` argument (`rg -n "sessionId" extensions/compaction-model.ts` → 0).

### Implementation Specification

1. Filter `null` header values before the call; pass the filtered map as `headers`.
2. Pass `auth.env` in `compact()`'s `env` position (9th positional, after `streamFn`). If the
   installed signature's position differs from the citation, stop with `PREMISE FALSIFIED`.
3. Doc-comment the why in one sentence: 1.4.0's `ProviderHeaders` carries deletion markers pi
   filters itself; this call site is outside pi's filter.

| row | case | asserts |
|---|---|---|
| R1 | auth returns `{apiKey, headers: {"a": "1", "b": null}, env: {"E": "1"}}` | the mocked `compact()` receives `headers` without the `null` key and `env` equal to the auth's |
| R2 | auth returns no headers and no env | `compact()` receives `undefined` for both, not `{}` — pi's defaults must not be replaced by empties |
| R3 | `[CHECKPOINT]` marker present | 061's predicate still short-circuits: no `find`, no `getApiKeyAndHeaders`, no `compact()` |
| R4 | `compact()` rejects | 061's `error`-level notify fires and the handler returns `undefined` |

**Required test boundary**: the real extension module's `session_before_compact` handler driven
with a stub ctx, `compact()` mocked at its module seam — the boundary
`tests/summary-ownership.test.ts` already uses. Calling a helper directly is INADEQUATE.

### Invariants

**Error handling conventions**: no `catch` may convert an error into a successful-looking result
without a surface; handlers must not throw into the runner.

**Default values to preserve**: absent headers/env forward as `undefined`, never as `{}`.

### Verification Criteria

**Tests that must pass**: `bun test tests/summary-ownership.test.ts` (061's 12 rows plus R1–R4),
then the full suite `env -u PI_SUBAGENT_ALLOWLIST -u PI_SUBAGENT_DEPTH -u PI_IS_SUBAGENT bun test`.

**Test surface requirements**: rows drive the handler; mutation control = revert the filter and
show R1 red.

**Build requirements**: none (no build step, no typecheck).

### Structural Risks

- [ ] **Route/path correctness**: positional arguments in the order pi's signature declares them
- [ ] **Input validation scope**: absent headers/env stay absent
- [ ] **Test surface**: handler-level rows only
- [ ] **Recovery logic**: 061's notify path still guarded against a stale `ctx`
- [ ] **No unrequested changes**: two arguments and one comment
- [ ] **Build config untouched**
- [ ] **No unsolicited features**
- [ ] **No parallel path**: one call site

### Context

**Prior work orders completed in this plan**: WO-2026-061 (predicate + failure surfacing,
`418490b`, unmerged at drafting).

**Upcoming work orders**: WO-2026-062 (composition, machine block, field validation).

### Completion Report Format

Standard schema plus the `review_policy: required` extras (assumptions, unexpected changes,
issues, test coverage, both reviewer verdicts with session ids and rounds, `review_cap_reached`).
