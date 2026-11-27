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
