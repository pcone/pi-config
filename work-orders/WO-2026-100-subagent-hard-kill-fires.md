# WO-2026-100 — the subagent runner's SIGKILL fallback actually fires

### Metadata

- **work_order_id**: WO-2026-100
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit
- **estimated_complexity**: small
- **review_policy**: required
- **order_source**: owner, 2026-11-13, relayed by seat `8f90746f` ("The sleep-guard SIGKILL bug: yes, its own order. It's the likely reason a frozen child survives a stop."), on the audit finding in `docs/investigations/pi-1.5.1-audit.md` §6.

### Task Summary

`extensions/subagent-async/sleep-guard.ts:238` guards its hard kill with

```ts
if (rs.proc && !rs.proc.killed && rs.proc.exitCode === null) {
```

Node sets `killed = true` on a *successful* `kill()` call, so after the SIGTERM
that precedes it the guard is always false and the SIGKILL never fires. Measured
on this box after a successful SIGTERM: `killed=true, exitCode=null,
signalCode=null`. A child that ignores SIGTERM therefore never hard-kills, which
is the likely reason a frozen child survives `subagent_stop`.

The same defect was fixed upstream in pi 1.5.1's `exec.js`, which checks
`exitCode === null && signalCode === null` instead.

### Scope

`dispatchKillSignals` in `extensions/subagent-async/sleep-guard.ts` (the SIGTERM
and the delayed SIGKILL), and any other place in `extensions/subagent-async/` that
decides whether a child is still alive from `proc.killed`. Grep for it:
`rg -n '\.killed' extensions/` — report every site and its verdict.

### Acceptance rows

1. **The kill escalates.** A child that ignores SIGTERM is dead after
   `HARD_KILL_DELAY_MS`, and the row asserts the process signal is `SIGKILL` (not
   `SIGTERM`) and that the wait ends. It must fail against the current guard —
   show that run.
2. **The escalation stays off for a child that exits on SIGTERM.** No second
   signal to a dead process: the timer must be cleared or the guard must see the
   exit, and the row asserts no throw and no `kill` call on an exited child.
3. **A kill requested for an already-dead child** returns `alreadyDead` and arms
   nothing (existing behaviour, pinned).

Keep `HARD_KILL_DELAY_MS` as it is unless a row needs otherwise; if the delay
changes, say how the test rows keep their timing budget.

### Sequencing

Independent. The audit is landed or landing as a doc only; this is the code fix it
names.

### Verification

- Row 1 red before the change, with the measured `killed/exitCode/signalCode`
  triple shown in the report.
- Full suite: one `bin/heavy -- bun test`, green apart from the known pre-existing
  reds (`tests/subagent-model-inheritance.test.ts:493` and the hermeticity row
  derived from it).
- No new public surface.
