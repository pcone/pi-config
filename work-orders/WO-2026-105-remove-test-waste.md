# WO-2026-105 — remove the test waste the slowdown bisect found

> **Lane**: pi-config, tests only. No production change.

### Metadata

- **work_order_id**: WO-2026-105
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit — the four items below are the dimension
- **priority**: low (hygiene, ~1–2 s)
- **estimated_complexity**: small
- **review_policy**: required
- **order_source**: owner 2026-11-20 ("sounds good"), on the bisect in
  `~/Developer/notes/hermeticity/slowdown.md` (+ `perfile.tsv`).

### Task Summary

The bisect compared a7a0b7f with the 2026-11-13 mainline over the 22 non-live files the
hermeticity row ran. Four of the regressions are waste rather than coverage: a fixed sleep where
an event could be awaited, and per-row git fixtures where one per describe would do. Each item
keeps every row and every assertion.

### Items

1. **`tests/subagent-async-kill.test.ts` R1** (bb5938f). The child that ignores SIGTERM
   announced only "ready", so the row slept a fixed 500 ms and hoped the handler had run. The
   child now announces the signal (`sigterm-arrived|`) and `spawnNode` exposes `saw(text, ms)`,
   so the row waits for the handler. The **real 5 s `HARD_KILL_DELAY_MS` row stays**: it is the
   only row proving the production timer actually SIGKILLs a process (the spy rows call the
   callback by hand). Making the delay injectable would be new production surface and is not
   approved.
2. **`tests/subagent-session-lifetime.test.ts`** rows 8 and 9 (6b19b68). Three fixed 200 ms
   settle sleeps, for a 50 ms timer. Row 8 now arms without the cancel first, keeping the
   "not vacuous" arm and *measuring* how late this box runs the timer, then waits exactly that
   long past the cancelled arm's deadline. Row 9 waits for the steer, then past the same
   measured lateness, so a replaced timer that still fired would have sent a second one.
   A negative assertion needs a window; it no longer needs a guessed one.
3. **`tests/work-record-capture.test.ts`** (f54c170, ebaed88, 0c97b8d, 2ceeb50) — **stopped,
   premise falsified.** See *Items 3 and 4 stopped* below.
4. **`tests/checkpoint-meta.test.ts`** (e9b9de8) — **stopped**, same reason.

### Not waste, so not touched

- The python `wo_record` stub spawning as a real process: it pins the argv/stdin contract.
- Row R1's real 5 s timer (item 1).
- `env: childEnv()` on every spawn; `tests/subagent-boundary-hermeticity.test.ts` fails a spawn
  that omits it.

### Verification

Per-file wall time, **interleaved A/B at matched load** (`git stash push <file>`, run, pop, run,
three rounds), because a before/after at different loads is not evidence:

| file | before (median) | after (median) | load |
|---|---|---|---|
| `subagent-async-kill` | 7.09 s | 6.68 s | 36.4–39.6, 1-min |
| `subagent-session-lifetime` | 1.48 s | 0.97 s | 35.8–36.8 |
| `work-record-capture` | (item stopped) | — | — |
| `checkpoint-meta` | (item stopped) | — | — |

Mutations, one per removed sleep, each run against its own row:

| mutation | row | result |
|---|---|---|
| the child stops announcing the signal (silent SIGTERM handler) | R1 | **red** — `saw` times out at 10 s |
| `clearActiveWait()` removed from the close path | session-lifetime 8 | **red** — the cancelled steer arrives |
| `armActiveWait` no longer clears the previous timer | session-lifetime 9 | **red** — two steers |

Suite: 1585 pass / 0 fail at load ~20-30 (the row count is unchanged: items 1 and 2 rewrote waits, not rows).

### Items 3 and 4 stopped — the approved mechanism is slower than what it replaces

The order said: one fixture per describe, reset before each row. Measured, that reset costs more
than rebuilding the repo, because the cost is the git process and a reset is two of them.

| fixture per row | ms/row (median, interleaved) |
|---|---|
| `mkdtemp` + `git init` + writes + commit (status quo) | **30.3** (implementer, n=20) / **128.4** (orchestrator, 10 rounds, includes three git calls) |
| `git reset --hard <base>` + `git clean -xdf` | **50.3** (implementer, n=20) |
| `fs.cpSync` of an initialised template repo | **1.6** (implementer) / **17.4** (orchestrator) |

Both measurements were interleaved so the arms shared the load (load 19–37); the ratio, not the
absolute, is the finding. Every git call costs 17–35 ms here whatever it does, so sharing a root
pays a reset and cannot beat a one-call `init` — over the 25 shareable rows in
`work-record-capture` the order's mechanism adds ~0.38 s to a 7.4 s file.

Two shape constraints also fight a shared root: `record: false` rows need a `HEAD` no commit
carries the record on, and one row deletes its whole tree.

`tests/checkpoint-meta.test.ts` has **one** row that builds a bare remote (`counts commits ahead
of the upstream`); the rest already use a shared `repo`. Moving that one build into `beforeAll`
added three git processes and 0.1 s of wall time (interleaved, 5 rounds, load 54–64: 2.71 s →
2.81 s median). It was implemented, measured and reverted; its two mutations (drop `-u` from the
push; start the row at a commit past the pushed tip) both went red, so the row's pins are intact
where they are.

No diff landed for items 3 and 4. The implementer stopped with `PREMISE FALSIFIED` rather than
land a measured regression, which is the correct outcome for this order.

### Q-105-a (owner question) — a template copy instead of the approved share-and-reset

The measured win is a different mechanism: build one initialised repo in `beforeAll` and
`fs.cpSync` it per row. Every row keeps its own tree, so there is no reset protocol, no shared
root and no per-shape exception, and the fixture stops paying a git process at all. On bun
1.3.11 the copy's `rev-parse HEAD` and `status --porcelain` match the template's, a row's
`git add` / `commit -- <path>` lands in the copy, and the template is untouched afterwards.

- **(a) Build the template copy in both files** (recommended). ≈ −0.95 s on
  `work-record-capture` by the implementer's per-row figure, more by mine; `checkpoint-meta`'s
  bare-remote row copies a remote+clone pair, its `origin` URL re-set per row. Covers the two
  custom-path rows and deletes the per-shape branching rather than adding to it.
- **(b) Land nothing for items 3 and 4.** The bisect's own note already reads "the fixture cost
  is modest"; the measurements agree, and the two files keep the cost they had.

**(a) changes the mechanism this order's items named, so it is an owner question, not an
implementer's call.** Recommendation: (a), as a separate order touching only these two files
(the shape map is in `~/Developer/notes/hermeticity/fixture-share-2026-11-21.md`).
