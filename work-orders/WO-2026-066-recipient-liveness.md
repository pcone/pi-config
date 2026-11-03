# WO-2026-066 — mail a live correspondent, and let a dead peer-link init fail loud

**Status: DISPATCHED 2026-11-03.**

### Metadata

- **work_order_id**: WO-2026-066
- **parent_plan_id**: [decision external-tools/008](../../decisions/external-tools/008-model-error-mail.md)
- **routed_to**: implement
- **invariant_exhaustiveness**: implicit
- **priority**: high (the mail's whole purpose is to break a silence, and today it can post into one)
- **estimated_complexity**: small
- **review_policy**: required (a liveness gate; the calibration case in the template is exactly this shape of change)

### Task Summary

Two halves, one order: both live in peer-link's lifecycle and both are follow-ups the owner asked for after WO-2026-065 landed.

1. The model-error mail goes to the last correspondent **only while that peer's heartbeat says it is online**; otherwise it broadcasts to the online peers. (Owner ruling, 2026-11-03.)
2. Peer-link's `session_start` no longer turns a wiring failure into a discarded UI notify. It notifies and then rethrows, and a row shows a throwing init failing the test it runs in.

### Rulings

- [external-tools/008](../../decisions/external-tools/008-model-error-mail.md), owner 2026-11-03, **a dead correspondent**: "Online, else broadcast (Recommended)". The last correspondent receives the mail when its heartbeat says it is online; otherwise the mail broadcasts to the online peers.
- Same decision, owner 2026-11-03, **the recipient**: "Last correspondent (Recommended)" — unchanged as the first preference, and now conditional on liveness.
- Same decision, owner 2026-11-03: "we probably want to auto mail on 4XX/5XX model errors, but with some kind of throttle to avoid spam".
- Owner 2026-11-03, via the planning seat, on half 2: the `catch` that turned a wiring `TypeError` into a UI notify the test discarded is "a hidden fallback by our rules (fail early and hard)"; fold making it loud into this order. The seat left the split to the author; it is folded, because both halves edit the same lifecycle and one review over both is cheaper than two.

**Rejected alternatives**: none. The owner picked "online, else broadcast" against a "prefer any live peer" reading, which is not this order's to land.

### Premise

**P1.** A peer's liveness is already recorded on disk and already read by both call sites: `listPeers(mailbox, now?)` in `extensions/peer-link/mailbox.ts` returns `PeerInfo[]` with an `online` field, derived from the heartbeat files `peer_send`'s broadcast filters on. Probe: `rg -n 'online' extensions/peer-link/mailbox.ts` and confirm `listPeers` computes it from heartbeats rather than from an in-process map. If liveness is only in-process, stop with `PREMISE FALSIFIED` — the mail module could then not read it without a new mechanism.

**P2.** The failure in half 2 is reachable from a test: a `session_start` handler whose `ctx` cannot satisfy peer-link's init rejects, and today that rejection is swallowed. Probe: the fixture at `tests/checkpoint-waits.test.ts` `peerCtx` omits `getSessionId`, and before the gate's fix the five peer-wait rows failed with no error text. If a rethrow cannot be observed at that boundary, stop with `PREMISE FALSIFIED` rather than testing an internal function.

### Preparatory refactor

**Refactor commit, behaviour-preserving:** extract the duplicated "online peers other than self" predicate into `extensions/peer-link/mailbox.ts` and call it from both sites. Today it is written twice — `peer_send`'s broadcast (`extensions/peer-link/index.ts`, the `params.to === "*"` arm, `listPeers(...).filter(p => p.online && p.name !== state.peerName)`) and `recipients()` in `extensions/peer-link/model-error-mail.ts`.

Shape: a pure function over the peer list, so neither caller changes how it obtains one and both stay testable without a mailbox.

```ts
export function onlineExcept(peers: PeerInfo[], self: string): PeerInfo[]
```

`index.ts` calls `onlineExcept(listPeers(state.mailbox), state.peerName)`; the mail module calls `onlineExcept(deps.peers(), self)`. `deps.peers()` stays the injection point (it is already `() => listPeers(state.mailbox)` at the wiring site).

Characterization rows that must pass **unchanged** at the refactor commit: the `peer_send` broadcast rows in `tests/peer-link.test.ts` (broadcast reaches online peers, excludes self, `requireOnline` still throws with none), and the recipient rows in `tests/model-error-mail.test.ts` (row 11 and its self-guard). If a row must change at the refactor commit, behaviour changed — stop.

Then the change, in the same branch, as its own commit.

### Mechanism

**Half 1 — liveness-gated recipient.** `recipients()` decides in this order, and never mails self:

1. Read the correspondent: the one recorded by `recordCorrespondent` this process, else `readLastCorrespondent(mailbox, self)`.
2. If a correspondent exists and it appears in `onlineExcept(deps.peers(), self)` — **that peer alone**.
3. Otherwise — every name in `onlineExcept(deps.peers(), self)`.
4. Empty result keeps today's behaviour: `warnOnce` naming the reason, return `false`, and the throttle window **does not open** (a window that opens on an unsent mail suppresses the first send that would have worked).

Record the correspondent as today, whether or not it was online: it records who wrote last, not who can receive.

**Half 2 — a loud init.** In `pi.on("session_start", ...)`, keep `ctx.ui.notify(\`peer-link init failed: …\`, "error")` and then **rethrow**. Subsequent handlers keep their current shape: this order changes the init path only. `consumeInbox`'s per-envelope catch is at-least-once retry by design and stays.

### Acceptance rows (each must fail without its mechanism)

| # | case | red without |
|---|---|---|
| 1 | correspondent recorded this process, heartbeat present → exactly one envelope, in that inbox | hardcode the old last-correspondent arm |
| 2 | correspondent read from the persisted record (fresh process), online → that peer only | drop the persisted read |
| 3 | **the ruling**: correspondent named in the record, its heartbeat absent/aged out, one other peer online → the mail lands in the *other* peer's inbox and not in the dead one's | ignore `online` in the correspondent arm |
| 4 | correspondent offline and **no** peer online → no envelope anywhere, one warn, and the throttle window does not open (a later online peer gets the next error immediately) | open the window on the failed send |
| 5 | no correspondent ever, peers online → broadcast to all of them | the correspondent arm only |
| 6 | a peer names *this* session as correspondent (self) → never a recipient, on either path | drop the self guard |
| 7 | `session_start` whose `ctx.sessionManager.getSessionId` throws → the emitted event **rejects** with a message naming peer-link init | `return` in place of `throw` |
| 8 | same as 7, and no peer runtime starts: no heartbeat file for this session, no scan interval, no inbox delivery for a prep-written envelope | start the runtime before the throw, or swallow |
| 9 | an ordinary `session_start` still starts the runtime and delivers (the guard did not over-fire) | the throw placed unconditionally |

Rows 1–6 drive the wired extension over `SessionManager.inMemory`, writing heartbeat and inbox files, and assert **which inboxes contain envelopes** — not an internal array. Rows 7–9 use the row-6-era `peerCtx` fixture and assert on the rejected emit plus the heartbeat directory.

### Prohibitions

- No new timer, interval or poll — `rg -c 'setInterval|setTimeout' extensions/peer-link/model-error-mail.ts` → 0.
- No config surface: the recipient rule lives in code and reads no `process.env` or settings key — `rg -n 'process\.env' extensions/peer-link/model-error-mail.ts` → 0.
- No user message from the mail path — `rg -n 'sendUserMessage' extensions/peer-link/model-error-mail.ts` → 0; delivery, steering, queueing and `ackEnvelope` semantics unchanged. The `recordCorrespondent` call site in `consumeInbox` keeps its position after the ack.
- One predicate: `rg -c 'p\.online && p\.name !==' extensions/peer-link/` → 0 after the refactor.
- The init change touches no other handler: `git diff` on `extensions/peer-link/index.ts` is confined to `session_start`, the broadcast arm's call, and the extract's import.
- No dependency, no `package.json` change.

### Docs to update

- `docs/design/model-error-mail.md` — the recipient rule becomes liveness-gated; the § on the dead correspondent changes from "works as specified, a peer short" to the gate, and the ruling is cited.
- `docs/design/peer-link.md` (or whichever doc states the extension's lifecycle) — init failure is loud.
- `decisions/external-tools/008-model-error-mail.md` — the Outcome gains this order's commit ids; the dead-correspondent paragraph points at the implementation instead of describing a hole.
- `docs/TODO.md` § **WO-2026-065 residues** — the broadcast-predicate residue is closed by this order's preparatory refactor: delete that bullet, keep the overflow one and cite the register row (see below).
- `docs/investigations/structure-trend.md` — the overflow residue gets its own register row (carried, not closed); this order's snapshot under both lenses.

### Completion report

The standard schema. Additionally:

- Row-by-row, the mutation used for each of the nine rows and the row's output alone (not the suite).
- The `git diff` for the extracted predicate showing exactly two callers changed.
- Confirmation that the four named characterization rows passed **unchanged** at the refactor commit, and that commit's id.
- `review_cap_reached` is hard: **3 rounds maximum**. A fourth round is refused and escalated to the orchestrator, not entered.
