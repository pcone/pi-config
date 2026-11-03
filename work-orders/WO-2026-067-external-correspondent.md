# WO-2026-067 — a Claude Code correspondent is deliverable after all

**Status: DISPATCHED 2026-11-03.**

### Metadata

- **work_order_id**: WO-2026-067
- **parent_plan_id**: [decision external-tools/008](../../decisions/external-tools/008-model-error-mail.md)
- **routed_to**: implement
- **invariant_exhaustiveness**: implicit
- **priority**: high (the previous landing removed the only route to the peer this feature was partly built for)
- **estimated_complexity**: trivial
- **review_policy**: required (a liveness gate; the template's calibration case is this shape)

### Task Summary

WO-2026-066's liveness gate excluded external peers from both arms, because an external peer (`external: true`, e.g. a Claude Code session) is never heartbeat-online. The owner has ruled that a registered external correspondent is deliverable. One condition, one arm, one new row.

### Rulings

- [external-tools/008](../../decisions/external-tools/008-model-error-mail.md), owner 2026-11-03, **a Claude Code correspondent**: "Yes, deliver to it (Recommended)". A registered `external: true` correspondent is deliverable **in the correspondent arm only**; its mail queues for that session's next prompt (decision 003). The broadcast arm still reaches only online pi peers.
- Same decision, owner 2026-11-03, **a dead correspondent**: "Online, else broadcast (Recommended)" — unchanged for pi peers. This order adds one clause to the correspondent arm and touches nothing else.
- [decision 003](../../decisions/external-tools/003-peer-link-channel.md): delivery to a Claude Code peer stays prompt-driven; the mail starts no Claude turn.

**Rejected alternatives**: none recorded. The owner's earlier "prefer a live peer" reading is not this order's to land.

### Premise

**P1.** A registered external peer appears in the list `deps.peers()` returns, carrying `external: true` and `online: false`, so `recipients()` can recognise it without a new lookup. Probe at dispatch time: `rg -n -A6 'external' extensions/peer-link/mailbox.ts` and read what `listPeers` sets for an `external` registration; then confirm the mail view of it with one row that writes a registered external peer and no heartbeat. If an external peer is *not* listed at all, stop with `PREMISE FALSIFIED` — the arm would need a different source, which is an owner question, not an implementation choice.

### Preparatory refactor

**`none`.** The change adds one clause to an existing condition in one function, and the predicate it reads (`onlineExcept`) is already the single home for the online/self rule as of `33d7cd4`. There is no copy to extract and no branch on duplicated structure: the new test is `peer.online || peer.external`, evaluated against the *same* list the arm already reads.

### Mechanism

In `extensions/peer-link/model-error-mail.ts`, `recipients()` becomes:

1. `self = deps.peerName()`; `peers = deps.peers()`; `online = onlineExcept(peers, self)`.
2. `recorded = correspondent ?? readLastCorrespondent(mailbox, self)`. If present, record it as today.
3. **Correspondent arm:** the recorded peer is a recipient when it appears in `online` **or** in `peers` with `external === true`. Still never `self`.
4. **Broadcast arm:** `online` only. An external peer is never reached here, even when it is the only other peer.
5. Empty result keeps today's behaviour: `warnOnce`, return `false`, and the throttle window does not open.

One predicate, not two: express the correspondent arm as a single boolean over the peer it names, so a later third kind of reachability has one place to land. No new field on `PeerInfo`, no lookup outside `deps.peers()`, no config key.

### Acceptance rows (each must fail without its mechanism)

| # | case | red without |
|---|---|---|
| 1 | **the ruling**: recorded external correspondent, no heartbeat, one online pi peer → the mail lands in the **external** peer's inbox and nowhere else | drop the `\|\| peer.external` clause |
| 2 | recorded pi correspondent, online → only it (the 066 gate unchanged) | make the arm unconditional on liveness |
| 3 | recorded external correspondent **and** an online pi peer → the external peer alone, not both | mail the correspondent plus the broadcast |
| 4 | no correspondent, one registered external peer, no online pi peer → **no** envelope anywhere, one warn, window stays shut | relax the broadcast arm to include external peers |
| 5 | no correspondent, one online pi peer and one external peer → the pi peer only | include external peers in the broadcast |
| 6 | recorded external peer that is also `self` (a session cannot be external and self; if the fixture cannot build it, say so and skip) → never a recipient | drop the self exclusion |
| 7 | a mail to an external correspondent uses the existing envelope path and stamps nothing new — `rg -n 'inReplyTo\|expectReply' extensions/peer-link/model-error-mail.ts` shows no new use | route it through a second send path |

Rows 1–5 drive the wired extension over `SessionManager.inMemory`, writing heartbeat files and a peer registration file, and assert **which inboxes** hold an envelope — not an internal array. Row 7 is a diff/rg fact, not a test.

### Prohibitions

- Broadcast arm unchanged: `git diff` shows the broadcast return line identical apart from nothing — it must be byte-identical.
- No new timer, interval or poll: `rg -c 'setInterval|setTimeout' extensions/peer-link/model-error-mail.ts` → 0.
- No user message from the mail path: `rg -n 'sendUserMessage\s*\(' extensions/peer-link/model-error-mail.ts` → 0.
- No config surface: `rg -n 'process\.env' extensions/peer-link/model-error-mail.ts` → 0.
- No change to `onlineExcept` or to `peer_send`'s broadcast: `git diff --stat -- extensions/peer-link/mailbox.ts extensions/peer-link/index.ts` → empty.
- No dependency, no `package.json` change.

### Docs to update

- `decisions/external-tools/008-model-error-mail.md` — the "Superseded in part (a Claude Code correspondent)" note gains an implemented pointer; the Outcome gains this order's commit ids and merge.
- `docs/design/model-error-mail.md` § Recipient — the arm is "online, or an external peer"; the broadcast arm stays online-only, and say why (an external peer's inbox is read on its user's next prompt, so it is reachable when named and not when swept).
- `README.md` peer-link entry — one clause.
- `docs/investigations/structure-trend.md` — a snapshot under both lenses. Delta-based: no absolute thresholds.

### Completion report

The standard schema. Additionally: the row-by-row mutation for each of the seven rows, run on that row alone; the `git diff` proving the broadcast arm is byte-identical; and confirmation that the three rows named in WO-2026-066's landing (rows 2, 3, 5 of that order) still pass unchanged.

`review_cap_reached` is hard: **3 rounds maximum**. A fourth round is refused and escalated to the orchestrator, not entered.

---

### Landing stamp (2026-11-03, merged 22ebe0c)

Landed as `a68653a` (the arm), `40015b2` and `8f8571c` (docs). One review round, both
APPROVED_WITH_NOTES, LOW only. Production delta: `22 9` in `model-error-mail.ts` and
nothing else; the broadcast return line is byte-identical to base.

Two spec defects, kept as written:

- **Row 2's red-without was under-powered.** "Make the arm unconditional on liveness"
  leaves row 2 green; WO-2026-066's row 3 reds under it and still passes unchanged. The
  row's real gate is the online term. This is the same defect class as WO-2026-066's row 1:
  a row whose fixture makes the mutation invisible.
- **Row 6's state is synthetic.** A session cannot be both external and self; the row
  builds it by overwriting this session's heartbeat file with `external: true`. It pins the
  guard, not a reachable state.

Two consequences worth keeping:

- **Self exclusion now has two homes** — `recorded !== self` in `recipients()` and
  `onlineExcept`'s own term in `mailbox.ts`. The arm reads `deps.peers()` (which includes
  this session's heartbeat) rather than `onlineExcept`'s output, so it cannot inherit the
  exclusion. The order mandated the guard; a future `mailbox.ts` change should give both
  sites one `reachableExcept`-style home. Recorded as a supersession note in decision 008.
- **The empty-case warn text still says "no peer is online now"** while the condition is
  now "no peer online and no named external correspondent". Left unchanged deliberately:
  the order says the empty result keeps today's behaviour. The design doc states the
  precise condition.
