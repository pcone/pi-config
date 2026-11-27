---
title: "pre-push refuses a foxtrot push to the mainline, and bin/setup installs the hook"
type: decision
status: done
date: 2026-11-27
---

# pre-push refuses a foxtrot push to the mainline, and bin/setup installs the hook

**What:**
- `bin/pre-push` gains rule (C). A push that moves the mainline keeps the previous remote tip on
  the pushed tip's first-parent line. A merge of the remote tip into local work is refused, and so
  is the other direction: a pushed tip that is an ancestor of the previous one is a rewind, which
  git takes with `--force` and nothing else refuses.
- `bin/setup` links `<git common dir>/hooks/pre-push` to `../../bin/pre-push`, and sets
  `pi.mainline` to `main` when the clone has none.

**Ruling:** owner, 2026-11-27, on the two findings put to him (the hook missing on tfd-box and
absent from `bin/setup`; no foxtrot guard in pi-config): "yeah we should add these".

Recorder's reading: both land.

**Ruling:** owner, 2026-11-27, on setup setting `pi.mainline` to `main` when a clone has none,
put to him as the recorder's choice with the alternative that setup stop and tell the user:
"agree". The hook refuses every push while the value is unset, so an install that left it unset
would block the clone.

**Why:**
- `APPEND_SYSTEM.md` § Landing work states the first-parent rule for every mainline, and only
  tfd's hook enforced it (tfd R98).
- Git accepts a foxtrot push as a fast-forward, so nothing else refuses it.
- Git accepts a rewind with `--force`, so nothing else refuses that either. tfd's own hook refused
  it until its foxtrot walk was deleted; the shared gate is where the rule lives for both repos.
- On tfd-box the hook was not installed after the move from the Mac, which left rule (B), the
  work-order id collision gate, off for pushes from the box.

**Tradeoffs:**
- The link is relative to the common git dir. Setup run from a linked worktree installs a hook
  that runs the main checkout's `bin/pre-push`, not the worktree's.
- tfd pipes its pushes into the same file, so rule (C) judges them too, before tfd's own
  `.githooks/pre-push` reaches its `change_scope.py` walk. Two mechanisms for R98 was the state
  this landing left: the shared gate refuses first, so tfd's foxtrot arm became unreachable and
  its two rows asserting that arm's wording reddened. The resolution is the shared gate owning
  the rule for every repo that imports it, and tfd deleting its walk (tfd's lane; recorded here
  when it lands). The refusal says "a foxtrot merge" so a repo can assert the shape from the
  shared wording rather than its own.

**Test coverage:** `tests/pre-push-hook.test.ts` § rule (C), six rows;
`tests/setup-install.test.ts`, five rows for the link and `pi.mainline`.
