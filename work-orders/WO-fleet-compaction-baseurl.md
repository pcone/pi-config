# WO-fleet-compaction-baseurl — the fleet compaction call forwards `auth.baseUrl`

**Status: DRAFT — DISPATCH-BLOCKED on Q-A1 (owner call).** Slug-only; the id is reserved at dispatch.

### Metadata

- **work_order_id**: WO-2026-077 (reserved at dispatch)
- **parent_plan_id**: planning-seat queue 2026-11-05 (item 1, from WO-2026-075's notes)
- **sequence_position**: 1 of 1
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit
- **priority**: low — latent, not live
- **estimated_complexity**: trivial (mechanism A) / moderate (mechanism C)
- **review_policy**: required

### Task Summary

**Goal**: the fleet summarization call stops dropping a field the registry resolved. `compact()` has no
positional for `auth.baseUrl`, but the URL is read from the *model object*, and pi's own compaction
path already handles it by wrapping the model.

### Premise

`auth.baseUrl` is resolved by `ctx.modelRegistry.getApiKeyAndHeaders` and read nowhere in
`extensions/compaction-model.ts`; pi's own path applies `{ ...model, baseUrl: auth.baseUrl }`
conditionally before calling the same `compact()` (`dist/core/agent-session.js:264`).

Probe that falsifies it: `rg -n 'baseUrl' extensions/compaction-model.ts` returning a hit (someone
already forwards it), or pi's provider api reading the URL from anywhere but `model.baseUrl`
(`pi-ai dist/api/openai-completions.js:562` builds `new OpenAI({baseURL: model.baseUrl})`; the
summarization options bag at `dist/core/compaction/compaction.js:463-469` carries no URL field).

**The gap is latent, and both the order and its rows must say so.** `auth.baseUrl` is populated only
by an OAuth handler's `toAuth()` (`pi-ai dist/auth/resolve.js:118`), and of the shipped handlers only
`github-copilot` returns one (`dist/auth/oauth/github-copilot.js:388`). The fleet seat is
`opencode-go` with api-key auth (`pi-ai dist/providers/opencode-go.js:11`), so at this call site the
field is `undefined` today. This is a faithfulness fix — the second of the same shape as WO-2026-075
(`compact()` decomposes `ResolvedRequestAuth` into positionals, so every field pi adds to that type is
silently dropped until someone notices) — not a live bug fix.

### Q-A1 — owner call: two working mechanisms, mutually exclusive

Both make the field reach the client. They differ in what else they change, so neither is a default
the implementer or I can pick.

**Mechanism A — wrap the model, mirroring pi (recommended).** One conditional at the `compact()` call
site: `const modelForCall = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model`. It is pi's own
code, its own conditional (`agent-session.js:264`); `id`, `provider`, `api`, `headers`, `compat` and
`contextWindow` all survive the spread, and the request's model id still comes from `model.id`
(`openai-completions.js:577`). Cost: a third copy of a pi-internal normalization in one file (after
WO-2026-075's `withoutDeletedHeaders`), because pi exports no helper to share. Exposure: `detectCompat`
reads `model.baseUrl` (`openai-completions.js:1318-1321`), so a proxied URL can flip auto-detected
compat flags — mitigated by the fleet model's explicit `compat` block, and it is the same exposure pi
accepts on every other request. Rows: one.

**Mechanism C — dispatch through the runtime instead.** Pass `ctx.modelRegistry.streamSimple` as
`compact()`'s 8th positional (`streamFn`), which routes through `ModelRuntime.prepareRequest` and
applies the `baseUrl` wrapper, the compat semantics and opencode's `x-opencode-session` header
(`model-runtime.js:456-522`, `:465`). This makes A — and its question — moot: `ProviderHeaders` null
semantics are preserved end to end, so WO-2026-075's local filter could be deleted rather than kept.
Cost, and why it is not a free win: it moves the compaction request from pi-ai's compat dispatch onto
the coding-agent runtime, so `before_provider_request` hooks and `model_call` telemetry start seeing a
request that today bypasses both (`docs/investigations/pi-1.4-compaction-override-2026-11.md:52,192`),
and auth resolution moves from the extension into the runtime. That is a behaviour change outside the
`baseUrl` question, so it needs a ruling of its own rather than riding a gap-closing order.

**Why this is an owner question and not my call:** A is minimal and safe but adds a duplicate; C removes
the duplicate and the whole drift class while changing dispatch visibility the project currently relies
on a doc statement about. Picking one is a shape decision with a cost on each side, which is the
owner's to make. The order lands whichever A1 names and only that one — they are mutually exclusive
(doing both resolves auth twice and pins two contradictory `streamFn` assertions).

### Rulings

- WO-2026-075's landing (`8c1595d`): `null` header markers filtered, `auth.env` forwarded to the 9th
  positional. Not revisited here.
- Author's choice: the wrapper is **conditional** (`auth.baseUrl ? … : model`), mirroring
  `agent-session.js:264`. An unconditional `{ ...model, baseUrl: undefined }` would invent a value the
  registry did not resolve, which is the defect WO-2026-075's R2 rejected in the other direction.

**Rejected alternatives**: none by the owner yet. Q-A1 names C as the alternative A would foreclose.

### Scope

**Invariants**: the other positionals are untouched (`apiKey`, filtered `headers`, `env`, `streamFn`
stays `undefined` under A); the `[CHECKPOINT]` yield at the top of the handler still short-circuits
before any registry read; `withoutDeletedHeaders` still filters `null` markers.

**Files expected to change**: `extensions/compaction-model.ts` (the call site and the doc block above
it), `tests/summary-ownership.test.ts` (one row under A; under C, the existing `streamFn` assertion
inverts and the header-filter row changes meaning).

**Files NOT to modify**: `extensions/checkpoint.ts`, `decisions/checkpoint/{005,006}`,
`extensions/lib/fleet-model.ts` (the model's own `baseUrl` and `compat` block are not this order's
business).

**Out of scope**: the pi-side change that would end the drift class — a resolved-auth object replacing
positionals 3/4/9. Recorded in the doc, not implemented here.

### Prohibitions

- **The test stub must carry the shape production returns.** `tests/summary-ownership.test.ts`'s
  registry stub currently returns `{ provider, id }` for the model, so a row asserting `baseUrl`
  would assert against a shape the real `Model<Api>` never has and would pass while a field is
  dropped. Fix the stub to include `api` and `baseUrl` (and keep its other fields), then the row
  means something. Check: the row fails if the wrapper drops `api`.
- **No unconditional wrapper** — `rg -n 'baseUrl: auth.baseUrl' extensions/` → 1, and the surrounding
  line is the ternary.
- **No second header mechanism** — `rg -c 'withoutDeletedHeaders' extensions/compaction-model.ts` → 2
  (definition + call), unchanged under A.
- **No `streamFn` change under A** — the existing row asserting the 8th positional is `undefined`
  stays green and unedited.

### Behavior matrix

| row | case | assert | red under |
|---|---|---|---|
| A1 | `auth.baseUrl` resolved | the model handed to `compact()` has that `baseUrl`, and still has the registry's `id`, `provider`, `api` | drop the wrapper |
| A2 | `auth.baseUrl` absent | the model handed to `compact()` is the registry's object, `baseUrl` not invented as `undefined`-own-property — compare `Object.keys` / identity | make the wrapper unconditional |
| A3 | checkpoint path | still zero registry reads and zero `compact()` calls (`[CHECKPOINT]` yield intact) | move the wrapper above the marker predicate |

### Verification Criteria

- `bun test tests/summary-ownership.test.ts` — all rows green, including WO-2026-073's sixteen and
  WO-2026-075's six; existing rows unedited.
- Each new row red under its named mutation, run alone, file `cmp`-clean afterwards.
- No `tsc` in this repo: verify with `bun build` on the extension and a `pi` load smoke test.

### Context

Carried from WO-2026-075's landing stamp and `docs/investigations/pi-upgrade-2026-10.md`'s §4 item,
which names this order as the carrier for the `baseUrl` half.

---

## Report on completion

Every completion report and landing for this order goes to `claude-8f90746f-e9aa-4dab-81ef-eb303ba0cb65`
by peer message. State commit hashes, not "landed".
