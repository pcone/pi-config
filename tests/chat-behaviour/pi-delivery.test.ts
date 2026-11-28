/**
 * Row provenance: `// inventory:` lines name the old suite's row, listed in
 * ~/Developer/notes/stage3/peer-link-rows.md.
 *
 * pi peers: addressing, the send gate, delivery and its timing, identity, and
 * init failure.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { hostname } from "node:os";
import { scrubSubagentEnv } from "../helpers/subagent-env.ts";
import { ADAPTERS } from "./adapters/index.ts";
import { type Bus, type PiPeer, fresh, injectedWith } from "./bus.ts";

const restoreSubagentEnv = scrubSubagentEnv();
afterAll(restoreSubagentEnv);

const NAME_RULE = /1-64 chars of \[A-Za-z0-9._-\]/;

for (const adapter of ADAPTERS) {
	describe(`${adapter.name}: pi delivery`, () => {
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

		// inventory: peer-link.test.ts:101
		it("a send to a connected pi peer is injected as [peer:<sender>] <text>", async () => {
			const bob = await bus.connect(fresh("bob"), "pi");
			const alice = await bus.connect(fresh("alice"), "pi");
			await bus.send(alice, bob.name, "hello bob");
			const got = await injectedWith(bob, "hello bob");
			expect(got.text).toBe(`[peer:${alice.name}] hello bob`);
			expect(alice.injected).toEqual([]);
		}, 30_000);

		// 015/38 (WO-2026-107 § 3): the injected text carries the whole body, never truncated.
		it("a multi-paragraph message arrives intact", async () => {
			const bob = await bus.connect(fresh("bob"), "pi");
			const alice = await bus.connect(fresh("alice"), "pi");
			const body = ["first paragraph", "x".repeat(3_000), "- a list\n- of lines", "last paragraph"].join("\n\n");
			await bus.send(alice, bob.name, body);
			expect((await injectedWith(bob, "last paragraph")).text).toBe(`[peer:${alice.name}] ${body}`);
		}, 30_000);

		// inventory: peer-link.test.ts:83 (shape half; path traversal is a file-layout row)
		it("a send to a name outside the peer-name rule fails naming the rule", async () => {
			const alice = await bus.connect(fresh("alice"), "pi");
			for (const bad of ["../etc", "a/b", "x".repeat(65), "has space", ".hidden"]) {
				await expect(bus.send(alice, bad, "hi")).rejects.toThrow(NAME_RULE);
			}
		}, 30_000);

		// inventory: peer-link.test.ts:143
		it("delivery mode: one-way steers by default; followUp opts in; expectReply always pivots", async () => {
			const bob = await bus.connect(fresh("bob"), "pi");
			const alice = await bus.connect(fresh("alice"), "pi");
			await bus.send(alice, bob.name, "plain one-way");
			await bus.send(alice, bob.name, "follow-up one-way", { followUp: true });
			await bus.send(alice, bob.name, "a question", { expectReply: true });
			expect((await injectedWith(bob, "plain one-way")).deliverAs).toBe("steer");
			expect((await injectedWith(bob, "follow-up one-way")).deliverAs).toBe("followUp");
			expect((await injectedWith(bob, "a question")).deliverAs).toBe("followUp");
		}, 30_000);

		// inventory: peer-link.test.ts:121, 642
		it("mail to a known offline peer is delivered when it next connects", async () => {
			const bobName = fresh("bob");
			const first = await bus.connect(bobName, "pi");
			await bus.disconnect(first);
			const alice = await bus.connect(fresh("alice"), "pi");
			const r = await bus.send(alice, bobName, "queued while you were away");
			expect(r.text).toContain(bobName);
			const bob = await bus.connect(bobName, "pi");
			const got = await injectedWith(bob, "queued while you were away");
			expect(got.text).toBe(`[peer:${alice.name}] queued while you were away`);
		}, 30_000);

		// inventory: peer-link.test.ts:189
		it("a UUID-tail address reaches the peer with that full name", async () => {
			const tail = crypto.randomUUID();
			const full = `2026-08-12T00-34-37-476Z_${tail}`;
			const bob = await bus.connect(full, "pi");
			const alice = await bus.connect(fresh("alice"), "pi");
			const r = await bus.send(alice, tail, "by tail");
			expect(r.text).toContain(full);
			expect((await injectedWith(bob, "by tail")).text).toBe(`[peer:${alice.name}] by tail`);
		}, 30_000);

		// inventory: peer-link.test.ts:222–247
		describe("the send gate", () => {
			it("an online target accepts, with or without requireOnline", async () => {
				const bob = await bus.connect(fresh("bob"), "pi");
				const alice = await bus.connect(fresh("alice"), "pi");
				await bus.send(alice, bob.name, "one");
				await bus.send(alice, bob.name, "two", { requireOnline: true });
				await injectedWith(bob, "two");
			}, 30_000);

			it("an offline target accepts without requireOnline and refuses with it", async () => {
				const bobName = fresh("bob");
				await bus.disconnect(await bus.connect(bobName, "pi"));
				const alice = await bus.connect(fresh("alice"), "pi");
				await bus.send(alice, bobName, "queued");
				await expect(bus.send(alice, bobName, "must be live", { requireOnline: true })).rejects.toThrow(
					/offline.*requireOnline/,
				);
				const bob = await bus.connect(bobName, "pi");
				await injectedWith(bob, "queued");
				await Bun.sleep(300);
				expect(bob.injected.map((m) => m.text).join("\n")).not.toContain("must be live");
			}, 30_000);

			it("an unknown target is refused, listing the known peers, with or without requireOnline", async () => {
				const bob = await bus.connect(fresh("bob"), "pi");
				const alice = await bus.connect(fresh("alice"), "pi");
				const nobody = fresh("nobody");
				await expect(bus.send(alice, nobody, "hi")).rejects.toThrow(bob.name);
				await expect(bus.send(alice, nobody, "hi", { requireOnline: true })).rejects.toThrow(nobody);
			}, 30_000);
		});

		// inventory: peer-link.test.ts:254–270
		describe("identity", () => {
			it("PI_PEER_NAME wins over the display name", async () => {
				const name = fresh("alice");
				const p = await bus.connect(name, "pi", { sessionName: "bug-triage" });
				expect(p.name).toBe(name);
			}, 30_000);

			it("without PI_PEER_NAME, a name-shaped display name is the identity, trimmed", async () => {
				const name = fresh("triage");
				const p = await bus.connect(name, "pi", { noEnvName: true, sessionName: `  ${name}  ` });
				expect(p.name).toBe(name);
			}, 30_000);

			it("a display name that is not name-shaped falls through to host-pid", async () => {
				const p = await bus.connect("unused", "pi", { noEnvName: true, sessionName: "Refactor auth" });
				expect(p.name).toBe(`${hostname()}-${process.pid}`);
			}, 30_000);
		});

		// inventory: peer-link.test.ts:341, 389
		describe("at-least-once injection", () => {
			it("an injection that throws is not lost: it is retried and delivered", async () => {
				let failNext = true;
				const attempts: string[] = [];
				const bob = await bus.connect(fresh("bob"), "pi", {
					inject: (text) => {
						attempts.push(text);
						if (failNext) {
							failNext = false;
							throw new Error("simulated sendUserMessage failure");
						}
					},
				});
				const alice = await bus.connect(fresh("alice"), "pi");
				await bus.send(alice, bob.name, "retry me");
				await injectedWith(bob, "retry me", 20_000);
				expect(attempts.filter((t) => t.includes("retry me")).length).toBeGreaterThanOrEqual(2);
			}, 40_000);

			it("one failing injection does not hold back the others; it is retried until it delivers", async () => {
				let badFails = true;
				const bob = await bus.connect(fresh("bob"), "pi", {
					inject: (text) => {
						if (badFails && text.includes("bad message")) throw new Error("simulated sendUserMessage failure");
					},
				});
				const alice = await bus.connect(fresh("alice"), "pi");
				await bus.send(alice, bob.name, "bad message");
				await bus.send(alice, bob.name, "good message");
				await injectedWith(bob, "good message", 20_000);
				expect(bob.injected.some((m) => m.text.includes("bad message"))).toBe(false);
				badFails = false;
				await injectedWith(bob, "bad message", 20_000);
			}, 40_000);
		});

		// inventory: peer-link.test.ts:597, 612
		describe("init failure", () => {
			it("a throwing getSessionId rejects session_start naming the init, and notifies the human", async () => {
				let err: (Error & { standin?: PiPeer }) | undefined;
				try {
					await bus.connect(fresh("alice"), "pi", { failInit: true });
				} catch (e) {
					err = e as Error & { standin?: PiPeer };
				}
				expect(err?.message).toMatch(/init failed.*getSessionId/);
				const notices = err?.standin?.notices ?? [];
				expect(notices).toHaveLength(1);
				expect(notices[0].message).toContain("init failed");
				expect(notices[0].level).toBe("error");
			}, 30_000);

			it("a failed init delivers nothing, even mail already waiting", async () => {
				const aliceName = fresh("alice");
				await bus.disconnect(await bus.connect(aliceName, "pi"));
				const bob = await bus.connect(fresh("bob"), "pi");
				await bus.send(bob, aliceName, "queued before a failed init");
				let standin: PiPeer | undefined;
				try {
					await bus.connect(aliceName, "pi", { failInit: true });
				} catch (e) {
					standin = (e as { standin?: PiPeer }).standin;
				}
				expect(standin).toBeDefined();
				await Bun.sleep(2_500);
				expect(standin?.injected).toEqual([]);
				expect(await bus.presence(aliceName)).not.toBe("online");
			}, 30_000);
		});
	});
}
