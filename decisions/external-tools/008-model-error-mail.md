---
title: "A seat mails its model's HTTP errors to a peer, throttled; Kimi usage joins the footer"
type: decision
status: done
date: 2026-11-03
---

# Model errors reach a peer (external-tools/008)

**Ruling (owner, 2026-11-03, in Claude session 8f90746f).** Scott was told a pi seat cannot report its own usage stall: a throttled turn errors or stops, and the footer's quota slot shows z.ai, MiniMax and OpenCode Go only, in that seat's own window. The proposal was a Kimi quota segment in the footer plus a peer-link message when a turn fails on a usage error. He answered: "yeah that sounds like worthwile thing to write. we probably want to auto mail on 4XX/5XX model errors, but with some kind of throttle to avoid spam".

What that settles:
- A model request that fails with an HTTP 4XX or 5XX sends peer-link mail without the model's involvement.
- The mail is throttled so a run of failures does not flood the recipient.
- The footer gains Kimi (`kimi-coding`) usage, as 006 did for OpenCode Go.

Not ruled, for the order to settle or raise as owner questions: the throttle's shape and window, and whether non-HTTP failures (aborts, connection errors) count. The recorder reads "4XX/5XX" as excluding user aborts.

**Ruling (owner, 2026-11-03, in Claude session 8f90746f), the recipient.** Asked who receives the mail, he picked "Last correspondent (Recommended)": the peer that most recently sent this session an envelope; when no peer ever has, a broadcast to the online peers. No config key.

**Ruling (owner, 2026-11-03, in Claude session 8f90746f), a dead correspondent.** After WO-2026-065 landed, the last correspondent could be a peer that has since exited (a subagent), so the mail queued unread. He picked "Online, else broadcast (Recommended)": mail the last correspondent when its heartbeat says it is online, else broadcast to the online peers.

**Why.** A seat on a capped plan stops silently. The supervising seat learns of it only by reading the session log, and only when it is prompted to look.

**Constraint.** Delivery to a Claude Code peer stays prompt-driven (003): the mail queues for that session's next human prompt and starts no Claude turn.

## Outcome (landed 2026-11-03, order WO-2026-065)

Both halves landed, on four commits:

- `ae59b26` — the quota segment's exact bytes pinned as goldens (29 rows) before any
  refactor.
- `8d8530a` — the preparatory refactor: three provider-specific quota implementations
  (z.ai, MiniMax, OpenCode Go) become one descriptor table in
  `extensions/lib/quota.ts` — `{ provider, endpoint, auth, parse, render }` plus the
  segment's overflow policy and an optional render-time prefix, with one fetch path, one
  warn-once and one renderer. No rendered byte moved.
- `4c5b885` — the mail half in `extensions/peer-link/model-error-mail.ts`:
  `message_end` on an assistant `stopReason: "error"` whose `errorMessage` matches
  `^\s*([45]\d{2})\b`, one envelope via `sendEnvelope` to the last correspondent (else a
  broadcast to the online peers), one mail per 30 minutes carrying the suppressed count.
  No tool call, no user message, no model involvement, no timer.
- `de5efef` — `kimi-coding` joins the descriptor table (one entry).
- Review rounds, same landing: `b3487b9` (per-descriptor wiring and the Kimi source
  choices pinned), `fd052a1` (no safe defaults on the mail body, self-correspondent guard,
  doc corrections), `89d18f5` (throttle as one value, the footer's live render goes through
  the descriptor, a clip golden for each MiniMax host). Branch tip at hand-off: `89d18f5`.

**Kimi probe (premise P2, held).** `GET https://api.kimi.com/coding/v1/usages` with the
configured OAuth subscription token answers 200 with a used ratio and an absolute reset
instant per window (`limit_5h`, `limit_month_code`, `limit_month_total`); the endpoint is
undocumented and was found by probing, not from a doc. Two probes minutes apart on
2026-11-03: the payload recorded in `docs/design/quota-footer.md` (04:28:45Z) renders
`5h:18% 29m mo:11% thru7% 27.8d` and is the test fixture; the footer's own fetch path
rendered `5h:28% 2m mo:12% thru7% 27.8d`, which is what follows. Response shape and the
series choice: `docs/design/quota-footer.md`.

**Design and the choices that are not rulings.** `docs/design/model-error-mail.md`
carries the trigger, the classifier table over the corpus strings, the throttle window,
the recipient rule and the prompt-driven delivery note. The order settled three things
that are its author's, not the owner's, and they stand as written: the classifier regex,
the 30-minute window with a suppressed count that a good turn clears, and the two
separately landable halves with the descriptor extracted first.

**Cost.** Before this landing the mail path did not exist: an assistant message cost the
extension exactly the handlers it already had, and an idle minute cost nothing because
nothing was scheduled. After it, measured on this box with an ad-hoc `bun` harness (not
committed — it is a microbenchmark of the module's own entry points, re-runnable against
`createModelErrorMail`):
one `message_end` with a non-error assistant message costs 3.0 ns (0.6 µs for a
200-message turn, up from 0), a qualifying error costs 63 ns for the classifier plus one
envelope write, and an idle minute still costs nothing — no timer and no poll is
registered.
The footer's per-60s-interval cost is unchanged for z.ai, MiniMax and Go (one request per
interval, as before); a `kimi-coding` session adds one request per interval, measured at
0.69–0.75 s per fetch, fire-and-forget at the poll boundary (Go 0.26–0.57 s and z.ai
0.26–1.08 s on the same box, for scale).

**Files:** `extensions/lib/quota.ts` (new), `extensions/footer-session-id.ts`,
`extensions/peer-link/model-error-mail.ts` (new), `extensions/peer-link/mailbox.ts`,
`extensions/peer-link/index.ts`, `docs/design/model-error-mail.md` (new),
`docs/design/quota-footer.md` (new), `tests/footer-quota-characterisation.test.ts` (new),
`tests/model-error-mail.test.ts` (new), `tests/footer-kimi-usage.test.ts` (new),
`tests/peer-link.test.ts` (fake ctx completed with `getSessionId`), `README.md`,
`docs/investigations/structure-trend.md`.

**Rollback:** the mail half is one file plus a handler registration; the quota half is a
descriptor entry per provider, and the refactor commit is byte-identical by test.
