# WO-2026-080 — fold the watch views onto the terminal-outcome vocabulary

### Metadata

- **work_order_id**: WO-2026-080
- **parent_plan_id**: planning-seat queue (structure-trend register row, 2026-11-05)
- **sequence_position**: 1 of 1
- **routed_to**: implement
- **invariant_exhaustiveness**: implicit — the census below is a lower bound; enumerate every remaining site that names a terminal word, and a *negative* result is the expected one.
- **priority**: normal
- **estimated_complexity**: moderate
- **review_policy**: required

### Task Summary

**One-sentence description**: The four subagent log viewers stop hand-listing which footer words mean "finished" and take both the word and its outcome from the one table the footer writer uses.

**Goal**: No viewer file contains a terminal word list. A run that ends `Errored`, `Overflowed`, `Aborted` or `Killed` displays as that word in every view, is coloured as a failure, and is never shown as `Completed` or as still running.

### Premise

The viewers are the last copies of the vocabulary: WO-2026-078 made `extensions/lib/subagent-state.ts` the single table (`OUTCOME_WORD`, `FOOTER_WORDS`, `TERMINAL_FOOTER_RE`, `parseTerminalFooter`, `readTerminalFooter`, `outcomeFromFooterWord`), and the four view files still test for `Completed`/`Exited`/`Stopped` by hand.

Probe that falsifies it: `rg -nic 'completed|errored|overflowed|aborted|killed|exited|stopped' extensions/subagent-async/watch-session.ts extensions/subagent-async/watch-session-v2.ts extensions/subagent-async/watch-session.cjs` is non-zero in each. If any of those files already derives from the lib, that file is out of scope and the plan is wrong about its size — report and continue with the rest rather than inventing work. Second probe: the `.cjs` files must be able to load the lib at all — `node -e 'const m=require("./extensions/lib/subagent-state.ts"); console.log(Object.keys(m).length)'` prints a count on this box's node v25.9.0. If it fails on the runtime these viewers are launched with, stop and report: converting the `.cjs` viewers to `.ts` is a change to how they are invoked, which is an owner question, not this order's call.

**Prerequisite:** the two TypeScript viewers do not load at this order's base — pi-tui 1.4 made `TUI` an interface and both still do `new TUI(terminal)`. WO-2026-081 ports them and lands first. Re-dispatch this order on top of that landing; the fold itself is unchanged by it.

### Preparatory refactor

**Refactor commit**, `extensions/lib/subagent-state.ts` and `extensions/subagent-async/index.ts`, behaviour-preserving:

1. Move `const MAX_TURNS_HARD = 500` from `extensions/subagent-async/index.ts` to `extensions/lib/subagent-state.ts` and export it; `index.ts` imports it back and keeps every existing use.
2. Extract `index.ts`'s `classifyOutcome` tail (the two lines after the turn branch: `exitCode === null → "aborted"`, else `exitCode !== 0 && turns < MAX_TURNS_HARD ? "aborted" : "finished"`) into an exported `outcomeFromExitCode(exitCode: number | null, turns: number): SubagentOutcome` in the lib. `classifyOutcome` calls it; the recovered-word branch calls `outcomeFromFooterWord` as it does now.
3. Add the composed read the viewers need, in the lib:
   ```ts
   /** The outcome a parsed footer names: its word, or — for `Exited`/`Stopped`,
      which record only that the process exited — the exit code and turn count. */
   export function outcomeFromFooter(footer: TerminalFooter): SubagentOutcome {
       return outcomeFromFooterWord(footer.word) ?? outcomeFromExitCode(footer.exitCode, footer.turns);
   }
   ```

Characterization: `bun test tests/subagent-abnormal-stop.test.ts tests/subagent-state-vocabulary.test.ts` — **all rows pass unedited at the refactor commit**. Those rows already pin every word, the exit-code axes, the `exit ?` form and the turn-limit arm, so an edit to any of them means the refactor changed behaviour: stop.

### Rulings

