/**
 * An unanswered reply request is a derived `peer` wait (decision
 * checkpoint/003; docs/design/checkpoint-waits.md). Ported from
 * tests/checkpoint-waits.test.ts:583–713. The checkpoint's reading of the wait
 * stays there; these rows pin the wait itself.
 *
 * The wait registry keeps one source per extension, the last registered, so
 * the waiting session connects last in every row.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { scrubSubagentEnv } from "../helpers/subagent-env.ts";
import { ADAPTERS, asRuled, asToday } from "./adapters/index.ts";
import { type Bus, fresh, injectedWith, until } from "./bus.ts";

const restoreSubagentEnv = scrubSubagentEnv();
afterAll(restoreSubagentEnv);

for (const adapter of ADAPTERS) {
	describe(`${adapter.name}: reply waits`, () => {
		let bus: Bus;
		beforeAll(async () => {
			bus = await adapter.setup();
		}, 60_000);
		afterAll(async () => {
			await bus.dispose();
		});
		beforeEach(async () => {
			await bus.reset();
		});

		// checkpoint-waits.test.ts:583
		it("an unanswered expectReply is a wait naming the peer and the ask; the reply ends it", async () => {
			const bob = await bus.connect(fresh("bob"), "pi");
			const alice = await bus.connect(fresh("alice"), "pi");
			await bus.send(alice, bob.name, "which branch is main?", { expectReply: true });
			const [wait] = alice.waits();
			expect(wait.kind).toBe("peer");
			expect(wait.reason).toBe(`reply from ${bob.name} "which branch is main?"`);
			await injectedWith(bob, "which branch is main?");
			await bus.send(bob, alice.name, "main, and here is why");
			await injectedWith(alice, "main, and here is why");
			await until(() => (alice.waits().length === 0 ? true : undefined), 10_000, "the wait to end");
		}, 40_000);

		// checkpoint-waits.test.ts:617 (a Claude peer: its replies carry no reply stamp).
		// As today: any envelope from the peer ends its waits. Rewritten under 015/33 below.
		asToday(adapter)("a Claude peer's wait ends on mail from it, and not on another peer's", async () => {
			const claude = await bus.connect(crypto.randomUUID(), "claude");
			const bob = await bus.connect(fresh("bob"), "pi");
			const alice = await bus.connect(fresh("alice"), "pi");
			await bus.send(alice, claude.name, "which branch is main?", { expectReply: true });
			expect(alice.waits().map((w) => w.reason)).toEqual([`reply from ${claude.name} "which branch is main?"`]);

			await bus.send(bob, alice.name, "unrelated question");
			await injectedWith(alice, "unrelated question");
			expect(alice.waits()).toHaveLength(1);

			await bus.send(claude, alice.name, "main, per the release notes");
			await injectedWith(alice, "main, per the release notes");
			await until(() => (alice.waits().length === 0 ? true : undefined), 10_000, "the wait to end");
		}, 40_000);

		// checkpoint-waits.test.ts:663. As today; rewritten under 015/33 below.
		asToday(adapter)("a later message from the peer ends every wait for it", async () => {
			const bob = await bus.connect(fresh("bob"), "pi");
			const alice = await bus.connect(fresh("alice"), "pi");
			await bus.send(alice, bob.name, "first question", { expectReply: true });
			await bus.send(alice, bob.name, "second question", { expectReply: true });
			expect(alice.waits()).toHaveLength(2);
			await injectedWith(bob, "second question");
			await bus.send(bob, alice.name, "answer to both");
			await injectedWith(alice, "answer to both");
			await until(() => (alice.waits().length === 0 ? true : undefined), 10_000, "both waits to end");
		}, 40_000);

		// 015/33 (owner 2026-11-28), replacing :617 and :663: a reply to the asking
		// event from anyone, or a DM from the target sent after it; a target's post
		// in a group room does not end the wait.
		asRuled(adapter)("015/33: a wait ends on a later DM from the target, not on its group-room post or another peer's DM", async () => {
			const claude = await bus.connect(crypto.randomUUID(), "claude");
			const bob = await bus.connect(fresh("bob"), "pi");
			const alice = await bus.connect(fresh("alice"), "pi");
			await bus.send(alice, claude.name, "which branch is main?", { expectReply: true });
			await bus.send(alice, claude.name, "and which is release?", { expectReply: true });
			expect(alice.waits()).toHaveLength(2);

			await bus.send(bob, alice.name, "unrelated question");
			await injectedWith(alice, "unrelated question");
			await bus.send(claude, "#peers", `@${alice.name} answering in the room`);
			await injectedWith(alice, "answering in the room");
			await Bun.sleep(300);
			expect(alice.waits()).toHaveLength(2);

			await bus.send(claude, alice.name, "main, and release-2");
			await injectedWith(alice, "main, and release-2");
			await until(() => (alice.waits().length === 0 ? true : undefined), 10_000, "both waits to end");
		}, 40_000);

		// checkpoint-waits.test.ts:689
		it("a reply relayed by a third peer ends the wait it names", async () => {
			const bobName = fresh("bob");
			await bus.disconnect(await bus.connect(bobName, "pi"));
			const carol = await bus.connect(fresh("carol"), "pi");
			const alice = await bus.connect(fresh("alice"), "pi");
			await bus.send(alice, bobName, "route this through carol", { expectReply: true });
			const ask = await bus.sentId(alice, bobName);
			expect(alice.waits()).toHaveLength(1);
			await bus.send(carol, alice.name, "bob says: main", { replyTo: ask });
			await injectedWith(alice, "bob says: main");
			await until(() => (alice.waits().length === 0 ? true : undefined), 10_000, "the wait to end");
		}, 40_000);
	});
}
