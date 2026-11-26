# Seat handover — pi-config, Mac to tfd-box

Seat moved to the Debian box 2026-11-26 (owner-requested). Nothing was left unlanded: every change
below is on `origin/main`, and the Mac checkout `~/Developer/pi-config` holds only another session's
work in progress (per-spawn model override), which is not this seat's.

## Landed, in order

| sha | what |
|---|---|
| `eefaf9e` | WO-2026-105 items 1–2: test-waste removals that measured as wins |
| `334724e` | checkpoint-meta fixture half of WO-2026-106 reverted (cost-neutral: 24 → 24 git calls) |
| `c5c98a5` | Fable-sweep footer count and age (`decisions/external-tools/011`) |
| `f8708aa` | R98: the Fable count reads code-only landings (`non_code:` globs) |
| `3de97d3` | work-order review entries pass `--model` (tfd R98 landed at `30f77de38`) |
| `0aeff48` | `bin/setup`: one installer, npm-resolved pi, 12 agent links, baba and `/tmp` stated |

Suite at the last landing: 1623 pass / 0 fail.

## First thing to do on the box

```bash
cd /home/agent/Developer/pi-config && git pull        # expect 0aeff48 or later
# move any real file or directory aside first: bin/setup refuses to replace one
bash bin/setup
bun test                                             # expect 1623 pass on a clean box
```

`bin/setup` prints `baba: unavailable here …` on Linux; that is the expected state, not a failure, and
`semantic_search` is genuinely absent on the box.

## Open, and whose it is

- **`trust.json` is linked into `~/.pi/agent`**, so pi's trust approvals on the box write through the
  symlink into this repo's tracked file (`/home/...` keys in the working tree). Follows the standing
  "all `~/.pi/agent` config under version control" choice, `06607a3`. Making it per-machine is an
  owner question; `decisions/settings/005-linux-install.md` records it as one.
- **A runtime notice when baba is missing** was not added: user-visible surface, so it waits on an
  owner ask. The install-time line is what exists.
- **`@modelcontextprotocol/sdk`** in the root `node_modules` is stale (points into
  `wt/pi-config-verify-063`); nothing tracked imports it and `bin/setup` does not create it. Delete it
  on either machine.
- **tfd WO-2026-526** (retire `docs_validate.py`'s duplicate id scan) is tfd's to implement; this seat
  only corrected its record.
- **Two WO-2026-518 shapes** (buffer_pop alias suspicion, `@c_struct` with a `Function` field) were
  forwarded to `bug-triage` on 2026-11-24; they were misaddressed to this seat. Nothing owed here
  unless bug-triage asks.

## Watch for on the box

- `/tmp` is tmpfs: RAM-backed, empty after reboot. Worktrees, notes and scratch go under
  `/home/agent/Developer/`.
- One checkout runs `bin/setup` at a time on a machine: the last run wins, and removing that checkout
  leaves all twelve `~/.pi/agent` links dangling.
