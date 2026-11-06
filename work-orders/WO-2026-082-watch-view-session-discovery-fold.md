# WO-2026-082 — one session-discovery function in the lib, used by all three viewers

### Metadata

- **work_order_id**: WO-2026-082
- **parent_plan_id**: planning-seat queue (structure-trend register row "session discovery in the watch viewers")
- **sequence_position**: 1 of 1
- **routed_to**: implement
- **invariant_exhaustiveness**: implicit — the census below is a lower bound. Enumerate every site that
  scans the tmp dir, builds a `pi-subagent-*` path, or applies a freshness window, and a *negative*
  result is the expected one.
- **priority**: normal
- **estimated_complexity**: moderate
- **review_policy**: required
- **turn_budget**: 140 turns. If you pass 180 without a completion report, stop where you are and report
  what has landed and what has not.

### Task Summary

**One-sentence description**: The two viewers that each scan the tmp dir for subagent sessions, plus the
three copies of the id→path rule, fold onto one discovery function in `extensions/lib`, with the
behaviour pinned by characterization rows before the fold.

**Goal**: One function finds sessions. No view file scans a directory, applies a freshness window,
builds a `pi-subagent-<id>.{sock,log,meta.json}` path, or reads a `meta.json` for discovery. Every
screen renders exactly what it renders today for every case the two copies agreed on.

### Premise

`watch-session-v2.ts:378` and `watch-session.cjs:94` are two hand-written copies of the same discovery
rule (tmp-dir socket+log scan, 30-minute window, mtime, meta load), and the same id→path rule exists
three times.

Probes that falsify it, each run at this order's base:

- `rg -c 'readdirSync\("/tmp"\)' extensions/subagent-async/watch-session-v2.ts extensions/subagent-async/watch-session.cjs`
  → **2 and 2**. Zero in either file means that viewer is already folded; report which and continue with
  the rest.
- `rg -n 'RECENT_WINDOW_MS = ' extensions/` → **2** (`watch-session-v2.ts:69`, `watch-session.cjs:92`).
- `rg -n 'pi-subagent-' extensions/subagent-async/watch-session.ts extensions/subagent-async/watch-session-v2.ts extensions/subagent-async/watch-session.cjs`
  → **8 / 6 / 1** sites. The `.cjs` pair and v2's `resolveSockPath` are the same rule with the same
  `/`-passthrough and the same `subagent-` prefixing.
- The lib already owns this knowledge, so the fold must **reuse it rather than add a parallel path**:
  `SUBAGENT_TMP_DIR = "/tmp"` (`extensions/lib/subagent-state.ts:179`), `listSubagentMetas(dir)`
  (`:187`), and the path construction inside `gatherSubagentDiskFacts` (`:479-480`).
  `gatherSubagentDiskFacts` yields the log's **last line** only, not its content, so discovery cannot be
  served by it as-is — it needs content for the footer (WO-2026-080's backwards scan) and the turn
  count.

If the lib already exposes a discovery function at the tip, that is `PREMISE FALSIFIED`: report and land
nothing.

### Preparatory refactor

**Characterization first, as two commits.** Owner ruling below. Commit 1 touches no production file.

1. **Commit 1 — characterization (the existing behaviour, pinned).** `test-viewer.cjs` already carries
   16 rows over the `.cjs` viewer's real `discoverSessions` (active-with-socket, ordering, the
   errored/overflowed/exited/stopped-?/aborted/killed words, the no-socket arm, `RECENT_WINDOW_MS`).
   **v2 has none.** Add `tests/watch-session-discovery.test.ts` pinning, against v2's
   `discoverSessions()`, each row D1–D11 below where it describes **today's** behaviour, including D11's
   *current* answer (v2 **drops** an unreadable log; the `.cjs` keeps it). Fixtures: `pi-subagent-test-wo082-<n>.{sock,log,meta.json}`
   in `/tmp`, removed in `afterEach`, ages set with `fs.utimesSync` — the same technique `test-viewer.cjs`
   uses. Every row must pass **at commit 1**, before any production change.
   - The `.cjs`'s 16 existing discover rows pass unedited at commit 1 and stay unedited at commit 2.
   - Importing v2 runs `bootstrapPiTheme()`; if that needs `node_modules`, link the parent's as a
     gitignored local fix and do not commit it.

