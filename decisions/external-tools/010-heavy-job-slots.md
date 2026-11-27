---
title: "Heavy jobs take a machine-wide slot"
type: decision
status: accepted
date: 2026-11-05
---

# Heavy jobs take a machine-wide slot (external-tools/010)

**Ruling (owner, 2026-11-05, in Claude session 8f90746f).** On 2026-11-05 the box (6 cores, 8 GB)
reached a 1-minute load of ~280 with five full suites and builds running at once, and timings and
gates went bad together. Asked what kind of job queue to build, Scott picked "Slot lock in the
harness (Recommended)".

What it settles, in the recorder's reading of the option he picked:
- A machine-wide semaphore: `flock` on lock files under `~/.cache/heavy-slots/`. The kernel releases
  a lock when its holder dies, so a lock never goes stale.
- The tools that start heavy work take a slot themselves, so no agent has to cooperate: tfd's
  `tests/run_tests.py` (a full suite and its release build) holds one for its run.
- A `heavy -- <cmd>` wrapper covers every other heavy command (a cargo build, a bun suite, a
  benchmark). A waiter prints who holds the slot (pid, command, start time, cwd).
- One slot to start with. A process that already holds one (an env var marks it) does not wait
  again, so a wrapped `run_tests.py` does not deadlock on itself.
- The tool lives in pi-config, so every repo shares it.

**Rejected:** a queue daemon with priorities (a long-lived process and more machinery); policy only,
with load checks in briefs (agents did not follow it reliably on 2026-11-05).

Carrier: [WO-2026-079](../../work-orders/WO-2026-079-heavy-job-slots.md).

## Outcome (landed 2026-11-05, order WO-2026-079)

On two commits:

- `819c263` — `bin/heavy` (the CLI), `bin/heavy_slot.py` (`slot()`, the importable form), and
  `tests/heavy-slots.test.ts` (one test per order row). `.gitignore` un-ignores the two scripts;
  `bin/` stays ignored for the binary tools.
- `8deeda1` — the README line.

Waiting polls the slots with `LOCK_EX | LOCK_NB` every 0.5 s, not one blocking `flock`: a waiter
over N slots must wake when any slot frees, and must print the holder every 60 s. The kernel still
releases each lock when its holder dies.

Open: when the holder is SIGKILLed, the child keeps running without a slot. Nothing stops it.

## Slots per machine — three on the box (owner, 2026-11-27, Claude session 6af3ba2a)

The one-slot line above was written for the 6-core Mac. tfd-box has 8 vCPU and 22 GB, and under
`HEAVY_SLOTS=2` two concurrent jobs each used all 8 cores: measured bursts of 36–41 runnable threads,
33–37 % system time, no I/O wait. Asked to pick between 3 slots of 4 cores and 2 slots of 6, Scott
chose **3x4** ("yeah lets do 3x4").

Applied in the box's `~/.zshenv`, not in any tracked file: `HEAVY_SLOTS=3`, `CARGO_BUILD_JOBS=4`,
`RUST_TEST_THREADS=4`. The two Rust vars are what caps a *single* job at 4 cores, which is the half of
the ruling `bin/heavy` cannot enforce.

`bin/heavy_slot.py` keeps its `HEAVY_SLOTS=1` default: a machine states its width in its own
environment, and a repo default of 3 would over-subscribe a 2-core CI runner. A running pi seat picks
the new value up on restart, since the env is read at process start.
