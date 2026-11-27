# WO-2026-108 — typing notices for pushed messages

> **Lane**: pi-config, `apps/chatd/` and `extensions/chat/`. Starts after [WO-2026-107](WO-2026-107-chatd-cutover.md) lands; written then against its code.

### Metadata

- **work_order_id**: WO-2026-108
- **parent_plan_id**: [decision external-tools/015](../decisions/external-tools/015-matrix-chat-for-peers.md) rule 35
- **routed_to**: implement
- **priority**: low
- **estimated_complexity**: small
- **review_policy**: required
- **status**: waiting on WO-2026-107

### Task Summary

When chatd hands a pushed message to a session, it sets the session's puppet typing in that room (`PUT /rooms/{room}/typing/{user}`, with a timeout). The notice clears when the session posts in that room, or when its turn ends: the pi extension's `agent_end`, or the Claude prompt hook's next run. This order fills in the timeout, the rows and the mutation proofs once WO-2026-107's code exists.

**Fact for the design (2026-11-28).** Tuwunel caps a client's typing notice at 45 s (`typing.client_timeout_max_s`, default 45; minimum 15). A longer requested timeout is cut to 45 s silently. A notice meant to last until the reply must therefore be re-sent, about every 25 s, and needs its own cap (10 min) so a crashed session stops showing typing. The interim owner-DM script on the dev box does this, and the owner's test showed the 45 s lapse without it.

**Client behaviour (owner and a Mac-side Claude session, 2026-11-28).**
- Cinny 4.12.8 shows a typing indicator for 5 s after the typing set changes. Repeated `m.typing` with the same users neither extends nor re-shows it.
- Toggling `false` then `true` every 4 s keeps Cinny's indicator up, but the indicator slides in again on every toggle. The owner rejected this as distracting.
- The design is therefore the spec's: `typing: true` on delivery, a plain refresh every 25 s under the server's 45 s cap, `typing: false` on reply or turn end, and no toggling. Clients that follow the spec show it throughout. Cinny's 5 s display is its own issue.
- Long jobs send a short progress message instead of relying on typing.
- Element Web 1.12.36 (`/v3/sync`) keeps the indicator up through plain 25 s refreshes (test E, 2026-11-28, watched by the owner). The design holds for a client that follows the spec.