- **Owner, 2026-11-05, via the planning seat**: "Yes, the watch-view vocabulary fold (five hand-listed footer vocabularies onto `OUTCOME_WORD`) is yours. Write the order against the register row you added, and dispatch when ready." This is the dispatch decision; it does not settle any word or spelling below.
- **Owner, 2026-11-05 (WO-2026-078 Q-A1)**: "Done, but labelled" — classify and visibly mark, never gate. The views are part of "visibly": a run's outcome is shown, not silently swallowed.
- Author's choice, argued against the code rather than ruled: the views display **the footer's own word**, upper-cased where they already upper-cased it, and take only *success versus failure* from `OUTCOME_WORD`. A view that re-spelled an outcome would be a fifth vocabulary again.

**Rejected alternatives**: none by owner ruling. Author's own rejections, for the record: (a) giving the viewers their own `word → success` map — that is the parallel path this order exists to delete; (b) exporting `classifyOutcome` to the viewers — it lives in the pi extension entry, so importing it from a standalone viewer script would load the extension.

### Scope

**Invariants** (what must not change):

- A live session still reads `RUNNING`, and every `status === "RUNNING"` filter keeps its meaning: the picker, the 3-pane auto-selection and the single-pane fallback must select exactly the sessions they select today.
- A log with no terminal footer keeps today's status (`STOPPED` in the discover paths, `EMPTY` when the log is empty) — this is the torn/legacy-log arm, not an outcome.
- A `Completed` run still displays `COMPLETED` (blue in the `.cjs` picker), and a `Stopped`/`Exited` run still displays `STOPPED`/`EXITED`. Existing screens do not change for the three words that already worked.
- `parseTerminalFooter` and `readTerminalFooter` keep their current acceptance: the `(… turns, exit N|?)` shape, and `readTerminalFooter`'s backwards scan. Do not loosen either to match an old viewer regex.
- The viewers stay standalone scripts: no viewer imports `extensions/subagent-async/index.ts`, and the extension does not import a viewer.

**Census at this order's base (the lower bound; verify it, do not trust it)** — fifteen sites in four
files, each naming a terminal word or matching a footer line. The first dispatch reviewed this table
against the code and found four sites it had missed; they are marked ▸ and are the ones the fold is
likeliest to skip:

| file | construct | what it does today |
|---|---|---|
| `watch-session.ts` | the header's `status` ternary | `exitCode === 0 ? "Completed" : \`Stopped (exit N)\`` |
| `watch-session.ts` | the socket `line` handler | three-word regex, `exit (\d+)` only |
| `watch-session-v2.ts` | `SessionStatus` union | hand-list of `COMPLETED`/`STOPPED` |
| `watch-session-v2.ts` | `discoverSessions`, log arm | `content.includes("── Completed")` then `Exited`/`Stopped`, everything else `STOPPED` |
| `watch-session-v2.ts` | the live-tail "Completion footer" branch | three-word regex |
| `watch-session-v2.ts` | the same branch's style | `word === "Completed" ? success : error` |
| ▸ `watch-session-v2.ts` | the same branch's exit-code parse | a **second** regex spelling the absent exit code `null` (the writer emits `?`), then coercing `null → 0` |
| `watch-session-v2.ts` | the pane header | `exitCode === 0 ? "COMPLETED" : \`EXIT N\`` |
| `watch-session.cjs` | `discoverSessions`, log arm | `includes("── Completed")` → `COMPLETED`/`STOPPED` |
| `watch-session.cjs` | the picker's status colour and label | keyed on `status === "COMPLETED"`, prints `status` |
| `watch-session.cjs` | the socket `line` handler | three-word regex, `exit (\d+)` only |
| `watch-session.cjs` | `renderPaneHeader` | `exitCode === 0 ? "COMPLETED" : \`EXIT N\`` |
| ▸ `test-viewer.cjs` | the discover rows over `watch-session.cjs` | assert `s.status === "COMPLETED"` / `"STOPPED"` by string |
| ▸ `test-viewer.cjs` | `DONE_RE` and its assertions | the same three-word regex |

