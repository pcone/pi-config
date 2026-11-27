// LIVE-NETWORK: this file makes real billed LLM calls on every full `bun test` run.
// Provider/model: openrouter/deepseek/deepseek-v4-flash (OpenRouter canonical `-20260423`),
// authorized from the live `~/.pi/agent/auth.json`.
// Invisible to session-log attribution: the sessions run via `SessionManager.inMemory`,
// so no transcript is persisted (~4 live prompts per adapter per run).
// See docs/investigations/or-workspace-attribution-2026-10.md.

/**
 * Real agent sessions: injection starts a turn, the auto-reply answers once,
 * and the model's own send.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { scrubSubagentEnv } from "../helpers/subagent-env.ts";
import { ADAPTERS } from "./adapters/index.ts";
import { type Bus, type PiPeer, fresh, injectedWith, until } from "./bus.ts";

// Billed model calls: `.env.test`'s injected gate env (pi-config#22) must not reach them.
const restoreSubagentEnv = scrubSubagentEnv();
afterAll(restoreSubagentEnv);

const fromPeer = (p: PiPeer, sender: string) => p.injected.filter((m) => m.text.startsWith(`[peer:${sender}]`));

for (const adapter of ADAPTERS) {
	describe(`${adapter.name}: live sessions`, () => {
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

		it("a peer message starts a turn and is auto-replied once", async () => {
			const alice = await bus.connect(fresh("alice"), "pi");
			const bob = await bus.connectLive(fresh("bob"), ["who"]);
			await bus.send(alice, bob.name, "ping from alice", { expectReply: true });
			await until(() => bob.userTexts().find((t) => t.startsWith(`[peer:${alice.name}] ping from alice`)), 60_000, "injected in bob");
			await bob.settled();
			await injectedWith(alice, `[peer:${bob.name}]`, 60_000);
			await Bun.sleep(2_000);
			expect(fromPeer(alice, bob.name)).toHaveLength(1);
			expect(fromPeer(alice, bob.name)[0].text.length).toBeGreaterThan(`[peer:${bob.name}] `.length);
		}, 240_000);

		it("the model sends with the send tool; a one-way send steers", async () => {
			const bob = await bus.connect(fresh("bob"), "pi");
			const alice = await bus.connectLive(fresh("alice"), ["who", "send"]);
			await alice.prompt(
				`Use the ${bus.toolName("send")} tool to send the message 'ping from alice' to the peer named '${bob.name}'. ` +
					"Do not use any other tools. Do not reply with text — the tool call is the whole task.",
			);
			await alice.settled();
			const got = await injectedWith(bob, "ping from alice", 60_000);
			expect(got.text.startsWith(`[peer:${alice.name}]`)).toBe(true);
			expect(got.deliverAs).toBe("steer");
		}, 240_000);

		it("an explicit send to the asker is its reply: no auto-reply follows", async () => {
			const alice = await bus.connect(fresh("alice"), "pi");
			const bob = await bus.connectLive(fresh("bob"), ["who", "send"]);
			await bus.send(
				alice,
				bob.name,
				`Call the ${bus.toolName("send")} tool with the message 'pong from bob' to the peer named '${alice.name}'. ` +
					"After the tool call, reply with the text 'answer for alice' and nothing else.",
				{ expectReply: true },
			);
			await injectedWith(alice, "pong from bob", 120_000);
			await bob.settled();
			await Bun.sleep(2_000);
			expect(fromPeer(alice, bob.name)).toHaveLength(1);
		}, 240_000);

		it("a send to another peer does not answer the asker's reply request", async () => {
			const alice = await bus.connect(fresh("alice"), "pi");
			const carol = await bus.connect(fresh("carol"), "pi");
			const bob = await bus.connectLive(fresh("bob"), ["who", "send"]);
			await bus.send(
				alice,
				bob.name,
				`Call the ${bus.toolName("send")} tool with the message 'hello from bob' to the peer named '${carol.name}'. ` +
					"After the tool call, reply with the text 'answer for alice' and nothing else.",
				{ expectReply: true },
			);
			await injectedWith(carol, "hello from bob", 120_000);
			await injectedWith(alice, `[peer:${bob.name}]`, 120_000);
			await Bun.sleep(2_000);
			expect(fromPeer(alice, bob.name)).toHaveLength(1);
			expect(fromPeer(carol, bob.name).filter((m) => m.text.includes("hello from bob"))).toHaveLength(1);
		}, 240_000);
	});
}
