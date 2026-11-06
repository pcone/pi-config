# WO-2026-087 — the quota entry points stop claiming callers they do not have

### Metadata

- **work_order_id**: WO-2026-087
- **parent_plan_id**: review triage 2026-11-06 (review `notes/review-2026-11-06/pi-config.md`, MEDIUM "the pre-refactor quota entry points have no production caller, and the comment says they do"; LOW "`minimaxParts` has an unreachable `undefined` arm")
- **sequence_position**: 2 of 3 (after WO-2026-086, before WO-2026-088)
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit — two named sites plus a doc comment.
- **priority**: normal
- **estimated_complexity**: small
- **review_policy**: skip — comment, doc, one unreachable arm; self-gated
- **turn_budget**: 25 turns. Target is 15. Targeted rows only.
- **base**: `a5f79c2` (`origin/main`)

### Rulings — the scope this order does NOT take, and why

The review's fix for the MEDIUM is "point the characterisation rows at the descriptor path and delete the
two entry points". **That deletion is deliberately not in this order**, and the reason is measured, not
cautious: the ~50 golden rows drive `renderQuotaSegment(quota, …)` with an *already-normalised*
`QuotaData`, and `renderGoUsageSegment(usage, …)` with a `GoUsage`. The production door for both is
`fetchQuotaSnapshot` → `descriptor.parse` → private `snapshotFor` → `descriptor.render`. Repointing the
rows means either (a) exporting `tokenWindowParts`, `goParts`, `snapshotFor` and `goDescriptor` so a
test-local shim can build the snapshot, or (b) re-authoring every fixture as a raw API payload and
proving all ~50 goldens reproduce byte-for-byte through the production parse. (a) trades two dead
functions for four test-only exports — the surface grows, so it is not the fix it looks like. (b) is a
real improvement with a real risk of silent golden drift, and it deserves its own order and budget
rather than riding inside a documentation change.

So this order does the part that is unambiguous: **stop the comment claiming callers** … and record the
deletion as open, with the blocking fact. A follow-up order that takes (b) is a design decision for the
orchestrator, not something to smuggle in here.

### Scope

**Site 1 — the comment that is false.** The block under `extensions/lib/quota.ts:654-660` (header `// Pre-refactor entry points` at `:655`) reads
"Pre-refactor entry points / Callers holding an already-normalised payload keep these signatures."
There are no production callers: `rg -n 'renderQuotaSegment|renderGoUsageSegment' --glob '!*.md'` finds
them in `quota.ts` (definition), `footer-session-id.ts` (re-export block, `:694-702`), and four test
files. The footer's render path calls `quotaDescriptorFor(...).render(...)`
(`footer-session-id.ts:1033-1034`, `quotaDescriptorFor(model?.provider)?.render(cachedQuota, …)`).

Rewrite that block: the section header becomes **Test seams**; the comment says what is true — no
production caller, the characterisation rows are the only users, and why they exist (they feed a
normalised payload, which production never does); and it names the open deletion. Keep both functions
and their signatures untouched.

Also correct `footer-session-id.ts:691-696` ("stay importable here for their existing callers and
tests" — there are no callers; the tests are the only users).

**Site 2 — the unreachable arm.** `extensions/lib/quota.ts:521-522`:

```ts
const bucket = buckets.find((b) => b.model_name === "general") ?? buckets[0];
if (!bucket) return undefined;
```

`buckets` is non-empty three lines above (`if (!buckets || buckets.length === 0) { warn(...); return undefined; }`),
so `buckets[0]` is always defined and the arm is unreachable. Per the safe-defaults rule it must not
stay as a silent `undefined`: replace it with a non-null assertion carrying the reason, so the invariant
is stated where it is relied on:

```ts
// `buckets` is non-empty here; the arm above returned otherwise.
const bucket = (buckets.find((b) => b.model_name === "general") ?? buckets[0])!;
```

No other change to `minimaxParts`.

**Also required — a register row.** Add to `docs/investigations/structure-trend.md` a row:
"the pre-refactor quota entry points are test-only and undeleted", open, **carrier named** as a
follow-up order id the orchestrator will allocate (write `carrier: WO-2026-089`), with the blocking fact
from §Rulings (the golden rows need either four test-only exports or a golden-preserving payload
repoint). Do not claim the row is closed.

### Prohibitions

1. **No production behaviour change.** `git diff` on `extensions/lib/quota.ts` and
   `extensions/footer-session-id.ts` is comments and the one `bucket` line; no signature, no export
   addition or removal, no reordering of the descriptor table.
2. **Both entry points stay exported from both modules.** `rg -c 'renderQuotaSegment|renderGoUsageSegment' extensions/lib/quota.ts extensions/footer-session-id.ts` → unchanged counts (definition + use, re-export).
3. **Every row in the four quota test files passes unchanged**, `tests/footer-quota-characterisation.test.ts`
   included and **unedited** (`git diff` empty for all four).
4. **The unreachable arm is gone, and nothing replaced it as a silent fallback**:
   `rg -n 'if \(!bucket\)' extensions/lib/quota.ts` → no output.
5. **No test row spawns**; if one does, it passes `env: childEnv()`.
6. **The register row is added with a carrier, not self-carried.**

### Verification Criteria

```
bun test tests/footer-quota-characterisation.test.ts
bun test tests/footer-session-id-multiplier.test.ts
bun test tests/footer-opencode-usage.test.ts
bun test tests/activity-timeline.test.ts
bun test tests/footer-kimi-usage.test.ts
bun test tests/footer-quota-key.test.ts
```

**Acceptance:** prohibition 2's counts before and after (record both), prohibition 4's `rg`, and a
mutation proving the `bucket` change is behaviour-preserving: delete the `?? buckets[0]` so a payload
with no `general` bucket throws — one or more MiniMax rows red, which shows the fallback is load-bearing
and the assertion is not decorative. Revert; rows green again.

**Report**: `files_modified`; the before/after counts; the mutation result; the register row's text.

### Stop reports

- **`PREMISE FALSIFIED`** — a production caller of either entry point exists (name it and why the `rg`
  missed it), or `buckets` can be empty at the `bucket` line.
- **`PLAN MISMATCH`** — a test row depends on the comment text, or the register file has no such section
  to add a row to.
