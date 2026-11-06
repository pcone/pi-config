# WO-2026-083 — the recovery scan reads session discovery, and nothing else

### Metadata

- **work_order_id**: WO-2026-083
- **parent_plan_id**: planning-seat queue — structure-trend register row "session discovery in the watch
  viewers", the surviving copy the row names at `extensions/subagent-async/index.ts:3365`
- **sequence_position**: 1 of 1
- **routed_to**: implement
- **invariant_exhaustiveness**: implicit — the census below is a lower bound. Enumerate every site that
  globs the tmp dir or parses a turn count, and every branch of the vault you touch. If you find a site
  this order does not name, say so in the report rather than folding it silently.
- **priority**: normal
- **estimated_complexity**: small-to-moderate
- **review_policy**: required
- **turn_budget**: 140 turns. If you pass 180 without a completion report, stop where you are and report.
  Targeted rows only — never the full `bun test` (a box-wide `flock` slot; the orchestrator runs it at the
  gate). If you spawn any reviewer, tell it the same.
- **base**: `6cbc9f6` (`origin/main`, after WO-2026-082)

### Task Summary

**One-sentence description**: `recoverOrphanedSubagents` stops scanning the tmp dir for `*.sock` and stops
parsing its own turn count; it takes both from `discoverSessions()` in `extensions/lib/subagent-discovery.ts`,
keeping its ownership predicate and its connection/tracking logic exactly where they are.

**Goal**: one scan of `/tmp` for subagent sessions in the whole repo's production code. Today there are
two, and the second one is this function.

### Premise

Verified at `6cbc9f6`:

- `rg -n 'endsWith\("\.sock"\)' extensions/` → one hit, `extensions/subagent-async/index.ts:3365`.
  `extensions/lib/subagent-discovery.ts` builds its sock arm from directory entries, not from a literal.
- `rg -n 'Turn \\\(\\\\d' extensions/` → one hit at `index.ts:3397` inside this function. The lib counts the
  same thing with `TURN_LINE_RE` (`subagent-discovery.ts:31`). `index.ts:2204` is a *print* of the header, not
  a parse — leave it.
- `discoverSessions({dir, now})` already reports everything this function reads for itself: `id`, `sockPath`,
  `logPath`, `mtimeMs`, `running`, `turns`, `content` (or `null` when unreadable), `footer`, `meta`
  (the raw registry object, or `undefined`).
- `listSubagentMetas(dir)` in `extensions/lib/subagent-state.ts:187` takes the same directory, so the
  `dir` seam the recovery tests inject still resolves metas from the injected directory. This is why the
  fold is possible at all: the lib's discovery and its registry loader already share one directory argument.
- `decideRecoveryAdoption` already lives in the lib (`subagent-state.ts:162`) and is the only consumer-side
  owner of decision 027's rule. It does not move in this order.
- The pinning rows already exist: `tests/subagent-recovery-ownership.test.ts` (594 lines; eleven calls to
  the scan with injected `dir` / `selfPid` / `selfSessionId` / `probe` / `connect`), plus recovery rows in
  `tests/subagent-abnormal-stop.test.ts`, `tests/work-record-capture.test.ts` and
  `tests/subagent-worktree-lock.test.ts`.

### The 027 question, settled here

Decision 027 (`decisions/subagents/027-recovery-scan-ownership.md`) rules **what** adoption requires:
`ownerPid` + `ownerStartToken`, with the 2026-11-02 supersession adding `parentSessionId` as the proof that a
dead owner's child is *ours*. That content is settled and this order does not touch it. Three placement
questions follow from folding the scan, and this order settles them; **none needs an owner ruling**, because
each is answered by an existing ruling plus the lib's stated contract, and the orchestrator is instructed to
stop and ask rather than guess if one turns out not to be.

1. **The predicate does not move onto discovery.** `decideRecoveryAdoption` stays in `subagent-state.ts` and
   keeps being called from `index.ts` with `selfPid` / `selfSessionId` / `probe`. Discovery reports disk
   facts; it has no session identity, and giving it `selfSessionId` + a liveness probe would hand every
   viewer two parameters it never uses and put policy into a read-only finder. Its module doc already states
   the contract: report facts, never a screen's vocabulary. **Prohibition P3 and P6 enforce this.**
