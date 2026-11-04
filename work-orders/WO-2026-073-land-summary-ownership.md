# WO-2026-073 — land the summary-ownership ruling and its two carriers

### Metadata

- **work_order_id**: WO-2026-073
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit
- **estimated_complexity**: moderate
- **review_policy**: required

### Task Summary

The owner ruled on **2026-10-31** that a checkpoint's stored summary is the text `checkpoint.ts`
composes, verbatim, with `compaction-model.ts` yielding on the `[CHECKPOINT]` marker **before** any
fleet call (`decisions/checkpoint/003-summary-ownership.md`). The ruling and both carriers never
merged. Meanwhile pi 1.4.0 armed the fleet override, so since 2026-11-01 this box has been
rewriting checkpoint summaries — 26 of 28 production pairs, proven at the wire in
`docs/investigations/pi-1.4-compaction-override-2026-11.md`. The box is violating a standing
ruling.

Land it: one branch, three sources merged, the ruled behaviour verified against a real compaction.

### Sources

- `summary-ownership` @ `fd3ee99` — the ruling record, WO-2026-061 and WO-2026-062, and the
  deletions of the superseded drafts. No code.
- `pi-subagent-1566ff09c877` @ `418490b` — WO-2026-061: the predicate plus loud fleet failure.
- `pi-subagent-34403ce0c69c` @ `78d356d` + `e9b9de8` — WO-2026-062: authored-section summary
  composition, the machine block, and fail-early field validation.

Both implementation branches sit on `fd3ee99`, not on each other, so you merge: `fd3ee99` first,
then 061, then 062. Where 062 and 061 touch the same function, keep both changes — 061 owns the
dispatch decision and the failure path, 062 owns the composed text. Do not drop either side to
make a conflict go away; if a change genuinely cannot hold both, stop with `PLAN MISMATCH`.

### Renumber, do not collide

`decisions/checkpoint/003-summary-ownership.md` collides with `main`'s landed `003` (wait-state,
2026-11-02), and `004` is now taken by the 1.4 audit record. Renumber the ruling to **`005`** and
update **every** reference to it: WO-061, WO-062, the ruling's own cross-references, the
`decisions/checkpoint/README.md` index row, the sanity-check corrections, and any code comment
that cites it by number. `rg -n '003-summary-ownership|checkpoint/003'` before and after; the
after-count must be zero for the old form and every hit must resolve.

### Acceptance rows

The 12 rows from WO-2026-061 and the 24 from WO-2026-062 must pass **together** at the merged tip,
in one run, each row still red under the mutation its order names. Beyond them, three rows this
integration owes:

1. **The predicate precedes the call.** With the `[CHECKPOINT]` marker present, no fleet request is
   made at all — assert on the transport, not on the result. The ruling's wording is "before making
   any fleet call"; a row that only checks the summary is verbatim passes under a
   call-then-discard implementation, which is the shape that just cost four days.
2. **`/compact` and auto-compaction still get the fleet seat.** The ruling explicitly does not
   reach them; a row proving the marker path is the *only* one that yields.
3. **A fleet failure on a non-checkpoint path is loud**, with the message naming the failure — the
   old silent `undefined` is a defect under every reading of the ruling.

### The verification that matters

Rows are necessary and not sufficient: the bug lived in production for four days while rows were
green on paper. After the merge, drive **one real checkpoint compaction** and compare the persisted
`CompactionEntry.summary` byte-for-byte against the archive's `.pi/checkpoints/*.meta.json`
`summary`. Method and artefacts: `docs/investigations/pi-1.4-compaction-override-2026-11.md` §1
(the driven run with a `globalThis.fetch` wrapper; the control run without `compaction-model.ts`).
Paste the comparison in the report. Before the merge it differs; after it, it must be equal for a
`[CHECKPOINT]` compaction and still differ for a `/compact` one.

### Boundaries

- Do not re-implement the ruling's mechanism. 061 and 062 implemented it; the job is to integrate,
  renumber and prove. A rewrite is a second implementation of a carried concern.
- Do not touch `models.json`, `settings.json` or `APPEND_SYSTEM.md.sec` — another session's
  uncommitted work in the live checkout.
- `work-orders/WO-fleet-client-headers-env.md` is blocked on 061 and stays blocked: landing 061
  unblocks it as a *separate* order, not this one.
- Two parallel orders may be in flight: WO-2026-070 (`extensions/subagent-async/`) and WO-2026-072
  (`tests/e2e-idle-compaction.test.ts`). Touch neither.

### Review

Hard cap 3 rounds. Gate at the merged tip by re-running all 36 rows in one run plus the three new
ones, then mutating the predicate (make `compaction-model.ts` call the fleet before checking the
marker) and showing rows 1 and 2 go red.

---

### Landing stamp (2026-11-04, merged `b18e7c9`)

**Landed.** Eight commits on `pi-subagent-124a5242c74d`: the ruling merged and renumbered to
`decisions/checkpoint/005`, then WO-2026-061's predicate and loud failure, then WO-2026-062's
composition and machine block, then the integration rows I1–I4, the wait-state fixture under the
new field contract, and a structure-trend snapshot. 22 files, +2597/−160. The predicate now sits
before model resolution (`extensions/compaction-model.ts:38`), so ownership is decided by the
marker and not by whether the fleet call happens to succeed.

**Two asks the implementer raised are my errors, not owner questions.**

- **The byte-equality row was mis-specified.** This order demanded the persisted entry summary be
  byte-equal to the archive's `meta.summary`. WO-2026-062 deliberately keeps the machine block out
  of the archive, so the archive is the authored text and the entry is authored **plus** block —
  the ruling's own words ("the authored fields … followed by a machine block"). The correct
  acceptance is therefore prefix-equality plus the block, which is what C1 pins
  (`tests/e2e-checkpoint.test.ts:1712`: `summary.startsWith(`${authored}\n\n### Machine facts\n`)`)
  and what the fleet path fails. The row was a bad translation of the ruling, and I am correcting
  it here rather than asking the owner to ratify my arithmetic.
- **The renumber check was unmeetable as written.** `rg '003-summary-ownership|checkpoint/003'` →
  zero could never hold: `checkpoint/003` legitimately names the wait-state record, and my own
  order text contains the old slug. The right form is the path-only check the implementer ran:
  `rg -n '003-summary-ownership'` → 3 hits, all inside this order's description of the collision,
  zero in `decisions/ docs/ extensions/ tests/`.

**Gate, re-run by me at the merged tip.** `tests/summary-ownership.test.ts` 16/0;
`checkpoint-meta` + `checkpoint-recoverability` + `checkpoint-waits` 49/0; C1 (the composition
row) 1/0. **My own mutation** — deleting the marker yield so the fleet call runs first — reds six
rows, including I1 (`no fleet request at all — not on the seam, not on the wire`), I2 (the marker
is the only yielding shape) and R8. Restored, 16/0. That is the control that matters: a
call-then-discard implementation passes any summary-equality row.

**Carried with carriers named.** `extensions/checkpoint.ts` growth takes a register row with one
open strike, whose candidate extraction (the two `execute` preambles at `:784-860` and `:930-946`)
still needs a carrier. `WO-fleet-client-headers-env.md` is unblocked — 061 landed. Two accepted
gaps from 062's mechanism, out of this order's remit: `captureAheadBehind` returns `null` on error
and renders as "unknown (no upstream)", and `behind > 0` is unexercised.