**Files expected to change**:

- `extensions/lib/subagent-state.ts` — `MAX_TURNS_HARD`, `outcomeFromExitCode`, `outcomeFromFooter` (refactor), plus nothing else.
- `extensions/subagent-async/index.ts` — import `MAX_TURNS_HARD`; `classifyOutcome` tail calls `outcomeFromExitCode`.
- `extensions/subagent-async/watch-session.ts` — header word and the footer-line match.
- `extensions/subagent-async/watch-session-v2.ts` — `discoverSessions`, the live-tail footer branch, the pane header.
- `extensions/subagent-async/watch-session.cjs` — `discoverSessions` and the socket line handler.
- `extensions/subagent-async/test-viewer.cjs` — its private `DONE_RE` and the assertions over it.
- `tests/watch-view-vocabulary.test.ts` — new.

**Files to read (reference only, do not modify)**:

- `extensions/lib/subagent-state.ts` — `OUTCOME_WORD`, `TerminalFooter`, `parseTerminalFooter`, `readTerminalFooter`, `outcomeFromFooterWord`, `readSubagentState` (the state reader the reap uses; it is *not* the viewer's source and must not be bent to fit a view).
- `extensions/subagent-async/index.ts` — the footer writer (`── ${how} (${rs.progress.turns} turns, exit ${code ?? "?"}) ──`) and `classifyOutcome`; the viewers must agree with these, not the other way round.
- `tests/subagent-abnormal-stop.test.ts` — the vocabulary's existing rows (characterization set).
- `tests/subagent-state-vocabulary.test.ts` — same.

**Files NOT to modify**:

- `tests/subagent-abnormal-stop.test.ts`, `tests/subagent-state-vocabulary.test.ts`, `tests/subagent-recovery-ownership.test.ts`, `tests/subagent-worktree-lock.test.ts` — the refactor's characterization set. A row that must change here is a behaviour change, so stop.
- `extensions/lib/subagent-state.ts`'s `readSubagentState`, `listInFlightSubagents`, `readTerminalFooter`, `parseTerminalFooter` bodies — the reap and the checkpoint in-flight section depend on their current shape.
- `extensions/subagent-async/_index.ts.off` — dead file, read-only history.
- `extensions/subagent-async/test-layout.ts` — consumes `Layout`/`SEP` from v2 only; leave it alone even though it imports v2.

**Out of scope**: deleting any viewer or test script (that is a surface removal and would be an owner question); unifying the four viewers into one (a separate refactor, and `structure-trend.md` has no row for it); the `/watch` TUI inside `index.ts`; `extensions/subagent-async/test-resume.cjs`.

### Prohibitions

Each with the check that shows it holds at the tip.

- **No terminal word literal in a viewer.** `rg -n '"Completed"|"Errored"|"Overflowed"|"Aborted"|"Killed"|"Exited"|"Stopped"' extensions/subagent-async/watch-session.ts extensions/subagent-async/watch-session-v2.ts extensions/subagent-async/watch-session.cjs` → no output. In `test-viewer.cjs`, such a literal may appear only inside a fixture input string (e.g. `"── Errored (3 turns, exit 1)"`), never in a matcher.
- **No second word→outcome map.** `rg -n 'outcomeFromFooterWord|outcomeFromExitCode|outcomeFromFooter' extensions/subagent-async/watch-session.ts extensions/subagent-async/watch-session-v2.ts extensions/subagent-async/watch-session.cjs` → every hit is a call into the lib import, and the lib holds the only definition: `rg -n 'function outcomeFrom(Footer|ExitCode)' extensions/` → two hits, both in `extensions/lib/subagent-state.ts`.
- **No second regex for a footer line.** `rg -c 'turns, exit' extensions/subagent-async/watch-session.ts extensions/subagent-async/watch-session-v2.ts extensions/subagent-async/watch-session.cjs` → 0: the only footer pattern in the viewers is `TERMINAL_FOOTER_LINE_RE` in the lib. `test-viewer.cjs` is exempt by design — its fixtures *are* real footer lines (`"── Errored (3 turns, exit 1)"`), so a fixture-free count there would mean the rows stopped testing the shape the writer emits.
- **The extension entry does not import a viewer.** `rg -n 'watch-session' extensions/subagent-async/index.ts` → no output.
- **No `classifyOutcome` export.** It stays module-private in `index.ts`: `rg -c 'export function classifyOutcome' extensions/` → 0.
- **`MAX_TURNS_HARD` has one definition.** `rg -c 'MAX_TURNS_HARD = ' extensions/` → 1, in `extensions/lib/subagent-state.ts`; `index.ts` imports it.

### Implementation Specification

**Detailed requirements**:

1. **Refactor** (commit 1, above): move the constant, extract `outcomeFromExitCode`, add `outcomeFromFooter`. `classifyOutcome`'s observable behaviour is unchanged: killed wins, then the recovered word, then the turn, then the exit code. Existing suite rows pass unedited.

2. **`extensions/lib/subagent-state.ts`** gains nothing beyond step 1.

3. **`watch-session.ts`** (single-pane TUI):
   - Add `word: string | null` and `outcome: SubagentOutcome | null` alongside the existing `done`/`exitCode`/`turns` fields; `setDone` takes the parsed footer instead of `(code, turns)`.
   - The header's status becomes `done ? (word ?? STOPPED_FOOTER_WORD) : "running"` — the word the footer wrote, on the state the footer recorded; `STOPPED_FOOTER_WORD` is the lib's exported constant, so no literal appears here. Delete the `exitCode === 0 ? "Completed" : \`Stopped (exit ${exitCode})\`` ternary.
   - The socket `line` handler matches with `parseTerminalFooter(line)` (unanchored, so the ANSI prefix the log line carries does not matter) instead of the three-word regex.
   - Socket-close with no footer (`setDone(0, turns)` today) still marks the session terminal but supplies no word, so the header shows `STOPPED_FOOTER_WORD`: the wordless arm is unchanged from today, and the close path must not invent a word of its own. Its call site changes because `setDone` takes the parsed footer; pass `null`.

4. **`watch-session-v2.ts`** (multi-pane):
   - `SessionStatus` becomes `"RUNNING" | "TERMINAL" | "EMPTY"`, and `SessionInfo` gains `word: string | null` and `outcome: SubagentOutcome | null`. Session *selection* keeps using `status === "RUNNING"`, unchanged at all four sites.
   - `discoverSessions`: the socket arm stays `RUNNING`; the log arm becomes `readTerminalFooter(content)` → `TERMINAL` with `word`/`outcome` (via `outcomeFromFooter`), `EMPTY` for an empty log, and `TERMINAL` with `word: null` for a non-empty log with no footer. The log is already read exactly once per file here (`content`); keep it at one read, and note `countTurns` below it opens the file again for its own purpose — leave that alone.
   - The live-tail "Completion footer" branch tries `parseTerminalFooter(trimmed)` and, on a match, sets `done`, `word`, `outcome`, `turns` and `exitCode` from it. Style: `TS.success` when `outcome === "finished"`, `TS.error` otherwise — the same rule as before, now reading the outcome rather than one word.
   - The pane header uses `word` (upper-cased) for the terminal case and `outcome === "finished"` for its colour, instead of `exitCode === 0`.
   - v2's picker renders **no** status word today, and `SessionStatus` is read only in `status === "RUNNING"` filters — so v2 takes no picker change from this order. Its `status` becomes `RUNNING`/`TERMINAL`/`EMPTY` and the word rides beside it.

5. **`watch-session.cjs`** (`require("../lib/subagent-state.ts")`):
   - `discoverSessions`: `status` becomes `"RUNNING"` or the upper-cased footer word (`STOPPED_FOOTER_WORD` upper-cased when wordless), plus `word`/`outcome` from `readTerminalFooter`. **The status string stays the word here, unlike v2**, because this viewer prints and pads it and `test-viewer.cjs` pins `"COMPLETED"`/`"STOPPED"` by string — so those rows stay unedited. This arm reads the log twice today (`countLines` then `fs.readFileSync(...).includes(...)`); fold that into one read while you are here, or leave `countLines` and read once for the footer — either is fine, but do not reach three.
   - The picker's colour rule: `RUNNING` green, `outcome === "finished"` blue, everything else terminal yellow — the current rule re-expressed, not changed — and its label becomes the upper-cased `word` (`STOPPED` from `STOPPED_FOOTER_WORD` when there is none), padded as today.
   - `renderPaneHeader` takes its word from `word` (upper-cased, `STOPPED_FOOTER_WORD` when wordless) instead of `exitCode === 0`, and colours by `outcome === "finished"`. **Delete the `EXIT n` branch**: no path reaches it, because the process's real exit code arrives only in a footer and a footer always carries a word.
   - The pane's `exitCode` becomes `number | null`, matching `TerminalFooter.exitCode`: a wordless close records `null` ("none observed") instead of today's invented `0`. Nothing displays it after the fold, so the field stops lying rather than starting to.
   - The socket `line` handler uses `parseTerminalFooter(line)` (with `plainLine`), as in `watch-session.ts`.

6. **`test-viewer.cjs`**: delete the private `DONE_RE` and re-point its rows at `parseTerminalFooter`, adding one row per footer word and one for `exit ?`. Its assertions must show the shared parser's output, not a copy of the regex.

**Required test boundary**:

The viewers are TIUs over a socket; the stable, cheap seam is the **library call each view makes**, plus a source-level claim about the views:

- Primary: `outcomeFromFooter` / `outcomeFromExitCode` / `parseTerminalFooter` / `readTerminalFooter` in `tests/watch-view-vocabulary.test.ts`, driving every footer word and every exit-code axis.
- Advanced: `watch-session-v2.ts`'s `discoverSessions` gets an exported, pure helper for the log→status derivation (`statusFromLogContent(content: string)`), called by `discoverSessions`; rows assert all seven words, `exit ?`, an empty log and a torn log through that helper. `discoverSessions` keeps its `/tmp` scan — do not add a scan directory hook for this order.
- Advanced: `node extensions/subagent-async/test-viewer.cjs` exits 0 and its per-word rows print; paste the tail in the report.
- Structural: the prohibition greps, run at the tip.

Do not spawn a TUI in a test. No row may require a TTY, a socket, or a real child process.

**Behavior and failure matrix**:

| # | Case | Expected |
|---|---|---|
| F1 | `── Completed (3 turns, exit 0) ──` | word `Completed`, outcome `finished`, success colour |
| F2 | `── Errored (3 turns, exit 1) ──` | word `Errored`, outcome `errored`, failure colour, **not** `COMPLETED` |
| F3 | `── Overflowed (3 turns, exit 0) ──` | word `Overflowed`, outcome `overflowed`, failure colour (exit 0 must not win) |
| F4 | `── Aborted (3 turns, exit 0) ──` | word `Aborted`, outcome `aborted`, failure colour |
| F5 | `── Killed (3 turns, exit ?) ──` | word `Killed`, outcome `killed`, failure colour; `exitCode` null |
| F6 | `── Exited (3 turns, exit 0) ──` | word `Exited`, outcome `finished` |
| F7 | `── Exited (3 turns, exit 1) ──` | word `Exited`, outcome `aborted` |
| F8 | `── Stopped (3 turns, exit 143) ──` | word `Stopped`, outcome `aborted` |
| F9 | `── Stopped (3 turns, exit ?) ──` | word `Stopped`, outcome `aborted` — the WO-2026-078 form, which today's three-word regexes do not match at all |
| F10 | `outcomeFromExitCode(0, n)` / `(1, n)` / `(null, n)` | `finished` / `aborted` / `aborted` |
| F11 | `outcomeFromExitCode(1, 500)` — at the hard cap | `finished` (the turn-limit kill carries its own word; this arm is preserved, not re-derived) |
| F12 | A log ending in an assistant line, no footer | `null` from `readTerminalFooter`; view status `TERMINAL`/wordless (discover) and no `done` (live tail) |
| F13 | An empty log | `EMPTY`, unchanged |
| F14 | A footer line carrying an ANSI prefix | parsed — the pattern is unanchored on the left |
| F15 | A footer word no writer emits (`── Finished (1 turns, exit 0) ──`) | **not** parsed as a footer: `parseTerminalFooter` → null, `readTerminalFooter` → null (the word list is the acceptance, not a prefix match) |

**Representation-level checks**: the word set in the viewers must be empty (the grep in Prohibitions is the check); `SessionStatus`'s terminal member is `"TERMINAL"`, so no terminal word appears in a type; `SessionInfo`'s `word` is `string | null` — the literal union of words lives only in the lib.

**Integration contract**: the views consume `parseTerminalFooter`, `readTerminalFooter`, `outcomeFromFooter`, `OUTCOME_WORD`, and the `SubagentOutcome`/`TerminalFooter` types from `extensions/lib/subagent-state.ts`. The extension entry consumes `MAX_TURNS_HARD` from the same file. The footer writer (`── ${how} (…) ──`) and the reader (`TERMINAL_FOOTER_LINE_RE`) keep agreeing because both are built from `FOOTER_WORDS`.

**Reference patterns**: `readSubagentState` in the lib shows the intended shape — one classifier over observed facts, with the evidence string naming what decided. `parseTerminalFooter`'s `exit ?` handling is the model for "a field the file may not carry".

### Invariants

**Cross-file conventions**:
- Every terminal word lives in `OUTCOME_WORD`/`EXITED_FOOTER_WORD`/`STOPPED_FOOTER_WORD` and nowhere else but a test fixture.
- Viewers are standalone: they may import the lib, never the extension entry.
- `.cjs` files load the lib with `require("../lib/subagent-state.ts")`; this is verified on node v25.9.0 and must not be replaced by a copied constant.

**Default values to preserve**:
- A wordless terminal log displays `STOPPED` in the picker (today's fallback), and `EMPTY` only when the log has no content.
- `MAX_TURNS_HARD` stays `500`.
- The pane header's elapsed-time accent and the `missing`/`connecting` states are untouched.

**Ordering assumptions**:
- `classifyOutcome`: killed → recovered word → turn → exit code. Unchanged by the refactor; `outcomeFromExitCode` is only the tail.
- `readTerminalFooter` scans backwards and returns the last footer; views must not substitute a forward `includes`.

**Error handling conventions**:
- `outcomeFromFooterWord` throws on a word no writer emits; that is unreachable through `parseTerminalFooter`, which only matches `FOOTER_WORDS`. Do not add a try/catch in a viewer to paper over it.
- `fs` reads in the viewers stay in their existing `try`/`catch` arms.

**Unspecified invariants** (`invariant_exhaustiveness: implicit`):
- The census is the deliverable: enumerate every site in the four files that names a terminal word or matches a footer line, and say how many you found and where. The table above lists eleven; the order's author found eight on the first pass and three more on the second, so a count that disagrees in either direction is worth reporting rather than reconciling silently.
- The `.cjs` runtime question: if `require` of the `.ts` lib fails under the launch command these files document (`node watch-session.cjs`), stop — do not convert the file to `.ts` and do not inline a copy.

### Verification Criteria

**Entry points that must work**:
- `bun test tests/watch-view-vocabulary.test.ts` — every row green.
- `bun test tests/subagent-abnormal-stop.test.ts tests/subagent-state-vocabulary.test.ts` — green, rows unedited (`git diff --name-only <base>..HEAD -- tests/subagent-abnormal-stop.test.ts tests/subagent-state-vocabulary.test.ts` → empty).
- `node extensions/subagent-async/test-viewer.cjs` — exits 0, per-word rows print.
- `bun build --target node --outdir <scratch dir> <viewer>` — clean, once per viewer. Not one command with two entry points (`bun build` refuses those without `--outdir`), and not the default target (pi-tui's browser arm cannot resolve `child_process`). At base this fails with exactly `No matching export … for import "TUI"`, which WO-2026-081 fixes first.
- `node --check extensions/subagent-async/watch-session.cjs extensions/subagent-async/test-viewer.cjs` — clean.
- `printf '' | pi -ne -e ./extensions/subagent-async/index.ts --offline --mode rpc` — the extension loads (the refactor moved code out of it).

**Input shapes that must be accepted**: every footer word incl. `exit ?`; an ANSI-prefixed footer line; a log with no footer; an empty log; a footer word no writer emits is rejected, not parsed.

**Tests that must pass**: the new file plus the two characterization files; targeted rows only for anything else — do **not** run the full suite, the orchestrator holds the base-vs-tip comparison.

**Test surface requirements**: rows go through the shared lib functions and `statusFromLogContent`, not through a private copy of a regex. A row that asserts a viewer's network/TTY behaviour is out of scope.

**Build requirements**: `bun build` clean on both TS viewers; no `tsc` in this repo. Do not touch `package.json`, `tsconfig`, or add dependencies.

**Mutation evidence** (each row's red-turning revert, run alone):
- Re-point one viewer at a private three-word regex → the F2/F3/F4/F5 row reds and the prohibition grep shows the literal.
- Make `outcomeFromFooter` ignore the word and use only the exit code → F3 (exit 0, `Overflowed`) and F6/F7 red.
- Make `outcomeFromExitCode` treat `null` as 0 → F5/F9/F10 red.
- Anchor the footer pattern on the left → F14 reds.

### Structural Risks

- [ ] **Route/path correctness** — every viewer still starts by its documented command (`npx tsx watch-session.ts`, `npx tsx watch-session-v2.ts`, `node watch-session.cjs`); the `.cjs` files are not renamed.
- [ ] **Input validation scope** — `parseTerminalFooter` is not widened to accept a word no writer emits (F15 is the boundary).
- [ ] **Test surface** — rows call the lib and `statusFromLogContent`, not a regex copy.
- [ ] **Recovery logic** — `discoverSessions`' socket arm still wins over the log arm for a session with a socket, exactly as today.
- [ ] **No unrequested changes** — no viewer deleted, renamed or unified; `readSubagentState` untouched.
- [ ] **Build config untouched** — no dependency added to make the `.cjs` files load the lib.
- [ ] **No unsolicited features** — no new viewer flags, no new status words, no colour changes beyond the outcome-driven rule.
- [ ] **No parallel path** — one word table, one footer pattern, one exit-code rule; if the fold needs a second map anywhere, stop and return `REFACTOR FIRST`.

### Context

**Prior work orders completed in this plan**:
1. WO-2026-078 (landed `fa3c9d6`) — one classifier writes the prefix, the footer word and the on-disk state; `OUTCOME_WORD` and `TERMINAL_FOOTER_RE` are built from one list. Its accepted notes record that these five viewer vocabularies do not know the three new words.
2. WO-2026-076 (landed) — the preceding funnel: five duplicated preamble steps became one helper. Same shape of change, one area over.

**Upcoming work orders**: none in this plan. The register row in `docs/investigations/structure-trend.md` (2026-11-05, "terminal-outcome vocabulary in the watch views") is closed by this landing; the orchestrator appends the closure.

### Completion Report Format

status / owner_asks / invariant_exhaustiveness / commits / files_modified / tests (each row's red-turning revert) / deviations_from_spec / claims (each prohibition with its check's output) / structural_checks / assumptions_made / unexpected_changes / issues_encountered / test_coverage / adversarial_reviews / accepted_notes / notes_for_orchestrator — per the agent's system prompt.

Send the same summary to `claude-8f90746f-e9aa-4dab-81ef-eb303ba0cb65` by peer message: every completion, gate, landing and stop goes there.
