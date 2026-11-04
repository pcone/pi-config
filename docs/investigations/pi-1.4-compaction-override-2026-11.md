# pi 1.4 compaction override: live, and against a standing ruling (2026-11-04)

WO-2026-071 step 1. Every claim below names the probe that produces it. Installed pi:
`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/package.json` → **1.4.0**
(mtime 2026-10-31T20:17). npm `latest` is 1.5.0 as of this date; nothing here is about 1.5.0.

**Verdict.** The fleet override is **live**. On this box, since 2026-11-01, a checkpoint
compaction's stored summary is the fleet model's rewrite, not the text `checkpoint.ts`
composed. That contradicts the owner's 2026-10-31 ruling
(`decisions/checkpoint/005-summary-ownership.md`) — the ruling and its carrier orders sat on
branch `summary-ownership`, unmerged, so `main` ran the behaviour the ruling rejects.

**Landed 2026-11-04 (WO-2026-073).** The ruling and both carriers are on `main`; the finding
below is the record of the state that produced them. Re-probed with the §1 method, one real
`checkpoint`-tool compaction per tree (`~/Developer/scratch/wo073/drive.ts`):

| tree | fleet request on the checkpoint compaction | persisted `CompactionEntry.summary` |
|---|---|---|
| `5edaff6` (before) | `deepseek-v4.1-flash`, body carries `[CHECKPOINT]` | 1140 chars, `usage` present, does not start with the archive's authored text |
| merged tip | **none** (no request to the fleet provider at all) | 1019 chars, no `usage`, byte-identical authored prefix then the machine block |
| merged tip, `/compact` control | `deepseek-v4.1-flash` | 855 chars, `usage` present, fleet rewrite — the ruling does not reach it |

## 1. Which model served the summary

Two artefacts, one driven run, one production corpus.

**Driven run** (`~/Developer/scratch/wo071/run.ts` + `probe-ext.ts`; in-process SDK session,
real extension modules in `settings.json` order — `checkpoint.ts` then `compaction-model.ts` —
live auth, session model `kimi-coding/k3.1-pro`, `keepRecentTokens: 500`, one
`session.compact("[CHECKPOINT]\nPNONCE-… ")`):

| run | extension set | request during compaction | stored `CompactionEntry` |
|---|---|---|---|
| F1 | checkpoint + compaction-model | `POST https://opencode.ai/inference/go/openai/v1/chat/completions`, `model: deepseek-v4.1-flash`, body contains `[CHECKPOINT]` and the nonce | 971 chars, `usage` present, `details.{readFiles,modifiedFiles}`, `fromHook: true` |
| F0 (control) | checkpoint only | **none** | 79 chars, byte-equal to the `[CHECKPOINT]` text, no `usage`, no `details` |
| F2 (fleet transport broken) | checkpoint + compaction-model | attempt to an unroutable port | 79 chars, verbatim, no `usage`; `session_compact_failed` never fires |

The wire request is the artefact: the summarization call goes to the fleet provider with
`model: deepseek-v4.1-flash` while the session model is `k3.1-pro`. Probe: the `wire_request`
lines in `~/Developer/scratch/wo071/sess-1.log` / `sess-0.log` / `sess6.log`, written by a
`globalThis.fetch` wrapper in `run.ts`. That wrapper is needed because the compaction request
bypasses both `before_provider_request` and the coding-agent `ModelRuntime` — `compaction-model.ts`
calls pi's exported `compact()` with no `streamFn`, so pi-ai dispatches it directly
(`dist/core/compaction/compaction.js:496`, `:531`; pi-ai `dist/models.js:442`).

