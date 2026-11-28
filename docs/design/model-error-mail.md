# Model error mail

A model request that fails with an HTTP 4XX or 5XX mails a peer from the chat
extension, as a DM from `@pi-system`. No model involvement: the seat's turn is
already dead, so nothing in the transcript is the model's to write.

Code: `extensions/chat/model-error-mail.ts` (classifier, throttle, recipient,
mail text), wired in `extensions/chat/index.ts`; chatd posts the mail
(`system_mail`, docs/design/chat.md § `@pi-system`). Rulings:
`decisions/external-tools/008-model-error-mail.md`, 015/15. Orders:
`work-orders/WO-2026-107-chatd-cutover.md` (the chat path). Earlier:
`work-orders/WO-2026-065-model-error-mail.md`; liveness gate and loud init:
`work-orders/WO-2026-066-recipient-liveness.md`; the external correspondent:
`work-orders/WO-2026-067-external-correspondent.md`.

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
the regex. `tests/chat-behaviour/model-error-mail.test.ts` holds the table.

## No model involvement

The extension composes the mail and hands it to chatd with `system_mail`. It
does not call a tool, does not `sendUserMessage`, and adds no user message or
tool call to this session's branch. `tests/chat-behaviour/model-error-mail.test.ts`
drives the wired extension and checks that nothing was injected into the failing
session while the mail still went out.

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
- No deliverable recipient — no peer online now, or `system_mail` failed — one
  warn, nothing mailed. The window does not open, so the next failure after a
  peer becomes reachable still mails.

State is in-process. A window in progress does not survive a restart; the
recipient does (below).

## Recipient — the last correspondent, while it is online

The peer whose pushed message this session most recently delivered. chatd
writes it on ack as account data `dev.pi.last_correspondent` on the session's
puppet and returns it at `hello`, so a restart keeps it; the extension tracks
later deliveries itself. The owner counts (`owner`); `@pi-system` does not. No
config key, no environment variable, no hardcoded id.

The mail goes to that peer while it is online (`who`), the owner always, and
otherwise as `@pi-system` DMs to every online non-subagent peer, a Claude
session included: a Claude session is online while registered
(WO-2026-107). With no recipient, nothing is sent. `recipients()` in
`extensions/chat/model-error-mail.ts` is the rule.

An offline correspondent is not a recipient: a subagent that has exited reads
nothing, which is the silence this mail exists to break (owner 2026-11-03,
decision 008).

Recording does not depend on liveness: the sender of a delivered message is
recorded whether or not it is online, because the record says who wrote last,
not who can receive.

This session is never a recipient, even when the record names it: a session
that mailed itself would become its own correspondent, and the model error
would come back as an injected user message — the one thing the mail path must
never cause. chatd refuses a `system_mail` to its sender too.

"Delivered" means injected and acked: a pushed event that failed to inject is
retried, not recorded.

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

A DM like any other: injected into a pi peer as `[peer:system] …`, shown to a
Claude Code peer at its next prompt or by its watch (docs/design/chat.md).

## Cost

Nothing runs on a turn that has no qualifying failure: one `stopReason` test
per assistant message, then one regex test. chatd is asked (`who`,
`system_mail`) only when a mail is about to go out, so an idle minute costs
nothing.
