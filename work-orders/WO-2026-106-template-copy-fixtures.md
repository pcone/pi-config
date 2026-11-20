# WO-2026-106 — a template repo copied per row, not rebuilt per row

> **Lane**: pi-config, two test files. No production change. Carries WO-2026-105's Q-105-a.

### Metadata

- **work_order_id**: WO-2026-106
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit — every fixture site in the two files is listed below
- **priority**: low (hygiene, ~0.4 s)
- **estimated_complexity**: small
- **review_policy**: required
- **order_source**: owner 2026-11-20 (claude seat relay): "Template copy (Recommended)" — "Separate
  small order: per-row fs.cpSync of a template repo in work-record-capture and checkpoint-meta;
  each row keeps its own tree." Recorded as Q-105-a's ruling in WO-2026-105.

### Task Summary

WO-2026-105's items 3 and 4 stopped: one fixture per describe plus a reset cost more than the
per-row `git init` it replaced, because the cost is the git process and a reset is two of them
(50.3 against 30.3 ms a row, measured twice). A template copied per row removes the process
instead of sharing one: `fs.cpSync` of an initialised tree is 1.6 ms, and every row keeps its
own repo, so there is no reset protocol and no per-shape exception.

### Change

`tests/work-record-capture.test.ts`

- `templateRoot`, built in `beforeAll`: a git repo with `work-orders/WO-2026-001-demo.md` and
  `scripts/wo_record.py`. Removed in `afterAll`; never written to after it is built.
- `copyTemplate(dest)`: `fs.cpSync(templateRoot, dest, { recursive: true })`. `makeRepo` copies
  into a fresh holder and then applies its shape: `ignoreRecords` writes the `.gitignore`,
  `script: false` removes `scripts/`, `record: true` writes the record file. `record: false`
  needs nothing removed — the template holds no record.
- The two custom-path rows (a directory named `wo.md dir …`, and a path holding a space and a
  parenthesis) copy the template into their awkward path instead of writing the files and
  running `git init` there. Both shapes are the point of those rows, and both survive the copy:
  the assertions are about the record path the tool reports.
- Left alone: `wo-elsewhere-` and `wo-recover-` build directories, not repos.

`tests/checkpoint-meta.test.ts`

- `upstreamTemplate`, built in `beforeAll`: a bare remote plus a clone whose `origin` is
  `../remote` — a relative path, so a copied pair still points at its own remote and the row
  needs no `remote set-url` (which would be the process the template exists to remove). Base
  pushed, one commit ahead.
- The upstream row copies the pair and reads the binding. No git call of its own.

### Verification

**Git processes, load-independent** (PATH shim logging argv):

| file | before | after |
|---|---|---|
| `work-record-capture` | 88 calls, **33** `git init` | 56 calls, **1** |
| `checkpoint-meta` | 24 calls | 24 calls (neutral — see below) |

**Wall time, interleaved A/B at matched load** (`git stash push <file>`, run, pop, run):

| file | before (median) | after (median) | load (1-min) |
|---|---|---|---|
| `work-record-capture` | 10.06 s (6 rounds) | 9.64 s (6 rounds) | 62–115 |
| `checkpoint-meta` | 2.57 s (4 rounds) | 2.78 s (4 rounds) | 77–83 |

`checkpoint-meta` is **cost-neutral, and reported as such**: that file has one upstream row, so
building the pair once in `beforeAll` moves the same seven git calls rather than removing them,
and the file's wall time is dominated by its hung-git row. It is included because the ruling named
it; the gain there is structural (the row gets its own pair, no shared build to reason about), not
timed.

**Isolation mutation** — `copyTemplate` returning `templateRoot` instead of copying (rows then
write into one tree): **red**, on twelve rows, including `writes nothing and says nothing in a
repo without wo_record.py` (the `script: false` row's deletion reached the next row) and both
custom-path rows. Per-row isolation is pinned, not assumed.

Rows: 33 and 5, unchanged, all passing. Suite: 1585 pass / 0 fail at load ~60-80.

### Rejected

- **Holding the copy to the parts a row needs** (write only `work-orders/` and `scripts/` after
  copying a bare `.git`): a second description of the fixture that has to be kept in step with
  `makeRepo`'s shape flags.
- **`git clone` from the template per row**: one git process, which is the cost being removed.
