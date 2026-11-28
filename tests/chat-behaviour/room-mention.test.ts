/**
 * `@room`, broadcast's one successor (WO-2026-107: `to: "*"`, comma lists and
 * the broadcast flag are gone). 015/30: it reaches no subagent.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { scrubSubagentEnv } from "../helpers/subagent-env.ts";
import { ADAPTERS } from "./adapters/index.ts";
import { type Bus, fresh, injectedWith } from "./bus.ts";

const restoreSubagentEnv = scrubSubagentEnv();
afterAll(restoreSubagentEnv);

for (const adapter of ADAPTERS) {
	describe(`${adapter.name}: @room`, () => {
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

		it("@room pushes to every non-subagent member, and not to a subagent member", async () => {
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

		it("a send to * is refused: no such peer", async () => {
			const alice = await bus.connect(fresh("alice"), "pi");
			await expect(bus.send(alice, "*", "anyone?")).rejects.toThrow(/1-64 chars/);
		}, 30_000);
	});
}