2. **Discovery's freshness window does not apply to sockets.** `RECENT_WINDOW_MS` is a *viewer* display
   policy — a log older than 30 minutes is not worth a picker row. Recovery is the opposite: an orphaned
   socket from three hours ago still needs its stale file unlinked or its child tracked. The lib's sock arm
   already ignores the window (only the log-only arm applies it); **row W1 exists so a later refactor cannot
   quietly "reuse the viewer's filtered list"** and stop adopting old orphans.
3. **A socket with no readable meta stays skipped, before any connection.** Base `continue`s on an
   unparseable or missing meta file. In the folded path `meta` is `undefined` and the predicate would answer
   `skip-legacy` — the same outcome by a different route, so the fold must keep the explicit skip and must
   **not unlink the socket** on that path (base leaves the file; only a failed `connect` unlinks). **Row W2
   pins the no-connect and the surviving file.**

**Rejected alternative**: teaching `discoverSessions` an `ownership` option so recovery calls it with
`{selfPid, selfSessionId, probe}` and gets only adoptable sessions back. It reads tidier and it is wrong:
adoption is a decision with three outcomes (`adopt`, `skip-live-owner`, `skip-foreign-session`) that the scan
logs and the tests assert, so the option would have to return the verdict anyway, and discovery would then
import process identity and a liveness probe to answer a question about one caller.

### Preparatory refactor

**`none`.** The area already has its characterization: 027's matrix plus 043's and the abnormal-stop rows
drive this function through an injected directory, probe and connection factory, and every adopt/skip arm
has a row. The fold replaces three in-loop reads (meta `JSON.parse`, log read, turn regex) with fields from
one call and adds no branch, so there is no second path that would need separating first.

The commit shape still fronts the behaviour, as WO-2026-082 did:

- **Commit 1 — rows only, no production change.** Add W1–W4 (below) to
  `tests/subagent-recovery-ownership.test.ts`. Every new row must pass **at base**, because they pin today's
  answers. If one cannot pass at base, that is `PLAN MISMATCH` — do not adjust the row to fit.
- **Commit 2 — the fold.** All of commit 1's rows and every existing row pass unedited.

### Scope

**Invariants** (what must not change):

- **Every adopt/skip answer for every meta shape.** Live foreign owner → skip. Dead foreign session → skip.
  Legacy (no `ownerPid`, or no `parentSessionId`) → skip. Recycled pid → adopt. Unreadable or missing start
  token → skip. Same process (`pid === selfPid`) → adopt. Same `parentSessionId` → adopt. Already-tracked
  sid → never re-adopted.
- **The `unref` contract**: the recovery client is `unref()`ed unconditionally; spawn handles stay
  referenced. A recovered connection never pins the event loop.
- **The stale-socket path**: a failed `connect` unlinks the sock file, deletes the sid from `running`, and
  updates the footer. A live-then-closed connection classifies the run from the log footer
  (`readTerminalFooter`) with `exitCode: null` when no footer names one.
- **`recoveryScanDirOverride` and `deps.dir` both still direct the scan**, and metas resolve from the same
  directory (the tests rely on this: they inject a directory holding sock + log + meta).
- **The recovered `RunningSubagent` literal**: every field keeps today's value, including
  `progress.currentActivity: "recovered"`, `killedExplicitly: false`, `stoppedExplicitly: false`,
  `turnNudged: false`, and the `parentTrackerKey` / `ownerAsksRequired` derivations.

**Files expected to change** (guidance, not a limit):

- `extensions/subagent-async/index.ts` — the scan's readdir block, the per-socket meta read and the turn
  regex; the import of `discoverSessions` from `../lib/subagent-discovery.ts`.
- `tests/subagent-recovery-ownership.test.ts` — commit 1's rows.
- `docs/investigations/structure-trend.md` — the register row this order carries.

**Files to read (reference only, do not modify)**:

- `extensions/lib/subagent-discovery.ts` (the function being adopted; `DiscoveredSession` at `:50`)
- `extensions/lib/subagent-state.ts:162-207` (`decideRecoveryAdoption`, `listSubagentMetas`)
- `decisions/subagents/027-recovery-scan-ownership.md`
- `decisions/subagents/043-owner-state-and-checkpoint-recoverability.md`

**Files NOT to modify**:

- `extensions/lib/subagent-discovery.ts` — **no new parameter, no new export.** If the fold seems to need
  one, stop with `PLAN MISMATCH`; the lib's surface is what three viewers and their rows are pinned to.
- `extensions/lib/subagent-state.ts` — the predicate is not moving.
- The three watch viewers and their tests.
- Any existing test row, including every row in the four test files named in the premise.

**Out of scope** (name these in the report, do not touch them):

