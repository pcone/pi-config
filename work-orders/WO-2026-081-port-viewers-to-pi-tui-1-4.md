# WO-2026-081 — port the two TS viewers to pi-tui 1.4's renderer split

### Metadata

- **work_order_id**: WO-2026-081
- **parent_plan_id**: planning-seat queue (structure-trend register row, 2026-11-05)
- **sequence_position**: 1 of 2 — prerequisite for WO-2026-080
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit
- **priority**: normal
- **estimated_complexity**: trivial
- **review_policy**: required — a live entry point starts working again; the routing criterion is "can an invariant fail", and "the viewer launches" is one.

### Task Summary

**One-sentence description**: Both TypeScript subagent viewers construct pi-tui's renderer again, which pi-tui 1.4 turned from a class into an interface.

**Goal**: `npx tsx extensions/subagent-async/watch-session.ts <id>` and `npx tsx extensions/subagent-async/watch-session-v2.ts <id>` reach their own argument handling instead of dying at import with `does not provide an export named 'TUI'`.

### Premise

pi-tui 1.4.0 exports `TUI` as a type only (`dist/index.d.ts:32`, `export { … type TUI … }`), makes `TuiBase` abstract (`dist/tui.d.ts:254`), and ships two concrete renderers: `TuiMainScreen` (`dist/tui-main-screen.js`, `mode = "regular"`) and `TuiAltScreen` (`mode = "fullscreen"`). Both viewers still do `new TUI(terminal)`.

Probe that falsifies it, at the order's base: `npx --no-install tsx extensions/subagent-async/watch-session.ts subagent-nope` prints `SyntaxError: The requested module '@earendil-works/pi-tui' does not provide an export named 'TUI'`. If either viewer already reaches its own message (`No subagent session found for: …` or a picker), that file is not broken and the order is smaller than described — say so and port only the other.

Second fact the fix depends on: `TuiMainScreen` is the behaviour-preserving choice, not a preference. `TUI` was the sole concrete class before the split and rendered into the main buffer, and pi-tui's README shows `const tui: TUI = new TuiMainScreen(terminal)` as the default construction while calling `TuiAltScreen` the alternative for an application-owned viewport (`README.md:61-67`). A `Stopped`-terminal log viewer's output must survive exit, which is `TuiMainScreen`'s documented property. If a viewer needs the alternate buffer, that is a separate, visible decision — not this order.

### Preparatory refactor

**`none`** — the change replaces one constructor call in each of two independent standalone scripts, which share no module. There is nothing to extract: a shared `makeTui()` helper would need a new file to hold one line, and the two files import nothing from each other.

### Rulings

- **Owner, 2026-11-05, via the planning seat**: "Yes, the watch-view vocabulary fold … is yours. Write the order against the register row you added, and dispatch when ready." This order is the prerequisite that fold needs, and it lands first.
- **Author's choice, grounded in the README citations in Premise**: `TuiMainScreen` rather than `TuiAltScreen`. Rejected: `TuiAltScreen` — it owns scrolling and restores the main buffer on exit, which erases the log a viewer exists to leave behind.

**Rejected alternatives**: none by owner ruling.

### Scope

**Invariants** (what must not change):

- Viewer behaviour after construction is byte-identical: same components, same keybindings, same socket path, same messages, same exit codes.
- `watch-session-v2.ts`'s exports stay as they are (`Layout`, `SEP`, `discoverSessions`, `SessionInfo`, …) — `test-layout.ts` imports them.
- No new dependency, no `package.json` change, no pinned pi-tui version. The tree installs pi-tui through the global pi; pinning it is an environment change, not a repo one.
- The `.cjs` viewers are untouched: `node --check` clean before and after, `node test-viewer.cjs` still exits 0 with the same row count.

**Files expected to change**:

- `extensions/subagent-async/watch-session.ts` — the import and one construction.
- `extensions/subagent-async/watch-session-v2.ts` — the import and one construction.

**Files to read (reference only, do not modify)**:

- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/README.md` — the renderer split, `:61-67`.
- `.../pi-tui/dist/tui.d.ts` — the `TUI` interface (`:218`) and abstract `TuiBase` (`:254`).
- `extensions/subagent-async/test-layout.ts` — imports `Layout`/`SEP` from v2 and fails at shell start today for this same reason; it must go green **without being edited**.

**Files NOT to modify**:

- `extensions/subagent-async/test-layout.ts` — the port fixes it through the import; editing it would hide whether the module evaluates.
- `extensions/subagent-async/test-viewer.cjs`, `watch-session.cjs` — `.cjs`, unaffected, and their rows are the regression set.
- `extensions/subagent-async/index.ts` — the `/watch` TUI inside pi is a different entry point on a different import path; if it is broken, that is its own finding to report, not to fix here.
- `work-orders/WO-2026-080-watch-view-vocabulary-fold.md` — a separate order; do not re-scope it.

**Out of scope**: any vocabulary change (that is 080); deleting or merging viewers; the alternate-buffer renderer; mouse-reporting or keybinding changes; a `TuiMainScreen` wrapper module.

### Prohibitions

- **No `TUI` value import survives.** `rg -n '^\s*TUI,|\bnew TUI\(' extensions/subagent-async/watch-session.ts extensions/subagent-async/watch-session-v2.ts` → no output.
- **No shim.** `rg -n 'class .*TUI|export .*TUI' extensions/subagent-async/*.ts` → only the two `type TUI` imports; no repo-local class or re-export stands in for the upstream one.
- **No dependency or config change.** `git diff --name-only <base>..HEAD` → the two viewer files only.
- **No test-file edit.** `git diff --name-only <base>..HEAD -- extensions/subagent-async/test-layout.ts extensions/subagent-async/test-viewer.cjs extensions/subagent-async/watch-session.cjs` → empty.

### Implementation Specification

**Detailed requirements**:

1. In each viewer, split the pi-tui import: `type TUI` stays in the import list as a type, and `TuiMainScreen` joins as a value. Keep any `const tui: TUI` annotation — it is the compile-time proof the renderer satisfies the interface the rest of the file is written against.
2. Replace `new TUI(terminal)` with `new TuiMainScreen(terminal)` at the one construction site in each file.
3. One comment at the construction, in the file's own voice, stating why the main-screen renderer: it preserves scrollback, so the log survives the viewer exiting, and the alternate-buffer renderer is the one for an application-owned viewport (pi-tui README). One sentence, no recap of this order.
4. If either file uses `TUI` in a value position anywhere else, report it rather than inventing a replacement.

**Required test boundary**: the launch commands are the boundary, because the defect is a module-evaluation failure that only a real launch exercises.

- `npx --no-install tsx extensions/subagent-async/watch-session.ts subagent-nope` → prints the "no subagent session found" message and its socket path, exits 1. No `SyntaxError`.
- `npx --no-install tsx extensions/subagent-async/watch-session-v2.ts subagent-nope` → the same: its own argument/connection handling, not a module error.
- `npx --no-install tsx extensions/subagent-async/test-layout.ts` → exit 0, its own pass count, file unedited.
- `node extensions/subagent-async/test-viewer.cjs` → exit 0, the same passed/failed counts as at base (77 passed when this order was written; re-measure rather than trusting the number).
- `bun build --target node --outdir <scratch> <each viewer>` → clean. At base both fail with exactly `No matching export … for import "TUI"`, so this row discriminates the fix from its absence.

**Behavior and failure matrix**:

| # | Case | Expected |
|---|---|---|
| P1 | `watch-session.ts` launched with a bogus id | its own "not found" message, exit 1 |
| P2 | `watch-session-v2.ts` launched with a bogus id | its own handling, no module error |
| P3 | `test-layout.ts` run | exit 0, unedited |
| P4 | `test-viewer.cjs` run | same counts as base |
| P5 | `bun build --target node` on each viewer | clean |
| P6 | Both `.cjs` files under `node --check` | clean |
| P7 | `printf '' \| pi -ne -e ./extensions/subagent-async/index.ts --offline --mode rpc` | rc 0 — the extension still loads (proves nothing in this port leaked into the extension's path) |
| P8 | A viewer started under a real TTY with a live session | out of scope to automate; if the implementer tries it by hand, record what was seen, but no row may depend on a TTY |

**Representation-level checks**: the renderer assignment must satisfy `TUI` (keep the annotation); no second renderer construction appears in either file (`rg -c 'new TuiMainScreen|new TuiAltScreen' extensions/subagent-async/*.ts` → 2, one per viewer).

**Integration contract**: `TuiMainScreen` implements `TUI` (`dist/tui-main-screen.d.ts:12`), so every call the viewers make through `tui` (`addChild`, `start`, `stop`, `requestRender`, `onTerminalColorSchemeChange`, …) is unchanged. `test-layout.ts`'s import of `Layout`/`SEP` from v2 becomes evaluable again.

**Reference patterns**: `pi-tui`'s README `:21,27,61-67` is the upstream's own construction example; follow it literally.

### Invariants

**Cross-file conventions**:
- Viewers are standalone scripts: they may import `@earendil-works/pi-tui` and `node:*`, never `extensions/subagent-async/index.ts`.
- `watch-session-v2.ts`'s export list is consumed by `test-layout.ts` and must not shrink.

**Default values to preserve**: the socket path pattern `/tmp/pi-subagent-<id>.sock`, the 30 s post-exit review window in `watch-session.ts`, v2's picker-when-no-arg default.

**Ordering assumptions**: none — the construction happens once, before any child component is added.

**Error handling conventions**: unchanged. A missing socket still produces the viewer's own message and exit 1; do not add a fallback that hides a failed connection.

### Verification Criteria

**Entry points that must work**: P1–P5 above, run and pasted.

**Input shapes that must be accepted**: a bogus session id (the "not found" path), and `test-layout.ts`'s module import.

**Tests that must pass**: `test-layout.ts` exit 0; `test-viewer.cjs` unchanged counts. There are no `bun test` rows for the viewers — do not invent any in this order.

**Test surface requirements**: the rows are process launches, not internal calls. A row that mocks `@earendil-works/pi-tui` proves nothing here: the defect is the real module's export surface.

**Build requirements**: `bun build --target node --outdir <scratch> <viewer>` clean on both; `node --check` clean on the `.cjs` files; no `tsc` in this repo; no dependency added.

**Mutation evidence** (each row's red-turning revert, run alone):
- Restore `TUI` as a value import → P1, P2, P3, P5 red.
- Swap `TuiMainScreen` for `TuiAltScreen` → P1–P5 stay green (it also satisfies `TUI`), so the renderer choice is **not** pinned by any of these rows. That is expected and must be reported, not papered over: the choice is pinned by the comment and by the README, not by a test, because the difference is buffer ownership at the terminal, which no headless row can observe.

### Structural Risks

- [ ] **Route/path correctness** — the launch commands stay the ones each file documents, and the files keep their names.
- [ ] **Input validation scope** — the port accepts the same CLI shapes as before; nothing new is validated.
- [ ] **Test surface** — rows are real launches and real builds, not mocked module surfaces.
- [ ] **Recovery logic** — n/a; no retry or recovery path is touched.
- [ ] **No unrequested changes** — only the two viewers change; `test-layout.ts` goes green unedited.
- [ ] **Build config untouched** — no `package.json`, `tsconfig`, or dependency change.
- [ ] **No unsolicited features** — no alternate-screen option, no new flags, no viewer unification.
- [ ] **No parallel path** — no repo-local `TUI` shim, no wrapper class, no conditional import.

### Context

**Prior work orders completed in this plan**: none — this is the prerequisite for WO-2026-080.

**Upcoming work orders**: WO-2026-080 (fold the four viewers onto the terminal-outcome vocabulary) re-dispatches on top of this landing. Per its own stop-report, it cannot meet its build, launch or `statusFromLogContent` criteria until this lands. Do not attempt 080's vocabulary changes here, and do not pre-empt its shape.

### Completion Report Format

status / owner_asks / invariant_exhaustiveness / commits / files_modified / tests (each row's red-turning revert) / deviations_from_spec / claims (each prohibition with its check's output) / structural_checks / assumptions_made / unexpected_changes / issues_encountered / test_coverage / adversarial_reviews / accepted_notes / notes_for_orchestrator — per the agent's system prompt.

Send the same summary to `claude-8f90746f-e9aa-4dab-81ef-eb303ba0cb65` by peer message: every completion, gate, landing and stop goes there.

---

### Landing stamp (2026-11-05, merged `08c5b20`, port commit `3f3b2b0`)

**Landed, verified at the merged tip by me, not from the report:**

- P1 `npx --no-install tsx extensions/subagent-async/watch-session.ts subagent-nope` → its own
  `No subagent session found for: …` plus the socket path, exit 1.
- P3 `npx --no-install tsx extensions/subagent-async/test-layout.ts` → 27 passed, 0 failed, file
  unedited.
- P5 `bun build --target node --outdir <scratch> <both viewers>` → both entry points emitted, no
  diagnostics.
- **My mutation: the full base state** (value `TUI,` *and* `new TUI(terminal)`) reds both P1
  (`does not provide an export named 'TUI'`) and P5 (`No matching export … for import "TUI"`).

**Two defects in this order, both mine, both confirmed by re-running:**

1. **Mutation evidence row 1 was a no-op.** I wrote "restore `TUI` as a value import → P1, P2, P3, P5
   red". Re-adding `TUI,` while the construction stays `new TuiMainScreen(…)` bundles clean: both
   esbuild/tsx and bun elide a named import used only in a type position. The discriminating revert is
   the **full base state**, which the implementer ran instead of the literal instruction. Verified:
   `0 errors` on the type-position-only mutant, `1` on the full revert.
2. **"No headless row can observe the renderer choice" was false.** The alternate-buffer switch
   `ESC[?1049h` reaches stdout through a pipe: 0 occurrences on the main-screen build, present under a
   `TuiAltScreen` mutant. So the choice *is* pinnable — and is pinned in WO-2026-080, which touches
   both viewers again, rather than by rewriting this frozen spec.

**Accepted, with the reason it is not a gap here:** the `const tui: TUI` annotation was *added*, not
kept — neither file had one at base (`const tui = new TUI(terminal)` inferred the concrete class). It
restores the base's static type instead of narrowing it to `TuiMainScreen`, types erase, and the
upstream README spells the construction this way. Both reviewers read it as inside the order.

**Not coverage of the port, so it is not cited as any:** `test-viewer.cjs`'s 77 passed rows require
`watch-session.cjs`, not the TS viewers; P6 and P7 are green regardless of them too.
