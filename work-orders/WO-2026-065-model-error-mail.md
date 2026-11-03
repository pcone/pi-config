# WO-2026-065 — a seat mails its model's HTTP errors, throttled; Kimi joins the quota slot

**Status: DISPATCHED 2026-11-03.**

### Metadata

- **work_order_id**: WO-2026-065
- **parent_plan_id**: [decision external-tools/008](../../decisions/external-tools/008-model-error-mail.md)
- **routed_to**: implement
- **invariant_exhaustiveness**: implicit
- **priority**: high (a seat on a capped plan stalls silently and its supervisor learns days later)
- **estimated_complexity**: moderate
- **review_policy**: required

### Task Summary

Two independent halves, one order because both serve the same signal.

1. A model request that fails with an HTTP 4XX or 5XX sends peer-link mail from the extension, with no model involvement, throttled so a run of failures does not flood the recipient.
2. The footer's quota slot gains Kimi (`kimi-coding`), as it did for OpenCode Go in `external-tools/006`.

### Rulings

- [external-tools/008](../../decisions/external-tools/008-model-error-mail.md), owner 2026-11-03: "we probably want to auto mail on 4XX/5XX model errors, but with some kind of throttle to avoid spam". Both halves are his to have written.
- 008 § Constraint: delivery to a Claude Code peer stays prompt-driven (decision 003). The mail queues for that session's next human prompt and starts no Claude turn.
- [external-tools/008](../../decisions/external-tools/008-model-error-mail.md): the owner's "4XX/5XX" is read as excluding user aborts.
- Same decision, owner 2026-11-03: "Last correspondent (Recommended)". The mail goes to the peer that most recently sent this session an envelope; when no peer ever has, a broadcast to the online peers. No config key.

### What the order settles, and what it does not

Three choices in this order are the author's, not owner rulings: the classifier's HTTP-status regex, the 30-minute throttle with a suppressed count that resets on a good message, and the two separately landable halves with the quota descriptor extracted first. They are order content and fall away if the owner overturns them. The only owner rulings are the four cited above, and the recipient is the last of them.

### Premises (verify first; on a false one stop with `PREMISE FALSIFIED`)

- **P1.** A failed model request surfaces as an assistant message with `stopReason: "error"` and an `errorMessage` string whose leading token is the HTTP status. Evidence from this box's session corpus, which is what the classifier must handle: `429: {…}` ×216, `503: {…}` ×26, `529 {…}` ×21, `500: {…}` ×19, `520: {…}` ×26, and the non-HTTP forms `terminated` ×801, `Operation aborted` ×444, `Request timed out.` ×273, `Connection error.` ×85, `Stream ended without finish_reason` ×84, `This operation was aborted` ×25, `Provider returned error` ×21. Verify the event reaches a `message_end` handler with those fields; do not verify by provoking a live failure.
- **P2.** `kimi-coding` exposes a quota/usage endpoint usable with the configured auth (the code path is `https://api.kimi.com/coding/v1`, OAuth subscription token or `KIMI_API_KEY`). It is undocumented, like z.ai's. Probe it; if neither a usage endpoint nor a balance endpoint answers with a quota, stop the footer half with `PREMISE FALSIFIED` and land the mail half — the two are independent.
- **P3.** An extension can write an envelope into a peer's inbox without a turn, through `newEnvelope` + `sendEnvelope` in `peer-link/mailbox.ts`, and the recipient's delivery path is unchanged by that.

### Mechanism

1. **Trigger — `message_end`, nothing else.** Assistant message, `stopReason === "error"`, and `errorMessage` matching `^\s*([45]\d{2})\b`. The classifier is one pure function over the string, with a table test using the exact strings above. `terminated`, `aborted`, a timeout, a connection error, a truncated stream and `Provider returned error` are not model HTTP errors and mail nothing.
2. **No model involvement.** The extension composes the envelope itself and writes it with `sendEnvelope` (P3). It does not call a tool, does not `sendUserMessage` into this session, and does not add a user message to this session's branch.
3. **Throttle.** One mail per session per 30 minutes. The first qualifying failure mails at once; later qualifying failures inside the window increment a suppressed counter and mail nothing. When the window has expired, the next qualifying failure mails and carries `+N suppressed since <time>`. A non-error assistant message ends the stall: it clears the window and the counter, so a new stall after a good turn mails immediately. State is in-process; no timer, no polling, and the check runs only when a qualifying failure arrives.
4. **Content.** Session peer name and id, cwd, model provider/id, the HTTP status, the first 200 characters of `errorMessage`, and the suppressed count when there is one. No credentials, no prompt text, no summary.
5. **Recipient — the last correspondent** (owner 2026-11-03). The peer that most recently sent this session an envelope, tracked as the `from` of the newest delivered envelope, persisted so a restart keeps it; when no peer has ever mailed this session, a broadcast to the online peers. No config key, no hardcoded id, and an empty recipient set is not an error (see acceptance row 7).
6. **Delivery unchanged.** For an external (Claude Code) peer this is a file in its inbox, read at its next prompt; no turn starts there or here (decision 003, 008 § Constraint).
7. **Footer: Kimi usage.** Add `kimi-coding` to the quota slot beside z.ai, MiniMax and OpenCode Go, following the existing per-provider shape: fetch with the configured auth, cache, render a segment for that provider only, warn once on failure, render nothing when there is no data.

