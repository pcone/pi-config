# pi 1.5.1 audit (2026-11-10)

WO-2026-097. Candidate 1.5.1 against the box's 1.4.0, in a scratch install. Method
as WO-2026-071: every claim carries the probe that produced it, and the installed
tree decides, not the changelog.

**Verdict: GREEN.** Nothing blocks the upgrade. Four follow-ups, none of them a
reason to stay on 1.4.0: soft-typed arguments after the pi-schema move (§1), the
warmed-cache cost needing a second settings key (§ Cache warming, owner question
`Q-097-a`), `fetch_url.headers` accepting a scalar (§1), and the subagent runner's
SIGKILL fallback that cannot fire (§6, carried by **WO-2026-100**).

## 1. Tool-argument validation moved to `@earendil-works/pi-schema`

**Inventory.** `rg -n 'registerTool\(' extensions/ | wc -l` → **18** sites. Two are
not loaded: `extensions/subagent/_index.ts.off` (renamed off) and
`extensions/worktree-guard.ts`, which registers only when `PI_SUBAGENT_WORKTREE` or
`PI_SUBAGENT_PARENT_CWD` is set (5 wrapped built-ins, `worktree-guard.ts:320`, registered at `:325`). The remaining 16
reach the validator through five of the 15 `settings.json` entries (14 from the
checkout plus `~/.pi/local-extensions/session-icon.ts`):

| extension | tools |
|---|---|
| `subagent-async/index.ts` | `subagent`, `subagent_status`, `subagent_review_status`, `subagent_resume`, `wait`, `subagent_steer`, `subagent_stop`, `subagent_kill` |
| `peer-link/index.ts` | `peer_list`, `peer_send` |
| `checkpoint.ts` | `checkpoint`, `checkpoint_fork` |
| `lib/waits.ts` | `wait_for` |
| `fetch-url.ts`, `kagi-search.ts`, `session-name.ts` | `fetch_url`, `kagi_search`, `session_by_name` |

Probe: a stub `ExtensionAPI` that records `registerTool`, then each extension's
default export (`~/Developer/notes/pi151-audit/enumerate-tools.ts`, run with
`PI_SUBAGENT_WORKTREE=1` — without it the guard does not register and the same
command prints 16 names) → `{"tools":[...,21 names...]}`, i.e. 16 repo tools plus `read`, `write`, `edit`,
`find`, `grep` from the guard. `fetch_url` is not in `settings.json`: it loads from
the auto-scanned `~/.pi/agent/extensions/` (§5), so it is in scope.

**TypeBox features used.** Over the 16 repo schemas: `Type.Union` over
`Type.Literal` → `anyOf`+`const` (2 `anyOf`, 7 `const`), `minLength: 1`
(`subagent_resume.session_id`), `minimum`/`maximum` (`wait.seconds` 1–600,
`kagi_search.limit` 1–20), `Type.Optional`, `Type.Object`, `Type.Array`. Every one
is JSON-Schema-expressible. No `Type.Refine`, `Type.BigInt`, `Type.Undefined`,
codec, or `Format.Set` anywhere (`rg -n 'Type\.(Refine|BigInt|Undefined|Codec|Void|Transform)\(' extensions/` → 0).
So no constraint of ours is lost by being unrepresentable: 1.5.1's
`docs/extensions.md#tool-parameter-schemas-and-typebox` lists exactly the features
that stop applying, and we use none.

**What does change: coercion, and three constraints stop rejecting.**

Probe: `~/Developer/notes/pi151-audit/schema-diff.ts` — 1.4.0's
`pi-ai/dist/utils/validation.js` (`Compile` + `Value.Convert`, TypeBox kinds intact)
against 1.5.1's (pi-schema `compile(schema, {coerce: true, unresolvedRefs: "reject"})`),
fed 747 generated probes over the 21 schemas:

