/**
 * Broadcast, as peer-link has it (peer-link.test.ts:451–533,
 * peer-link-external.test.ts:375–444). WO-2026-107 retires it: its one
 * successor is "`@room` pushes to every non-subagent member", pinned below.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { scrubSubagentEnv } from "../helpers/subagent-env.ts";
import { ADAPTERS, asRuled, asToday } from "./adapters/index.ts";
import { type Bus, fresh, injectedWith } from "./bus.ts";

const restoreSubagentEnv = scrubSubagentEnv();
afterAll(restoreSubagentEnv);

for (const adapter of ADAPTERS) {
	describe(`${adapter.name}: broadcast`, () => {
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

		asToday(adapter)("reaches every online peer, never the sender, and skips an offline one", async () => {
			const bob = await bus.connect(fresh("bob"), "pi");
			const carol = await bus.connect(fresh("carol"), "pi");
			const dave = await bus.connect(fresh("dave"), "pi");
			await bus.disconnect(dave);
			const alice = await bus.connect(fresh("alice"), "pi");
			await bus.send(alice, "*", "to everyone");
			await injectedWith(bob, "to everyone");
			await injectedWith(carol, "to everyone");
			await Bun.sleep(300);
			expect(alice.injected).toEqual([]);
		}, 30_000);

		asToday(adapter)("a requireOnline broadcast with no other online peer fails", async () => {
			const alice = await bus.connect(fresh("alice"), "pi");
			await expect(bus.send(alice, "*", "anyone?", { requireOnline: true })).rejects.toThrow(/no online peers/);
		}, 30_000);

		// WO-2026-107 table row 2: broadcast is gone; its one successor.
		asRuled(adapter)("@room pushes to every non-subagent member, and not to a subagent member", async () => {
			const bob = await bus.connect(fresh("bob"), "pi");
			const claude = await bus.connect(crypto.randomUUID(), "claude");
			const sub = await bus.connect(fresh("sub"), "subagent");
			const alice = await bus.connect(fresh("alice"), "pi");
			await bus.send(alice, "#peers", "@room standup in five");
			await injectedWith(bob, "standup in five");
			expect((await bus.pushed(claude)).out).toContain("standup in five");
			await Bun.sleep(500);
			expect(sub.injected.some((m) => m.text.includes("standup in five"))).toBe(false);
			expect(alice.injected).toEqual([]);
		}, 30_000);

		asRuled(adapter)("a send to * is refused: no such peer", async () => {
			const alice = await bus.connect(fresh("alice"), "pi");
			await expect(bus.send(alice, "*", "anyone?")).rejects.toThrow(/1-64 chars/);
		}, 30_000);
	});
}