- `resolveSubagentMeta` (`index.ts:424-450`) — a *second* tmp-dir scan in this same file: it globs
  `pi-subagent-*.meta.json` on a hardcoded `/tmp` and lazily reads each meta, where `listSubagentMetas(dir)`
  already does exactly that. It is a separate fold with its own behaviour (partial-id matching, an
  ambiguity error), and this order is the sock scan. Recorded in the register row, not folded here.
- The recovered-`RunningSubagent` field list, the close handler's output handling, and anything in the spawn
  path.

### Prohibitions

1. **No sock glob left in `index.ts`.** `rg -n 'endsWith\("\.sock"\)' extensions/subagent-async/index.ts` →
   no output. (`rg -c 'readdirSync' extensions/subagent-async/index.ts` → **1**, down from 2: the survivor
   is `:428`, the out-of-scope meta scan. A count of 0 there means you deleted something you were told to
   leave; say so.)
2. **No second turn parser.** `rg -n 'Turn \\\(\\\\d' extensions/subagent-async/index.ts` → no output.
   `rg -n '── Turn' extensions/subagent-async/index.ts` still shows `:2204` (a header print).
3. **The predicate is still called, once per candidate, from `index.ts`**, with `selfPid`, `selfSessionId`
   and `probe` from `deps`/`ctx` exactly as now. `rg -n 'decideRecoveryAdoption' extensions/` → the
   definition in `subagent-state.ts` and one call site in `index.ts`.
4. **The four pinning test files are unedited** except for commit 1's additions:
   `git diff <base>..HEAD -- tests/subagent-abnormal-stop.test.ts tests/work-record-capture.test.ts
   tests/subagent-worktree-lock.test.ts` is empty, and `tests/subagent-recovery-ownership.test.ts` shows
   additions only (zero removed lines).
