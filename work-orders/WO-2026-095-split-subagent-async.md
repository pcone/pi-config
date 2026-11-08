# WO-2026-095 — split `subagent-async/index.ts` by responsibility

### Metadata

- **work_order_id**: WO-2026-095
- **parent_plan_id**: the refactor-needed register — `docs/investigations/structure-trend.md`, WO-2026-091 entry: the file is 5,215 lines and has taken three consecutive landings. The area is **closed** to feature work until this lands (owner 2026-11-08: *"the split of that file runs first"*).
- **sequence_position**: ahead of WO-2026-094.
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit — the split boundary list in §Mechanism is the enumeration; the implementer names any section the list misses.
- **priority**: high (blocking 094 and any further subagent work)
- **estimated_complexity**: complex (nine extractions, one file)
- **review_policy**: required
- **turn_budget**: planned **140** turns, cap **190**. Report `planned / cap / actual`. Targeted rows only — never the full `bun test` (box-wide `flock` slot; the orchestrator gates it). Tell any reviewer you spawn the same.
- **base**: `origin/main` at dispatch

### Task Summary

**One-sentence description**: `extensions/subagent-async/index.ts` becomes a thin entry point over nine responsibility modules, behaviour-identical, with each extraction landing separately behind the existing rows.

**Goal**: the next feature in this area adds a file, not a hundred lines to a 5,215-line one.

### Premise

Measured at `1f1f8fe`: 5,215 lines, 99 top-level functions, one file. Section comments already mark the responsibilities — the split is a move along boundaries the file states itself, not a re-design. Three consecutive landings touched it (090's turn cap, 091's build-output reaper, the model-inheritance fix), which is what closed the area.

### Preparatory refactor

This order **is** the refactor; there is no change commit after it. Each extraction is its own commit, and the whole order is behaviour-preserving: no rename beyond what a move needs, no signature change, no logic edit. A behaviour change found on the way is a bug-triage handoff, not part of this order.

**Characterization first.** For each section being moved, name the existing rows that pin it; where a section has no row at its boundary, write a characterization row that pins current behaviour *through the public entry* (the tool registration, or the exported function) before moving anything. The named rows must pass unchanged at every extraction commit — that is the proof the move preserved behaviour.

### Mechanism

Move these sections, in this order (line spans at `1f1f8fe`; verify at your base):

| # | new file | sections | span | why together |
|---|---|---|---|---|
| 1 | `subagent-async/worktree.ts` | Worktree isolation + Worktree removal | 908–1483 | one lifecycle; 091 already funnels removal |
| 2 | `subagent-async/records.ts` | Work-order records | 1483–1637 | `script/wo_record.py`'s only caller (094 will edit this file) |
| 3 | `subagent-async/turn-cap.ts` | Turn cap and stall tripwire | 1637–1854 | decision 046's whole mechanism |
| 4 | `subagent-async/rpc.ts` | RPC communication + Attach helpers | 1854–2178 | the child's wire protocol |
| 5 | `subagent-async/recovery.ts` | Recovery ownership + Orphan recovery scan | 351–620, 3703–4066 | one question asked at two points in the lifecycle |
| 6 | `subagent-async/sleep-guard.ts` | Sleep guard + silence stage-2 auto-kill | 3256–3669 | one timer's arithmetic |
| 7 | `subagent-async/ui.ts` | Live Log Viewer + Attach Editor + Attach widget + Detach + Footer | 2990–3165, 3669–3703 | TUI surface, no lifecycle |
| 8 | `subagent-async/spawn.ts` | Spawn & manage | 2240–2990 | the loop itself; leave it last, it is the largest |
| 9 | `index.ts` keeps | constants, meta helpers, progress tracking, live-session ctx, attach state, git helper, model resolution, tool-action formatting, extension entry point | — | wiring and the tool surface |

**Import discipline.** A moved function that other sections call is imported by them, not copied. The entry point re-exports nothing that was not already exported — importers outside the extension (`orchestrator` tool, tests) import from the module that now owns the code, updated in the same commit as the move.

**Duplication check.** Before the first move, `rg` each section for functions that a second section also calls or re-implements; record the count in the completion report. A section found duplicating another is unified in its own extraction commit, with the characterisation row that pins it — not folded silently into a move.

### Prohibitions

- No logic change, no rename beyond a move, no signature change.
- No behaviour "fixed" on the way; a bug found is handed to `bug-triage` with the repro.
- No copying: a moved function has one home, everything else imports it.
- No new file that mixes two rows of the table above.
- Do not split `spawn.ts` further unless it still exceeds ~900 lines after extraction — then the split is a follow-up order, not this one.

### Verification Criteria

