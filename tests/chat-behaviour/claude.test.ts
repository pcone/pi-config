/**
 * Claude Code peers: the CLI as Claude Code's hooks and Bash tool run it.
 *
 * Delivery here is at-most-once: a hook, a watch or a reply-wait claims what
 * it prints (decision external-tools/012).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { scrubSubagentEnv } from "../helpers/subagent-env.ts";
import { ADAPTERS } from "./adapters/index.ts";
import { type Bus, type ClaudePeer, type PiPeer, fresh, injectedWith } from "./bus.ts";

const restoreSubagentEnv = scrubSubagentEnv();
afterAll(restoreSubagentEnv);

const sid = () => crypto.randomUUID();

for (const adapter of ADAPTERS) {
	describe(`${adapter.name}: Claude peers`, () => {
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

		async function pair(): Promise<{ me: ClaudePeer; bob: PiPeer }> {
			const bob = await bus.connect(fresh("bob"), "pi", { sessionFile: "/s/bug-triage.jsonl" });
			const me = await bus.connect(sid(), "claude");
			return { me, bob };
		}

		it("session-start names the session; a pi send reaches its next prompt, once; session-end ends it", async () => {
			const id = sid();
			const me = await bus.connect(id, "claude");
			const start = await me.hook("session-start");
			expect(start.code).toBe(0);
			expect(JSON.parse(start.out).hookSpecificOutput.additionalContext).toContain(me.name);

			const bob = await bus.connect(fresh("bob"), "pi");
			await bus.send(bob, me.name, "issue #42 filed");
			const prompt = await bus.pushed(me);
			expect(prompt.code).toBe(0);
			const ctx = JSON.parse(prompt.out).hookSpecificOutput;
			expect(ctx.hookEventName).toBe("UserPromptSubmit");
			expect(ctx.additionalContext).toContain(`[peer:${bob.name}] issue #42 filed`);
			expect((await bus.pushed(me)).out).not.toContain("issue #42 filed");

			expect((await me.hook("session-end")).code).toBe(0);
			expect(await bus.presence(me.name)).not.toBe("online");
		}, 60_000);

		// WO-2026-107 table row 3, replacing :72 and :84.
		it("a Claude session is online from session-start until session-end, or until its process exits", async () => {
			const { me, bob } = await pair();
			expect(await bus.presence(me.name)).toBe("online");
			await bus.send(bob, me.name, "live delivery", { requireOnline: true });
			expect((await bus.pushed(me)).out).toContain("live delivery");
			await me.hook("session-end");
			await bus.untilOffline(me.name);
			await expect(bus.send(bob, me.name, "after the end", { requireOnline: true })).rejects.toThrow(/offline/);

			const other = await bus.connect(crypto.randomUUID(), "claude");
			expect(await bus.presence(other.name)).toBe("online");
			await bus.disconnect(other);
			expect(await bus.presence(other.name)).toBe("offline");
		}, 60_000);

		it("a prompt claims its mail: an Escape-aborted prompt does not re-emit it", async () => {
			const { me, bob } = await pair();
			await bus.send(bob, me.name, "mail lost to Escape");
			expect((await bus.pushed(me)).out).toContain("mail lost to Escape");
			expect((await bus.pushed(me)).out).not.toContain("mail lost to Escape");
		}, 60_000);

		it("a prompt claims only what it shows; mid-turn arrivals wait for the next prompt", async () => {
			const { me, bob } = await pair();
			await bus.send(bob, me.name, "seen by the turn");
			expect((await bus.pushed(me)).out).toContain("seen by the turn");
			await bus.send(bob, me.name, "arrived mid-turn");
			const next = (await bus.pushed(me)).out;
			expect(next).toContain("arrived mid-turn");
			expect(next).not.toContain("seen by the turn");
		}, 60_000);

		it("renders mail oldest first, with the reply command when a reply is asked", async () => {
			const { me, bob } = await pair();
			await bus.send(bob, me.name, "first");
			await Bun.sleep(20);
			await bus.send(bob, me.name, "second", { expectReply: true });
			const out = (await bus.pushed(me)).out;
			expect(out.indexOf("first")).toBeLessThan(out.indexOf("second"));
			expect(out).toContain(`send --from ${me.name} ${bob.name}`);
		}, 60_000);

		// WO-2026-107 table row 5, replacing :167's message.
		it("chat hook stop exits 1 as an unknown subcommand", async () => {
			const { me } = await pair();
			const r = await me.hook("stop");
			expect(r.code).toBe(1);
			expect(r.err).toContain('unknown hook subcommand "stop"');
		}, 60_000);

		it("sends to a pi peer from stdin with --reply: the text arrives as a reply request", async () => {
			const { me, bob } = await pair();
			const r = await me.run(["send", ...me.from, "--reply", bob.name, "-"], "repro: x\nwhere: y\n");
			expect(r.code).toBe(0);
			const got = await injectedWith(bob, "repro: x");
			expect(got.text).toBe(`[peer:${me.name}] repro: x\nwhere: y`);
			expect(got.deliverAs).toBe("followUp");
		}, 60_000);

		it("fails loud: an unknown target, an unregistered sender, requireOnline to an offline peer", async () => {
			const { me, bob } = await pair();
			const unknown = await me.run(["send", ...me.from, fresh("nobody"), "hi"]);
			expect(unknown.code).toBe(1);
			expect(unknown.err).toContain(bob.name);

			const forged = await me.run(["send", "--from", "claude-forged", bob.name, "hi"]);
			expect(forged.code).toBe(1);

			await bus.disconnect(bob);
			const offline = await me.run(["send", ...me.from, "--require-online", bob.name, "hi"]);
			expect(offline.code).toBe(1);
			const back = await bus.connect(bob.name, "pi");
			await Bun.sleep(500);
			expect(back.injected.map((m) => m.text).join("\n")).not.toContain("[peer:claude-forged]");
			expect(back.injected).toEqual([]);
		}, 60_000);

		it("the peer list shows a pi peer's session log, else its cwd", async () => {
			const { me, bob } = await pair();
			const other = await bus.connect(fresh("nolog"), "pi", { cwd: "/w/other" });
			const out = await bus.who(me);
			expect(out).toMatch(new RegExp(`${bob.name}.*/s/bug-triage\\.jsonl`));
			expect(out).toMatch(new RegExp(`${other.name}.*/w/other`));
		}, 60_000);

		describe("send --wait", () => {
			it("a reply from the target ends the wait: exit 0, printed, and not shown again at the next prompt", async () => {
				const { me, bob } = await pair();
				const waiter = bus.wait(me, bob.name, "hi", 1);
				try {
					await injectedWith(bob, "hi");
					await bus.send(bob, me.name, "the answer");
					const r = await waiter.exited;
					expect(r.code).toBe(0);
					expect(r.out).toContain("the answer");
				} finally {
					waiter.kill();
				}
				expect((await bus.pushed(me)).out).not.toContain("the answer");
			}, 60_000);

			it("mail from the target sent before the send does not end the wait", async () => {
				const { me, bob } = await pair();
				await bus.send(bob, me.name, "old news");
				await Bun.sleep(300);
				const r = await bus.wait(me, bob.name, "hi", 0.03).exited;
				expect(r.code).toBe(4);
				expect(r.out).toContain(`no reply from ${bob.name}`);
				expect(r.out).not.toContain("old news");
			}, 60_000);

			it("a check-in names the target's session log", async () => {
				const { me, bob } = await pair();
				const r = await bus.wait(me, bob.name, "hi", 0.03).exited;
				expect(r.code).toBe(4);
				expect(r.out).toContain("/s/bug-triage.jsonl");
			}, 60_000);

			it("the target going offline ends the wait with exit 3", async () => {
				const { me, bob } = await pair();
				const waiter = bus.wait(me, bob.name, "hi", 1);
				try {
					await injectedWith(bob, "hi");
					await bus.disconnect(bob);
					const r = await waiter.exited;
					expect(r.code).toBe(3);
					expect(r.out).toContain(`${bob.name} is no longer online`);
				} finally {
					waiter.kill();
				}
			}, 60_000);

			it("--wait implies --require-online: an offline target fails before sending", async () => {
				const { me, bob } = await pair();
				await bus.disconnect(bob);
				const r = await bus.wait(me, bob.name, "hi", 1).exited;
				expect(r.code).toBe(1);
				expect(r.err).toContain("requireOnline");
				const back = await bus.connect(bob.name, "pi");
				await Bun.sleep(500);
				expect(back.injected).toEqual([]);
			}, 60_000);

			it("--wait rejects a non-positive or non-numeric value before sending", async () => {
				const { me, bob } = await pair();
				for (const bad of ["0", "x", "-1"]) {
					const r = await me.run(["send", ...me.from, "--wait", bad, bob.name, "hi"]);
					expect(r.code).toBe(1);
					expect(r.err).toContain("--wait needs a positive number of minutes");
				}
				await Bun.sleep(300);
				expect(bob.injected).toEqual([]);
			}, 60_000);
		});

		describe("the watch", () => {
			it("direct mail wakes the watch: exit 0 with the mail and the restart line", async () => {
				const { me, bob } = await pair();
				const watcher = bus.watch(me);
				try {
					await bus.untilWatching(me);
					await bus.send(bob, me.name, "direct ask");
					const r = await watcher.exited;
					expect(r.code).toBe(0);
					expect(r.out).toContain(`[peer:${bob.name}] direct ask`);
					expect(r.out).toContain("watch");
				} finally {
					watcher.kill();
				}
				expect((await bus.pushed(me)).out).not.toContain("direct ask");
			}, 60_000);

			it("a live reply-wait owns its reply: the watch does not claim it, the waiter does", async () => {
				const { me, bob } = await pair();
				const watcher = bus.watch(me);
				const waiter = bus.wait(me, bob.name, "question", 1);
				try {
					await bus.untilWatching(me);
					await injectedWith(bob, "question");
					await bus.send(bob, me.name, "the answer");
					const r = await waiter.exited;
					expect(r.code).toBe(0);
					expect(r.out).toContain("the answer");
					await Bun.sleep(1_500);
					const raced = await Promise.race([watcher.exited, Bun.sleep(10).then(() => undefined)]);
					expect(raced).toBeUndefined();
				} finally {
					watcher.kill();
					waiter.kill();
				}
			}, 60_000);

			it("a prompt hook skips a reply a live reply-wait owns", async () => {
				const { me, bob } = await pair();
				const waiter = bus.wait(me, bob.name, "question", 1);
				try {
					await injectedWith(bob, "question");
					await bus.send(bob, me.name, "owned reply");
					expect((await bus.pushed(me)).out).not.toContain("owned reply");
					const r = await waiter.exited;
					expect(r.out).toContain("owned reply");
				} finally {
					waiter.kill();
				}
			}, 60_000);

			it("a second watch for the same session is refused with exit 2", async () => {
				const { me } = await pair();
				const first = bus.watch(me);
				try {
					await bus.untilWatching(me);
					const second = await bus.watch(me).exited;
					expect(second.code).toBe(2);
					expect(second.err).toContain("already running");
				} finally {
					first.kill();
				}
			}, 60_000);

			it("a watch exits 3 when the session's registration ends", async () => {
				const { me } = await pair();
				const watcher = bus.watch(me);
				try {
					await bus.untilWatching(me);
					await me.hook("session-end");
					const r = await watcher.exited;
					expect(r.code).toBe(3);
				} finally {
					watcher.kill();
				}
			}, 60_000);

			it("a watch exits once its Claude Code process is gone", async () => {
				const { me } = await pair();
				const watcher = bus.watch(me);
				await bus.untilWatching(me);
				await me.exit();
				const r = await watcher.gone();
				expect(r.out).toContain("watch exiting");
			}, 60_000);

			it("the prompt hook nudges a watch when mail is pending and none is live, not when one is", async () => {
				const { me, bob } = await pair();
				await bus.send(bob, me.name, "first");
				expect((await bus.pushed(me)).out).toContain("no watch is running");
				const watcher = bus.watch(me);
				try {
					await bus.untilWatching(me);
					const quiet = await bus.pushed(me);
					expect(quiet.out).not.toContain("no watch is running");
				} finally {
					watcher.kill();
				}
			}, 60_000);

			it("a prompt with no mail and a live watch emits nothing", async () => {
				const { me } = await pair();
				const watcher = bus.watch(me);
				try {
					await bus.untilWatching(me);
					const r = await bus.pushed(me);
					expect(r.code).toBe(0);
					expect(r.out).toBe("");
				} finally {
					watcher.kill();
				}
			}, 60_000);
		});
	});
}