5. **No test row spawns a process without `env: childEnv()`** from `tests/helpers/subagent-env.ts`. The
   repo's `subagent-boundary hermeticity` gate walks every spawn site; a new file that spawns inherits the
   obligation even if no row exercises it (WO-2026-082's one red).
6. **`extensions/lib/subagent-discovery.ts` and `extensions/lib/subagent-state.ts` are byte-identical to
   base.** `git diff <base>..HEAD -- extensions/lib/` empty.
7. **Every existing row in the four pinning files passes unchanged**, including the 027 matrix, the
   `unref` assertions, the stale-socket unlink row and the `session_start` handler wiring row.
8. **`git diff` on `index.ts` touches `recoverOrphanedSubagents` and its import line only** — no reordering,
   no formatting sweep, no change to the `RunningSubagent` literal's values.

### Implementation Specification

**The fold** — inside `recoverOrphanedSubagents`, replace:

- the `fs.readdirSync(sockDir).filter(...)` block and its surrounding try/catch,
- the per-socket `sid` slice, `sockPath` / `logPath` / `metaPath` construction, the meta `JSON.parse` with
  its `continue`,
- `let turns = 0; try { … .match(/── Turn (\d+) ──/g) … } catch {}`,

with:

```ts
const sessions = discoverSessions({ dir: sockDir }).filter((s) => s.running);
for (const s of sessions) {
  const { id: sid, sockPath, logPath, meta } = s;
  if (running.has(sid)) continue;
  if (!meta) continue;            // base skipped an unreadable/missing meta; keep the file
  const adoption = decideRecoveryAdoption(meta, { … });   // unchanged
  if (adoption !== "adopt") { debugLog(…); continue; }
  const turns = s.turns;
  …the existing RunningSubagent literal, unchanged…
}
```

Notes the implementer must not "improve":

- Keep the outer `try { … }` — the function stays never-throwing even though discovery never throws.
- Keep the `connect(sockPath)`, the `unref()`, both `error` and `close` handlers, the `unlinkSync` fallback
  and the close handler's own log read. `s.content` from scan time can be stale by the time the socket
  closes; that read stays a read.
- The `close` handler continues to call `readTerminalFooter` on a freshly read log — do not substitute the
  scan-time `footer`.
- `s.meta` is the raw registry object (`Record<string, any>`), so `meta.agentName`, `meta.cwd`,
  `meta.worktreePath`, `meta.systemPrompt` and the rest read exactly as they do today.
- A `running` entry with a sock but no log gives `turns: 0` and `content: null` — the same answers base
  produced from its `catch`.

**Behavior and failure matrix** — dimensions: socket age (fresh / older than the 30-minute window), meta
presence (valid / absent / torn JSON / legacy-without-owner), log presence (present / absent / unreadable),
and listing (sock present / log only). Rows W1–W4 are **new and must pass at base**; the rest exist.

| # | Case | Expected |
|---|---|---|
| W1 | sock + valid meta + log, everything 3 h old | adopted; `running` gains the sid; `progress.turns` = the log's turn count. **The 30-minute window must not filter the sock arm.** |
| W2 | sock + no meta file | no connection opened (`connect` never called); the sock file **still exists** afterwards |
| W3 | sock + meta + unreadable log (chmod 000) | adopted; `progress.turns === 0`; no throw |
| W4 | a fresh log file with no sock, inside the window | not adopted; `connect` never called |
| W5 | sock + meta whose `ownerPid` is a live foreign pid | `skip-live-owner`; no connection |
| W6 | sock + meta whose owner pid is gone, `parentSessionId` matches | adopted |
| W7 | sock + legacy meta (no `ownerPid`) | `skip-legacy`; no connection |
| W8 | sid already in `running` | skipped; no re-adoption |
| W9 | `deps.dir` / `_testSetRecoveryScanDir` injected directory | discovery scans **that** directory, and metas resolve from it |
| W10 | adopted socket whose listener is gone (`connect` errors) | sock file unlinked, sid removed from `running`, footer updated |
| W11 | torn meta JSON | skipped, no connection, no throw |

**Representation-level checks**: no new type, no new export, no change to `RecoveryScanDeps`. The function's
signature is identical, so every existing call site and row compiles unchanged.

**Reference patterns**: `extensions/lib/subagent-discovery.ts:95` for the call shape; the existing
`recoverOrphanedSubagents` body for everything this order does not name.

### Verification Criteria

**Entry points that must work**:

- `session_start` → `recoverOrphanedSubagents(pi, ctx)` adopting a self-owned socket from an injected
  directory (the existing handler row).
- `bun build --target node --outdir /tmp/wo083 extensions/subagent-async/index.ts` exits 0.
- A load smoke test: `pi -ne -e ./extensions/subagent-async/index.ts --offline --mode rpc` starts and exits
  without error.

**Tests that must pass** (targeted, never the full suite):

```
bun test tests/subagent-recovery-ownership.test.ts
bun test tests/subagent-abnormal-stop.test.ts
bun test tests/work-record-capture.test.ts
bun test tests/subagent-worktree-lock.test.ts
bun test tests/subagent-boundary-hermeticity.test.ts -t 'explicit env'
```

**Acceptance rows**: the matrix above, each with its own row and, in the completion report, the mutation
that turns it red **run alone** — `bun test tests/subagent-recovery-ownership.test.ts -t '<row>'` — with the
file reverted between mutations. A mutation that leaves behaviour identical is not evidence; say so if you
write one.

**Cleanup**: every fixture directory removed; `ls -d /tmp/pi-subagent-test-wo083-*` empty.

**Report**: `files_modified`; the W-row table with mutation evidence; prohibitions 1–8 each with the `rg` or
`git diff` that shows it holds; the two commits with their file lists; anything in `index.ts` you found that
this order did not name.

### Stop reports

- **`PREMISE FALSIFIED`** — `discoverSessions` cannot supply `meta`, `turns`, or the sock path for a socket
  session; or `listSubagentMetas` does not follow the injected directory; or the 027 matrix cannot pass
  through a discovery-fed scan.
- **`PLAN MISMATCH`** — the fold needs a new parameter or export on the discovery lib; or a W-row cannot be
  made to pass at base; or a behaviour in the matrix differs from what base does — **stop and report the
  difference rather than pinning the new behaviour**.
- **`REFACTOR FIRST`** — the recovery function needs the scan split out before it can take the change, or
  `resolveSubagentMeta`'s meta scan turns out to be entangled with this one (it should not be: it is a
  separate function and a separate question).

---

### Landing stamp (2026-11-06, merged `85f100d`, commits `4b32c9e` rows + `ff533bf` fold + `633cec0`/`df64add` review notes)

**Landed.** `recoverOrphanedSubagents` takes the socket list, the registry object and the turn count from
`discoverSessions({ dir })`. Three hand-written reads and a second turn regex are gone
(`index.ts` 4758 → 4752, the function 168 → 161). The 027 predicate did not move: `decideRecoveryAdoption`
stays in `subagent-state.ts:162` and is still called from `index.ts` with `selfPid` / `selfSessionId` /
`probe`.

