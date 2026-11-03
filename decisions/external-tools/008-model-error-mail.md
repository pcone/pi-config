---
title: "A seat mails its model's HTTP errors to a peer, throttled; Kimi usage joins the footer"
type: decision
status: accepted
date: 2026-11-03
---

# Model errors reach a peer (external-tools/008)

**Ruling (owner, 2026-11-03, in Claude session 8f90746f).** Scott was told a pi seat cannot report its own usage stall: a throttled turn errors or stops, and the footer's quota slot shows z.ai, MiniMax and OpenCode Go only, in that seat's own window. The proposal was a Kimi quota segment in the footer plus a peer-link message when a turn fails on a usage error. He answered: "yeah that sounds like worthwile thing to write. we probably want to auto mail on 4XX/5XX model errors, but with some kind of throttle to avoid spam".

What that settles:
- A model request that fails with an HTTP 4XX or 5XX sends peer-link mail without the model's involvement.
- The mail is throttled so a run of failures does not flood the recipient.
- The footer gains Kimi (`kimi-coding`) usage, as 006 did for OpenCode Go.

Not ruled, for the order to settle or raise as owner questions: the recipient, the throttle's shape and window, and whether non-HTTP failures (aborts, connection errors) count. The recorder reads "4XX/5XX" as excluding user aborts.

**Why.** A seat on a capped plan stops silently. The supervising seat learns of it only by reading the session log, and only when it is prompted to look.

**Constraint.** Delivery to a Claude Code peer stays prompt-driven (003): the mail queues for that session's next human prompt and starts no Claude turn.
