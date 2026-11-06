# WO-2026-086 — discovery reads only what its caller will use

### Metadata

- **work_order_id**: WO-2026-086
- **parent_plan_id**: review triage 2026-11-06 (review `notes/review-2026-11-06/pi-config.md`, MEDIUMs "session-start recovery reads every recent log, then discards all but the running sockets" and "`discoverSessions` parses every meta file … including the 5-second viewer tick")
- **sequence_position**: 1 of 3 (then WO-2026-087 dead quota entry points, then WO-2026-088 shared view text helpers)
- **routed_to**: implement
- **invariant_exhaustiveness**: implicit — the census below is a lower bound; enumerate every `discoverSessions` caller and every `listSubagentMetas` caller before changing either signature.
- **priority**: normal
- **estimated_complexity**: moderate
- **review_policy**: required
- **turn_budget**: 70 turns. At 100 without a completion report, stop and report. Targeted rows only — never the full `bun test` (a box-wide `flock` slot; the orchestrator runs it at the gate). Tell any reviewer you spawn the same.
- **base**: `ae9dd71` (`origin/main`, after WO-2026-085)

### Task Summary

**One-sentence description**: `discoverSessions` grows an option that skips the log-only arm, and the registry parse is limited to the ids a call actually reports, so the recovery scan stops reading and parsing sessions it will filter away.

**Goal**: the scan's reads match its callers' needs. Same facts, same answers, less I/O.

### Premise

Verified at `ae9dd71`:

- `enumerateSessions`/`discoverSessions` (`extensions/lib/subagent-discovery.ts:95-180`) reads the full text of **every** in-window log-only session (`readLog`, the log arm) and of every socket's log (the sock arm), then the recovery caller keeps only `s.running` (`index.ts:3368`).
- `discoverSessions` builds its meta map by parsing **every** `pi-subagent-*.meta.json` in the directory before any session exists (`:115` via `listSubagentMetas`), including metas for ids no arm will report.
- Callers, all of them: `extensions/subagent-async/watch-session-v2.ts` (5 s tick, `autoCycleTick`), `extensions/subagent-async/watch-session.cjs` (5 s tick), `extensions/subagent-async/index.ts:3368` (recovery, once per `session_start`), `extensions/subagent-async/test-viewer.cjs` and `tests/watch-session-discovery.test.ts` (rows).
- What the recovery caller uses per session: `id`, `sockPath`, `logPath`, `meta`, `turns`. It never reads `content` or `footer`, and a log-only session can never be adopted (no socket to connect to).
- `listSubagentMetas(dir)` is also called by `extensions/lib/subagent-state.ts`'s `resolveSubagentMeta` (whole registry, by design — a lookup by partial id must see every meta).

### Scope

**Invariants** (what must not change):

- **Every answer both viewers give today, for every fixture shape.** `discoverSessions()` called with no options returns exactly the list it returns now, field for field, including the log-only arm, the 30-minute window, the mtime sort and the unreadable-log answer (`content: null`, `turns: 0`).
- **The recovery scan's answers**: same adopt/skip matrix, same `turns`, same sock/meta/log paths, same stale-socket unlink.
- **`DiscoveredSession`'s shape**: no field added or removed. A caller that needs less must not be given a different object.
- **The window**: `RECENT_WINDOW_MS` stays the one definition, and it still applies to the log-only arm only.

**Files expected to change**:

- `extensions/lib/subagent-discovery.ts` — the option, the arm skip, and the meta map construction.
- `extensions/lib/subagent-state.ts` — `listSubagentMetas` gains an optional id filter (the registry scan is unchanged; only which files get parsed).
- `extensions/subagent-async/index.ts` — the recovery call passes the option.
- Rows in `tests/watch-session-discovery.test.ts` (and `extensions/subagent-async/test-viewer.cjs` if a lib-level row is cheaper there).
- `docs/investigations/structure-trend.md` — the chunk's snapshot.

**Files NOT to modify**: the two watch viewers' render paths, `watch-session.ts`, every existing row in `tests/watch-session-discovery.test.ts` (additions only), `tests/watch-view-vocabulary.test.ts`, `tests/subagent-recovery-ownership.test.ts`.

**Out of scope**: any change to what *content* discovery retains for the viewers; the `readLog` cost the tick already paid before this range.

### Prohibitions

1. **`discoverSessions()` with no arguments returns today's list.** Every existing row in `tests/watch-session-discovery.test.ts` and `test-viewer.cjs` passes unchanged (additions only, zero removed lines in those files).
2. **No second scan.** `rg -c 'readdirSync' extensions/lib/subagent-discovery.ts extensions/lib/subagent-state.ts extensions/subagent-async/index.ts` → **1 / 1 / 0** at `ae9dd71`: discovery's directory listing, the registry's listing, and nothing in the extension entry, which lost its last one when `resolveSubagentMeta` moved (WO-2026-084). The counts must not change.
3. **The option is on `discoverSessions` only**, named for what it does (`socketsOnly`), and only the recovery caller passes it: `rg -n 'socketsOnly' extensions/` → the option's definition, its use, and one call site.
4. **`listSubagentMetas`'s no-filter behaviour is unchanged**, including its rule that a malformed or non-object meta is skipped: every existing `resolveSubagentMeta` row stays green.
5. **No test row spawns without `env: childEnv()`** (`tests/helpers/subagent-env.ts`); the hermeticity gate walks every spawn site.
6. **`turns` still comes from the log read** for a socket session with the option on — a socket's turns are the recovery tracker's baseline and must not become `0` as a side effect of skipping content.
7. **`git diff` on the two viewers is empty.**

