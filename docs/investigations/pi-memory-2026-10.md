# pi memory: where it goes and what can be cut (2026-10)

pi 0.83.0, node 25.9.0, `/usr/bin/time -l` peak RSS, one process per measurement.

**Verdict first:** a pi process costs ~180 MB before it reads a session, then
~3× the session's JSONL bytes. Compaction does not give that back. Trimming the
pre-compaction prefix is the only lever that shrinks a session, and it is safe for
the model context but not for in-pi history navigation.

## 1. Measurements

| what | peak RSS |
|---|---|
| `node -e 0` | 47 MB |
| `pi --version` | 154 MB |
| fresh session, no project extensions | 180 MB |
| fresh session, pi-config cwd | 204 MB |
| session 0.7 MB / 11 MB / 61 MB | 216 / 213 / 219–371 MB |
| 61 MB session with a compaction at the tip | 403 MB |

Repeated runs of one session vary by ~40% under load (212 / 279 / 310 / 369 MB for
the same 61 MB file), so single-run comparisons are not evidence. The 61 MB figure
is the median of runs; the ≤11 MB rows sit inside the noise of the 180 MB baseline.

Subagent processes are full pi processes: same baseline plus their own session, so
dispatch parallelism multiplies the cost linearly.

## 2. Mechanism

`SessionManager.fileEntries` holds every parsed entry for the process's life
(`dist/core/session-manager.js:591`, populated by `loadEntriesFromFile`; append-only
via `appendEntry` at :755). Parsed JS objects are ~3× their JSON bytes.

Compaction rebuilds only the *context* (`buildContextEntries`, :191 — entries before
the newest compaction's `firstKeptEntryId` are dropped from what the model sees).
`fileEntries` is untouched, so `/compact`, auto-compaction and checkpoint all leave
RSS where it was — measured: adding a compaction at the tip moved 371 MB to 403 MB.

The TUI adds rendered message components to `chatContainer`
(`modes/interactive/interactive-mode.js:280`) and clears them on compaction
(:2503), so rendered history is bounded by the last compaction, not by the session.

## 3. Rejected: V8 tuning as a session-cost fix

`NODE_OPTIONS=--max-semi-space-size=2` cuts *startup* RSS reproducibly — 6
interleaved runs each: default 160 / 167 / 173 / 183 / 198 / 206 MB vs
--semi-space=2 127 / 129 / 130 / 141 / 143 / 150 MB. It does **not** help a large
session: 4 interleaved runs each on the 61 MB file, default 231 / 279 / 298 / 369 MB
vs 239 / 261 / 312 / 329 MB — indistinguishable. The young generation is not where
the session tree lives.

Kept anyway for the per-process startup saving: `/Users/scott/bin/pi` is a wrapper
that exports the flag and execs `/opt/homebrew/bin/pi`. It is first on PATH, and
subagents spawned via `process.execPath` fall back to `pi` on PATH
(`extensions/subagent-async/index.ts:879`), so they inherit it.

## 4. Trimming the pre-compaction prefix

A 61–127 MB session is almost entirely dead prefix. Latest compaction's retained
tail in the three largest live sessions:

| session | file | entries | compactions | outside retained tail |
|---|---|---|---|---|
| `tfd-d` | 61.0 MB | 24 648 | 112 | 0.4 MB |
| `tfd` | 127.3 MB | 26 882 | 199 | 0.7 MB |
| `tfd-triage` | 100.6 MB | 35 876 | 180 | 0.9 MB |

Landed as `extensions/session-trim.ts` (decision `decisions/sessions/001`): keep the
session header, the entries from `firstKeptEntryId` onward, and the last
`model_change` / `thinking_level_change` / `session_info` re-rooted at the head of
the kept chain (settings and name live outside the kept region, so dropping them
would resume on the wrong model or lose the session's name). Result on `tfd`:

- 127.3 MB → 0.7 MB, 456 of 26 882 entries kept. On `tfd-d`: 61.0 MB → 0.42 MB.
- `buildSessionContext()` identical: same 456 messages, same SHA-256, same
  `thinkingLevel: high`, same `model`. Context is unaffected, as expected.
- Load peak RSS 210 MB → 121 MB (`tfd-d` copy).
- Load does not rewrite or "repair" the trimmed file: hash unchanged, no `.pre-*`
  backup created.

What the prefix is still needed for, none of it model-facing:

- `/tree` navigation, rewind, and fork-from-point into pre-compaction history.
- `--export` HTML.
- Extension reads of `getEntries()` / `getBranch()` (`session-log`, checkpoint's
  file scan, `watch-session.cjs`).
- Two of 24 648 dropped entries in `tfd-d` and 58 of 26 882 in `tfd` are on other
  branches, not ancestors of the leaf; those branches go too.

**Prompt caching.** A trim cannot invalidate a cached prefix: the request body is
unchanged (identical `buildSessionContext()`), and providers key their cache on
request content. pi's own cache accounting detects misses from per-turn `usage` and
idle time (`core/cache-stats.js`), not from the file, and it already treats a
compaction entry as a content reset. What does move is the *tally*: `computeCacheWaste`
and `getUsageCostBreakdown` scan entries, so after a trim the session's waste, token
and cost figures restart at the retained tail — 492 misses / 18.6 M tokens / $30.58
→ 0 / 0 / $0.07 on the `tfd-d` copy. The spend stays in the archive.

**Cross-process hazard.** pi does not lock session files (only auth, settings and
trust are locked). A rewrite is only safe when the writing process is the session's
only writer: a second live pi holding the untrimmed session in memory will append
entries that reference archived ids, and its next compaction then loses its own
retained tail. So trimming belongs in the owning process, and a bulk sweep needs
pi closed.

## 5. Disk

`~/.pi/agent/sessions` was 2.6 GB over 3 804 files, including 157 MB of
`.pre-orphan-repair-*` / `.pre-envelope-fix-*` full-file backups from October's
repair work. Backups moved to `~/.pi/agent/sessions-archive/backups/` (2.5 GB
remains). Session files are append-only, so the same prefix waste that costs RSS at
load costs disk forever.