2. **Commit 2 — the fold.** Add the lib function, rewire all three viewers, and flip D11 in the new file
   to the `.cjs` disposition with the reason in the diff. Commit 2 must leave every commit-1 row except
   D11 passing **unedited**: a row that needs an edit means a screen changed, so stop.

### Rulings

- **Owner, 2026-11-06, via the planning seat**: "Order it next" — on the register row "session discovery
  in the watch viewers" (two production copies plus the harness). Scope quoted from the same message:
  "one discovery function in extensions/lib (socket scan, log glob, the recent window, metadata load),
  used by both viewers and the test harness, with characterization rows first."
- **Owner, 2026-11-05 (WO-2026-078 Q-A1)**: "Done, but labelled" — a run's state is shown, never
  silently swallowed. Load-bearing here: D11's disposition must not delete a session from the list.
- Author's choices, each argued against the code rather than ruled:
  - **Reuse `SUBAGENT_TMP_DIR` and `listSubagentMetas`**; add no second tmp-dir path parser.
  - **One `readdirSync` per call**, unioning `.sock` and `.log` candidates, instead of two passes.
  - **One log read per session.** Today v2 reads each log twice (content, then `countTurns`); the fold
    reads once and derives both.
  - **Fold the id→path rule too**, including `watch-session.ts:42`. It is the same knowledge as the scan
    and it is three copies; leaving it out guarantees a fourth vocabulary. It changes no screen.
  - **`{dir, now}` options** on the discovery function, matching `gatherSubagentDiskFacts`'s existing
    seam, so rows run against a temp dir and a fixed clock instead of racing `/tmp`.

**Rejected alternatives**: none by owner ruling. Author's rejections: (a) a `subagent-discovery.ts` that
re-derives tmp paths — that is the parallel mechanism this order exists to delete; (b) moving each
viewer's **display** mapping into the lib (`COMPLETED` padding in the `.cjs`, v2's
`RUNNING`/`TERMINAL`/`EMPTY`) — the fold is about finding sessions, and moving display would change
screens.

### Scope

**Invariants** (what must not change):

- **Every screen renders today's output for every case the two copies agreed on.** That includes the
  `.cjs` picker's upper-cased word with its `STOPPED` fallback, v2's `RUNNING`/`TERMINAL`/`EMPTY` and its
  word/outcome, both viewers' mtime-descending order, the `.cjs`'s 1-based `order` field, and every
  `status === "RUNNING"` filter's selection (the picker, the 3-pane auto-selection, the single-pane
  fallback).
- A running session (a `.sock` exists) is `RUNNING` regardless of the log's age — the window applies only
  to the log-only arm, as today.