### Rejected alternatives

- **Mailing from the model** ("tell the agent to mail when it sees an error"). The failure is a dead request, not a decision the model gets to make; the tfd seat's stall produced no turn at all.
- **A `peer_send` tool call from the extension.** It would enter this session's branch as a tool call and could start a turn; the envelope write is the mechanism the mail path already uses.
- **A retry loop or a health poll.** The signal already exists in the failure; polling every turn costs every turn (see the cost note below).
- **Throttling with a timer.** A timer per session for a rare event is cost without a purpose; the window is checked when a failure arrives.
- **Mailing on every non-2XX-shaped message text**, including `Provider returned error`. It is not an HTTP response with a status, so the owner's "4XX/5XX" does not cover it; if that turns out to be the usage stall in disguise, that is a follow-up with evidence.

### Preparatory refactor

The footer already carries three provider-specific quota implementations (z.ai, MiniMax, OpenCode Go): three fetchers, three parsers, three render segments, and a shared warn-once. Adding a fourth is the copy this order must not make.

Extract one provider-parameterised quota mechanism — a descriptor `{ provider, endpoint, auth, parse, render }` plus one fetch/cache/render path — and move z.ai, MiniMax and OpenCode Go onto it **behind their existing tests**, in its own commit, before Kimi is added. Characterisation: the footer's existing quota rows pass unchanged at the refactor commit, and the rendered output for each provider is byte-identical for the same cached fixture.

### Acceptance

Each row fails with its mechanism reverted; show the revert. No row needs a live model or a live Kimi endpoint: the classifier is a table, and the footer renders from a cached fixture.

1. `429: {…}` on an assistant error message mails the recipient once, carrying the status and the truncated message.
2. `503` and `529` mail too (5XX).
3. `terminated`, `Operation aborted`, `Request timed out.`, `Connection error.`, `Stream ended without finish_reason`, `This operation was aborted` and `Provider returned error` mail nothing — one table row each, using the corpus strings verbatim.
4. Three qualifying failures inside the window produce one mail; the first failure after the window carries the suppressed count.
5. A non-error assistant message clears the window and the counter, and the next failure mails immediately.
6. Sending the mail adds no user message and no tool call to this session's branch.
7. An unsendable recipient (no correspondent and no online peer) warns once and does not throw into the turn.
8. Footer: the Kimi segment renders the remaining quota from the cached fixture and is absent for every other provider.
9. Footer: a failed Kimi fetch warns once and renders nothing, matching the existing providers' rows.
10. The refactor commit changes no rendered output: every provider's segment is byte-identical before and after for the same fixture.
11. The mail goes to the last correspondent: after a peer mails this session, a qualifying failure is addressed to that peer; with no peer ever having mailed it, the envelope is broadcast to the online peers; and no recipient is read from configuration.

### Cost

The mail path adds no polling: it runs on `message_end`, one string test and a map lookup per assistant message. Report the measured cost of one idle minute and of one 200-message turn before and after, and the footer's added fetch cost per poll interval (one request per interval, only when the model's provider is `kimi-coding`).

### Docs

- New `docs/design/model-error-mail.md`: the trigger, the classifier table, the throttle window and what "suppressed" means, the recipient rule, and that delivery is prompt-driven for a Claude Code peer.
- `docs/design/` or the footer's own docs for the quota descriptor and the Kimi segment.
- `decisions/external-tools/008` § Outcome: commit ids at landing.

### Prohibitions

- No new polling or timer on the mail path: no work on a turn that has no qualifying failure.
- No credentials, prompt text or summary in the mail; no transcript reads.
- Do not change peer-link delivery, steering or queueing; the mail is an envelope write.
- Do not start a Claude turn (decision 003) or send a user message into this session.
- No new dependency; no config surface without a ruling.
