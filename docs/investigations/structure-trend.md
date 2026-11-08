# Structure trend

Chunk-boundary structural snapshot for this repo. Convention: `APPEND_SYSTEM.md`
§Refactor-needed register, `decisions/subagents/024-structural-growth-checks.md`
and `040-refactor-first.md`. One entry per chunk
landing, newest first, under two lenses — **growth** (file/function size deltas,
candidate extractions) and **unification** (parallel mechanisms for one idea;
files unrelated work items all had to touch). Delta-based — no absolute
thresholds. Each audit runs as `scout-code` over the delta since the previous
entry. Each growth or parallel-mechanism finding is a strike on its area in the register below;
two strikes, or one `REFACTOR FIRST` refusal, close the area to feature work until its
refactor lands.

## Refactor-needed register

| area | strikes (landing or refusal) | state | refactor |
|---|---|---|---|
| `extensions/{checkpoint,auto-checkpoint}` read tracking | 1 (2026-10-21) | open — one duplicate copy remains in `auto-checkpoint.ts` (blocked: another session's WIP, migration order pending owner ruling) | fold `auto-checkpoint.ts` onto `extensions/lib/read-tracking.ts` |
| `extensions/checkpoint.ts` growth | 1 open (2026-11-04, WO-2026-073); the 2026-10-21 strike was resolved by WO-2026-057 (901 → 818) and is spent | open — one open strike, **carrier named: WO-2026-076** (the extraction itself, dispatched as its own order). Reading used: closure needs one more flagged landing (or a `REFACTOR FIRST` refusal); the extraction closing does not itself close the area — a further flagged landing would | the two `execute` preambles in `checkpoint` and `checkpoint_fork` (`checkpoint.ts:784-860`, `:930-946`) into one helper, behind characterization rows (WO-2026-076) |
| `extensions/subagent-async/index.ts` growth | 3 landings (090 turn cap, 091 reap, the model-inheritance fix) — closed 2026-11-08 | **closed 2026-11-08 by WO-2026-095** — 5215 → 2143 lines over eight responsibility modules, 153/153 declarations with one home, no import cycle among them. The order's 1600-line bound was not met (entry point 1151 + the sections row 9 keeps); `Q-095-a` carries what splits the remainder | — (no further extraction scheduled; the area reopens on the next flagged landing) |
| terminal-outcome vocabulary in the watch views | — (closed by WO-2026-080, `a8ff8be`) | **closed 2026-11-05** — 0 terminal word literals in the three viewers; `rg -n 'function outcomeFrom(Footer|ExitCode|FooterWord)' extensions/` → 3, all in `extensions/lib/subagent-state.ts`; the two live viewers had also been dead since pi-tui 1.4 (WO-2026-081) | — |
| the viewers' text helpers (`plainLen`, `stripAnsi`, `padRight`, `timeAgo`, `truncate`) | — (closed by WO-2026-088) | **closed 2026-11-07** — one module, `extensions/lib/view-text.ts`, 5 exports: `rg -n 'function (plainLen|padRight|timeAgo|stripAnsi|truncate)' extensions/subagent-async/watch-session.cjs extensions/subagent-async/watch-session-v2.ts` → 0; `rg -n 'plainLine' extensions/` → 0 (the `.cjs`'s second name for `stripAnsi`). `watch-session.cjs` still *exports* `plainLen`, `padRight`, `timeAgo`, `truncate` — as re-exports of the module, because `test-viewer.cjs:51-53` imports them from the viewer, which is the harness's contract | — |
| `extensions/lib/quota.ts` overflow policy | — (residue of WO-2026-065, not a strike) | open — carried; no order scheduled, so the row is the carrier. Five provider entries keep two behaviours: z.ai and both MiniMax hosts `clip` the first part, Go and Kimi `truncate` it | unify on one policy, then re-baseline the segment goldens in `tests/footer-quota-characterisation.test.ts` |
| session discovery in `/tmp` | — (observation only; no landing was flagged for it) | **closed 2026-11-06 by WO-2026-083** — the three viewers folded in WO-2026-082 (`7eeaeb6`), then the last production copy: `rg -n 'endsWith("\.sock")' extensions/subagent-async/index.ts` → 0, `rg -c 'readdirSync' extensions/subagent-async/index.ts` → 1 (the out-of-scope meta scan, `:429`), `rg -n '── Turn' extensions/subagent-async/index.ts` → 1 (`:2205`, a header print). `recoverOrphanedSubagents` now takes its sock list, meta and turn count from `discoverSessions()`. The adoption predicate did not move: `decideRecoveryAdoption` stays in `subagent-state.ts:162`, called from `index.ts` with `selfPid` / `selfSessionId` / `probe` (WO-2026-083's 027 section). One copy is named and left uncarried: `resolveSubagentMeta` (`index.ts:426-456`) globs `pi-subagent-*.meta.json` on a hardcoded `/tmp` where `listSubagentMetas(dir)` already does it — its partial-id matching and ambiguity error make it its own fold, not this one's | — |
| `resolveSubagentMeta`'s meta glob | — (residue of WO-2026-083, not a strike) | **closed 2026-11-06** — `rg -n 'endsWith("\.meta\.json")' extensions/subagent-async/index.ts` → 0; the resolver filters `listSubagentMetas` in `lib/subagent-state.ts`, and `test-resume.cjs` requires it instead of mirroring it (`rg -n 'function resolveSubagentMeta' extensions/subagent-async/test-resume.cjs` → 0) | — |
| pre-refactor quota entry points (`renderQuotaSegment`, `renderGoUsageSegment`) | — (observation; no landing was flagged for it) | **closed 2026-11-07 by WO-2026-089** — both deleted; `rg -n 'renderQuotaSegment|renderGoUsageSegment' --glob '!*.md' extensions/` → 0. The three rendering files reach the one renderer through `tests/helpers/quota-render.ts` (one shared adapter, 82 lines), which assembles the snapshot the private `snapshotFor` used to build from `descriptor.fromQuotaData` / `goParts`; `goParts` is the one internal export added, marked `@for-testing` and still called by `goDescriptor.parse`. `fromQuotaData` stays: descriptor metadata the adapter reads. No golden moved — every `expected:` string in the four files is byte-identical | — |

## 2026-11-08 — chunk: WO-2026-095 `subagent-async/index.ts` split by responsibility

**growth.** `extensions/subagent-async/index.ts` 5215 → **2143** (−3072; `--numstat` 292 3364),
replaced by eight responsibility modules totalling **3465**: `spawn.ts` 817, `recovery.ts` 697,
`worktree.ts` 599, `sleep-guard.ts` 439, `rpc.ts` 346, `ui.ts` 213, `turn-cap.ts` 211, `records.ts`
143. Of the 3465, 69 lines are the entry point's import/`export … from` wiring and ~240 are the eight
module headers and import blocks; the rest is moved body. Every file is under the 900-line follow-up
threshold, so nothing is split further. `index.ts` did **not** reach the order's 1600-line bound: the
extension entry point alone is 1,151 lines (nine tool registrations, five commands, the wait source),
and the sections row 9 keeps — constants, the reviewer-spawn tracker, meta helpers, progress tracking,
live-session ctx, attach state, `git`/`getPiInvocation`, model resolution, tool-action formatting plus
`detach()` — are another ~900. `Q-095-a` in the order asks what carries the remaining split.

**unification.** The census is the point of this chunk: 153 top-level declarations before the split,
**0** declared twice, **98** referenced from more than one section. At the tip each of the 153 has
exactly one home (`rg`-derived definition scan over the nine files (the eight extractions plus the residual entry point): 153/153, 0 duplicated, 0
missing), so the split removed no duplicate and created none. Three placements were decided by the
"one new file, one row" rule rather than by the physical section: `bumpActivity` sits in `rpc.ts` (the
protocol layer observes activity; the timer reads it) because leaving it with the timer made
`rpc.ts` ↔ `sleep-guard.ts` cyclic; the scan-dir/cargo-home overrides and the heartbeat/caffeinate
state moved with the code that assigns them (a module cannot assign an imported `let`); and
`extractFilesFromArgs` / `formatProgress` / `formatTokens` / `writeTempFile` / `getFinalOutput` were
placed by responsibility, not by which section they happened to sit in. `detach()` could not move at
all (`Q-095-b`).

**import graph.** `rg -o 'from "\./[a-z-]*\.ts"'` over the eight modules: `spawn` → 7, `sleep-guard`
→ 3, `recovery` → 2, `ui` → 2, `records` → 1, `turn-cap` → 1, `worktree` → 0, `rpc` → 0. Acyclic
among the eight. All eight import `index.ts`, which imports all eight: the entry point is a hub by
construction, because row 9 keeps the state they all read (`running`, `liveSessionCtx`,
`attachedSessionId`, the meta helpers, the constants). The hazard that a hub cycle normally carries —
a module reading an uninitialised `const` from the hub at its own top level — is absent: every
cross-module reference is inside a function body.

**cost.** Module load, interleaved A/B, 12 samples each, in-process import: 529 ms pre-split vs 526 ms
at the tip (−4 ms, −0.7%) — no measurable cost. 69 lines of the entry point are the re-export shims
plus the eight import statements.

**not taken.** Splitting the entry point's tool registrations into their own module. It is the largest
remaining block and the obvious next extraction, but row 9 says index keeps the tool surface and the
order forbids a file the table has no row for; that is an owner question, not an implementer's call.

## 2026-11-07 — chunk: WO-2026-090 the harness enforces a turn cap

**growth.** `extensions/subagent-async/index.ts` 4689 → **5033** (+344), `extensions/lib/subagent-state.ts`
636 → **801** (+165), new `tests/turn-cap.test.ts` **1206** (1208 before the E2 deletion). The growth is one mechanism in two halves:
pure decisions in the lib, IO and one `message_end` entry in the extension (`turnCapTurn`, 1 production
call site). Candidate extraction, when the area is next opened: `extensions/lib/turn-cap.ts` holding the
constants, the decider, the fold and the budget line, leaving `index.ts` with the closure over `rs`.
Not done here — `index.ts` grew by a mechanism, not by duplication.

**unification.** The steer send is one helper with **five** callers (450 nudge, `subagent_stop`, the
`steer` tool, the wind-down, the stall steer) — it was three copies of the same `isDone`/`procExited`/
`stdin` guard block before the preparatory refactor. The stall state is one `StallTracker` value rather
than six sibling fields on `RunningSubagent` (`rg -n 'rs\.stall(Turns|Steered|Observed|LastTip|Pending|FoldedTurn|InFlight)'`
→ 0). Kill paths unchanged at 9 `proc.kill` sites.

**cost.** The commit observation was synchronous per turn (286 ms mean, 1.3 s p95 under load) and is now
one async `git rev-parse` every 10 turns: a 10× reduction in spawns and no blocking on `message_end`
(`rg -c 'execFileSync' extensions/subagent-async/index.ts` → 0).

**not taken.** Folding the observation on the turn it lands instead of on a later sample — it would
tidy the detected-latency number and change acceptance row U7; the owner ruled the bound instead
(two sample intervals, worst case 50).

## 2026-11-07 — chunk: WO-2026-089 the test-only quota entry points are gone

**growth.** `extensions/lib/quota.ts` 707 → 655 (−52; `--numstat` 5 57): the 55-line tail deleted
(blank, the 16-line "Test seams" block, then `renderQuotaSegment`'s 21 lines and
`renderGoUsageSegment`'s 15), less 3 lines added to `goParts`' doc block.
`extensions/footer-session-id.ts` 1115 → 1111 (−4; `3 7`): two names out of a re-export block and its
comment. `tests/helpers/quota-render.ts` is new at 82, of which ~30 are the doc block. The test files
moved 0 lines of fixtures: 7 in, 10 out, all imports plus one export-name assertion in
`activity-timeline.test.ts`.

**unification.** One adapter, not four: `rg -n 'function renderQuotaSegment|function
renderGoUsageSegment' tests/` → 2, both in `tests/helpers/quota-render.ts`, and the three files that
call them import it. No production surface gained but one internal export: `rg -n 'export function
goParts' extensions/` → 1. Provider gating in the Go arm is the renderer's own `snapshot.provider !==
provider` guard rather than a second copy of it. The goldens are unchanged because the parts still
come from `fromQuotaData` / `goParts`, the conversions `descriptor.parse` uses.

**not taken here.** Re-authoring the fixtures as raw API payloads (the review's other reading) would
move every golden and change what the rows pin from renderer bytes to the parse-plus-render pipeline,
which the descriptor-wiring block already covers against `ZAI_PAYLOAD` / `MINIMAX_PAYLOAD`.

## 2026-11-07 — chunk: WO-2026-088 the viewers' text helpers are one module

**growth.** `extensions/subagent-async/watch-session.cjs` 606 → 574 (−32; `--numstat` 11 43),
`extensions/subagent-async/watch-session-v2.ts` 1686 → 1642 (−44; `1 45`), new
`extensions/lib/view-text.ts` 98. Each viewer lost five private helpers and gained one `require` / one
`import`; the lib's 102 lines are the five bodies plus the doc block that carries the ruling. No branch
was added to a function that already had one: `plainLen`'s scan and `truncate`'s walk moved verbatim, and
`padRight` lost the `.cjs` copy's redundant `Math.max(0, …)` clamp (the early return already covers it).
New `tests/view-text.test.ts` 137 (test-only; commit 1 pinned the `.cjs`'s answers, commit 2 the shared
module's).

**unification.** One idea, one home, counted at the landed tip: `rg -n 'function
(plainLen|padRight|timeAgo|stripAnsi|truncate)' extensions/subagent-async/watch-session.cjs
extensions/subagent-async/watch-session-v2.ts` → 0; `rg -c 'export function
(plainLen|padRight|timeAgo|stripAnsi|truncate)' extensions/lib/view-text.ts` → 5; `rg -n
'plainLine' extensions/` → 0, so `stripAnsi` is the only name for stripping. The module imports nothing
(`rg -n '^import|require\(' extensions/lib/view-text.ts` → 0), which is what lets the `.cjs` viewer
require it under plain `node`.

**the ruling's table, corrected by measurement — an open owner question.** WO-2026-088 measured the two
`plainLen` forms as differing "only on an escape sequence that never terminates". Exhaustively over the
597,871 strings of length ≤ 6 from `ESC [ m 1 ; a ? < space`, 28,002 differ, and **every** divergent
string contains an `ESC [` the regex could not strip — 0 diverge where every `ESC [` starts a matchable
`ESC [ [0-9;]* <letter>`. The divergent class is therefore "what the regex fails to strip", one term
wider than the table: a body byte outside `[0-9;]` counts too (`ESC[?25l` 6 → 0, `ESC[<64;3;5M` 10 → 0),
and 42 of the 28,002 run the other way, the scan counting a stray `ESC` inside a sequence as a column
(`ESC[ESC[0m` 4 where the regex gave 2). This is a behaviour change the ruling's "nothing else changes"
did not name, so the order's own `PREMISE FALSIFIED` clause fires: the mechanism landed as ruled, the
module's doc block and `tests/view-text.test.ts` state and pin the wider class, and acceptance waits on
the owner's word. The `.cjs` cuts raw log lines (`watch-session.cjs:402`), so a line carrying a sequence
neither viewer composed measures and cuts differently than it did; SGR-only content, which both viewers
compose, is unaffected — the 100-row harness and 27 layout rows pass unchanged.

**watch.** `truncate` is the one helper only one viewer calls: v2 cuts with pi-tui's `truncateToWidth`, so
a v2 line that needs the ellipsis contract would add a second cutter unless it calls the lib's. Neither
viewer is named in this chunk's duplication finding: the fold removed a copy from each.

## 2026-11-06 — chunk: WO-2026-086 discovery reads only what its caller uses

**growth.** `extensions/lib/subagent-discovery.ts` 182 → 191 (+9; `--numstat` 35 26): `discoverSessions`
85 → 89 lines, the log-only arm behind one `if (!opts.socketsOnly)` and the registry scan moved below
the arms so it can name the ids the call reports. `extensions/lib/subagent-state.ts` 631 → 636 (+5):
`listSubagentMetas` 21 → 22, one skip on the file name. `extensions/subagent-async/index.ts` 4688 →
4689 (+1): the recovery call passes the option. Test-only: `tests/watch-session-discovery.test.ts`
525 → 621 (+96; `--numstat` 98 2, the two minus lines being the two D11 rows gaining `.skipIf`),
`extensions/subagent-async/test-viewer.cjs` 605 → 620 (+15; `--numstat` 16 1, the row's skip guard,
the harness's `__piSkip` arm and the skipped count in the summary). No function gained a branch on an
already-duplicated structure; the arm's body is the same code under a guard.

**unification.** Still one registry scan and one log read: `rg -c 'readdirSync'
extensions/lib/subagent-discovery.ts extensions/lib/subagent-state.ts extensions/subagent-async/index.ts`
→ 1 / 1 / 0 (unchanged); `rg -n 'meta\.json' extensions/lib/subagent-discovery.ts` → 0, so discovery
never names a registry file itself. `rg -n 'socketsOnly' extensions/` → 5 hits: one doc paragraph
(`subagent-discovery.ts:98`), the definition (`:104`), its one use (`:159`), and one call site with its
comment (`index.ts:3300`, `:3305`); the two viewers and `test-viewer.cjs` call the no-option form, and
`git diff` on `watch-session.cjs` / `watch-session-v2.ts` is empty. The chmod skip reuses the repo's
`skip()` convention (an `__piSkip` throw, counted in the summary line) rather than a second one:
`rg -n '__piSkip = true' extensions/` → 5, one `skip(msg)` per `.cjs` harness.

**cost, measured at the landed tip on this box.** `/tmp` held 60 `.sock`, 890 `.log` and 194
`.meta.json` files; `discoverSessions('/tmp')` reported 71 sessions (60 socket, 11 in-window log-only).
Warm: 13.9 ms and **7** meta parses for the no-option call, 7.9 ms and **2** with `socketsOnly` — the
scan parses only the metas whose ids it reports, where before it parsed all 194. The 830 log-only
candidates still cost one `statSync` each (the window check follows the stat,
`subagent-discovery.ts:163-173`); only the 11 in-window ones are read. Viewer ticks likewise drop to
the ids they report. Parse counts are instrumented, not file counts.

**not taken here.** The socket arm still reads a socket's whole log for `content` and `footer`, which
recovery reads neither of: it wants `turns` only. Splitting that returns a different `DiscoveredSession`
shape, which this order forbids, so it stays a separate question with its own order.

## 2026-11-06 — chunk: review triage, the meta lookup and the memoised key

**growth.** `extensions/subagent-async/index.ts` 4752 → 4688 (−64): `normalizeIdQuery`,
`idMatchesQuery` and `resolveSubagentMeta` moved to `lib/subagent-state.ts` 575 → 631 (+56), and
`index.ts` re-exports them. `extensions/subagent-async/test-resume.cjs` 840 → 810 (−30): its copy
of the resolver is gone, a `require` replaced it. `footer-session-id.ts` 1107 → 1113 (+6). New
`tests/footer-quota-key.test.ts` (3 rows).

**unification.** `rg -n 'readdirSync\("/tmp"\)' extensions/subagent-async/index.ts` → 0. The
resolver's own listing and its per-id `readMetaJson` read are both gone; one registry scan serves
the recovery scan, the viewers and the id lookup. `warnOnce` is exported rather than copied, so a
second warn site shares the fetch path's once-per-provider memory.

**not taken here.** The review's other MEDIUMs are queued as orders (discovery's eager log/meta
reads, the viewers' duplicated text helpers, the dead `renderQuotaSegment`/`renderGoUsageSegment`
entry points) and one is an owner question (the marker-with-no-pending checkpoint arm against
decision 005).

## 2026-11-06 — chunk: WO-2026-083 the recovery scan is discovery's last copy

**growth.** `extensions/subagent-async/index.ts` 4758 → 4752 (−6); `recoverOrphanedSubagents` 168 → 161
lines (−7), replacing a readdir block, a meta `JSON.parse` and a log read + own turn regex with one
`discoverSessions({ dir })` call and three field reads. No branch added, none removed from the
adoption path. `tests/subagent-recovery-ownership.test.ts` 594 → 766 (+172, test-only — commit 1's
rows plus the review round's one-line comment fix; additions only, `--numstat` → `172 0`).

**unification.** One idea, one home, counted at the landed tip: `rg -n 'endsWith("\.sock")'
extensions/subagent-async/index.ts` → 0; `rg -c 'readdirSync' extensions/subagent-async/index.ts` → 1
(the out-of-scope meta scan); `rg -n '── Turn' extensions/subagent-async/index.ts` → 1 (a header
print, not a parse). The 027 predicate stayed put deliberately: discovery reports disk facts and has
no session identity, so an `ownership` option would have put one caller's policy into the lib and
returned a verdict anyway.

**cost.** Every log in the directory is read, and so is every meta (`readLog` runs unconditionally in
the lib's sock arm, `listSubagentMetas` in the scan's), where the pre-fold scan read a log only for a
socket it had already decided to adopt and a meta only for sockets. In-window log-only sessions are
read before the `running` filter drops them too. Once per `session_start`, over `/tmp`; the viewers
already pay the same reads on a 5 s tick.

**residue, named not carried.** `resolveSubagentMeta` (`index.ts:426-456`) still globs
`pi-subagent-*.meta.json` on a hardcoded `/tmp`. Different question (partial-id matching, an ambiguity
error), so it is its own order.

## 2026-11-06 — chunk: WO-2026-082 session discovery is one function

**growth.** Deltas at the landed tip: `watch-session-v2.ts` 1718 → 1686 (−32), `watch-session.cjs`
637 → 606 (−31), `watch-session.ts` 197 → 196 (−1), new `extensions/lib/subagent-discovery.ts` 179,
`test-viewer.cjs` 520 → 605 (+85, test-only), new `tests/watch-session-discovery.test.ts` 525
(test-only). Both production viewers shrank: the fold deleted discovery, `countTurns`, `loadSessionMeta`,
`resolveSockPath`, `RECENT_WINDOW_MS` and two `readdirSync` passes and added a 10-line and a 12-line map.
No branch was added to a long function. No candidate extraction is left in the viewers.

**unification.** One idea, one home, counted at the landed tip: `rg -c 'readdirSync' ` over the three
viewers → 0; `rg -c 'RECENT_WINDOW_MS = ' extensions/` → 1; `rg -c 'pi-subagent-' ` over the three
viewers → 0; `rg -c 'meta\.json' ` over the three viewers → 0. Three things folded, not one: the scan, the
freshness window and the id→path rule. The window and the scan had drifted into two copies that agreed;
the path rule existed three times (v2's `resolveSockPath`, the `.cjs`'s two inline builders,
`watch-session.ts:42`) and had not.

**cost.** The `.cjs` picker now reads every live session's tail facts where it previously read neither the
log nor the registry: on this box 65 live sessions, 0.3 MB, 46 ms warm, on a 5 s tick. That is the data
shape the order specifies (a socket session carries `turns` and its footer), so the number belongs in the
snapshot rather than in a follow-up: re-check it before a fleet-sized `/tmp`.

**remaining copy, not this chunk's.** `extensions/subagent-async/index.ts:3355-3395`
(`recoverOrphanedSubagents`) scans the same sock glob, slices the same id and owns a second turn regex
(`:3392`). The order forbids the extension entry from importing discovery, and that function answers the
owner-classification question (027), so folding it is a separate order with its own premise. The register
row above records it as unscheduled.

## 2026-11-05 — chunk: WO-2026-081 + WO-2026-080 the views read the vocabulary, and the viewers load again

**growth.** `watch-session-v2.ts` 1677 → 1727 (+50), `watch-session.cjs` 606 → 639 (+33),
`watch-session.ts` 188 → 197 (+9), `extensions/lib/subagent-state.ts` 550 → 575 (+25). The three viewer
files gained the fold's plumbing and lost two regexes, one private word list, one fabricated `exitCode = 0`
and one dead `EXIT n` branch; the lib gained `MAX_TURNS_HARD`, `outcomeFromExitCode` and
`outcomeFromFooter`, which `classifyOutcome` now calls instead of owning. New
`tests/watch-view-vocabulary.test.ts` (+181) — test-only. Net: `subagent-state.ts` is the only file in the
repo that names a terminal word or matches a footer line.

**unification.** One idea, one home, counted at the landed tip: `rg -n '"Completed"|"Errored"|"Overflowed"|"Aborted"|"Killed"|"Exited"|"Stopped"'` over the three viewers → 0; `rg -n 'function outcomeFrom(Footer|ExitCode|FooterWord)' extensions/` → 3, all in the lib; `rg -c 'MAX_TURNS_HARD = ' extensions/` → 1; `rg -n 'exitCode === 0'` over the viewers → 0. The fold cost two orders because the four viewers had drifted into five vocabularies *and* two of them had stopped loading — the same idea's decay and the reason nobody noticed were the same fact: nothing runs a viewer in CI.

**watch.** `extensions/subagent-async/index.ts` (4761) and `watch-session-v2.ts` (1727) are the top two non-test sources; this chunk grew v2 by 50 lines and deleted more mechanism than it added, so it is a **downgrade** on v2 as well. A fourth footer word site, or a viewer that re-derives an outcome, is the strike: the register row above is closed, so the next vocabulary change edits `subagent-state.ts` and no view.

**observation for the next refactor needed here, not this chunk's:** only the vocabulary was folded.
*Session discovery* — the `/tmp` socket scan, the `pi-subagent-*.log` glob, its own copy of
`RECENT_WINDOW_MS = 30 * 60 * 1000` and the metadata load — is still two production copies
(`watch-session-v2.ts`, `watch-session.cjs`; `rg -c 'readdirSync' ` → 2 each). `test-viewer.cjs` is not a
third: it imports the `.cjs` viewer's real `discoverSessions` and writes fixtures into `/tmp` for it, and
its only `readdirSync` hit is a comment. The register row states the pair as a fact; scheduling is the
owner's.

## 2026-11-05 — chunk: WO-2026-078 abnormal terminal turns are labelled

**growth.** `extensions/subagent-async/index.ts` 4688 → 4761 (+145/−22): the classifier, the word
table and the two live-handler call sites, minus the three booleans and their branches it replaces.
`extensions/lib/subagent-state.ts` 431 → 550 (+122/−3): `classifyOutcome`, `OUTCOME_WORD`, the reversed
vocabulary and `TERMINAL_FOOTER_RE` built from it. New `tests/subagent-abnormal-stop.test.ts` (750
lines, 23 rows) — test-only. Net structural effect is **down** in `index.ts`, despite the line count:
"how did this run end" went from three independent booleans (`isDone`, `killedExplicitly`, exit code)
read at three sites to one classification read from one table. Named extraction for a future landing:
`terminalOutcome` is now the file's single funnel for terminal vocabulary, and the recovery path's
`terminalOutcome`-from-footer read is its second consumer, so a third consumer (watch views, see below)
has one place to come to.

**unification.** One idea, one home, counted at the landed tip: `rg -c 'isAbnormalStop'` in
`subagent-async/` and `lib/` → 0 (it survives only in the unloaded `_index.ts.off`); `rg -c 'code \?\?
0|exitCode \?\? 0'` → 0; `rg -o 'footer: "[A-Za-z]+"' extensions/lib/subagent-state.ts` → the five
words, and `TERMINAL_FOOTER_RE` is generated from the same list, so read and write cannot drift.
`rg -n 'terminalOutcome\(' extensions/subagent-async/index.ts` → 3 (footer, delivery, recovery).

**carried, with its carrier named.** Five hand-itemised footer vocabularies outside this chunk
(`watch-session.ts`, `watch-session-v2.ts` ×2, `watch-session.cjs` ×2, `test-viewer.cjs`, plus the test
mirror) do not know the three new words. They fall back on mtime/`STOPPED`, so no child is claimed to be
running forever — the cost is live-tail styling. This is a unification refactor (five copies, one
vocabulary) and it has no order yet: the register row below is its carrier until one is written.

**watch.** `extensions/subagent-async/index.ts` is 4761 lines, the repo's largest non-test source file,
and three of today's four landings touched it or its neighbours. This entry is a **downgrade** rather
than a strike, because the landing removed branches rather than adding them; a further landing that adds
a fourth word site or another boolean over terminal state is the strike.

## 2026-11-05 — chunk: WO-2026-076 checkpoint execute-preamble extraction

**growth.** `extensions/checkpoint.ts` 1150 → 1231 (+81, `git diff --numstat` 161/−80): the two
`execute` preambles are now one module-private helper, and each tool body keeps only the half that
differs. The line count rose because a helper needs its own signature, options union and doc comment;
the measure that matters for this area moved the other way. New `tests/checkpoint-preamble.test.ts`
(602 lines, seven rows) — a test-only file, no production surface. Export count 3 → 3, checked, so the
"no new exported symbol" prohibition held without needing an accessor.

**unification.** The strike this closes was one mechanism duplicated per rule: five steps (validate,
owner verdict, continuation, git binding, in-flight) each appeared twice. Counts at the landed tip, one
`rg` per element, all → 1: `validateSummaryFields(params.summary)`, `checkOwnerState(params.nextSteps`,
`resolveContinuation(params.continue`, `listInFlightSubagents({`, `formatInFlightSection(inFlight)`.
The one dispatch site is `options.tool === "checkpoint_fork"` → 1. No second vocabulary: the refusal
verb is a literal per tool, not a default, and `rg -F 'archived or'` → 1 site.

**register.** `extensions/checkpoint.ts` growth: the 2026-11-04 strike is resolved by this landing and
spent. The area is **not** closed — the register's reading is that closure needs two flagged landings,
and this one is the named refactor rather than a second strike. A further landing that duplicates
structure there reopens it with a fresh strike.

**watch.** The extraction is where a third tool would land, and it is the file's only funnel for tool
preparation. Two things to watch rather than act on: `PendingCheckpoint.injection` is the one member
filled after construction (`pending.injection = injection`), so a second post-construction field means
the literal is no longer the whole shape — C1 pins the assignment set to exactly `injection` so that
shows up as a red row rather than a silent gap. And the fork hoists its `ctx.sessionManager` reads
above validation, so a throwing read on a stale ctx surfaces where a rejection path once read nothing;
both reviewers rated it LOW and no row covers that state.

## 2026-11-04 — chunk: WO-2026-073 summary-ownership integration (061 + 062 merged)

**growth.** `extensions/checkpoint.ts` 994 → 1150 (+156), `extensions/compaction-model.ts`
68 → 79 (+11: the predicate, and the notify guard folded onto `lib/safe-notify.ts` in place of
a local copy), new `extensions/lib/checkpoint-summary.ts` (169),
`tests/summary-ownership.test.ts` 600 → 800 (15 rows). Counts measured at the landed tip. 062's own delta on `checkpoint.ts` was
+221/−65; the net is smaller because main's wait surface and 062's composition share the body
that grew. The new half lives in `lib/` rather than in `checkpoint.ts` itself, which is the
split 062's order asked for: the composition is one `composeSummary([...])` shape at three sites
(`checkpoint.ts:687`, `:820`, `:976`) and the machine block one `renderMachineBlock` call, so no
function gained a branch structure.
`extensions/checkpoint.ts` is the third-largest non-test source file (`rg`-counted:
`subagent-async/index.ts` 4620, `watch-session-v2.ts` 1675, then 1150). One open strike on
`extensions/checkpoint.ts` growth — the 2026-10-21 strike was resolved by WO-2026-057
(901 → 818), so this landing starts the count again rather than closing the area. Candidate
extraction if a third lands: the two tool `execute` bodies still repeat their
validation → continuation → in-flight → archive preamble (`checkpoint.ts:784-860`,
`checkpoint_fork`'s at `:930-1000`).

**unification.** Two of the three carriers the 2026-10-31 entry named are closed by this merge:

- the `[CHECKPOINT]` literal — `rg -n '"\[CHECKPOINT\]"' extensions/` → 1,
  `extensions/lib/checkpoint-marker.ts:8`, imported by `checkpoint.ts` and `compaction-model.ts`.
- the notify guard — `compaction-model.ts`'s own `notify()` is gone; it imports
  `extensions/lib/safe-notify.ts:24`, the helper main landed after 061's base (`fd3ee99` has no
  such file), so the merge was the point to fold it.

Still open, unchanged: the captured-handler-table harness duplicated between
`tests/summary-ownership.test.ts` and `tests/e2e-checkpoint.test.ts`. Carrier: the extraction is
not scheduled, so this entry is the carrier — it lands with whichever order next edits both
harnesses.

## 2026-11-03 — chunk: WO-2026-068 baba-search CLI

**growth.** The client extract lands in `pcone/baba-pi`, not here: `extensions/baba` is a
tracked symlink (mode `120000`), so its growth is that repo's register, not this one. For the
record, `baba-pi/src/index.ts` 681 → 146 lines and the new `src/client.ts` 570 — the split is
a move, not an addition, and no line of the client was rewritten beyond the
`findMainRoot`/`resolveMainRoot` split that gives the CLI a "not a repo" answer. New
`baba-pi/bin/baba-search.ts` (119), `test/client.test.ts` (343), `test/cli.test.ts` (442).
pi-config side is 55 lines of skill, two README bullets, a 26-line Outcome in decision 009 and
this entry — no production code.

**unification.** One implementation of the socket protocol with two entry points: the
extension and the CLI both import `src/client.ts`, and the socket path is constructed once
(`rg -n '"\\.baba", "daemon\\.sock"' baba-pi/src baba-pi/bin` → 1, `src/client.ts:277`). No
new mechanism here: the CLI adds argv parsing and two exit codes over a client it does not
own. No strike, and the register above is unchanged.

## 2026-11-02 — chunk: WO-2026-064 checkpoint wait state

**Growth:** `extensions/checkpoint.ts` 935 → 1083 lines mid-landing; the review's
finding was that the `wait_for` tool and the restart announcement are not
checkpoint-specific. Extraction done inside the landing, not deferred:
`registerWaitSurface(pi)` in `extensions/lib/waits.ts` owns the tool and both
handlers, so the file ends at 994 (+59 for the feature, all of it the
`PendingCheckpoint` wiring and the two `describePending` result lines). New
module `extensions/lib/waits.ts` (424 lines) carries the store, the sources
registry, the rule, the rendering and the surface. No strike.

**Unification:** the continuation rule and the kickoff prompt each have one home
(`resolveContinuation` two call sites, `composeKickoff` one); `sendTracked` is
the single outbound path in `peer-link` (1 `sendEnvelope` call site). Files
touched by the landing: `checkpoint.ts`, `waits.ts`, `subagent-state.ts`,
`peer-link/index.ts`, `subagent-async/index.ts` — three of those only to register
a derived source or move a test hook, which is the shape the order asked for.

## 2026-10-31 — chunk: WO-2026-061 summary-ownership dispatch

**growth.** `extensions/compaction-model.ts` 70 → 90 lines: one predicate plus one `notify`
guard; no function grew, no extraction candidate appeared. New
`extensions/lib/checkpoint-marker.ts` (9 lines) holds the `[CHECKPOINT]` literal. New
`tests/summary-ownership.test.ts` (600 lines, 12 rows: real handlers, module-seam
`compact()` mock). No strikes.

**unification.** Three copies of one idea remain, each out of this order's reach because the
other copy lives in a file another order owns or forbids changing:
- notify guard — `extensions/compaction-model.ts:34-40` repeats `extensions/checkpoint.ts`'s
  inline `try/catch` notify sites (`:461`, `:475`, `:489`, `:547`). Carrier: WO-2026-062 if
  it rewrites those sites, otherwise `extensions/lib/notify.ts` under its own order.
- captured-handler-table harness — `tests/summary-ownership.test.ts:105-224` repeats
  `tests/e2e-checkpoint.test.ts:447-505`. Carrier: a `tests/helpers/extension-harness.ts`
  extraction, blocked while `tests/e2e-checkpoint.test.ts` is required unchanged.
- the `[CHECKPOINT]` literal — `extensions/checkpoint.ts:32` and
  `extensions/lib/checkpoint-marker.ts:9`. Carrier: WO-2026-062 (owner of `checkpoint.ts`).
No strikes: no area took work it must be refactored before.

## 2026-10-22 — chunk: seat-config ruling batch (3bf7b2f, ff7a78f, 9833b88, 28f10c2, 2bbcae3)

**Growth:** production delta small — `extensions/lib/fleet-model.ts` (one join exported),
`compaction-model.ts`, `subagent-async/index.ts` (3 fallback arms); remainder is decisions/docs
(21 files, +379/−51). No new extraction candidates; the batch *consumed* one — the provider-less
`FLEET_MODEL` fallback copy is now a single `FLEET_MODEL_SPEC` join with two consumers.

**Unification:** `models.json` touched by two landings (fidelity pin `ff7a78f`, mimo preference
pin pending in 042) — both through the single override mechanism, no parallel path; the
458-request bare-slug drift anomaly (seat audit 2026-10-22) is the closed proof case.
No strikes.

## 2026-10-21 — chunk: boundary-pin derivation (test-side only)

Closes the two follow-ups parked in the spawn-env idiom entry below. Zero
production change.

**Pin.** `tests/subagent-boundary-hermeticity.test.ts` no longer names files;
its header is the decision record.

- Behavioral row: derived set — `*.test.*` files that spawn a child or import a
  module reading `process.env.PI_SUBAGENT_*` / `PI_IS_SUBAGENT`, minus itself
  and minus live-model files (`createAgentSession`); re-run as a child
  `bun test` under a replicated harness injection. 24 files, 24–37 s (was 3
  enumerated files, 6 s).
- Static row: every spawn call site under `tests/` passes an explicit `env`
  (inventory 11 files / 16 sites), plus a blindness guard so a mask that eats
  code cannot pass vacuously.
- Mutation-checked both ways: dropping a file's `scrubSubagentEnv()` reds the
  behavioral row (child report in the message); dropping `env: childEnv()` from
  `tests/e2e-checkpoint.test.ts:544` reds the static row at that line.
- Rejected: whole-suite nested run (doubles the suite, +~150 s, and couples to
  live rows); extending the enumerated `BOUNDARY_FILES` (one edit per new file,
  and e2e-checkpoint is 82 s of live rows); static-only (blind to an in-process
  observer with no spawn site — `work-order-policy-wiring.test.ts` is one);
  spawn-wrapper funnel (restructures the 10 just-landed `childEnv()` sites).
- The static row caught four straggler sites, now passing `env: childEnv()`:
  `work-record-capture.test.ts:81,101`, `subagent-model-inheritance.test.ts:304`,
  `subagent-id-resolution.test.ts:388`. No assertion changed.

**Follow-up closed: `PI_SUBAGENT_WORKTREE` / `PI_SUBAGENT_PARENT_CWD` are a
different class, so `SUBAGENT_ENV_VARS` stays the three gate vars.** One reader
(`extensions/worktree-guard.ts:298-299`, at extension load inside a pi process),
one writer that always overwrites both at spawn
(`extensions/subagent-async/index.ts:1737-1745`, empty when unisolated), no test
reading them from `process.env` (`tests/subagent-id-resolution.test.ts:669`
asserts the builder's return; `extensions/worktree-guard.test.mjs` sets both
itself in every wiring row), and no in-suite child or SDK session that loads the
guard off an ambient value.

Suite: 822 tests / 0 fail / 43 files bare and under injected `PI_SUBAGENT_*`
(baseline in the same worktree 820/0; +2 rows — committed-tree counts; the main
checkout reads +3 from another session's uncommitted `tests/auto-checkpoint.test.ts`
rows). Flaky rows seen in both windows and at base:
`apps/changelog-gen/src/cli.test.ts` (spawns `npx tsx`) — **fixed 2026-10-21 @
52d2301 (gh #10)**: `runCli` spawns bun directly, and a fake-broken-npx
regression pin guards the class; and the live-model e2e rows.

### Growth

| file | now | base | Δ |
|---|---:|---:|---:|
| `tests/subagent-boundary-hermeticity.test.ts` | 410 | 71 | +339 |
| `tests/work-record-capture.test.ts` | — | — | +2/−1 |
| `tests/subagent-model-inheritance.test.ts` | — | — | +2/−2 |
| `tests/subagent-id-resolution.test.ts` | — | — | +2/−1 |

Test-side growth only; no strike (production untouched).

### Unification

- One derivation (`walk` + `callSites`) feeds both rows, so "spawn-capable" is
defined once; no second env helper, no per-file list.
- Watch: the static row is a hand-rolled scanner living in a test file. A third
consumer (e.g. rejected option D's import restriction) extracts it into
`tests/helpers/` — do not copy it.

## 2026-10-21 — chunk: spawn-env idiom adoption (`d068989`, merged `5b8c429`)

1 commit + 1 merge, 3 test files (+39/−4), `review_policy: skip` with the
orchestrator reviewing the diff: the two hermeticity follow-ups parked in the
058+059 entry. `sh()` in `tests/e2e-checkpoint.test.ts` now passes
`env: childEnv()` (the real trip-wire: a no-env `spawnSync` hands children bun's
startup snapshot, so an in-process scrub never reaches them), and
`tests/peer-link-external.test.ts` / `tests/peer-link-smoke.ts` adopt
`childEnv(overrides)`. Dispatch premise correction: neither file had a scrub at
all (the order assumed e2e-checkpoint did) — file-level `scrubSubagentEnv()`
added to both, module-top for the smoke script (scripts have no bun hooks).
Suite verified on the merge: 823 tests / 0 fail / 43 files bare AND under
injected `PI_SUBAGENT_*` (the implementer measured 820/0 in its fresh worktree
— 3 tests/25 expects short of main: the other session's uncommitted
`tests/auto-checkpoint.test.ts` adds 3 rows a fresh worktree does not carry;
before == after either way). No assertion changed.

### Growth

| file | Δ |
|---|---:|
| `tests/e2e-checkpoint.test.ts` | +15/−1 |
| `tests/peer-link-external.test.ts` | +17/−2 |
| `tests/peer-link-smoke.ts` | +7/−1 |

Test-side only; no strike (production untouched).

### Unification

- One spawn-env idiom (`childEnv`/`scrubSubagentEnv`) now covers every spawn
  site the register knows; no second scrub/env helper.
- Follow-ups parked here (not register rows): the boundary pin
  (`tests/subagent-boundary-hermeticity.test.ts` `BOUNDARY_FILES`) still lists
  only the original three files, so the adopted sites have no regression row —
  and extending it with `tests/e2e-checkpoint.test.ts` would couple the pin to
  that file's live-model rows (flaky for a hermeticity pin); decide
  behavioral-vs-static pin in a dedicated tiny order. And
  `extensions/worktree-guard.ts:298-299` reads `PI_SUBAGENT_WORKTREE` /
  `PI_SUBAGENT_PARENT_CWD`, which `SUBAGENT_ENV_VARS` omits — different class
  (harness worktree plumbing, not gate env); check whether tests need those
  covered.
  **Both closed 2026-10-21** (entry above): the pin derives its file set, and
  the guard pair is confirmed a different class — the scrub set stays the three
  gate vars.

## 2026-10-21 — chunk: WO-2026-058 + WO-2026-059 test-infra pair (`a23e6d3..d03af90`)

Two test-side orders landed in one window (suite 823/0 bare and 823/0 under
harness-style injection at `d03af90` — verdict now invariant to invocation
context, pi-config#9). 058: boundary rows control the `PI_SUBAGENT_*` env they
exercise via `tests/helpers/subagent-env.ts`; KNOWN-BUG pin row flipped
positive; mutation-checked (removing the scrubs reds the pin). 059: the parked
git-hang row — `runGit`'s `execFile` timeout pinned by a discriminating row,
mutation-checked both ways (option dropped → row reds on its witness; restored
→ green). Zero production change in both (059: `extensions/lib/checkpoint-meta.ts`
byte-identical). Reviews: 058 both APPROVED_WITH_NOTES (1 round), 059
APPROVED/APPROVED (1 + 2 rounds); LOWs accepted. Excluded as before: another
session's uncommitted `auto-checkpoint.ts` + `settings.json` +
`tests/auto-checkpoint.test.ts` + `decisions/settings/**`.

### Growth

| file | now | base | Δ |
|---|---:|---:|---:|
| `tests/helpers/subagent-env.ts` | 55 | — | +55 (new) |
| `tests/subagent-env.test.ts` | 101 | — | +101 (new) |
| `tests/checkpoint-meta.test.ts` | 161 | — | +161 (new) |
| 7 adopted test files | — | — | net +93/−73 (scrub lines only; no assertion changed) |

Test-side growth only; no strike (production untouched).

### Unification

- Three hand-rolled `PI_SUBAGENT_*` scrub copies (`owner-asks`, `session-log`,
  `subagent-nesting`) folded into the one helper, and the new sites adopt it —
  one scrub mechanism repo-wide, which is what made "no third copy" true.
- One spawn-env idiom (`childEnv`) with the Bun startup-snapshot quirk pinned
  in one place. Both orders' implementers probed the quirk independently and
  agreed: it bites *sync* spawns only; async `execFile` sees live `process.env`.
- No parallel paths introduced (one shim fixture, one witness helper, no second
  harness).
- Reviewer seats (023): verdicts matched the diffs on gate inspection; one
  reviewer remark was wrong on branch ancestry (the implementer corrected it) —
  data point for the seat call.
- Follow-ups parked here (not register rows): `tests/e2e-checkpoint.test.ts:530`
  spawns without explicit env — **done 2026-10-21** (spawn-env idiom adoption
  chunk, below), `tests/peer-link-external.test.ts:41` +
  `tests/peer-link-smoke.ts:28` adopt `childEnv()` — **done 2026-10-21** (same
  chunk), bun 1.3.11 `execFileSync`-under-`bun test` stderr leak (test-log
  noise; upstream quirk — parked: not ours to scrub), and the still-parked
  `tsc --noEmit` step.

## 2026-10-21 — chunk: WO-2026-057 lib extraction (`981d3aa..0886a9f`)

1 commit + 1 merge (bug-triage's `subagent-boundary-hermeticity` pin row merged
alongside), 2 files: the register's named refactor — `runGit`,
`captureGitBinding`, `tokensBefore`, `renderTokenDelta`, `recordTokensAfter`,
`metaPathFor`, `GitBinding`, `CheckpointTokens` moved verbatim from
`extensions/checkpoint.ts` to `extensions/lib/checkpoint-meta.ts`. Zero test
edits; suite 814/0. Reviews: review-code APPROVED, review-tests
APPROVED_WITH_NOTES (2 LOW, accepted).

### Growth

| file | now | base (WO-2026-056) | Δ |
|---|---:|---:|---:|
| `extensions/checkpoint.ts` | 818 | 901 | −83 |
| `extensions/lib/checkpoint-meta.ts` | 108 | — | +108 (new) |

Delta, not strike: the growth candidate this register named has landed and the
row is resolved. One-way imports hold (the lib imports only `node:*` and a
type-only `ExtensionContext`).

### Unification

- Exports minimal: `runGit`/`GIT_TIMEOUT_MS` module-private; nothing that
  `checkpoint.ts` does not consume.
- Follow-up candidates surfaced by review, parked here (not register rows):
  a git-hang behavioural row — **done 2026-10-21 (WO-2026-059)**: the `execFile`
  timeout is now pinned by a discriminating row, mutation-checked both ways —
  and a `tsc --noEmit` step (the repo has no typecheck step — that is how a dead
  type import survived to review).

## 2026-10-21 — chunk: WO-2026-056 summary schema + observability (`4b2861c..f2cbcbc`)

1 commit (harness-squashed), 3 files: fixed summary schema on both checkpoint
tools (5 required fields incl. `triedAndFailed`, one `renderSummary` with three
consumers), token before/after + summary in notify and archive meta, git-ref
binding in meta. Review: review-code APPROVED_WITH_NOTES, review-tests APPROVED
(2 rounds). Excluded as before: another session's uncommitted
`auto-checkpoint.ts` + `settings.json` + `decisions/settings/**`.

### Growth

| file | now | base (`59655ec`) | Δ |
|---|---:|---:|---:|
| `extensions/checkpoint.ts` | 901 | 664 | **+237** |

One feature landed almost entirely in one file. The growth is cohesive (schema+
renderer block, git+tokens block) and single-sourced (one renderer, one meta
writer + one token patch), so this is a growth strike with a named candidate —
see the register. If the next landing grows this file again, the area closes and
the extraction becomes a mandatory order before further feature work here.

### Unification

- One renderer, three consumers (`customInstructions`, meta, fork message) —
  asserted as such; no per-consumer formatting copy.
- Meta shape unified across all three archive sites (checkpoint, fork, and the
  auto-compaction path now writes the same keys).
- New seam worth watching (not yet a candidate): `metaPathFor`'s
  `.jsonl`→`.meta.json` convention is mirrored in the test-local `readMeta`
  helper — unavoidable test mirror, no production duplicate.

## 2026-10-21 — chunk: WO-2026-055 checkpoint injection fix (`689de07..59655ec`)

2 commits (`af2733a` extract, `59655ec` change), 7 files: the shared read-tracking
helper, the `tool_result.input`/`toolCall` sourcing fix, the staleness guard +
snapshot label (per the utility evaluation in
`checkpoint-sanity-check-2026-10.md` §5.7), and honest injection coverage.
Review: review-code + review-tests APPROVED (2 rounds). Excluded as before:
another session's uncommitted `extensions/auto-checkpoint.ts` + its test.

### Growth

| file | now | base | Δ |
|---|---:|---:|---:|
| `extensions/checkpoint.ts` | 664 | 726 | **−62** |
| `extensions/lib/read-tracking.ts` | 217 | — | +217 (new; logic moved out of `checkpoint.ts`) |
| `tests/e2e-checkpoint.test.ts` | 952 | 601 | **+351** (deterministic injection rows M1–M14; vacuous describes deleted) |
| `tests/read-tracking.test.ts` | 299 | — | +299 (new) |

Production code shrank while gaining the staleness guard; all growth is test
coverage for a feature that previously could not fail. No growth strike.

### Unification

- **Resolved — read-region tracking had two diverging copies** (`checkpoint.ts`
  on `tool_execution_end.args`, `auto-checkpoint.ts` on `tool_result.input`).
  `extensions/lib/read-tracking.ts` is now the one ingestion/merge/normalize
  path; `checkpoint.ts` consumes it. **One copy remains** in
  `auto-checkpoint.ts` (grandfathered — another session's WIP): strike recorded
  above; closes when its migration order lands.
- Checked and not duplicated by this delta: the staleness guard lives only in
  `selectFreshRegions`; the snapshot label is one constant in `checkpoint.ts`.

## 2026-10-18 — chunk: seat-burn tracker (WO-2026-053, merge `4e7a00b`)

1 landing: `docs/data/seat_burn.py` (new, 1,397 lines) + 15 committed fixtures
(`docs/data/testdata/seat_burn/`), plus decision `model-tiers/005` (shared-allowance
mechanism) and its doc updates. Review: review-code APPROVED_WITH_NOTES, review-tests
APPROVED (2 rounds).

### Growth

| file | now | base | Δ |
|---|---:|---:|---:|
| `docs/data/seat_burn.py` | 1,397 | — | **+1,397** (new) |
| `docs/data/testdata/seat_burn/**` | 15 files | — | +~275 |

New file lands already large — the flag for the next audit is its *delta*, not the size.
Ranked extraction candidate if it grows: the price/limit table (the only table in the
repo that must stay in sync with OpenCode's catalog by hand).

### Unification

- **Price data now exists twice**: `docs/data/seat_burn.py`'s per-class price/limit table
  vs `docs/data/role_scores.py`'s blended $/M cost axis. Both cite decision records for
  provenance. If either updates, they drift apart silently — candidate to share one table.
- **Quota display vs quota projection**: `extensions/footer-session-id.ts` renders the
  server's plan-wide % (decisions/external-tools/006), `seat_burn.py` projects the same
  meter from logs. Complementary by design (006's boundary note anticipated this tool);
  no merge candidate, but the meter formula now lives in two places (`model-tiers/005`
  and the tool) — the decision is the source of truth.

## 2026-10-18 — chunk: OpenCode Go usage footer (`d4cd160..` this landing)

1 landing: OpenCode Go plan usage in the footer's provider-quota slot
(`extensions/footer-session-id.ts` Go section + `tests/footer-opencode-usage.test.ts`),
per `decisions/external-tools/006`.

### Growth

| file | now | base (`d4cd160`) | Δ |
|---|---|---|---|
| `extensions/footer-session-id.ts` | 1633 | 1456 | **+177** (file already on the large-file watchlist — see 2026-10-03 entry) |
| `tests/footer-opencode-usage.test.ts` | 240 | — | +240 (new) |

### Unification

- z.ai/MiniMax percent-color thresholds were two inline IIFEs; now one
  `colorUsedPct` helper at three call sites (the new Go renderer included).
- Go usage renders through the existing quota segment slot + refresh cycle
  (`refreshQuotaNow`) rather than a parallel footer mechanism; a standalone
  extension could not compose into the footer anyway (single `setFooter` owner).

**Extraction candidate carried forward:** the quota/z.ai/MiniMax/Go block
(~400 lines of fetch + normalize + render) is the natural split of
`footer-session-id.ts` into `extensions/lib/quota.ts` if the file keeps growing;
deferred until a second consumer or another provider lands.

## 2026-10-13 — chunk: todo extension retired (`126d9bf..` this landing)

1 landing: the `todo` tool, widget and `/todos` command removed
(`extensions/todo.ts` 530 lines, `tests/todo-injection.test.ts` 310,
`tests/todo-render.test.ts` 108, `docs/todo-injection-fix.md` 96), and the
instruction text that pointed agents at it now points at the session log's
state query (`decisions/todo/001`).

### Growth

| file | now | base (`126d9bf`) | Δ |
|---|---|---|---|
| `extensions/todo.ts` | — | 530 | **−530** (removed) |
| `tests/todo-injection.test.ts` | — | 310 | −310 (removed) |
| `tests/todo-render.test.ts` | — | 108 | −108 (removed) |
| `docs/todo-injection-fix.md` | — | 96 | −96 (removed) |
| `extensions/modes.ts` | 256 | 254 | +2 |
| `agents/bug-triage.md` | 121 | 120 | +1 |
| `docs/design/session-log-hooks.md` | 58 | 56 | +2 |

Net −1039 lines; no file grew beyond the instruction edits. `createPiStub`
copies 7 → 6 (`tests/todo-injection.test.ts:47` gone); bare `typebox`
importers 5 → 4 among top-level `extensions/*.ts` (7 → 6 across all extension
dirs, so `tests/setup.sh`'s typebox link stays). The top-1 file `extensions/subagent-async/index.ts` (4258
lines, 1082-line factory) is untouched this chunk.

### Unification

- **Landed — one work-list mechanism.** The in-session todo state (tool +
  widget + `/todos`) was a parallel record of what the session log already
  tracks; it is gone, and `summary --session <id> --current` is the single
  state query. The deletion is negative growth by construction.
- **Carried forward unchanged:** `createPiStub` extraction (now 6 copies),
  the `test-workorder-policy.cjs` mirror fold, the `review_policy` single
  resolver, the `model-tiers` `†` helper.

## 2026-10-08 — chunk: work-order grammar landing (`16eb6fe..` this landing)

2 commits, 1 work item: the audit artifact itself (`71bd902`) plus the
decision-032 work-order grammar (bare-bold `review_policy` accepted, one
resolver for all three gate sites, mirror synced, `implement` allowlist widened).
Measurements from git refs / `wc` / brace-matched spans. Excluded, as in the
entry below: another session's uncommitted `extensions/auto-checkpoint.ts` +
`tests/auto-checkpoint.test.ts`, `settings.json` (owner's model switch), and the
untracked `agents/scout-sweep.md` — the table covers only this chunk's files.

### Growth

| file | now | base (`71bd902`) | Δ |
|---|---|---|---|
| `extensions/subagent-async/index.ts` | 4258 | 4251 | **+7** |
| `extensions/subagent-async/test-workorder-policy.cjs` | 411 | 302 | **+109** |
| `tests/work-order-policy.test.ts` | 132 | 69 | +63 |
| `tests/work-order-policy-wiring.test.ts` | 268 | — | new |
| `tests/discover-agents-cache.test.ts` | 336 | 322 | +14 |

Functions: the top-1 file's factory is still **1082 lines** (3177–4258, shifted
+7) and `spawnSubagent` still **664** (1731–2394) — the +7 net landed in the
module-scope parser block, so the delta grew neither large function. The mirror's
+109 is the second implementation's tax, acknowledged in decision 032 with a
reopening trigger. One work item touched `index.ts` this chunk — no churn smell.

### Unification

- **Landed — previous candidate 3.** `review_policy` is now one dash-optional
  `POLICY_BOLD_RE` + one `POLICY_YAML_RE` + one `parseWorkOrderPolicy` + one
  `taskDeclaresPolicySkip`; the gate fallback and the injection detector call the
  detector instead of carrying byte-identical private regexes.
- **Half-landed — previous candidate 2.** The mirror learned the YAML
  alternative it had drifted away from (the stale claim in the entry below) and
  gained precedence/first-token rows; the fold onto shared logic stays open, and
  the mirror is still not wired into any runner — its filename matches none of
  bun's test patterns (`.test.*` / `_test_*` / `.spec.*`) and no runner
  references it.
- **Worsened — previous candidate 1.** `createPiStub` is now in **7** test files
  (the new wiring file adds a minimal copy). Extract before the next test-heavy
  chunk.
- **New seam worth watching (not yet a candidate).**
  `tests/work-order-policy-wiring.test.ts` spawns a stand-in `pi` script (holds
  the RPC pipe open, no model call) so the real `subagent.execute` gate and
  injection paths are assertable cheaply. First occurrence — generalize from it
  rather than copying it if a second file needs it.

### Extraction candidates (carried forward, ranked)

| # | candidate | status |
|---|---|---|
| 1 | shared test `createPiStub` helper, called from all test files | open — now 7 copies |
| 2 | fold `test-workorder-policy.cjs` onto shared logic | open — YAML drift closed by decision 032 |
| 3 | one `review_policy` resolver for the three sites | **landed** (decision 032) |
| 4 | model-tiers `†` mark + legend helper | open (details in the entry below) |

## 2026-10-08 — chunk: WO-2026-052 → decision 031 (`4cdce3b..16eb6fe`)

25 commits, 12 source files, **+2153/−314** lines (vendored code excluded;
`extensions/auto-checkpoint.ts` + its test excluded — another session's
uncommitted work). Measurements from git refs, spot-checked against `wc`/Node.
This is the baseline entry: there is no prior snapshot, so deltas are against
`4cdce3b` (the WO-2026-052 landing), not against a previous entry.

### Growth

Top 10 `.ts` files, current vs `4cdce3b` (`git show 4cdce3b:<path> | wc -l`):

| # | file | now | base | Δ |
|---|---|---|---|---|
| 1 | `extensions/subagent-async/index.ts` | 4251 | 4039 | **+212** |
| 2 | `extensions/subagent-async/watch-session-v2.ts` | 1675 | 1675 | 0 |
| 3 | `extensions/footer-session-id.ts` | 1456 | 1456 | 0 |
| 4 | `tests/subagent-id-resolution.test.ts` | 769 | 492 | **+277** |
| 5 | `extensions/checkpoint.ts` | 726 | 726 | 0 |
| 6 | `tests/activity-timeline.test.ts` | 716 | 716 | 0 |
| 7 | `extensions/model-tiers/index.ts` | 707 | 704 | +3 |
| 8 | `tests/peer-link.test.ts` | 621 | 621 | 0 |
| 9 | `tests/e2e-checkpoint.test.ts` | 601 | 601 | 0 |
| 10 | `extensions/rules.ts` | 600 | 520 | +80 |

Growth concentrated in the repo's top-1 file (+212) and its largest test file
(+277). Also grew >100 below the top 10: `tests/model-tiers-render.test.ts`
156→427, plus new files `tests/subagent-model-inheritance.test.ts` (431),
`tests/rules-refresh.test.ts` (311), `tests/subagent-resume-cwd.test.ts` (208).
The three already-top-5 files that did not move (`watch-session-v2.ts`,
`footer-session-id.ts`, `checkpoint.ts`) carry large functions — 422 and 306
lines in the two unchanged extensions — but no delta risk.

Functions over ~150 lines in the files the delta touched (brace-matched):

| function | span | lines | changed by delta? |
|---|---|---|---|
| `subagent-async/index.ts` `export default function (pi)` | 3170–4251 | **1082** | yes — 13 hunks land inside it |
| `subagent-async/index.ts` `spawnSubagent` | 1724–2387 | **664** | yes — 3 hunks (model resolution, args, prompt) |
| `subagent-async/index.ts` `processLine` (nested in `spawnSubagent`) | 1973–2262 | 290 | no |

The largest function in the repo is a single 1082-line extension factory; the
delta added to it rather than through it.

**Duplication introduced or still present inside the delta:**
- `review_policy` is matched by three separate regexes — `parseWorkOrderPolicy`
  (`index.ts:1656-1661`), the task-text gate fallback (`index.ts:1823`), and the
  skip-injection detector (`index.ts:3422`, byte-identical to 1823). See
  Unification below.
- `createPiStub` exists in 6 test files, 3 of them added by this delta:
  `tests/subagent-id-resolution.test.ts:409`, `tests/subagent-resume-cwd.test.ts:154`,
  `tests/subagent-model-inheritance.test.ts:188`, plus pre-existing copies in
  `tests/subagent-async-kill.test.ts:203`, `tests/todo-injection.test.ts:47`,
  `tests/subagent-session-lifetime.test.ts:90`.
- `extensions/model-tiers/index.ts`: the missing-axis `mark` ternary at `:468`
  and `:512`, with the same `†` legend dimmed at `:480` and `:522`.

**De-duplication the delta itself performed** (the counter-trend): one
`findRunningByQuery` replaces two identical running-map loops; one
`resolveChildModel` replaces two `effectiveModel` computations; one
`describeUnknownSession` replaces four copies of the not-found string; one
`scoreRows` replaces `scoreModels`/`scoreAllModels`; one `applyFreeCutoff`
replaces two inline cutoffs. Removed dead code: `UPCOMING_OPEN_WEIGHTS`,
`contextTier`, `paretoFilter3D`. No dead code found in the delta.

**Churn** (commits per file in the delta, max 4 in the whole range):

| file | commits | work items |
|---|---|---|
| `tests/model-tiers-render.test.ts` | 4 | one (model-tiers rework) |
| `extensions/subagent-async/index.ts` | 3 | **three distinct** — `f864339` id resolution, `65bef12` resume cwd, `ed1c0a4` decision 031 |
| `extensions/model-tiers/index.ts` | 3 | one (model-tiers rework) |
| `tests/subagent-nesting.test.ts` | 2 | two (same 028 topic) |
| `extensions/rules.ts` | 2 | two — line cap, re-read at injection |

Only `subagent-async/index.ts` served unrelated work items (3) — and it is also
the top-1 largest file and the largest function's home. That is the boundary
smell this audit exists to catch.

### Unification

**`review_policy` has three parse sites and two accepted grammars.** The sites
answer different questions, but the task-text pair is a literal duplicate:

- `index.ts:1656` `parseWorkOrderPolicy` — accepts the canonical bullet
  `/^\s*-\s*\*\*review_policy\*\*:\s*(\S+)/m` **or** the YAML line
  `/^review_policy:\s*(\S+)/m`; first token `=== "skip"`.
- `index.ts:1823` gate fallback — `/^\s*-\s*\*\*review_policy\*\*:\s*skip\b/m`
  on the task text, only when no WO is present.
- `index.ts:3422` injection detector — the same regex, deciding whether the task
  already carries the skip bullet.

Measured behavior (Node, one encoding per row):

| input | parse (`:1658`) | gate (`:1823`) | inject-detect (`:3422`) |
|---|---|---|---|
| `- **review_policy**: skip` | skip | true | true |
| `**review_policy**: skip` (no dash) | required | false | false |
| `review_policy: skip` (YAML) | **skip** | false | false |
| `- **review_policy**: required` | required | false | false |
| `- **review_policy**: required \| skip` | required | false | false |

The bare-bold row is a silent mis-read (a peer hit it in another repo: the WO
declared `skip`, the gate stayed live, and the tool param cannot override a
present WO by design — decision 014). The YAML row shows the gate and injection
sites do not accept the encoding the parser does; only the parser's first form
is mirrored by the task-text sites.

**Second implementation of the same logic:** `extensions/subagent-async/test-workorder-policy.cjs`
(302 lines) mirrors the parser (`:41`), the skip-bullet regex (`:49`), the gate
computation (`:56`) and the injector (`:70`) with `KEEP IN SYNC` contracts,
because plain `node` cannot import `index.ts` (typebox/`@earendil-works/*`
resolve only under jiti). It is a manual fixture (`node <file>`), referenced
only by WO-2026-033/035/037 as a required test boundary — no runner wires it in.
It is **already stale**: its parser has no YAML alternative, so it reads
`review_policy: skip` as `required` where production reads `skip`.

**Checked and not found duplicated** (recorded so the next audit does not redo
the search): model-spec splitting (`splitModelSpec` is the only
`lastIndexOf(":")` in `extensions/` + `apps/`); argv building
(`buildSubagentArgs`) and meta building (`buildSpawnMeta`); model resolution
(`resolveChildModel` is now the single source for both spawn args and
`meta.json`); resume validation (`validateResumeMeta`, module scope);
session-header reading (`readSessionCwd` is the only header-cwd parser —
`footer-session-id.ts` takes header/entries as arguments and `checkpoint.ts`
never parses a pi session header).

### Extraction candidates (ranked by lines-removed × risk)

| # | candidate | lines removed | risk | owner |
|---|---|---|---|---|
| 1 | Extract the shared test `createPiStub` into one `tests/` helper, called from all 6 files | ~25 (3 delta copies), ~44 if the 3 pre-existing copies collapse too | low — test-only, no production blast radius | test-infra cleanup |
| 2 | Fold `test-workorder-policy.cjs`'s mirrored parser/gate/injector onto shared logic (or at minimum sync its YAML gap) | ~35 mirrored lines | medium — node-only harness by design, cross-file coupling, no automated runner | review-policy harness |
| 3 | One `review_policy` resolver for the three sites (shared bullet regex + a `hasSkipBullet` used by `:1823`/`:3422`), which is also the single place the bare-bold gap closes | 1–3 regex lines; closes a silent mis-read | low — `tests/work-order-policy.test.ts` covers the parser | subagent review-policy |
| 4 | One helper for the `model-tiers` `†` mark + legend at `:468/:480/:512/:522` | ~2–3 | low — pure render, covered by `tests/model-tiers-render.test.ts` | model-tiers render |

Candidate 3 is coupled to the pending owner ruling on the work-order grammar
(bare-bold acceptance); candidate 2 rides with it.

### Limits

Negative claims are scoped to the files searched: `apps/changelog-gen`,
`extensions/peer-link` and `watch-session-v2.ts` were not read for duplication
beyond the searches above. Candidate 1's spans and candidate 3's regex lines
were counted; candidates 2 and 4 are structural estimates from matched spans.
The working tree was not read (another session's WIP excluded by instruction).

## Snapshot 2026-10-22 — WO-2026-060 lands WO-2026-054 (merge `fa84a99`)

**growth.** `extensions/subagent-async/index.ts` takes the mechanism back (+~1.4k: registry
section, worktree lock/unlock, owner_asks + nextSteps gates), but the branch did the 040
extraction unprompted: `extensions/lib/subagent-state.ts` (~395 lines) is the sole state
reader (`readSubagentState`: definition + one consumer) and `extensions/lib/owner-row.ts`
holds both validators. New suites: worktree-lock (447 lines), state-vocabulary (328),
owner-asks-gate, recovery-ownership. Review found no new extraction candidates; the ranked
table above is unchanged and none of its four entries shrank.

**unification.** The merge removed one parallel mechanism rather than adding one:
`composeSummary`'s predecessor is gone — `renderSummary` is the single summary composer
(2 call sites, both `composeSummary(renderSummary…)`). `extensions/checkpoint.ts` has now
been touched by two landings (057 extraction, 060 merge re-point), both summary-shape work
and related (060 re-bases on 057's contract) — no flag, stays on the watch list. The one
cross-cutting pattern in the landing: hidden post-branch conventions (the spawn-env/
hermeticity gate) reddened 14 branch rows until the suites adopted main's idiom — the cost
was discovery, not design.

## Snapshot 2026-11-03 — WO-2026-065 (model error mail, Kimi quota slot)

**growth.** `extensions/footer-session-id.ts` 1652 → 1104 lines (−624/+76): the three
per-provider quota blocks are gone. `extensions/lib/quota.ts` is new at 696 lines,
holding what moved (three fetchers, three parsers, three render segments, one warn-once
and one key memo) plus the descriptor table and the Kimi parser. Production net: +1072/−624
across five files, of which the mail half is +220 and the quota mechanism +696 — a fourth
provider now costs ~70 lines in the table instead of a fourth copy. The refactor left
two residues un-extracted, both carried in `docs/TODO.md` § WO-2026-065: `QuotaSnapshot.overflow` per provider (unifying it moves
rendered bytes this order had to hold) and the "online peers other than self" predicate
written twice in peer-link (extracting it edits the send path this order fences off). The
pre-refactor entry points (`renderQuotaSegment`, `renderGoUsageSegment`) stay: 8-line
adapters onto the one renderer, kept because existing suites import them.

**unification.** One mechanism replaces three: `extensions/lib/quota.ts` is now the only
fetcher, the only warn-once, the only segment renderer and the only place a snapshot's
provider is attached (`snapshotFor`) — which is what let the two MiniMax hosts share one
parser without a second renderer. The footer's cache went from two slots to one and its
key memo from three to one. `snapshotFor` closes the class of bug the old code invited
(a parser handing back another provider's numbers) by construction rather than by test.

No strikes. Two files were touched by both halves (`README.md`, `footer-session-id.ts`
exports) — documentation and re-exports, not mechanism. The mail half reuses peer-link's
existing envelope path and adds no mechanism to it: `sendEnvelope` + `newEnvelope`, with
the delivery record in `mailbox.ts`'s new `_state/` layer.

**watch.** `extensions/peer-link/index.ts` is now the second landing in a row to touch
peer-link's consume path (007 channel, this order); both added around the same delivery
point (`sendUserMessage` + ack). Not a duplicate mechanism, but the seam to watch if a
third lands there.

## Snapshot 2026-11-03 — WO-2026-066 (liveness-gated mail, one predicate, loud init)

**growth.** Production +35/−14 across three files (`git diff --numstat e133b31..HEAD --
extensions/`): `extensions/peer-link/mailbox.ts` 410 → 422 (the new `onlineExcept` plus its
doc), `extensions/peer-link/index.ts` 597 → 601 (the init catch now builds and rethrows an
error; the broadcast arm is three lines shorter), `extensions/peer-link/model-error-mail.ts`
232 → 237 (`recipients()` gains the liveness test; the redundant self term is gone). No new
extraction candidate: `recipients()` remains two arms over one predicate, and the init catch
is five lines. Tests +463/−66 across two files (`tests/peer-link.test.ts` 631 → 837,
`tests/model-error-mail.test.ts` 578 → 769): the wired rows drive `SessionManager.inMemory`
and the peer-link rows the fake-pi stub, and the review rework collapsed the two
near-identical wired-extension stubs into one `wiredExtension` helper rather than landing a
second.

**unification.** One predicate replaces two copies. `onlineExcept` in `mailbox.ts` is now
the only "online peers other than self" in the extension: `peer_send`'s broadcast arm and
the mail's recipient fallback both call it, and the self exclusion that the self-record row
pins lives only there. The extraction had to write its own characterization rows first —
the three `peer_send` broadcast rows the order named did not exist (`rg -n 'broadcast'
tests/peer-link.test.ts` → 0 matches at `e133b31`), so `b675a0d` pinned them and they pass
unchanged through `33d7cd4`. Two files changed together for the shared call
(`index.ts`, `model-error-mail.ts`): the shared-module shape, not a parallel mechanism.

**watch (carried).** `extensions/peer-link/index.ts` is the third landing to touch the
extension's delivery/lifecycle seam (`007` channel, `065` mail handler, `066` broadcast arm
and `session_start` catch). This landing's edits there are two small ones in different
functions and they removed duplication rather than adding it, so no strike and the register
is unchanged: the overflow row in `extensions/lib/quota.ts` remains the only open one, and
this order's own residue (the duplicate predicate) closes. The seam stays on the watch list
for a fourth landing that adds mechanism there.

## Snapshot 2026-11-03 — WO-2026-067 (external correspondent, one reachability predicate)

**growth.** Production +22/−9 in one file (`git diff --numstat 0130a0c..HEAD -- extensions/`):
`extensions/peer-link/model-error-mail.ts` 237 → 250 (`recipients()` gains a `peers` binding, the
one reachability boolean and its four-line comment; the doc block above it restates the two ways a
peer is reachable). `mailbox.ts` and `index.ts` are byte-identical to the base — the predicate the
arm needed (`onlineExcept`) already lived in the shared module, so nothing moved. Tests +132/−0 in
one file (`tests/model-error-mail.test.ts` 774 → 906): six wired rows plus a `registerExternal`
helper and an `inboxesHoldingMail` sweep. No extraction candidate: `recipients()` is still one
function, two arms, and the arm is one boolean.

**unification.** No new mechanism. The mail's correspondent arm evaluates `online || external` over
`deps.peers()`, the list it already read, so the external case adds a term rather than a source:
`rg -n 'external === true' extensions/peer-link/*.ts` → 1 (this arm). The other external-aware
sites read the flag for display or the send gate (`peerStatus`, `deliveryDecision`,
`listPeers`'s `online` derivation), none of them a recipient rule, so there is no second "who can
receive" predicate to unify — and the register's open item stays the one it was.

**watch.** `extensions/peer-link/index.ts` untouched this landing: the fourth-touch question the
last snapshot raised is not answered either way. `recipients()` is now the file's only conditional
over peer identity, which is where a third reachability kind lands.

### WO-2026-091 — subagent build output dies with its worktree (2026-11-08)

**growth.** `git diff --numstat c1e44f0..HEAD -- extensions/`: `extensions/lib/build-output-reaper.ts`
new **743**, `extensions/subagent-async/index.ts` 5033 → 5215 (+182 net over 4 commits), the reap's
own body **136 → 113** lines after the extraction. The file grew by the call sites and the wiring, not
by the mechanism: everything that touches a `target/` or a shared dir lives in the new lib, called
once from the reap (`createReapBuildOutput`) and once from `removeWorktreeTree`.

**unification.** The landing's point was removing a parallel mechanism, not adding one: the two
removal sites' unlock → remove → branch-delete sequences became one `removeWorktreeTree`
(`rg -n '"worktree", "remove' extensions/` → 3 lines, **2** sites; the third is `createWorktree`'s
stale-leftover cleanup, parked as `Q-091-a`). `removeWorktreeTarget` has 2 callers, both in the lib.

**closed (owner 2026-11-08).** `extensions/subagent-async/index.ts` is **5215** lines and has now been touched by three
consecutive landings (091, the turn cap in 090, the model-inheritance fix). Two strikes is the
register's closure rule, and this is the third touch. **Carrier: WO-2026-095** (split by
responsibility, nine extractions, ahead of WO-2026-094). No feature work lands in the file until it
does. The reap extraction (136 → 113, mechanism
moved out) is the pattern that works; the remaining inline growth is the spawn path.

### WO-2026-093 + WO-2026-095 — seat-sync, and the subagent-async split (2026-11-08)

**growth.** Two landings, one purpose each. `extensions/seat-sync.ts` is new at **76** lines over
`extensions/lib/{seat-sync,git-fetch,git-run}.ts` (the last two extracted from `owner-asks` and the
extension, so the fetch and the git runner each have one home). `extensions/subagent-async/index.ts`
**5215 → 2143** (−3072): eight new modules, largest `spawn.ts` 817, then `recovery.ts` 697,
`worktree.ts` 599, `sleep-guard.ts` 439, `rpc.ts` 346, `ui.ts` 213, `turn-cap.ts` 211, `records.ts` 143.

**unification.** The split removed no behaviour and added no mechanism: 153 top-level declarations,
one home each, 0 duplicated; `spawn.ts` and `recovery.ts` moved byte-identically. Two placements had
to cross a section boundary — `bumpActivity` into `rpc.ts` (the other placement is a genuine
`rpc` ↔ `sleep-guard` cycle) and `detach()` staying in `index.ts` (an ES module cannot assign an
imported `let`). Both are recorded in the modules that own them.

**flag, and the register's own correction.** `index.ts` at 2143 still exceeds the order's 1,600-line
success row; the remainder is one `execute` body per tool, recorded as `Q-095-a`. The area's *next*
unification candidate is `running`: a `const Map` mutated from seven sites across three files, now
that the files are split. Not a defect of this landing — the mutation surface was always shared — but
it is the next thing the split made visible.

**cost.** Module load 529 → 526 ms (±4 ms over 12 samples). Seat-sync adds 2–7 ms blocking per
session start and 4–5 git invocations per seat session, zero for a `wt/` session.