```
21 tools … 38 differences over 747 probes
DIFF subagent_resume · session_id = null
     1.4.0: reject: - session_id: must not have fewer than 1 characters
     1.5.1: accept {"session_id":"null","task":"x"}
DIFF subagent · silenceTimeoutMs = empty string (optional)
     1.4.0: reject: - silenceTimeoutMs: must be number
     1.5.1: accept {"agent":"x","task":"x","silenceTimeoutMs":0}
DIFF subagent · turn_cap = empty string (optional)
     1.4.0: reject; 1.5.1: accept {"turn_cap":0}
DIFF kagi_search · limit = float 3.5 (optional)
     1.4.0: reject: - limit: must be integer
     1.5.1: accept {"query":"x","limit":3}
DIFF fetch_url · headers = "solo" (optional)
     1.4.0: reject: - headers: must be array
     1.5.1: accept {"url":"x","headers":["solo"]}
```

Three classes, all documented in pi-schema's README §Coercion, none of them a
TypeBox-kind loss:

1. **`null` for a required string becomes the string `"null"`, not `""`** ("pass 2
   wins: `null` for a required string becomes `"null"`, not `""`"). This is class
   1's one lost rejection (class 2 loses eight more; see below): `subagent_resume.session_id` declares `minLength: 1`, and a
   `null` argument now passes validation and fails later in id resolution, as a
   worse message. Same shape on `subagent.agent`/`task`, `peer_send.to`/`message`,
   `session_by_name.friendlyName`, `checkpoint_fork.newCwd`, and pi's own
   `write.content` (`null` → a 4-byte file body `null`).
2. **`""` for a number becomes `0`** ("numeric strings (`""` is 0)"). On
   `subagent.silenceTimeoutMs` and `subagent.turn_cap`, `0` means "disabled" in the
   schema's own text, so an `""` that 1.4.0 rejected now silently turns the silence
   timeout or the turn cap off.
3. **`integer` truncates floats, `array` wraps a single value** (`3.5`→`3`,
   `"solo"`→`["solo"]`).

Bounds still bite: `wait.seconds = 0` and `kagi_search.limit = 0` are rejected in
both, and a non-member of a `Type.Literal` union is rejected in both. `peer_list`'s
`Type.Object({})` accepts anything in both (JSON Schema default:
`additionalProperties` is permissive and neither validator closes the object).

**Finding.** No constraint silently stops applying through a TypeBox feature
outside JSON Schema, because we use none. Three classes of constraint at the *type*
boundary softened: eighteen rejections in total (one, eight and nine), of which the
`null` `session_id` is a lost rejection rather than a wrong result. Follow-up, not a
blocker; see § Verdict.

## 2. `GrepOperations.readFile` is no longer called

```
$ rg -n 'readFile' extensions/ | rg -i grep | wc -l
0
$ rg -n 'GrepOperations|createGrepTool' extensions/ tests/
extensions/worktree-guard.ts:34:  createGrepTool,   (import)
extensions/worktree-guard.ts:320:  ["grep", createGrepTool(localCwd)],
```

Nothing here sets `readFile`, or `isDirectory`, or any `operations`. The guard
constructs the tool with a cwd only and wraps `execute`, which is the replacement
1.5.1 prescribes for remote search.

1.5.1's `dist/core/tools/grep.d.ts` keeps two members:

```ts
isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
/** @deprecated Ignored. Context lines come directly from ripgrep. ... */
readFile?: (absolutePath: string) => Promise<string> | string;
```

`readFile` becomes optional *and* ignored, so a path that relied on it would not
fail to compile or throw: `grep` with `context` would silently return matches with
no context lines. No such path exists here. The associated 1.5.1 fixes (grep `glob`
now relative to `path`, `limit: 0` meaning 1, no match-limit notice at exactly
`limit`) touch no caller here either: `rg -n 'glob:|context:' tests/` → 0.

## 3. OpenAI-compatible models omit `tools: []`

**No provider completion body is built in this repo.** Every model call goes
through pi's runtime; the only `api: "openai-completions"` mentions are model
*descriptors* in two tests, never an outbound payload. Two HTTP bodies are built
elsewhere — `kagi-search.ts:161` (`body: JSON.stringify(body)`) and the quota
probes — and neither is a completion request:

```
$ rg -n 'openai-completions' tests/
tests/model-error-mail.test.ts:468,783,795,845   (assistant message events)
tests/summary-ownership.test.ts:258,1028,1049    (Model<Api> fixture + assertions on model.api)
$ rg -n 'tools: \[\]' tests/ extensions/
7 in tests/, 4 in extensions/subagent-async/test-resume.cjs
```

Those `tools: []` are the subagent's tool-restriction list
(`buildSubagentArgs({ tools: [] })`, `SpawnMetaFields.tools`), not provider
arguments.

**No `models.json` model needs `compat.requiresToolsWithToolHistory`** (file read,
not edited): `models.json` declares one provider, `openrouter`, with
`modelOverrides` only; `rg -n '"compat"' models.json` → 3, all
`{"openRouterRouting": …}`. The change does apply to this box's traffic —
`openrouter` is an OpenAI-compatible provider, and 1.4.0 set `params.tools = []`
for any session with tool history while 1.5.1 omits it unless
`compat.requiresToolsWithToolHistory` is set. Nothing here depends on the empty
array, so the omission is safe: 1.5.1 drops a field the endpoint here never
required. The flag has no caller, and a LiteLLM-style gateway added under
`providers` later is the model that would need it.

## 4. The 1.5.0 tightened system prompt vs `APPEND_SYSTEM.md`

Probe: `diff -u` of `dist/core/system-prompt.js`, global 1.4.0 against 1.5.1. The
whole delta is **one hunk: six lines removed, five added** (the sixth pair is
cosmetic, `pi packages` → `packages` inside the docs list):

```
- "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by
-  reading files, executing commands, editing code, and writing new files."
+ "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files,
+  run commands, and modify code."
- "${tools}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project."
+ "${tools}\n\nAdditional tools may be available."
- "Pi documentation (read only when the user asks about pi itself, …)"
+ "Pi documentation (read only when the user asks about the harness itself, …)"
- "- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing"
- "- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)"
+ "- Before implementing harness changes, read the relevant docs and examples in full, following related
+  cross-references."
```

**Duplicated paragraph.** `APPEND_SYSTEM.md:23` "Read the relevant docs before
implementing, and keep them current." and the new base line both order the same
thing. They do not conflict: the base scopes itself to *harness* changes and pi's
own docs; ours scopes to the project's `docs/` and `decisions/` and adds "keep them
current", which the base does not say. Nothing to rewrite: the addendum is stricter
where it overlaps, and the overlap is one sentence out of 178 lines.

**Contradiction.** None. The base's "read only when the user asks about the harness
itself" is a limit on proactively reading pi's packaged docs; `APPEND_SYSTEM.md` and
`rules/` say nothing about those. `rules/work-order-numbering.md` and
`rules/writing-rules.md` are about work-order ids and prose, and neither mentions
docs-reading or the tools list: `rg -n 'read the relevant docs|docs and examples|before implementing' rules/ APPEND_SYSTEM.md`
→ `APPEND_SYSTEM.md:23` only.

**Removed wording is unreferenced.** `rg -n 'other custom tools depending|Always read pi .md|When working on pi topics' --glob '!node_modules' --glob '!docs/investigations/pi-1.5.1-audit.md' .`
→ 0 hits; the only three are this report's own quotations.

## 5. Symlinked-extension dependency fix

**The change.** 1.5.1's loader imports the entry through its real path:
`dist/core/extensions/loader.js` `jiti.import(canonicalizePath(extensionPath), { default: true })`
(`canonicalizePath` = `realpathSync`, `dist/utils/paths.js:15`). 1.4.0 passes
`extensionPath` raw.

**Most of this box's extensions load through a symlink, one does not.** Probe over
`settings.json`'s `extensions` list — `realpath(entry) == entry`, per entry:

```
entries 15  symlinked 14  real 1
NOT SYMLINKED: /Users/scott/.pi/local-extensions/session-icon.ts
agent/extensions is symlink: True -> /Users/scott/Developer/pi-config/extensions
baba: True
```

`~/.pi/agent/extensions` is itself a symlink to the checkout, so every auto-scanned
file under it also resolves through one. The exception is `session-icon.ts`: a real
file in a real directory, listed in `settings.json`, where `canonicalizePath` is a
no-op. The loader's own probe (`DefaultResourceLoader`, 1.5.1, agentDir
`~/.pi/agent`, cwd the parent checkout) loads 24 extensions, 23 of them through a
symlink, and errors 0.

