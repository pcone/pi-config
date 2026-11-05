# WO-2026-079 — heavy jobs take a machine-wide slot

**Status: LANDED 2026-11-05.** The polled `flock` (above) and the `.gitignore` exception for
`bin/heavy` and `bin/heavy_slot.py` are the dispatcher's corrections to its own wording, not
departures from external-tools/010.

### Metadata

- **work_order_id**: WO-2026-079
- **parent_plan_id**: [decision external-tools/010](../decisions/external-tools/010-heavy-job-slots.md)
- **routed_to**: implement
- **invariant_exhaustiveness**: implicit
- **priority**: high
- **estimated_complexity**: small
- **review_policy**: required

### Task Summary

`bin/heavy` (bun or a POSIX script; pick the simplest that does `flock` correctly on macOS and
Linux) runs a command holding one of N machine-wide slots, waiting until one is free.

### Mechanism

- Slots are lock files `~/.cache/heavy-slots/slot-<i>.lock`, `N` from `HEAVY_SLOTS` (default 1).
  Acquire with an exclusive `flock` (non-blocking, polled every 0.5 s, so a waiter over N slots
  takes whichever frees first and can print its 60 s status). The kernel drops it when the holder
  exits, killed included.
- The holder writes `pid`, the command, its start time and its cwd into `slot-<i>.info`. A waiter
  prints that once (`heavy: waiting for slot 0, held by pid 123 (cargo build …, 4m12s, ~/wt/x)`)
  and then every 60 s.
- The child runs with `HEAVY_SLOT_HELD=<i>`. A nested `heavy` call that sees it runs without
  waiting.
- Exit status is the child's. Signals are forwarded to the child.
- A library form for the tfd harness: the same acquire/release callable from Python
  (`heavy_slot.py` beside the script, stdlib only), so `tests/run_tests.py` can hold a slot without
  a subprocess wrapper.

### Rows

1. Two concurrent `heavy -- sleep 2` runs with one slot take ≥4 s together, and the second prints
   the holder line.
2. Killing the holder with SIGKILL frees the slot at once.
3. A nested `heavy` under `HEAVY_SLOT_HELD` does not wait.
4. The exit status and stdout pass through.
5. `HEAVY_SLOTS=2` lets two run at once.

### Prohibitions

- No daemon, no stale-lock cleanup code (`flock` makes it unnecessary).
- No change to any repo's harness here; tfd's wiring is its own order.

### Docs

The README gains a `bin/heavy` line, and decision 010's Outcome its landing.
