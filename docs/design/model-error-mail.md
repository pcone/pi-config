# Model error mail

A model request that fails with an HTTP 4XX or 5XX mails a peer from the
peer-link extension. No model involvement: the seat's turn is already dead, so
nothing in the transcript is the model's to write.

Code: `extensions/peer-link/model-error-mail.ts` (classifier, throttle,
recipient, envelope text), wired in `extensions/peer-link/index.ts`.
Rulings: `decisions/external-tools/008-model-error-mail.md`. Order:
`work-orders/WO-2026-065-model-error-mail.md`; liveness gate and loud init:
`work-orders/WO-2026-066-recipient-liveness.md`.

## Trigger

One event: `message_end`, for an assistant message with
`stopReason: "error"` whose `errorMessage` leads with an HTTP status. Nothing
else runs the mail path — no timer, no poll, no health check.

The classifier is one pure function over the string:

```
^\s*([45]\d{2})\b
```

| Corpus string (verbatim, from this box's session logs) | Mail | Status |
| --- | --- | --- |
| `429: {"code":"1302","message":"Rate limit reached for requests"}` | yes | 429 |
| `503: {"type":"server_error",…}` | yes | 503 |
| `529 {"type":"error","error":{"type":"overloaded_error",…}}` | yes | 529 |
| `500: {"type":"server_error",…}` | yes | 500 |
| `520: {"message":"Provider returned error","code":520,…}` | yes | 520 |
| `terminated` | no | — |
| `Operation aborted` | no | — |
| `Request timed out.` | no | — |
| `Connection error.` | no | — |
| `Stream ended without finish_reason` | no | — |
| `This operation was aborted` | no | — |
| `Provider returned error` | no | — |

The non-HTTP forms are not a response with a status, so the owner's "4XX/5XX"
does not cover them (decision 008 reads it as excluding user aborts too).
`Provider returned error` on its own is the one to watch: if a usage stall turns
out to present that way, it is a follow-up with evidence, not a reason to widen
the regex. `tests/model-error-mail.test.ts` holds the table.

## No model involvement

The extension composes the envelope and writes it with `sendEnvelope`. It does
not call a tool, does not `sendUserMessage`, and adds no user message or tool
call to this session's branch. `tests/model-error-mail.test.ts` asserts the
branch itself: it drives the wired extension over an in-memory session whose
`sendUserMessage` appends a user entry, then checks the branch's entries are
unchanged and the mail still went out.

## Throttle

One mail per session per 30 minutes.

- The first qualifying failure mails at once and opens the window.
- Further qualifying failures inside the window increment a counter and mail
  nothing.
- Once the window has passed, the next qualifying failure mails and carries
  `suppressed: N more qualifying failures since <ISO time>`, where the time is
  when the dropped window opened. It then resets.
- A non-error assistant message ends the stall: the window and the counter
  clear, so a new stall after a good turn mails immediately.
- No peer is online now, a recorded correspondent with a dead heartbeat
  included: one warn, nothing mailed. The window does not open, so the next
  failure after a peer comes online still mails.

State is in-process. A window in progress does not survive a restart; the
recipient does (below).

## Recipient — the last correspondent, while it is online

The peer that most recently sent this session an envelope: the `from` of the
newest delivered envelope, written to `_state/<peer>.json` in the mailbox so a
restart keeps it. The mail goes to that peer when its heartbeat says it is
online, and otherwise to every peer online now. With no peer online, nothing is
sent. No config key, no environment variable, no hardcoded id.

The gate is the ruling (owner 2026-11-03, decision external-tools/008: "online,
else broadcast"). The correspondent can be gone by the next failure — a subagent
heartbeats as a real peer, and its heartbeat ages out when it exits — and mail
to a dead peer queues in an inbox nobody reads: the silence this feature exists
to break, one peer over. Liveness is the same read the send gate uses,
`listPeers(...).online` over the heartbeat files. `recipients()` in
`extensions/peer-link/model-error-mail.ts` is the rule.

An external peer (a Claude Code seat) is never online — its inbox is read only
when its user prompts (`docs/design/peer-link-external.md`) — so it is never a
recipient: both arms list `online` peers only.

Recording is unchanged by the gate: the sender of a delivered envelope is
recorded whether or not it is online, because the record says who wrote last,
not who can receive.

This session is never a recipient, even when the record names it: a session
that mailed itself would otherwise become its own correspondent, and the model
error would come back as an injected user message — the one thing the mail path
must never cause. `onlineExcept` in `mailbox.ts` owns the self exclusion for
both recipient paths.

"Delivered" means the extension's inbox scan injected it and acked it — an
envelope read but not delivered is retried, not recorded. Two envelopes landing
in the same scan window resolve in directory-read order, not by `sentAt`.

## The mail

```
[model-error] <provider>/<model> returned HTTP <status>
session: <peer name> (<session id>)
cwd: <cwd>
error: <first 200 characters of errorMessage, newlines flattened>
suppressed: N more qualifying failures since <ISO time>     (only when N > 0)
```

No credentials, no prompt text, no summary, no instruction. A recipient that
wants more reads the sender's session log.

## Delivery

Unchanged from peer-link. A pi peer picks the envelope up on its next inbox
scan. A Claude Code peer reads it on its user's next prompt and starts no turn
(decision 003, 008 § Constraint).

## Cost

Nothing runs on a turn that has no qualifying failure: one `stopReason` test
per assistant message, then one regex test. The mailbox is only read when a mail
is about to go out, so an idle minute costs nothing.
`tests/model-error-mail.test.ts` covers the behaviour; the measured figures are
in the landing report for WO-2026-065.
