# WO-2026-072 — the idle-compaction e2e: find out why it reds, then make it honest

### Metadata

- **work_order_id**: WO-2026-072
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit
- **estimated_complexity**: small
- **review_policy**: required

### Task Summary

`tests/e2e-idle-compaction.test.ts` passed at `22ebe0c` and has failed three times since with
identical code: the full-suite run (10 fails), a standalone run (188 s, no compaction entry), and
another full run (403 s, same row). Nothing landed between the pass and the failures except
markdown, so the row is either load-, provider-, or timing-sensitive. **Prove which, then fix it
so the row reports its own cause.** A row that reds without saying why is how real failures get
rerun away.

### Premise — reproduce first

Run the row three times at today's tip; record the duration, the fail or pass, and the machine's
state. If it passes all three times, say so and treat this as an intermittent — the rest of the
order still applies, because the row cannot report a cause today.

### The flaw that makes this findable

`stubUI()` returns a Proxy whose every method is a no-op, so **every `ui.notify` from the
extension is discarded** — an idle-compaction refusal, a failed summarization call, a skipped
compaction ("session too small") all vanish, and the row reports only "no compaction entry". That
is why three failures produced no diagnosis.

### Mechanism

1. **Capture, then assert.** Replace the swallowing proxy with a stub that records `notify`
   messages (level + text) and keeps the no-op behaviour for every other method. On failure,
   include the captured notifications and the session entry types in the assertion message, so the
   next red names its cause. This is diagnostic, not decoration: the message is the deliverable.
2. **State the cause in the row** once found, in the comment block that already explains why the
   file exists (real session, real provider, `keepRecentTokens` floor). Whichever of these it is:
   - **Provider/credit** (a summarization call returning 402 or similar): the row tests a billed
     live call, and the file's header must say so where a reader will hit it, with the recorded
     failure. Do not add a skip; the project has no skip convention and inventing one hides the
     red.
   - **Timing** (the 180 s deadline losing to a slow provider or a loaded machine): make the
     deadline derive from the observed duration with headroom, and say the number you measured.
   - **Refusal** ("nothing to compact", `keepRecentTokens` floor): fix the fixture and pin the
     floor it must clear, with the token count it actually reaches.
3. **Every row in the file must be able to fail for the reason it names.** If you keep more than
   one row, show for each the mutation that reddens it.

### Acceptance rows

1. The stub records `notify` calls, and a row proves it — inject a notify through the extension
   path (a compaction that names its reason, or a direct call to the stub) and assert it is
   captured. Red today: nothing is captured.
2. A failing compaction's assertion message contains the captured notifications and the entry
   types. Prove by making compaction fail deliberately (a provider that refuses) and pasting the
   message.
3. The row passes at the tip, three runs, with the measured durations recorded in the report.
4. The header comment states the live-call dependence and the observed cause, with the evidence
   that established it.

### Prohibitions

- No `test.skip`, no `test.failing`, no environment-variable escape hatch. If it cannot be green
  deterministically, say so and report — do not make it silently optional.
- Do not change `extensions/checkpoint/*`: WO-2026-071 audits that area in parallel. If the cause
  is in the extension, report it with the evidence rather than editing.
- Do not lower the fixture below pi's 20k-token keep floor to make compaction "easier".
- Do not touch other test files.

### Docs to update

- `docs/investigations/structure-trend.md` only if the row's runtime changes materially (the
  always-on cost budget).
- The row's own header, as above.

### Review

Hard cap 3 rounds. Gate at the tip by running the row three times and pasting the durations, and
by pasting the diagnostic message your stub produces on a deliberate failure.

---

### Landing stamp (2026-11-04, merged `b29ef9f`)

**Cause, reproduced by my own mutant.** The fixture was 1600 lines — 92,179 chars, ~23.0k tokens
by pi's chars/4 floor walk, 15% over the 20k `keepRecentTokens` floor — while the provider reports
~28.9k for the same text. pi decides the cut with the floor walk, not with the number
`getContextUsage()` reports. A prompt that fails at the provider is replaced during recovery by
`context_edit` omissions, so the projected transcript shrinks **below** the floor, idle compaction
refuses, and the only trace was the swallowed notify. My mutant (`fillerLines(1600)` →
`fillerLines(800)`) reproduces the production text exactly —

```
[error] Idle compaction failed: Nothing to compact (session too small)
```

— and reds the row in 10.6 s. Three base runs before the fix: 23 s pass, 195 s fail, 41 s pass.
Three at the tip: 13 s, 18 s, 14 s, both rows green.

**Why the row could red three times without a diagnosis:** `stubUI()` replaced every `ui.notify`
with a no-op, so a refusal, a failed summarization call and a deadline all looked like "no
compaction entry". The stub now records level and text, every failure message carries the captured
notifications and the transcript's entry types, and the wait's three-way exit (`compaction` /
`error notification` / `deadline`) is asserted with a mutation proving the assertion reds.

**Cost moved down:** ~30k billed prompt tokens in 3 requests (base was ~50–60k), runtime 11–21 s
against 23–41 s. The always-on budget improved, so the structure-trend snapshot is deliberately
untouched.

**A product defect this exposed, carried separately:** a provider failure at prompt time makes the
extension report "Nothing to compact (session too small)" when the session was neither small nor
out of cut points — the right cause is the failed prompts. That is a reporting defect in
`extensions/auto-checkpoint.ts`, not a test concern, and it is filed with pcone/pi-config#11.