So the fix is on the path for 23 of the 24. The finding below ("no file-level
symlink") is unaffected: `session-icon.ts` is not a symlink at all.

**What resolves does not change.** For the symlinked entries, the dependency lookup
still lands in the same
directory, because the intermediate path component is itself the symlink: probing
the two forms with jiti 2.7.0 (the version both installs ship):

```
entry          : /Users/scott/.pi/agent/extensions/fetch-url.ts
entry realpath : /Users/scott/Developer/pi-config/extensions/fetch-url.ts
1.4.0 (raw symlinked path): turndown -> /Users/scott/Developer/pi-config/extensions/node_modules/turndown/lib/turndown.cjs.js
1.5.1 (canonicalizePath)  : turndown -> /Users/scott/Developer/pi-config/extensions/node_modules/turndown/lib/turndown.cjs.js
(same for linkedom; for baba's entry, same for zod)
```

`/Users/scott/.pi/agent/extensions/node_modules` resolves through the directory
symlink to the checkout's `extensions/node_modules`, so both forms see it.

**Positive control, so the probe is not vacuous.** A *file-level* symlink into a
directory with no `node_modules` — the shape #8112 fixed — differs, under node:

```
entry: ~/Developer/notes/pi151-audit/symctl/loaddir/fetch-url.ts  (a symlink to the extension)
1.4.0 (raw symlinked path): turndown FAILED: MODULE_NOT_FOUND
1.5.1 (canonicalizePath)  : turndown -> /Users/scott/Developer/pi-config/extensions/node_modules/turndown/lib/turndown.cjs.js
```

**Finding.** This box has no extension loaded through a file-level symlink — only
the `extensions` directory and the `baba` directory, both of which keep resolving
through the symlink. The fix changes nothing here. It becomes load-bearing the day
an extension file itself is symlinked out of the checkout.

## 6. `pi.exec` SIGKILL and `maxBuffer` vs the subagent runner

**No harness path uses `pi.exec`.** The two call sites are `fetch_url`'s curl
invocations (`extensions/fetch-url.ts:409`, `:455`):

```
$ rg -n 'pi\.exec\(' extensions/ --glob '*.ts'
extensions/fetch-url.ts:409:  const result = await pi.exec("curl", args, { cwd: ctx.cwd, signal });
extensions/fetch-url.ts:455:  const pdfResult = await pi.exec("curl", pdfArgs, { cwd: ctx.cwd, signal })
```

The runner spawns its children itself with `node:child_process`: `spawn.ts:311`
(`spawn(invocation.command, …)`), the kill path in `sleep-guard.ts:199–263`
(`dispatchKillSignals`, which sends SIGTERM then arms a SIGKILL after
`HARD_KILL_DELAY_MS`), output
buffering in the same files, and `turn-cap.ts:57` / `lib/git-run.ts:46` on
`execFile`. Spawn, kill, output buffer and turn cap are therefore untouched.

**Observable differences** (1.5.1 `dist/core/exec.js` against 1.4.0's), for
`fetch_url` only:

- **SIGKILL now fires.** 1.4.0's force-kill guard was `!proc.killed`, which is
  already false right after a successful `proc.kill("SIGTERM")`, so the SIGKILL
  never happened and a child that ignored SIGTERM hung the promise forever. 1.5.1
  checks `exitCode === null && signalCode === null` and kills 5 s later. Effect
  here: an aborted `fetch_url` whose curl ignores SIGTERM now ends in ~5 s instead
  of hanging until pi exits.
- **Output is capped** at `min(256 MiB, MAX_STRING_LENGTH)` (`maxBuffer`
  overridable), with `truncated: true` and a nonzero `code`; 1.4.0 was unbounded and
  crashed with `RangeError: Invalid string length` past the string limit. `fetch_url`
  already caps the download itself (`--max-filesize 52428800`, 50 MiB), so the pi
  cap is not reachable there.
- **A spawn failure reports its stderr** instead of empty; and stdout/stderr decode
  through a `StringDecoder`, so a UTF-8 character split between chunks survives.

`ExecOptions`/`ExecResult` gain `maxBuffer`/`truncated`; `signal` and `timeout` are
unchanged, and `fetch_url` passes `signal` only.

**The runner's own escalation had the same defect, and the upgrade did not fix it.**
Until WO-2026-100, `sleep-guard.ts` guarded its SIGKILL with
`if (rs.proc && !rs.proc.killed && rs.proc.exitCode === null)` (`:241` is that guard's
`alreadyDead` sibling, `:257` the SIGKILL).
Node sets `killed = true` on a successful `kill()`, so after the SIGTERM the guard
was false and the SIGKILL never fired — the same shape as 1.4.0's `exec.js` bug just
described, measured on this box (`killed=true, exitCode=null, signalCode=null` after
the SIGTERM). A subagent that ignored SIGTERM therefore never hard-killed; it hung
until the process group or the turn cap ended it. Pre-existing, not upgrade-caused,
and out of this order's scope: nothing in 1.5.1 changes it either way. Carried by
**WO-2026-100**.

> **Fixed, WO-2026-100.** `dispatchKillSignals` and `subagent_stop`'s force-kill
> fallback now test `exitCode === null && signalCode === null` (`stillRunning`,
> `extensions/subagent-async/sleep-guard.ts`), so the SIGKILL fires on a child
> that ignores SIGTERM. `tests/subagent-async-kill.test.ts` R1–R4 drive real node
> children; R5 is a stub handle with a throwing `kill()`.
>
> The order's scope was every site in `extensions/subagent-async/` that decides
> liveness from `proc.killed`. `rg -n '\.killed' extensions/` returns 45 hits in
> six files; the ones that ask whether a *process handle* is alive, rather than
> reading the runner's own `killedExplicitly`/`killedVia` bookkeeping or the
> `OUTCOME_WORD.killed` vocabulary, are these:
>
> | site | verdict |
> | --- | --- |
> | `sleep-guard.ts:241` — `alreadyDead` for the dispatch | **Was the defect.** `rs.proc.killed \|\| rs.proc.exitCode !== null` read a SIGTERM'd live child (`killed=true, exitCode=null, signalCode=null`) as dead, so `subagent_kill` inside `subagent_stop`'s 5 s window reported “already dead” and armed no escalation of its own. Now `!stillRunning(rs.proc)`. |
> | `sleep-guard.ts:257` — the delayed SIGKILL's guard | Fixed with the order: `stillRunning(proc)`, was `proc && !proc.killed && proc.exitCode === null`. |
> | `index.ts:2196` — `subagent_stop`'s own force-kill fallback | Fixed with the order: `stillRunning(rs.proc)`, was `rs.proc && !rs.proc.killed`. |
> | `test-progress-kill-timeout.cjs:175,179` — the mirror's copies of both | Same verdict as their originals: `alreadyDead` is now `!stillRunning`, and `stillRunning` keeps the real helper's `proc !== null` guard. |
> | `test-progress-kill-timeout.cjs:222` — the mirror's proc stub | Writes `killed = true` on any signal, which is what Node does; it is the stub's fidelity, not a liveness read. |
> | `spawn.ts:623`, `index.ts:2238–2240`, `sleep-guard.ts:173,203,204,309,342,353,365,366,368,370` | Not a liveness read: `killedExplicitly`/`killedVia` are the runner's own intent flags, and `OUTCOME_WORD.killed` is footer vocabulary. No verdict needed. |
> | `extensions/lib/git-run.ts:59` — `(err as {killed?}).killed` | Different mechanism: `execFile`'s own timeout flag on an `ExecException`, not a `ChildProcess` liveness read. Out of this order's scope. |
> | `extensions/subagent/_index.ts.off:459` — `if (!proc.killed) proc.kill("SIGKILL")` | The same defect in a dead file: `.off`, never compiled or imported. Left untouched; deleting the file is separate work. |

## 7. Full suite against 1.5.1

```
$ ~/Developer/pi-config/bin/heavy -- bun test         # cwd = this worktree, HEAD 4933b82
 1506 pass
 2 fail
 12067 expect() calls
Ran 1508 tests across 78 files. [476.34s]
```

Failures, both pre-existing at 1.4.0:

- `tests/subagent-model-inheritance.test.ts:493` —
  `expect(sessionFile).toBeTruthy()` receives `undefined` ("keeps the recorded model
  on resume, even when the resuming caller runs another model"). Red at 1.4.0 with
  the four symlinks pointed back at the global install: `bun test
  tests/subagent-model-inheritance.test.ts` → `15 pass / 1 fail`, same line, and red
  in the 1.4.0 full run below.
- `tests/subagent-boundary-hermeticity.test.ts:379` — derived, not independent. The
  row re-runs the 45 gate-sensitive files as a child `bun test` and fails when that
  child is not green. The 1.5.1 child report is `789 pass / 2 fail` over 791 tests,
  45 files (`~/Developer/notes/pi151-audit/suite-1.5.1.log:48`): the row above
  (`:30`) and `tests/subagent-worktree-lock.test.ts:797` (`:46`). The 1.4.0 child
  is `790 pass / 1 fail`, model-inheritance:493 only
  (`suite-1.4.0.log:29`). The derivation holds on the cleaner 1.4.0 child: this row
  is red whenever model-inheritance:493 is red, at either version.

Baseline at 1.4.0, same worktree, same lane:

```
$ ~/Developer/pi-config/bin/heavy -- bun test
 1501 pass
 7 fail
 1 error
Ran 1508 tests across 78 files. [661.47s]
```

Its seven failures are the two shared rows above, four `tests/e2e-checkpoint.test.ts`
rows -- "reads haystack files and finds needles in read regions" (60 s timeout),
"triggers checkpoint and compaction succeeds with file injection" (`:328`), "agent
answers from injected context without tools" (`:365`), "sibling tool in the same
turn" (150 s timeout) -- and `tests/subagent-worktree-lock.test.ts:797` (next
paragraph); plus one `Unhandled error between tests` at `:319`.

None of the five reproduced at 1.5.1. **Cause not established.** The 185 s excess is
accounted for by the 60 s and 150 s timeouts themselves, while 1.5.1's hermeticity
child ran 32 s *slower* (166.09 s against 133.76 s), and the only load record in
either capture points the other way: the 1.5.1 run waited ~4 minutes for the
box-wide slot, held by another project's run (`suite-1.5.1.log:1-3`), and the 1.4.0
run waited not at all. So: not a 1.4.0 regression, and not shown to be load either.
If the upgrade turns up an `e2e-checkpoint` timeout, this baseline cannot say
whether it is new.

`tests/subagent-worktree-lock.test.ts:797` also appeared red in two of the four
suite runs (the 1.4.0 full run, and the child run inside 1.5.1's hermeticity row)
and green in the other two: the 1.4.0 child and the 1.5.1 outer run. Not a version
difference: it is red at 1.4.0 and
green at 1.5.1's top level, and `bun test tests/subagent-worktree-lock.test.ts` is
`29 pass / 0 fail` standalone at 1.4.0 (reproduced 2026-11-13); no 1.5.1 standalone
run was captured, so that figure rests on the outer run.

**Load-sensitive test, mechanism unproven.** The tree it waits for and the branch it
then reads are removed by two separate steps: the reap runs fire-and-forget from
`session_start` (`extensions/subagent-async/index.ts:1140`, its `.catch()` at `:1150`), the
row waits for the tree (`tests/subagent-worktree-lock.test.ts:793`) and then samples
the branch with no wait (`:797`), and the branch delete follows
`disposeWorktreeBuildOutput`. A sampler that catches the gap between them fails
exactly as observed: tree gone, `worktreeEntry` null, branch still present. A
cross-process collision is not possible — each run gets its own `mkdtempSync` repo
and home (`:46`, `:80`), and the fixed branch name lives inside that private repo.
Neither mechanism is pinned; the row wants a `waitFor` on the branch, which is a
test fix and not this order's.

78 files rather than 45: 45 is the gate-sensitive subset —
`gateSensitiveTestFiles()` walks `tests/` only
(`tests/subagent-boundary-hermeticity.test.ts:332`). The suite's 78 are 68 under
`tests/`, 5 under `apps/changelog-gen`, 4 under `baba-pi/test` (reached through the
auto-scanned extension; the log prints only `daemon.test.ts` because the others
print nothing) and `extensions/worktree-guard.test.mjs`. Both runs show 78 files and
1508 tests, so the baba inclusion is not a 1.5.1 difference.

## Cache warming

Ready at the upgrade, not set here.

- **1.5.1's default is `"idle"`**: `dist/core/settings-defaults.js:60`
  `cacheWarming: "idle"`; `docs/settings.md:21` — `"off" | "streaming" | "idle"`,
  default `"idle"`, "Global setting only". `"idle"` keeps an eligible prompt cache
  warm for up to 30 minutes between runs, but only when the refresh is expected to
  pay for itself; `"streaming"` reproduces 1.4.0's behaviour.
- **Where the key goes**: top level of `~/.pi/agent/settings.json` (on this box a
  symlink to the checkout's `settings.json`), beside `defaultModel`/`theme`.
  Global-only, so a project `.pi/settings.json` entry does nothing.
- **How the cost is read**: `formatCacheWarmingUsage`
  (`dist/core/cache-warmer.js:273`) renders `Cache warmed: $<cost>`, `cost` being
  `toFixed(6)` with trailing zeros trimmed. Consecutive warms do **not** print one
  line each: `addCacheWarmingUsage` in
  `dist/modes/interactive/interactive-mode.js` adds to the previous line's total
  while the last chat child is that same notice and the note matches
  (`previous.total.cost += entry.usage.cost.total`), so what accumulates is
  **one cumulative line**, `Cache warmed: $<total>` — the running total since the
  last ordinary chat output, not the cost of the latest warm.
- **It only prints with `showCacheMissNotices: true`.** That setting defaults to
  `false` (`settings-defaults.js:27`; `docs/settings.md:20` -- "Show notices for
  significant cache misses, successful cache warming, compaction usage, and
  provider recovery"), and `addCacheWarmingUsage` returns early without it. The box's `settings.json` does not set it, so `cacheWarming: "idle"`
  alone warms silently. Each warm is still persisted as a `usage` entry of kind
  `cache_warm` (`sessionManager.appendUsage("cache_warm", …)`), so it lands in
  session cost either way. Visibility needs both keys:
  `"cacheWarming": "idle"` and `"showCacheMissNotices": true`.
- **`/session` reports why nothing warmed** (`formatCacheWarmingStatus`):
  `Inactive (cache economics unavailable)`, `scheduled`/`refreshing` with the
  expected savings against `CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS`, or
  `Stopped (…)` naming the reason. A model with no prompt-cache TTL for the active
  tier is never eligible (`docs/models.md:112`), which is where to look first if no
  line ever appears.

## Verdict

**GREEN — upgrade.** No item in this audit produces a wrong result, a crash, or a
constraint that matters going quiet. The suite is no redder than at 1.4.0 (it is
less red: 2 failures against 7), and both failures reproduce at 1.4.0.

Follow-ups, in order of what would bite first. None blocks the upgrade:

1. **Soft arguments in `subagent_*` (§1).** A `null` `session_id` now passes
   validation as `"null"`; `""` for `silenceTimeoutMs`/`turn_cap` becomes `0`, which
   the schema documents as "disabled". Fix would touch `extensions/subagent-async/index.ts:1839–1845`
   (`ResumeParams.session_id`, the headline case), `:1382` (`silenceTimeoutMs`) and
   `:1388` (`turn_cap`), or a guard in `execute`, plus a row in
   `tests/subagent-id-resolution.test.ts`. Follow-up.
2. **Warmed-cache cost invisible to the transcript (§ Cache warming).** Owner
   question `Q-097-a` in the work order: the order permits one settings key and the
   line needs a second. Options there are (a) add `"showCacheMissNotices": true`
   beside `"cacheWarming": "idle"` at upgrade time, so the transcript can be read
   after a day, or (b) keep the single key and review spend from the `cache_warm`
   usage entries. Recommendation (a); the owner decides, and nothing is set here.
3. **`fetch_url.headers` accepts a scalar (§1).** `"Accept: x"` wraps to a one-item
   array and works; `123` wraps to `["123"]` and curl rejects it with a murkier
   message than 1.4.0's. Not worth a schema change on its own.

## Provenance

- Scratch install: `npm i --prefix ~/Developer/notes/pi151-install
  @earendil-works/pi-coding-agent@1.5.1` → `pi-coding-agent`, `pi-agent-core`,
  `pi-ai`, `pi-tui`, `pi-schema` all 1.5.1.
- **The global install was not touched**: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/package.json`
  reads `1.4.0` before and after every run.
- The worktree's `node_modules` is a copy of the parent checkout's (gitignored); only
  the four `@earendil-works/*` symlinks were repointed for the 1.5.1 run. `typebox`
  stayed on the global copy because both installs ship 1.3.27 with identical trees
  (`diff -rq` → empty).
- 1.5.1 run, `readlink` at run time (HEAD `4933b82`):
  `pi-coding-agent -> /Users/scott/Developer/notes/pi151-install/node_modules/@earendil-works/pi-coding-agent`
  `pi-agent-core -> …/notes/pi151-install/node_modules/@earendil-works/pi-agent-core`
  `pi-ai -> …/notes/pi151-install/node_modules/@earendil-works/pi-ai`
  `pi-tui -> …/notes/pi151-install/node_modules/@earendil-works/pi-tui`
- 1.4.0 baseline run, `readlink` at run time (same HEAD): all four point into
  `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`.
- Probe scripts and both full-suite logs: `~/Developer/notes/pi151-audit/`
  (`enumerate-tools.ts`, `schema-diff.ts`, `tool-schemas.json`, `suite-1.5.1.log`,
  `suite-1.4.0.log`, `run-*-provenance.txt`, `symctl/` for the file-level symlink
  control). The loader and jiti probes were one-off scripts and were not preserved;
  those claims were re-derived here (`DefaultResourceLoader` + `reload()` +
  `getExtensions()` for the 24/23 split) but are **not** re-derivable from this doc
  alone, and the filesystem probe in §5 is the `realpath` loop printed there.
- No `models.json`, `settings.json`, `APPEND_SYSTEM.md.sec` or global install change
  was made or is proposed here.