- **R1** at each extraction commit, every named characterisation row passes unchanged (`git diff <prev>..<commit> -- tests/` shows only additions).
- **R2** the extension still loads and registers the same tools/commands: a smoke row that loads the module and asserts the tool name set is unchanged against the pre-split list.
- **R3** `index.ts` at the tip is under **1,600** lines; every new file is under **900** (the two numbers are the split's success condition, measured and reported).
- **R4** the duplication census: each function name that appeared in more than one section before the split is either one definition at the tip, or its two uses are recorded with a reason.
- **R5** no import cycle between the new modules (`rg` + a load-order check, or a cycle detector if one is already used).
- **R6** external importers still resolve: every `import … from "…/subagent-async/index.ts"` outside the extension compiles against the tip.

Each row with its mutation where one applies; the extraction rows are proved by "existing rows pass unchanged at that commit", which is stronger than a mutation.

### Cost — measure, do not assert

Module load time before and after (the extension is loaded at every session start), and the line count attributable to re-export shims. Report both; a split that costs load time for no structural gain is the wrong trade.

### Stop reports

- `PLAN MISMATCH` if a section cannot move without a logic change — name it and land nothing further in that extraction.
- `REFACTOR FIRST` if you find a third responsibility the table has no row for, large enough to deserve its own file.
- If an extraction needs more than 12 prerequisite steps, stop and hand the remaining plan back (the split is too big for one order).

---

## Gate-back record — 2026-11-08

Landed: `c406d6f` (characterisation rows) and eight extraction commits,
`b38ec37` → `f1af6dc`, plus the residual/docs commit. `index.ts` 5215 → 2143.
Snapshot: `docs/investigations/structure-trend.md`, 2026-11-08 entry.

### Owner question Q-095-a (raised 2026-11-08) — RULING PENDING

**Ask:** R3's 1,600-line bound on `index.ts` cannot be met by the order's own
boundary list. Which rule wins — keep row 9's list, or split the tool surface so
the bound holds?

**The arithmetic at `f1af6dc`.** `index.ts` is **2143** lines, of which the
extension entry point (row 9: "the tool surface") is **1151** — nine
`registerTool` bodies with their `Type.Object` schemas, four commands, the wait
source, `maybeInjectReviewPolicySkip`, `buildAgentConfigFromMeta`. Row 9's other
keeps add ~900: constants 79, reviewer-spawn tracker 133, meta-file helpers 56,
progress tracking (types, `running`, `newProgress`, `extractFilesFromArgs`,
`formatProgress`) 200, live-session ctx 63, attach state + `detach()` 60,
`git`/`getPiInvocation` 42, model resolution 62, tool-action formatting (incl.
`bumpStaleWatchdog`) 112, header and imports ~140, shims 69. Removing every
section the table assigns a new file leaves that floor; the eight modules took
the other 3072.

**Why a ruling and not a review.** Every row of §Mechanism was followed, so the
split is the specified one; the shortfall is between two statements in the same
order — R3's number and row 9's list. Splitting the tool surface is a new row
the table does not have, and §Prohibitions forbids a file mixing two rows and
says nothing about a tenth. Landing it unasked would be a departure; failing R3
silently would be a false claim.

**Option A (recorder's recommendation, not a ruling) — accept 2143; no further
split.** The bound was a proxy for "the next feature adds a file, not a hundred
lines". The file fell 59% and the 1151 that remain are the tool surface: one
`execute` body per tool, each already delegating to a module. Costs nothing;
leaves `Task Summary`'s stated goal met and R3's number unmet, recorded as such.
**Option B — split the tool registrations into `tools.ts`** (~900 of the 1151:
the seven non-`subagent` tools, their param schemas and the command handlers),
leaving `index.ts` ≈ 1240 with the factory and `subagent`'s dispatch. Buys the
bound; costs one more module and a tenth row the table does not have, and the
tool bodies would then import `running`/`describeUnknownSession` from the hub
they already share.

### Owner question Q-095-b (raised 2026-11-08) — RULING PENDING

**Ask:** row 7 puts `detach()` in `ui.ts`; row 9 keeps attach state in
`index.ts`. Does `detach()` stay where it is, or does the attach state move?

**The site.** `detach()` assigns `attachedSessionId` and `_attachCtx` before
calling `updateFooter()`. Those two `let`s are the row-9 attach state, still in
`index.ts` (the `/attach` handler writes them too). An ES module cannot assign
to an imported binding — `attachedSessionId = null` in `ui.ts` is a
`TypeError` — so the section cannot move as written. Splitting it (a `setAttached()`
exported from `index.ts`, or moving both `let`s to `ui.ts` with the `/attach`
handler using accessors) is a mechanism change, so it was not done.

**What landed.** `ui.ts` took the rest of row 7 — `LogViewer` (+
`formatTokens`), `AttachEditor`, `AttachLogViewer`, `updateFooter`,
`notifyChildDetached` — and `detach()` stayed in `index.ts` unchanged,
re-exported as before.

**Option A (recorder's recommendation, not a ruling) — `detach()` stays in
`index.ts`.** The state and its only writer stay together; `ui.ts` reads
`attachedSessionId` through the live binding and calls `detach()` through the
hub, which is what it already does for `running` and `liveSessionCtx`. Costs
row 7 being one section short, recorded here. **Option B — move the attach
state to `ui.ts` and add accessors**, with `/attach` calling them. Row 9 loses
"attach state"; the entry point gains two exported setters it does not have
today. Cleanest ownership; the largest diff for no behavioural gain.