**Production corpus.** `~/.pi/agent/sessions/**/*.jsonl` compaction entries since the 1.4.0
install, paired with `.pi/checkpoints/*.meta.json` in the session's cwd within 300 s
(`~/Developer/scratch/wo071/pair.mjs`): 46 compaction entries, 30 pairings, 2 spurious (a
subagent session matching another session's archive). Of the 28 real pairs, **26 persisted a
summary that is not the text in the archive's `summary`**; the 2 verbatim ones are
`2026-11-01T02:12` (session `01a0f603`) and `2026-11-01T05:00` (`01a11479`). Every checkpoint
compaction from 2026-11-02 on persisted a rewrite.

**Which model, from pi's own accounting.** For session `01a0f603` the session model was
`kimi-coding/k3.1-pro` ($2/M in, $10/M out — `ModelRuntime.getModel(...).cost`) from
2026-11-03T04:59, yet each compaction entry's `usage.cost` implies **$0.15/M in, $0.60/M out** —
`deepseek-v4.1-flash`'s table. Probe: `~/Developer/scratch/wo071/inspect.mjs` on
`~/.pi/agent/sessions/--Users-scott-Developer-tfd--/2026-10-01T05-50-19-249Z_01a0f603-….jsonl`.
A `k3.1-pro` summarization of the same tokens would have cost ~13× more; the recorded cost is the
fleet seat's.

**What opens with "## Goal".** Not a tell. pi's own `SUMMARIZATION_PROMPT`
(`compaction.js:379-447`) produces that shape, so the default path and the fleet path are
indistinguishable by summary shape or by the presence of `usage`. Only the wire model, the cost
table, or the verbatim comparison discriminates.

## 2. Runner semantics on 1.4.0: which extension wins

Unchanged from 0.83.0. `dist/core/extensions/runner.js:813` `emit()`: a truthy
`session_before_compact` result **overwrites** the previous one, `cancel` short-circuits, and a
throw is caught into `emitError` leaving the prior result standing. `settings.json` loads
`checkpoint.ts` first and `compaction-model.ts` ninth, so the fleet handler is last and replaces
checkpoint's `{compaction}` whenever its `compact()` returns. Results replace, never merge.
Probe: the F0-vs-F1 pair above — the only difference between the two runs is whether the last
handler returns.

## 3. The marker split still discriminates; `reason` still cannot

- `CompactionResult.reason` **still does not exist in 1.4.0**: `{summary, firstKeptEntryId,
  tokensBefore, estimatedTokensAfter?, usage?, details?}` (`dist/core/compaction/compaction.d.ts:18-28`).
  The premise hazard holds — do not rebuild a plan on it.
- The hook event keeps `reason` (`dist/core/extensions/types.d.ts:601-611`).
- `/compact` and `ctx.compact()` both report `"manual"`: `AgentSession.compact()` emits
  `{type: "compaction_start", reason: "manual"}` (`dist/core/agent-session.js:2233`), and that
  method is the shared entry point for `/compact`, RPC and extensions. Probed live: the F1 run's
  `before_compact` line shows `reason: "manual"` with `[CHECKPOINT]` present in
  `customInstructions`.
- So the `[CHECKPOINT]` marker remains the only checkpoint-vs-`/compact` discriminator, exactly
  as WO-2026-061's premise states.

## 4. Why it woke

`compaction-model.ts` passes no `sessionId`, so `completeSummarization` generates one
(`compaction.js:483` `sessionId: options.sessionId ?? uuidv7()`), and pi-ai attaches it to the
openrequest (`dist/models.js:442` → `x-opencode-session`). The header is present on the wire and
opencode-go accepts it. Probed: the F1 wire line carries `x-opencode-session:
01a1a5e5-0f1e-…` while the session id was `01a1a5e4-e213-…` — a fresh uuidv7, not the session's.

Consequence for `pi-upgrade-2026-10.md` §6 step 4: passing
`ctx.sessionManager.getSessionId()` as `compact(…, sessionId)` is **not needed**. The historic
`MissingSessionID` 400 does not reproduce on 1.4.0, with or without the real id.

## 5. The failure path is still silent where it counts

`compaction-model.ts` catches every `compact()` error, emits `ctx.ui.notify(…, "error")` and
returns `undefined`. Probed by redirecting the fleet model's `baseUrl` to an unroutable port
(run F2): the request fails, the handler falls through, the compaction **succeeds** with
checkpoint's verbatim summary, and **no `session_compact_failed` event fires**. A
summary-ownership flip therefore leaves no durable trace — the only signal is a transient toast
that a settled or idle session does not show at all. That is how 26 flips went unnoticed.

## 6. The ruling, and where its carrier is

`decisions/checkpoint/005-summary-ownership.md` (renumbered from `003` when it landed) on branch
`summary-ownership` (commit `fd3ee99`,
2026-10-31) records the owner's ruling: a checkpoint's stored summary is the text `checkpoint.ts`
composes, verbatim, and `compaction-model.ts` returns `undefined` on the marker **before** any
fleet call. Its mechanism is WO-2026-061 (predicate + non-silent failure) and WO-2026-062
(composition, machine block, field validation), both marked DISPATCHED 2026-10-31.

State of that work, probed:

| item | state |
|---|---|
| `decisions/checkpoint/005`, WO-2026-061, WO-2026-062 | landed on `main` 2026-11-04 by WO-2026-073 (was: only on `origin/summary-ownership`) |
| WO-2026-061 implementation | branch `pi-subagent-1566ff09c877`, commit `418490b`: marker predicate before model resolution, stale-ctx-safe `notify`, shared `extensions/lib/checkpoint-marker.ts`, `tests/summary-ownership.test.ts` (600 lines) |
| its test rows | `bun test tests/summary-ownership.test.ts` at that tip: **12 pass, 0 fail**, 1.57 s |
| WO-2026-062 implementation | branch `pi-subagent-34403ce0c69c`, commits `78d356d` (refactor: N sections, one joiner) + `e9b9de8` (verbatim + machine block + field validation); `extensions/lib/checkpoint-summary.ts` new, `checkpoint.ts` +221/−65. Offline rows at that tip: `bun test tests/checkpoint-meta.test.ts tests/checkpoint-recoverability.test.ts` → 24 pass, 0 fail. Its `e2e-checkpoint.test.ts` rows are live-network and were not run here. |
| the two branches | separate lineages from the same base `fd3ee99`: `pi-subagent-1566ff09c877` does not contain 062's commits and `pi-subagent-34403ce0c69c` does not contain 061's `418490b`. They touch disjoint files (`compaction-model.ts` vs `checkpoint.ts` + `lib/`), so they merge in either order, but neither has landed. |

So the behaviour on this box is not an unruled hazard any more; it is a ruling whose carrier never
landed. The F0 control above is what the branch's predicate produces.

## 7. Port audit — what 1.3.0/1.4.0 still needs

`pi-upgrade-2026-10.md` §4/§5 items, each re-probed against the installed 1.4.0 tree.

| item | probe | still needed? |
|---|---|---|
| retried compaction | `compaction.js:488` wraps the single summarization call in `retryAssistantCall` | no |
| truncated-summary refusal | `getSummarizationFailure` (`compaction.js:454-462`) returns a failure on `stopReason === "length"`, `completeSummarization` **throws** (`:533-536`) | no |
| malformed tool-arg rejection | pi-ai `dist/utils/json-parse.js:87-97` throws "Tool arguments must be a JSON object"; `validation.js:282` rejects with the parse error | no |
| `read` label fixes | display-only, shipped in 1.3.0; no extension surface | no |
| `context_with_system` | `rg context_with_system extensions/ tests/` → 0 | no |
| in-scope type mismatch | `ProviderHeaders = Record<string, string \| null>` (pi-ai `dist/types.d.ts:41`) vs `compact(…, headers?: Record<string, string>)`; `compaction-model.ts` forwards `auth.headers` and drops `auth.env` | **yes**, latent — no runtime symptom today (the live call succeeds), no typecheck exists, and the fix belongs to the fleet client surface WO-2026-061 explicitly leaves out of scope. Order: `work-orders/WO-fleet-client-headers-env.md` (draft, numbered at dispatch), blocked on WO-2026-061 landing |

Nothing else in `checkpoint.ts`, `compaction-model.ts`, `lib/read-tracking.ts` or
`lib/checkpoint-meta.ts` needs a port: the first has no removed API (its `agent_settled` trigger,
`deliverAs: "followUp"` and `onError` path are already the 1.3.x shapes), the last two touch no
changed surface. `theme $schema` and `keybindings.json` from §5 were not exercised live here —
this audit did not start a full-config TUI session.

## 8. Draft retirements

| draft | disposition |
|---|---|
| `WO-pi-upgrade-1.3.0.md` | **deleted**. Its premise (npm latest = 1.3.0) is false; the upgrade happened, and the only leftover from its scope is the type/env item now carried by `work-orders/WO-fleet-client-headers-env.md`. Reason recorded in `decisions/checkpoint/004`. |
| `WO-summary-ownership-dispatch.md` | **deleted, superseded**. The owner ruled (`decisions/checkpoint/005`, 2026-10-31) and the ruling's carriers are WO-2026-061/062; this draft's three-column table cannot be dispatched as written because `reason` does not split `/compact` from a checkpoint (both `"manual"`), and its premise "fleet calls fail in this environment" is false on 1.4.0. |
| `WO-drift-decision-record.md` | **restated**, narrowed to the live part: the missing `9925257` record and its disposition column (Q4). The README signature drift and the `checkpoint_search` references it also listed are already fixed in `main` (probe: `rg checkpoint_search README.md agents/` → 0, and `README.md:67-69` describes the two current tools). |

## 9. The four questions

| q | state | citation |
|---|---|---|
| Q1 summary ownership | **answered 2026-10-31**, landed 2026-11-04 — verbatim | `decisions/checkpoint/005` (owner 2026-10-31) |
| Q2 upgrade timing | **stale** — the upgrade happened, twice (1.3.0, then 1.4.0) | installed `package.json` 1.4.0, mtime 2026-10-31T20:17; `settings.json` `lastChangelogVersion: 1.4.0` |
| Q3 uncommitted `auto-checkpoint.ts` WIP | **stale** — the WIP landed as idle compaction with its own record, and the file now imports the shared read-tracking helper (the last duplicate is gone) | `decisions/checkpoint/002` (2026-10-29); `git log --oneline -- extensions/auto-checkpoint.ts` → `edfffd6`, `92307ca`, `40e86b9`, `0c1f1fe`, `aa00a93`; `extensions/auto-checkpoint.ts:77` imports `lib/read-tracking.ts` |
| Q4 `9925257` features removed | **live** — no decision record exists for the removals | `rg -l 9925257 decisions/ docs/` → only the sanity-check investigation; sent to the planning seat |

## 10. Reproduce

```
bash tests/setup.sh                     # links the global pi packages into node_modules
cd ~/Developer/scratch/wo071
REPO=<worktree> WITH_FLEET=1 PROBE_LOG=$PWD/sess-1.log NONCE=PNONCE-F1 bun run.ts   # fleet wins
REPO=<worktree> WITH_FLEET=0 PROBE_LOG=$PWD/sess-0.log NONCE=PNONCE-F0 bun run.ts   # verbatim wins
REPO=<worktree> WITH_FLEET=1 BREAK_FLEET=1 PROBE_LOG=$PWD/sess6.log bun run.ts      # failure: silent fallback
node ~/Developer/scratch/wo071/pair.mjs ~/.pi/agent/sessions                        # production pairs
```

`run.ts` records four artefact classes: `wire_request` (provider URL + `model` + headers),
`model_call` (coding-agent `ModelRuntime` calls — note the compaction call is absent),
`before_compact` / `compact` (hook inputs and the persisted entry), and the session id, so
`x-opencode-session` can be compared against it.
