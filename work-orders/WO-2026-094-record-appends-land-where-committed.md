# WO-2026-094 — a work-order record append lands where it gets committed, or fails loudly

### Metadata

- **work_order_id**: WO-2026-094
- **parent_plan_id**: owner 2026-11-08 — `wo_record` appends for WO-477 and WO-424 were written into `~/Developer/tfd`'s working tree, not the worktree that commits; origin's records lack ~44 and ~10 entry headings. **Recovery dropped from scope (owner 2026-11-08):** the tfd seat restored those entries at `41880c7cc` as notes, because the stray copies reuse departure ids. This order is only "appends land where they commit, or fail loudly".
- **sequence_position**: 3 of 3 — after **WO-2026-095** (the `subagent-async` split), which owns `index.ts`; this order edits the new `subagent-async/records.ts` instead.
- **routed_to**: implement
- **priority**: high (records are the durable account of what a work order did)
- **estimated_complexity**: moderate
- **review_policy**: required
- **turn_budget**: planned **70** turns, cap **100**. Report `planned / cap / actual`. Targeted rows only — never the full `bun test` (box-wide `flock` slot; the orchestrator gates it). Tell any reviewer you spawn the same.
- **base**: the tip of `origin/main` at dispatch

### Task Summary

**One-sentence description**: the harness appends a work-order record entry in the checkout that will commit it — the subagent's isolation worktree when one exists — and reports a record that cannot reach a commit as a failure, not a passing note.

**Goal**: no record entry is written into a tree nobody commits, and a lost append is impossible to miss.

### Premise

`openWorkRecord(cwd, …)` (`extensions/subagent-async/index.ts:1529`) runs `python3 scripts/wo_record.py append` with `cwd` — the **parent checkout** — while the child's edits commit on the isolation worktree. The append therefore lands as an uncommitted change in `~/Developer/tfd`, which no branch carries and which a later `git checkout`/reap discards. Observed: WO-477 missing ~44 entry headings on origin, WO-424 ~10; the same class as the 2026-10-29 stray-append stash. `woRecordAppend`'s failure is reported as a `note`, and a note is not loud enough to stop a lost record.

### Mechanism

**M1 — one cwd rule.** The record's cwd is the tree that will be committed: `worktreePath` when the spawn is isolated, else the parent cwd (a non-isolated spawn's commits land there). `openWorkRecord` takes that path explicitly rather than inheriting whichever cwd the dispatcher had; the worktree path is already in scope at the call site (`index.ts:4500`).

**M2 — verify where it must be true.** At close, after the harness has committed the child's work, check that every entry the record append wrote for this dispatch is present in the tree being merged (the committed HEAD of the isolation branch, else the parent's HEAD). This is the structural gate: one check at the one place a record can still be saved, not a rule restated at each append site.

**M3 — loud when it cannot.** A dispatch whose record cannot be written into a committing tree, or whose close-time verification finds the entries missing, ends the run with a **loud failure** carrying the record's path and the missing entry ids — the same weight as a failed worktree removal, not a `note`. The spawn still completes; the record failure is terminal for the record and visible in the status line.

### Prohibitions

- No second append path: the append goes through `wo_record.py append`, never a hand-written JSON/Markdown edit.
- Never append into a tree that will not be committed.
- Never silently downgrade a record failure to a note.
- Don't change `wo_record.py`'s format in this order; the format is another repo's contract and `scripts/wo_record.py` owns it.

### Verification Criteria

Each row with its mutation, run alone:

- **R1** an isolated spawn appends into the worktree, and the entry is in the branch's committed tree.
- **R2** a non-isolated spawn appends into the parent cwd and commits there.
- **R3** the append landing in the parent checkout while the spawn is isolated is caught (the observed bug): the close-time check fails loudly and names the record path.
- **R4** a missing entry at close (append silently no-opped) fails the same way.
- **R5** a repo without `scripts/wo_record.py` still gets no record and no failure (the existing contract).

### Cost — measure, do not assert

The append is one `python3` spawn, and the close-time verification is one `git grep`/`show` per record. Measure both, and state what the verification costs on a record with ~50 entries.

### Stop reports

- `PREMISE FALSIFIED` if the record append already runs in the worktree (it does not, per the premise) or if `wo_record.py` writes somewhere other than a git-tracked path.
- `PLAN MISMATCH` if a second place writes record entries besides `openWorkRecord` and the close path.