**Gated by me at the merged tip, with my own `rg`s:** `endsWith("\.sock")` in `index.ts` → **0**;
`readdirSync` in `index.ts` → **1** (the out-of-scope meta scan, now `:429`); the turn parser → **0**, the
header print surviving at `:2205`; `extensions/lib/` byte-identical; the `index.ts` diff is one import line
and two hunks inside the function, no field value touched; the four pinning files' 79 rows green
(30 / 23 / 15 / 11), hermeticity `-t 'explicit env'` green, no fixture dirs left (`/tmp/pi-recovery-*` →
none; note the W-rows' `mkdtemp` prefix is `pi-recovery-`, not the `pi-subagent-test-wo083-` this order's
cleanup line names — see defect 2).

**My mutations, each alone with `index.ts` restored from a sha1-verified copy:**

| mine | mutation | red |
|---|---|---|
| M1 | recovery reuses the viewer's window: `… .filter(s => s.running && Date.now() - s.mtimeMs <= 30*60*1000)` | W1 |
| M2 | the `running` filter dropped, so the log-only arm reaches `connect` | W4 |
| M3 | `if (!meta) { fs.unlinkSync(sockPath); continue; }` | W2 |
| M4 | the predicate called with `selfSessionId: undefined` | three existing 027 rows (dead-owner adopt, its owner_asks delivery, the gone-listener drop) + W1 + W3 |

M4 is the one that mattered: it proves 027's matrix still bites *through* the fold, i.e. the scan did not
quietly stop consulting the predicate while staying green on its own new rows.

**Full suite, one `heavy` slot: 1264 tests across 66 files.** Red set identical to WO-2026-082's tip
**except one row** — `idle compaction (live session) > compacts itself after the idle delay and leaves a
marker` (75.8 s, in-suite). It is a timing row: run alone it passes, 2/2, at 102 s. Nothing in this diff
can reach it (`git diff 1755470..HEAD` touches `index.ts`'s recovery function and one test file), so it is
a load flake recorded, not a regression. The standing set is otherwise unchanged row-for-row.

**Three defects in this order, all mine:**

1. **Prohibition 3 asserted a count I never took.** It said `decideRecoveryAdoption` has "one call site in
   `index.ts`". Base has **two** (`:3383` the scan, `:3562` the reap) plus one lib-internal
   (`subagent-state.ts:552`), and the tip keeps all three at `:3380` / `:3556` / `:552`. I read the
   definition with a scoped `rg` and then wrote a file-wide count from memory. The prohibition's *substance*
   holds (one call per candidate, all three deps); its number was fiction.
2. **The cleanup criterion proves nothing.** `ls -d /tmp/pi-subagent-test-wo083-*` is vacuous: this file's
   fixtures are `mkdtemp(path.join(tmpdir(), "pi-recovery-"))`. I copied the line from WO-2026-082's order,
   where the prefix did match. The implementer caught it and checked the right glob.
3. **Two citations moved** under the new import line (`:428`→`:429`, `:2204`→`:2205`): process-only, re-derived.

**Three behaviour deltas the order could not pin, disclosed rather than hidden.** A row that pins any of
these fails at base, which the order forbids: (a) a socket file named `pi-subagent-.sock` was adoptable as
sid `""` at base and the lib's `if (!id) continue` skips it; (b) a scan directory whose *path* contains
`.sock` never matched a meta at base, because base's `sockPath.replace(".sock", ".log")` rewrote the
directory segment — the lib's anchored `replace(/\.sock$/, …)` fixes that, a favourable change nobody asked
for; (c) iteration moves from readdir order to `mtimeMs` descending, so several adoptable sockets connect in
mtime order. No adopt/skip answer changes.

**Register: closed, with the residue split out honestly.** The row is now "session discovery in `/tmp`" and
closed — the sock scan has one implementation. The implementer added a **separate row** for
`resolveSubagentMeta`'s meta glob (`index.ts:429`, hardcoded `/tmp` where `listSubagentMetas(dir)` already
does it), carried by itself. That is the right shape: two different folds, two different carriers, neither
pretending the other finished the area.

**Cost, recorded:** every log and every meta in the directory is read on each `session_start`, where base
read a log only for a socket it had already decided to adopt. Once per start, over `/tmp`; the viewers pay
the same reads on a 5 s tick.

**Budget:** implementer 73 turns of 140 (no stop-report), plus one dispatch killed at turn 8 by a provider
429 storm with zero files touched; my gate ~40.
