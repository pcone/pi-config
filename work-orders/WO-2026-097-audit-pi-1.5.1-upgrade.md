# WO-2026-097 — audit pi 1.5.1 before the next upgrade

### Metadata

- **work_order_id**: WO-2026-097
- **routed_to**: orchestrator
- **invariant_exhaustiveness**: explicit
- **estimated_complexity**: large
- **review_policy**: required
- **order_source**: owner, 2026-11-10, relayed by seat `8f90746f` (quote: "dispatch the audit, also I'm good with trying cache warming")

### Task Summary

The box runs pi **1.4.0**; **1.5.1** is a candidate. Audit it in a scratch install and report
green or red. Green means the global upgrade happens at the seat-restart cycle, where every seat
restarts once onto the new guidance and the new pi. Do not upgrade the global install here — the
seat coordinates that.

### Scope

- Install 1.5.1 **in a scratch directory**, never over the global install:
  `npm pack @earendil-works/pi-coding-agent@1.5.1` into a fresh dir under `~/Developer/`.
- Changelog: `~/Developer/notes/pi-1.5.1-dl/package/CHANGELOG.md`.
- Reuse WO-2026-071's method: each claim carries the probe that produced it, and the installed
  `.d.ts` decides, not the changelog.

### What to check

1. **Tool-argument validation moved to `@earendil-works/pi-schema` (1.5.0).** TypeBox features
   outside JSON Schema stop applying. Enumerate every tool schema this repo registers — `rg` the
   tool registrations, then check each schema against the reduced dialect. Peer-link and subagent
   tools are in scope. A schema that silently loses a constraint is the failure mode: find it by
   feeding a value the old constraint rejected.
2. **`GrepOperations.readFile` is no longer called for context lines (1.5.1).** Confirm nothing
   here relies on that call.
3. **OpenAI-compatible models omit `tools: []` (1.5.1).** Confirm no provider path or test depends
   on an empty `tools` array being sent.
4. **The 1.5.0 "tightened system prompt"** against our `APPEND_SYSTEM.md`: does the tightened text
   already say what an appended block says, or contradict it? Name the duplicated or conflicting
   paragraphs; do not rewrite them in this order.
5. **The symlinked-extension dependency fix** — this repo's extensions are symlinked into
   `~/.pi/agent/extensions/`, so state whether the fix changes what resolves on this box.
6. **`pi.exec` SIGKILL and `maxBuffer` changes** against the subagent runner: the runner kills and
   buffers child output, so name the observable difference and whether any harness path depends on
   the old behaviour.
7. **Full suite against 1.5.1.** One run, box-wide slot (`bin/heavy -- …`). Report pass/fail counts
   and every failure with its file and line.

### Cache warming

The owner approves trying `"cacheWarming": "idle"` — 1.5.1's default. Set it **explicitly** in
`~/.pi/agent/settings.json` at upgrade time, so the value is visible rather than implied by the
default. State in the report how its cost is read (the `Cache warmed: $x` lines) so it can be
reviewed after a day.

### Sequencing

Start after WO-2026-092 lands. Report green or red; on red, name each blocker with its probe and
what the fix would touch. Do not change `models.json`, `settings.json` beyond the one
`cacheWarming` key, or `APPEND_SYSTEM.md.sec`.

### Q-097-a (owner question) — the second cache-warming key

The order permits one `settings.json` change at upgrade time (`cacheWarming`). The
2026-11-13 audit found the warmed cost prints only with `showCacheMissNotices: true`
(`settings-defaults.js:27`, default `false`; `addCacheWarmingUsage` returns early
without it). Without it every warm is silent in the transcript, though it still lands
in session cost as a `cache_warm` usage entry.

- **(a)** Set `"cacheWarming": "idle"` and `"showCacheMissNotices": true` at upgrade
  time, so the order's "review after a day" can be done from the transcript.
- **(b)** Set only `cacheWarming` as the order says, and review cache spend from
  session cost (`cache_warm` usage entries) instead.

Recommendation: **(a)** — the review method the order names is otherwise unexecutable,
and the key is display-only. Owner's call; nothing is set here.

### Verification

- Each of items 1–6 has a written finding with the probe that produced it.
- Item 7 has a full-suite result at the 1.5.1 scratch install.
- The report states whether the global upgrade is green, and if red, what each blocker needs.