### Implementation Specification

`extensions/lib/subagent-state.ts`:

```ts
export function listSubagentMetas(dir: string = SUBAGENT_TMP_DIR, onlySids?: ReadonlySet<string>): SubagentMetaEntry[]
```
— same readdir, same prefix/suffix filter, same `if (!sid) continue`; when `onlySids` is given, a file whose sid is not in the set is skipped **before** its `readFileSync`/`JSON.parse`.

`extensions/lib/subagent-discovery.ts`:

```ts
export function discoverSessions(opts: { dir?: string; now?: number; socketsOnly?: boolean } = {}): DiscoveredSession[]
```
— when `socketsOnly` is true, skip the log-only arm entirely (no stat, no read); the sock arm is unchanged. Then build the meta map from the ids actually collected, in one call:
`listSubagentMetas(dir, new Set(ids))` — so an id with no meta still gets `meta: undefined` and a meta for an unreported id is never parsed.

`extensions/subagent-async/index.ts:3368`: `discoverSessions({ dir: sockDir, socketsOnly: true }).filter((s) => s.running)`.

**Behavior and failure matrix** — new rows (X1–X4) plus the existing rows:

| # | Case | Expected |
|---|---|---|
| X1 | `socketsOnly: true`, a fresh in-window log with no sock plus one sock session | only the sock session is reported; `find` for the log-only id is `undefined`. The log-only arm is not entered at all, which the omission plus the arm skip in the diff covers — say plainly in the report that the *absence of the read* is not directly observable without a read seam, which this order does not add |
| X2 | `socketsOnly: true`, a socket with a 3-turn log | `turns === 3` (skipping content must not zero the baseline) |
| X3 | `socketsOnly: true`, a socket whose log is unreadable | reported, `turns === 0`, `content === null`, no throw |
| X4 | `listSubagentMetas(dir, new Set([a]))` with metas for `a` and `b` | only `a`; a *malformed* meta for `b` does not make the call throw (the filter runs before the parse) |
| X5 | `discoverSessions({dir})` no options, log-only session in window | reported with its content and footer, as today (the regression row for the option's default) |

**Reference patterns**: `extensions/lib/subagent-discovery.ts:95` (the seam object `{dir, now}`), `subagent-state.ts:187` (`listSubagentMetas`'s never-throwing shape).

### Verification Criteria

**Tests that must pass** (targeted, never the full suite):

```
bun test tests/watch-session-discovery.test.ts
bun test tests/subagent-recovery-ownership.test.ts
bun test tests/subagent-state-vocabulary.test.ts
bun test tests/watch-view-vocabulary.test.ts
bun test tests/subagent-id-resolution.test.ts
bun test tests/subagent-boundary-hermeticity.test.ts -t 'explicit env'
node extensions/subagent-async/test-viewer.cjs
```

**Acceptance rows**: X1–X5, each with the mutation that reds it, run alone with the file reverted between mutations. A mutation that leaves behaviour identical is not evidence — say so if you write one.

**Also required — a low-cost hygiene sweep in the rows you touch** (owner 2026-11-06): `tests/watch-session-discovery.test.ts:254` and `:414` and the "picked session with an unreadable log" row in `extensions/subagent-async/test-viewer.cjs` build an unreadable log with `chmod 0o000`, which root can read. Skip those rows when `process.getuid?.() === 0` (`it.skipIf`, or a `continue` in the harness) with a one-line reason at the site. They are the only rows that change in those files beyond X1–X5.

**Cleanup**: fixture dirs removed (`mkdtemp` prefixes in this file are `pi-subagent-test-wo082-*`; say which glob you checked and that it is empty).

**Report**: `files_modified`; the X-row table with mutation evidence; prohibitions 1–7 each with its `rg` or `git diff`; the readers/writers census you enumerated; anything the option forced you to decide that this order did not name.

### Stop reports

- **`PREMISE FALSIFIED`** — a viewer depends on the log-only arm's *content* for a socket session, or the recovery caller needs `content`/`footer` after all.
- **`PLAN MISMATCH`** — the option cannot be added without changing `DiscoveredSession`, or an existing row changes answer.
- **`REFACTOR FIRST`** — the meta map cannot be built lazily without a second registry path.

### Questions (raised 2026-11-06 by the implementer; both ruled by the orchestrator, neither was an owner question)

**Ruled 2026-11-06 — Q-A1: keep the landed row (their option 1).** This order's matrix cell and its
"each with the mutation that reds it" clause contradict each other: a malformed meta for an unasked id
is already swallowed by the parse's `try`/`catch`, so the literal fixture pins nothing. The landed row
is strictly stronger — a *valid* meta for `b` is what reds without the id filter, and a malformed `c`
keeps the no-throw clause. Repairing an under-specified acceptance fixture to make the order's own
acceptance clause hold is not a departure from what the row accepts; it is what the row was for.
**Status: resolved, no owner involvement.**

**Ruled 2026-11-06 — Q-A2: sweep it (their option 2, done at the gate).** The owner's ruling covers
*the chmod rows*, and this order touched that file; this order's enumeration of "three" was the defect,
not the scope. `extensions/subagent-async/test-viewer.cjs:365` now skips under root like the other
three (`node -e 'process.getuid = () => 0; require(...)'` → 98 passed, 2 skipped).
**Status: resolved, no owner involvement.**

Rows are numbered the way WO-2026-078's are; each cites the order text it reads against.

**Q-A1 — the X4 fixture cannot both match this order's wording and red without the filter.**
The matrix says "metas for `a` and `b` … a *malformed* meta for `b` does not make the call throw",
and the Acceptance rows clause says "each with the mutation that reds it". A malformed meta for an
unasked `b` is already swallowed by the parse's `try`/`catch` (`subagent-state.ts:263-266`), so that
row answers `[a]` with or without the id filter — it pins nothing, and it is also green at `ae9dd71`,
against the "X1/X4 cannot pass at base" line in the dispatch note. Landed shape (commit
`dc0503f`): `a` and `b` get valid metas (the valid `b` is what reds without the filter)
and a third id `c` gets a malformed one for the no-throw clause. Options: (1) keep the landed row;
(2) restore the literal fixture and record in the row that it pins nothing. Option 1 is the
implementer's recommendation; the choice is the owner's because it changes an acceptance row's fixture.

**Q-A2 — widen the chmod sweep to the fourth `0o000` row?**
The sweep names three rows. `extensions/subagent-async/test-viewer.cjs:365-372` ("an unreadable log
is kept, with no content, footer or turns", `chmod` at `:367`) builds the same `chmod 0o000` fixture and fails under a
real root user at `eq(s.content, null)`. It is outside the three, so it was left untouched. Options:
(1) leave it (compliant with this order); (2) sweep it in the same style as the other three.

---

### Landing stamp (2026-11-06, merged `4d1c695`, commits `dc0503f` rows + `36a29be` change + `867351f`/`3526d9d` review notes)

**Landed.** `discoverSessions({dir, now, socketsOnly})`; recovery is the only caller that passes it
(`index.ts:3305`), so the 30-minute log-only arm — the picker's concern — is never entered on session
start. The registry scan is limited to the ids the call reports (`listSubagentMetas(dir, onlySids?)`
filters on the file name, above the parse), so a meta for an unreported id costs no read.

**Gated by me at the merged tip:** `readdirSync` **1 / 1 / 0** across the three modules (unchanged);
`socketsOnly` appears 5 times — doc, signature, gate, one call site with its comment; both viewers
untouched (`git diff --stat` empty); the seven targeted suites green (38 / 30 / 21 / 36 / 47 / 3 / 2);
`test-viewer.cjs` 100 passed, and **98 passed / 2 skipped under a forced root uid**.

**My mutations:** the arm gate forced on reds X1; a socket's `turns` taken from the footer reds X2
(3 vs 9 — the fixture separates marker count from footer count); deleting the registry id filter reds
X4; dropping the per-session `meta` assignment reds X6 *and* the pre-existing D8 rows, i.e. the fold
did not leave the old meta coverage behind.

**Two escalations, neither of which reached the owner — that is the finding of this landing.** The
implementer filed both as owner questions and marked the order `partial`. Q-A1 was an
acceptance-fixture contradiction in my own order: the matrix asked for a malformed meta on an unasked id,
which the parse swallows either way, so the fixture could not discriminate — the fix is the landed row
(a valid unasked id is what the filter changes, a malformed third id keeps the no-throw clause), and
choosing a stronger fixture for a clause the order already required is the orchestrator's call, not a
ruling. Q-A2 was my under-count of the chmod rows (two in `test-viewer.cjs`, not one), against an owner
ruling that named the class, not the count — so it was in scope and I swept it at the gate.

**Two order defects, both mine:** (a) the matrix's X4 fixture was under-specified, as above; (b) the
cleanup line's glob (`pi-subagent-test-wo082-*`) names a fixture *id*, not a `mkdtemp` prefix — the real
ones are `wo082-` and `wo082-cjs-`, and `/tmp/wo082-d15.txt` is a leftover **file** from 082, still
there. Also `[moved-citation]`: the recovery call site is `:3305`, not the order's `:3368` (084 moved it).

**Disclosed limit, kept:** X1 cannot prove "no read happened" — the lib has no read seam and this order
adds none. The evidence is the omission plus the arm skip in the diff. Recorded in the row's own comment
rather than papered over.

**Review calibration:** three of four review rounds were about doc arithmetic — the implementer counted
*files* where the code parses *ids*, twice. The final snapshot's numbers are instrumented (7 parses with
no options, 2 with `socketsOnly`, 194 meta files, 830 log-only stat candidates on this box). Carry that
instruction into any order whose deliverable includes a `structure-trend.md` entry.
