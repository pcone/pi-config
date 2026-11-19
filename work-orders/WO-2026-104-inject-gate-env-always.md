# WO-2026-104 — the gate env is injected into every suite run

> **Lane**: pi-config, test harness. Closes pi-config#22.

### Metadata

- **work_order_id**: WO-2026-104
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit — the row list below is the dimension
- **priority**: normal
- **estimated_complexity**: small
- **review_policy**: required
- **order_source**: owner ruling 2026-11-20 recorded on pi-config#22: "300s for a single test
  isn't really acceptable, we need to work out how we could get mostly equivalent coverage with
  less runtime"; then "Yes, inject always (Recommended)".

### Task Summary

`tests/subagent-boundary-hermeticity.test.ts` spawned a child `bun test` over a derived set of
gate-sensitive files under a replicated harness env. It cost **292 s against a 300 s cap** alone
on a warm box, timed out at any other load, and grew with every file that gained a spawn site.
Its purpose — the suite's verdict does not depend on the invocation context's
`PI_SUBAGENT_ALLOWLIST` / `PI_SUBAGENT_DEPTH` / `PI_IS_SUBAGENT` — is satisfied better by
injecting those vars into every run: every file is then checked, not a derived subset, and the
check costs nothing.

### Change

- `.env.test` at the repo root carries the three vars at the harness's values. `bun test` sets
  `NODE_ENV=test` and loads the file into the env snapshot taken at process start, which is the
  snapshot a child spawned without `env` receives — so the values reach spawns, not only
  in-process readers. A real environment variable wins, so a subagent's own run is unchanged.
- `childEnv()` deletes `NODE_ENV`. A bun child started in the repo with `NODE_ENV=test` set
  re-reads `.env.test` into its own snapshot and the three vars return after the parent
  scrubbed them; the owner-asks print-mode row went red that way.
- Row 1 (the child run) is deleted with its machinery: the derived set, the module-graph
  resolver, the child spawn. The header is rewritten to the new mechanism.
- Rows kept: the static spawn-env row and its detector self-test.
- Rows added: the run carries the injected vars (vacuity guard); `childEnv()` drops `NODE_ENV`;
  every file that makes billed model calls scrubs the gate env.
- The billed-call detector replaces the `createAgentSession`-only live filter, which missed
  turn-cap's four E rows — they spawn a real `pi` and make billed calls (2026-11-07). It matches
  `createAgentSession`, `PI_BIN` and the stand-in shims, and turn-cap is named in the row so the
  miss cannot come back. `tests/e2e-idle-compaction.test.ts` and `tests/peer-link.test.ts` made
  billed calls without scrubbing; they now scrub at module level like their siblings.

### Verification

Suite: **1585 pass / 0 fail** under injection (1583 rows before; −1 deleted, +3 added).

The file itself: **292 s → 0.39 / 0.43 / 0.38 s** over three runs. Suite wall 2046 s at load 41
— load-dominated and not comparable to the 205–365 s figures in
`~/Developer/notes/hermeticity/report.md` (loads 12–149); the change removes the suite's only
nested `bun test` and starts no process of its own, so the suite's work strictly decreases.

Mutations, each run against its own row:

| mutation | row | result |
|---|---|---|
| `.env.test` moved away | carries the injected env | **red** |
| `delete env.NODE_ENV` removed from `childEnv()` | childEnv drops NODE_ENV | **red** |
| turn-cap's `scrubSubagentEnv()` replaced by a no-op | billed files scrub | **red**, naming `tests/turn-cap.test.ts` |
| `env: childEnv()` dropped from one spawn | spawn-env row | **red**, naming the file and line |

A mutation that first passed exposed a weak pin: matching `scrubSubagentEnv` as a *mention*
stayed green on the import line, so the row now requires a call (`scrubSubagentEnv(`).

### What this drops, on purpose

The clean-env verdict: a plain `bun test` is now injected, and `PI_SUBAGENT_ALLOWLIST= bun test`
restores the clean run. A file that depends on the vars being absent and does not scrub now fails
in every run — the intended pressure, and the mechanism that makes "inject always" a check
rather than a convention.
