# WO-2026-101 — the harness re-invokes pi with a runtime that cannot host it

### Metadata

- **work_order_id**: WO-2026-101
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit
- **estimated_complexity**: small
- **review_policy**: required
- **order_source**: gh #15 (owner-relayed 2026-11-14: "Reserve a WO and diagnose first. Is the fault in the test or in the extension? Show the probe that tells those two apart, before any fix."), diagnosis below.

### Premise (established, with the probe)

gh #15 blamed the extension's pre-prompt `get_state` persistence. The diagnosis says
otherwise, and the probe separates the two:

```
bun  <pi>/dist/bundle/cli.js --mode rpc --session-id …   → TypeError: webidl.util.markAsUncloneable
                                                            is not a function   (undici CacheStorage)
node <pi>/dist/bundle/cli.js --mode rpc --session-id …   → {"id":1,"response",…,"success":true,
                                                            "data":{… "sessionFile": …}}
```

`getPiInvocation` (`extensions/subagent-async/index.ts:816`) re-invokes
`process.argv[1]` with `process.execPath`. Under `bun test` that is
`bun <testfile> --mode rpc …`, which is why the tests patch `argv[1]` to pi's JS entry
(`tests/subagent-model-inheritance.test.ts:257-258`) — but the *interpreter* is still
bun, and pi 1.5.1's bundle needs Node APIs bun 1.3.11 does not have. The child dies at
startup: no `get_state` answer, no `sessionFile` in meta, `close: code=1 … turns=0`.
At 1.4.0 the same invocation started, which is why the row was green before the upgrade
and why the fault looks like the extension.

So: the extension's `get_state` handling is correct; the harness picks a runtime that
cannot run pi.

### Scope

`getPiInvocation` only. The rule it must express: **re-invoke pi on a runtime that can
host it.**

- `process.execPath` is not a generic runtime (a standalone pi binary) → run it.
- execPath is `node` → re-invoke `argv[1]` with it (same install, supported runtime).
- execPath is `bun` → spawn `pi` from `PATH`; pi's engines say `node>=22.19.0` and the
  probe above shows bun cannot start the 1.5.1 bundle.

Add injectable inputs (`{ execPath?, argv1? }`) so both arms can be driven in a test;
existing callers are unchanged. No new user-facing surface.

### Acceptance rows

1. **bun as the host picks `pi` from PATH**, even when `argv[1]` exists and is a real
   file. Red today: the current code returns `{bun, [argv1, …]}`.
2. **node as the host keeps the same-install re-invocation** `{node, [argv1, …]}`, so
   the fix does not change production's default path.
3. **A standalone pi binary is run directly** (`execPath` not generic), argv[1]
   ignored.
4. **The e2e symptom:** `tests/subagent-model-inheritance.test.ts` "keeps the recorded
   model on resume" passes, and with it the `subagent-boundary-hermeticity` row that
   derives from it. This is the row that cannot be faked by the unit rows.

### Sequencing

Standalone, one file. The doc half (gh #15's `get_state`-persistence theory) is
corrected in the same landing: the investigation section that says "record which" now
records it.

### Verification

- Rows 1-3 red before the change for the reason each names.
- Row 4: the full suite on the upgraded install (pi 1.5.1) at **0 fail** — the two
  permanently red rows are this order's done condition.
- `bin/heavy -- bun test` once, at the end.