- A log older than `RECENT_WINDOW_MS` with no socket is skipped by both viewers, as today.
- `parseTerminalFooter`/`readTerminalFooter`/`outcomeFromFooter` keep their acceptance and their
  last-footer-wins scan (WO-2026-080's rows).
- The pi extension entry (`extensions/subagent-async/index.ts`) does not import the discovery module: the
  extension must not gain a tmp-dir scan.
- The `.cjs` viewers are launched by `node` and require the `.ts` lib today (`require("./lib/subagent-state.ts")`).
  Keep whatever mechanism they already use; do not convert a viewer to `.ts`.

**Files expected to change** (guidance, not a limit):
- `extensions/lib/subagent-discovery.ts` — new: `RECENT_WINDOW_MS`, `DiscoveredSession`,
  `discoverSessions(opts)`, `subagentPaths(id, dir?)`.
- `extensions/subagent-async/watch-session-v2.ts` — `discoverSessions` becomes a thin map to
  `SessionInfo`; `resolveSockPath` and `loadSessionMeta`'s path building use the lib.
- `extensions/subagent-async/watch-session.cjs` — `discoverSessions` becomes a thin map; the two inline
  `pi-subagent-…sock` builders use the lib.
- `extensions/subagent-async/watch-session.ts` — its one sock-path builder uses the lib.
- `extensions/subagent-async/test-viewer.cjs` — rows for the shared function, and the cross-viewer
  agreement row (D12).
- `tests/watch-session-discovery.test.ts` — new (commit 1).

**Files to read (reference only, do not modify)**:
- `extensions/lib/subagent-state.ts` `:179-215` (`SUBAGENT_TMP_DIR`, `listSubagentMetas`), `:466-500`
  (`gatherSubagentDiskFacts` — the `{dir, now}` seam to match, and the last-line-only limit that makes
  discovery a separate function), `:355-400` (footer parse).
- `extensions/subagent-async/watch-session-v2.ts:278-296` (`SessionInfo`), `:327-346` (meta mapping and
  its two text helpers — these stay in v2).
- `extensions/subagent-async/watch-session.cjs:88-152` — the copy being replaced.
- `extensions/subagent-async/test-viewer.cjs:155-310` — the 16 rows and their fixture helpers.
- `tests/watch-view-vocabulary.test.ts` — the WO-2026-080 rows; the same fixture style, and the
  `env: childEnv()` rule if commit 1 spawns anything.

**Files NOT to modify**:
- `extensions/subagent-async/index.ts` — the extension entry.
- `extensions/lib/subagent-state.ts` — discovery is a new module that imports it. If you believe a helper
  belongs there instead, say so in the report rather than editing it.
- `tests/watch-view-vocabulary.test.ts`, `tests/subagent-abnormal-stop.test.ts`,
  `tests/subagent-state-vocabulary.test.ts` — WO-2026-080 characterization.

**Out of scope**: the `.cjs`'s now-unused `countLines`; any change to `index.ts`'s owner-state
classification; uniting the two viewers' *display* vocabularies; the 51 merged `pi-subagent-*` branches.

### Prohibitions

Each answered in the completion report with its check's output at the tip.

1. **No directory scan outside the lib** — `rg -c 'readdirSync' extensions/subagent-async/watch-session.ts extensions/subagent-async/watch-session-v2.ts extensions/subagent-async/watch-session.cjs`
   → no output (0 each; `test-viewer.cjs` may keep its own comment).
2. **No `pi-subagent-` literal in any view file** —
   `rg -c 'pi-subagent-' extensions/subagent-async/watch-session.ts extensions/subagent-async/watch-session-v2.ts extensions/subagent-async/watch-session.cjs`
   → no output.
3. **The freshness window is defined once** — `rg -n 'RECENT_WINDOW_MS = ' extensions/` → 1 hit, in the new
   lib module. Callers may import it; no viewer compares an age to a window of its own
   (`rg -n 'mtimeMs > |60 \* 1000' <the three viewers>` → 0).
4. **No `meta.json` read outside the lib for discovery** — `rg -c 'meta.json' <the three viewers>` → 0.
5. **The extension entry gains no scan** — `rg -n 'subagent-discovery' extensions/subagent-async/index.ts` → 0.
6. **The `.cjs`'s 16 discover rows and the 080 rows pass unedited** —
   `git diff --stat <base>..HEAD -- extensions/subagent-async/test-viewer.cjs` touches no existing row
   (additions only), and `tests/watch-view-vocabulary.test.ts` is byte-identical.
7. **No new spawn without an explicit env** — if a row spawns a process, it passes `env: childEnv()`
   from `tests/helpers/subagent-env.ts`; `bun test tests/subagent-boundary-hermeticity.test.ts -t 'explicit env'`
   must be green. (A 080 row was caught by exactly this.)

### Implementation Specification

**The function** — `extensions/lib/subagent-discovery.ts`:

```ts
export const RECENT_WINDOW_MS = 30 * 60 * 1000;

/** The `pi-subagent-<id>` paths for `id`. A `/`-prefixed id is taken as the sock
 *  path itself; a bare id is prefixed `subagent-` when it lacks it. */
export function subagentPaths(id: string, dir?: string): { sockPath: string; logPath: string };

export interface DiscoveredSession {
	id: string;
	sockPath: string;
	logPath: string;
	/** A `.sock` file exists — the session is live whatever the log's age. */
	running: boolean;
	/** Max of the sock and log mtimes when running; the log's mtime otherwise. */
	mtimeMs: number;
	/** `── Turn n ──` occurrences in the log. 0 when the log is unreadable. */
	turns: number;
	/** The log's text, or null when it could not be read. */
	content: string | null;
	/** The terminal footer `content` carries, or null. */
	footer: TerminalFooter | null;
	/** The raw `meta.json` object, when one parsed. */
	meta?: Record<string, any>;
}

export function discoverSessions(opts?: { dir?: string; now?: number }): DiscoveredSession[];
```

Rules, in the order a session is considered:

- Candidates are the `pi-subagent-*.sock` and `pi-subagent-*.log` entries of `dir`, from **one**
  `readdirSync`; an unreadable dir yields `[]` (today's behaviour, both copies).
- A candidate with a `.sock` is `running: true`, `mtimeMs = max(sock, log)`, and is **not** subject to
  the window.
- A candidate without a `.sock` is subject to `now - mtimeMs > RECENT_WINDOW_MS` → skip. `statSync`
  failure → skip (today).
- The log is read **once**; `footer` comes from `readTerminalFooter(content)` and `turns` from the same
  text, so the second read v2 does today is gone.
- An unreadable-but-statable log is **kept**: `content: null`, `footer: null`, `turns: 0` (D11).
- `meta` comes from one `listSubagentMetas(dir)` call, matched by id.
- The result is sorted by `mtimeMs` descending; the viewers keep their own tie-breaking and `order`.

**Each viewer's map** (this is where the screens are preserved):

- **v2** → `SessionInfo`: `running ? "RUNNING" : statusFromLogContent(content ?? null).status`; `word` and
  `outcome` from the same call; `meta` via its existing `loadSessionMeta`-style mapping from the raw
  object (`extractSubject`/`extractWorkOrderId` stay in v2); `turns` as given. `statusFromLogContent`
  gains a `string | null` parameter: `null` → `{ status: "TERMINAL", word: null, outcome: null }`. Its
  080 rows pass unchanged.
- **`.cjs`** → `status: (footer?.word ?? STOPPED_FOOTER_WORD).toUpperCase()`, `word`, `outcome`, then its
  existing mtime sort and `order = i + 1`.
- **`watch-session.ts`** → uses `subagentPaths(id)` for its one sock-path site; no scan.

**Required test boundary**: `discoverSessions({dir, now})` from the lib, plus each viewer's exported
`discoverSessions()` over fixtures in a temp dir or `/tmp`. The three viewer entry points must each be
exercised at least once through their own export, because the fold's failure mode is a viewer mapping the
shared facts wrongly rather than the shared facts being wrong. `test-viewer.cjs` is a row-level harness,
not a boundary.

**Behavior and failure matrix** — dimensions: socket presence (sock+sockless), log age (fresh/stale),
readability (readable/unreadable/missing), content (footer/no footer/empty), meta (present/malformed/absent),
enumeration (dir given/default).

| # | case | expected |
|---|---|---|
| D1 | `.sock` + fresh log with a `Completed (2 turns, exit 0)` footer | `running: true`, `turns: 2`, `footer.word === "Completed"`, in v2 `RUNNING`, in `.cjs` `RUNNING` |
| D2 | `.sock` + **stale** log (90 min) | still returned, `running: true` — the window never applies to a socket |
| D3 | log only, fresh, footer `Errored (3 turns, exit 1)` | `running: false`, `turns: 3`, word `Errored`; v2 `TERMINAL` with outcome `errored`; `.cjs` `ERRORED` |
| D4 | log only, **stale** (> `RECENT_WINDOW_MS`) | skipped by the lib and by both viewers |
| D5 | log only, no footer (`"── Turn 1 ──\n  text\n"`) | `footer: null`; v2 `TERMINAL`, word null; `.cjs` `STOPPED` |
| D6 | log only, empty file | `content: ""`, `footer: null`; v2 `EMPTY`; `.cjs` `STOPPED` |
| D7 | sock only, no log | `running: true`, `content: null`, `turns: 0`, `mtimeMs` = the sock's |
| D8 | `pi-subagent-<id>.meta.json` parses | `meta` present with the parsed object; v2's `SessionInfo.meta` unchanged in shape |
| D9 | `.meta.json` is torn JSON | `meta` undefined, session still returned (no throw) |
| D10 | no meta file | `meta` undefined |
| D11 | log statable, unreadable (mode `000`) | **the fold's one behaviour change**: kept with `content: null`, `footer: null`, `turns: 0`. v2 **drops** this session at commit 1; the `.cjs` keeps it as `STOPPED` today and after |
| D12 | the same fixture through v2's and the `.cjs`'s `discoverSessions()` | both report the same id, `mtimeMs`, word and outcome — the anti-duplication pin |
| D13 | `discoverSessions({dir})` pointed at a temp dir | only that dir's sessions; `/tmp` untouched |
| D14 | `discoverSessions({now})` with the clock past a log's mtime | that log is skipped; the same call with `now` at its mtime returns it |
| D15 | `subagentPaths("subagent-abc")`, `("abc")`, `("/tmp/x.sock")` | `abc`/`abc`→`pi-subagent-subagent-abc.*` only when already prefixed; bare `abc` → `pi-subagent-subagent-abc` is **wrong** — bare ids get the `subagent-` prefix exactly once, and a `/`-prefixed id is used as the sock path verbatim with the log path derived by extension swap |
| D16 | two sessions, mtimes 60 s and 10 s | both viewers list the newer first; `.cjs` `order` is 1 then 2 |

D15's arms are the ones today's three copies disagree-shaped on: check each copy's current behaviour
before writing the helper, and make the row the union of what the three sites do, not a new spelling.

**Representation-level checks**: the returned `DiscoveredSession` carries no display vocabulary (no
upper-cased status, no `order`, no `EMPTY`); `footer` is the parsed object, never a re-parsed word.

**Integration contract**: `watch-session-v2.ts` and `watch-session.cjs` export `discoverSessions()` with
their existing signatures (the `.cjs` keeps `RECENT_WINDOW_MS` in its `module.exports` map if anything
imports it — `test-viewer.cjs` does not today, so a re-export from the lib is fine). `watch-session.ts`
keeps its argv handling. No viewer imports another.

**Reference patterns**: `extensions/lib/subagent-state.ts:179-215` for a tmp-dir helper that never throws
and takes `dir`; `:466-500` for the `{dir, now}` option seam; `test-viewer.cjs:155-310` for fixture
writing, `utimesSync` ageing and cleanup.

### Invariants

**Cross-file conventions**:
- A lib helper that touches the filesystem never throws: every `fs` call is wrapped, as
  `listSubagentMetas` and `gatherSubagentDiskFacts` do.
- The `.cjs` viewers `require` the `.ts` lib directly (node's type stripping); a new lib module is
  imported the same way, with no build step.
- `discoverSessions` is read-only: no writes, no unlinks, no socket connects.

**Default values to preserve**:
- `dir` defaults to `SUBAGENT_TMP_DIR`; `now` defaults to `Date.now()`.
- `RECENT_WINDOW_MS` stays 30 minutes.
- The `.cjs` `order` is 1-based and dense after the mtime sort.

**Ordering assumptions**:
- Sort by `mtimeMs` descending before any viewer maps the list.

**Error handling conventions**:
- An unreadable dir, an unreadable log and a malformed meta each have the arms in the matrix; none of
  them may throw, and none may silently drop a session except D4's stale window.

### Verification Criteria

**Entry points that must work**:
- `node extensions/subagent-async/watch-session.cjs --help`-style launch still starts (the `.cjs` loads
  the new lib through node's type stripping).
- `bun extensions/subagent-async/test-layout.ts` (imports v2) still passes.
- `bun test tests/watch-view-vocabulary.test.ts` still passes, unedited.

**Tests that must pass**:
- `bun test tests/watch-session-discovery.test.ts` — all rows, including D11's commit-2 flip.
- `node extensions/subagent-async/test-viewer.cjs` — all rows, the 16 discover rows unedited.
- `bun test tests/subagent-introspection.test.ts` if it touches discovery (check first).
- `bun test tests/subagent-boundary-hermeticity.test.ts -t 'explicit env'`.
- `bun build --target node --outdir /tmp/wo082 <one viewer>` for both TS viewers; `node --check` the
  `.cjs`.

**Acceptance rows**: the matrix above, each with its own row and, in the completion report, the
mutation that turns it red **run alone**. A row whose expected value is recomputed with the code's own
formula pins nothing.

**Cleanup**: after the rows run, `ls /tmp/pi-subagent-test-wo082-*` is empty.

**Report**: `files_modified`, the D-row table with mutation evidence, the seven prohibitions with their
`rg` output, any row you could not make red, and every screen whose output differs from base with the
reason. If a prohibition cannot hold, that is a `PLAN MISMATCH` stop, not a note.

### Stop reports

- **`PREMISE FALSIFIED`** — the lib already has a discovery function, or a viewer already calls one.
- **`PLAN MISMATCH`** — a commit-1 characterization row cannot be written without changing production
  code (the behaviour is untestable through the boundary), or commit 2 cannot preserve a screen, or a
  prohibition can only hold by editing an existing row.
- **`REFACTOR FIRST`** — if you find the fold needs a second scan path, or the two viewers' `SessionInfo`
  shapes cannot share one `DiscoveredSession` without a per-viewer branch on the shared facts, stop and
  say what the preparatory refactor would be.

---

### Landing stamp (2026-11-06, merged `4c2e2fd`, commits `a526788` characterization + `7eeaeb6` fold + `06b8b44` hygiene)

**Landed.** `extensions/lib/subagent-discovery.ts` holds the scan, the window, the metadata load and the
id→path rule, built on the lib's existing `SUBAGENT_TMP_DIR` and `listSubagentMetas` rather than a second
parser. All three viewers map its facts to their own display. Both production viewers **shrank** (v2
1718 → 1686, `.cjs` 637 → 606, `watch-session.ts` 197 → 196) while gaining the shared facts.

**Gated by me at the merged tip, with my own `rg`s:** `readdirSync`, `pi-subagent-` and `meta.json` are
each **0** across the three viewers; `RECENT_WINDOW_MS = ` appears once, at
`subagent-discovery.ts:29`; `subagent-discovery` appears **0** times in `index.ts`; the four frozen files
(080's vocabulary rows, both characterization suites, `index.ts`, `subagent-state.ts`) are byte-identical
to base. 32 new rows pass, `test-viewer.cjs` 100 (its 16 discover rows unedited), 080's 36 + state-vocab
21, `test-layout.ts` 27, the hermeticity spawn-env row 2. `/tmp/pi-subagent-test-wo082-*` clean after the
run.

**My mutations:** the lib's sock arm `running: true → false` reds two D1 rows, two D2 rows and two D7 rows;
the `.cjs` picker taking its status from the footer instead of `running` reds one row (`99 passed, 1
failed`) — that is the trap the implementer found and pinned; `subagentPaths` dropping the bare-id prefix
reds both D15 rows; `statusFromLogContent`'s unreadable arm `TERMINAL → EMPTY` reds D11.

**My fourth mutation proved nothing, and that is the lesson.** I first inserted `content === null ||` into
the *empty* arm of `statusFromLogContent` — a branch the unreadable arm above it already returns before.
It changed no behaviour, so of course every row stayed green. I had written a non-discriminating mutation
for the second time in this landing series; re-aimed one line up, D11 goes red. A mutation that leaves the
program's behaviour identical is not evidence about a row.

**Full suite, one `heavy --` slot: 1260 tests across 66 files** (base 1228 across 65 — the new file). Red
set compared **by row name with WO-2026-080's run: identical in both directions** — the standing 5 credit,
2 × 402, 2 × #15, 1 hermeticity cascade. Nothing new red.

**Two defects in this order, both mine:**

1. **D15's expectation cell is garbled.** It says `abc`/`abc`→`pi-subagent-subagent-abc` "only when
   already prefixed" and then calls the same output "wrong" for a bare id. The row's own instruction —
   "make it the union of what the three sites do" — is the coherent half, and all three base sites resolve
   identically. The implementer pinned the base union; `review-code` compared 15 id shapes against all
   three base spellings and found them identical on all 15. Cell corrected here, not in the matrix, because
   the row as implemented is the right one.
2. **D16's "`order` is 1 then 2" is unreachable through that viewer's export** — the `.cjs` has no `dir`
   seam, so ambient `/tmp` owns `order: 1`. The row pins the invariant instead (`order === index + 1`
   densely over the mtime sort, newer first), which `review-tests` accepted.

**The one behaviour change, as disclosed before dispatch:** v2 now **keeps** a session whose log stats but
cannot be read (`TERMINAL`, word null, turns 0) where it dropped it. The `.cjs` always kept it. Commit 1
pinned v2's drop, commit 2 flipped that row with the reason in the diff — the characterization-first shape
doing exactly the job it exists for: the change is visible in the diff as a row that moved, not as a
silent divergence.

**Register row left OPEN, against the implementer's "closed".** The three viewers are folded, but
`extensions/subagent-async/index.ts:3365` (`recoverOrphanedSubagents`) still scans the same sock glob,
slices the same id and owns a second turn regex at `:3392` — I verified each of those three facts at the
landed tip. Marking the row closed would say the area is clean while a second copy of the same scan runs on
every extension load. It is **unscheduled and uncarried**; folding it is not a viewer change, because it
decides recovery adoption (027), not display.

**Cost, recorded rather than optimised away:** the `.cjs` picker now reads each live session's log and the
registry where it read neither (65 sessions / 0.3 MB / 46 ms warm, on a 5 s tick). That is the data shape
D1 specifies; the number is in the register snapshot so the next person has a baseline before a
fleet-sized `/tmp`.
