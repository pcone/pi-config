/**
 * A model HTTP error mails a peer, throttled (decision external-tools/008;
 * docs/design/model-error-mail.md). Ported from tests/model-error-mail.test.ts.
 *
 * Module rows drive the transport's mail module over a recipient list the row
 * controls, with a fake clock. Wired rows drive the transport's pi extension
 * with real peers and assert which peer received the mail.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { scrubSubagentEnv } from "../helpers/subagent-env.ts";
import { ADAPTERS, asRuled, asToday } from "./adapters/index.ts";
import { type Bus, type MailPeer, type Peer, type PiPeer, fresh, injectedWith, until } from "./bus.ts";

const restoreSubagentEnv = scrubSubagentEnv();
afterAll(restoreSubagentEnv);

// Corpus strings, verbatim `errorMessage` values from this box's session logs.
const E_429 = '429: {"code":"1302","message":"Rate limit reached for requests"}';
const E_503 = '503: {"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}';
const E_529 =
	'529 {"type":"error","error":{"type":"overloaded_error","message":"The server cluster is currently under high load. Please retry after a short wait and thank you for your patience. (2064) (529)"},"request_id":"062bd6b14136c890de0bacf068e7af8b"}';
const E_429_RATE = "429 Sorry, you've exhausted this model's rate limit";
const NOT_HTTP_ERRORS = [
	"terminated",
	"Operation aborted",
	"Request timed out.",
	"Connection error.",
	"Stream ended without finish_reason",
	"This operation was aborted",
	"Provider returned error",
];

const SELF = "self-seat";
const SID = "session-019ff364-0000-7000-8000-000000000000";
const CORRESPONDENT = "oracle-seat";
const err = (errorMessage: string) => ({ stopReason: "error", errorMessage, provider: "opencode-go", model: "deepseek-v4.1-flash" });
const ok = { stopReason: "stop", provider: "opencode-go", model: "deepseek-v4.1-flash" };
const online = (name: string, kind: MailPeer["kind"] = "pi"): MailPeer => ({ name, online: true, kind });

/** A failed request as pi emits it at `message_end`. */
function errorEnd(errorMessage = E_429) {
	return {
		message: {
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: "opencode-go",
			model: "deepseek-v4.1-flash",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
			stopReason: "error",
			errorMessage,
			timestamp: Date.now(),
		},
	};
}

for (const adapter of ADAPTERS) {
	const m = adapter.mail;
	const harness = (o: { correspondent?: string; peers?: MailPeer[] } = {}) =>
		m.harness({ self: SELF, sessionId: SID, cwd: "/work/tfd", correspondent: o.correspondent, peers: o.peers ?? [] });

	describe(`${adapter.name}: model-error mail, module (model-error-mail.test.ts:149–394, 870–908)`, () => {
		it("reads the leading status of an HTTP error message", () => {
			expect(m.modelHttpStatus(E_429)).toBe(429);
			expect(m.modelHttpStatus(E_503)).toBe(503);
			expect(m.modelHttpStatus(E_529)).toBe(529);
			expect(m.modelHttpStatus(E_429_RATE)).toBe(429);
			expect(m.modelHttpStatus("  500: {")).toBe(500);
			expect(m.modelHttpStatus("520: {")).toBe(520);
		});

		it("does not read a non-HTTP failure as an HTTP error, and requires the status to lead", () => {
			for (const text of NOT_HTTP_ERRORS) expect(m.modelHttpStatus(text)).toBeUndefined();
			expect(m.modelHttpStatus("Streaming response failed: [500] Internal Server Error")).toBeUndefined();
			expect(m.modelHttpStatus("Internal Server Error")).toBeUndefined();
			expect(m.modelHttpStatus("")).toBeUndefined();
			expect(m.modelHttpStatus(undefined)).toBeUndefined();
		});

		it("a 429 mails the correspondent once: status, session, cwd, model and the message, nothing else", async () => {
			const h = await harness({ correspondent: CORRESPONDENT, peers: [online(CORRESPONDENT)] });
			await h.onAssistantMessage(err(E_429));
			expect(h.inbox(CORRESPONDENT)).toEqual([
				[
					"[model-error] opencode-go/deepseek-v4.1-flash returned HTTP 429",
					`session: ${SELF} (${SID})`,
					"cwd: /work/tfd",
					`error: ${E_429}`,
				].join("\n"),
			]);
			expect(h.inbox(SELF)).toEqual([]);
		});

		it("truncates the carried message to 200 characters", async () => {
			const h = await harness({ correspondent: CORRESPONDENT, peers: [online(CORRESPONDENT)] });
			const long = `429: {"message":"${"x".repeat(400)}"}`;
			await h.onAssistantMessage(err(long));
			const line = h.inbox(CORRESPONDENT)[0].split("\n").find((l) => l.startsWith("error: "))!;
			expect(m.MAIL_ERROR_CHARS).toBe(200);
			expect(line.slice("error: ".length)).toBe(long.slice(0, 200));
		});

		for (const [text, status] of [
			[E_503, 503],
			[E_529, 529],
		] as const) {
			it(`mails a ${status}`, async () => {
				const h = await harness({ correspondent: CORRESPONDENT, peers: [online(CORRESPONDENT)] });
				await h.onAssistantMessage(err(text));
				expect(h.inbox(CORRESPONDENT)).toHaveLength(1);
				expect(h.inbox(CORRESPONDENT)[0]).toContain(`returned HTTP ${status}`);
			});
		}

		for (const text of NOT_HTTP_ERRORS) {
			it(`does not mail on ${JSON.stringify(text)}`, async () => {
				const h = await harness({ correspondent: CORRESPONDENT, peers: [online(CORRESPONDENT)] });
				await h.onAssistantMessage(err(text));
				expect(h.inbox(CORRESPONDENT)).toEqual([]);
				expect(h.warns).toEqual([]);
			});
		}

		it("throttle: three failures inside the window are one mail; the next after it carries the count", async () => {
			const h = await harness({ correspondent: CORRESPONDENT, peers: [online(CORRESPONDENT)] });
			const firstAt = h.clock.now;
			await h.onAssistantMessage(err(E_429));
			h.clock.now += 60_000;
			await h.onAssistantMessage(err(E_429));
			h.clock.now += 60_000;
			await h.onAssistantMessage(err(E_429));
			expect(h.inbox(CORRESPONDENT)).toHaveLength(1);
			expect(h.inbox(CORRESPONDENT)[0]).not.toContain("suppressed:");
			h.clock.now = firstAt + m.MAIL_THROTTLE_MS;
			await h.onAssistantMessage(err(E_429));
			const texts = h.inbox(CORRESPONDENT);
			expect(texts).toHaveLength(2);
			expect(texts.filter((t) => t.includes(`suppressed: 2 more qualifying failures since ${new Date(firstAt).toISOString()}`))).toHaveLength(1);
		});

		it("throttle: the window is exclusive at its boundary", async () => {
			const h = await harness({ correspondent: CORRESPONDENT, peers: [online(CORRESPONDENT)] });
			await h.onAssistantMessage(err(E_429));
			h.clock.now += m.MAIL_THROTTLE_MS - 1;
			await h.onAssistantMessage(err(E_429));
			expect(h.inbox(CORRESPONDENT)).toHaveLength(1);
			h.clock.now += 1;
			await h.onAssistantMessage(err(E_429));
			expect(h.inbox(CORRESPONDENT)).toHaveLength(2);
		});

		it("a good turn clears the window: the next failure mails at once, with no count", async () => {
			const h = await harness({ correspondent: CORRESPONDENT, peers: [online(CORRESPONDENT)] });
			await h.onAssistantMessage(err(E_429));
			h.clock.now += 60_000;
			await h.onAssistantMessage(err(E_429));
			await h.onAssistantMessage(ok);
			h.clock.now += 60_000;
			await h.onAssistantMessage(err(E_429));
			const texts = h.inbox(CORRESPONDENT);
			expect(texts).toHaveLength(2);
			expect(texts.every((t) => !t.includes("suppressed:"))).toBe(true);
		});

		it("no recipient: warns once across failures and mails nothing; a later recipient gets the next one", async () => {
			const h = await harness();
			await h.onAssistantMessage(err(E_429));
			h.clock.now += m.MAIL_THROTTLE_MS + 1;
			await h.onAssistantMessage(err(E_429));
			expect(h.warns).toHaveLength(1);
			expect(h.warns[0]).toContain("no recipient");
			h.peers.push(online("late-peer"));
			await h.onAssistantMessage(err(E_429));
			expect(h.inbox("late-peer")).toHaveLength(1);
		});

		it("the recipient is the last correspondent, not the online peers, across a restart too", async () => {
			const h = await harness({ peers: [online(CORRESPONDENT), online("bystander")] });
			h.recordCorrespondent(CORRESPONDENT);
			h.restart();
			await h.onAssistantMessage(err(E_429));
			expect(h.inbox(CORRESPONDENT)).toHaveLength(1);
			expect(h.inbox("bystander")).toEqual([]);
		});

		it("never addresses a session that mailed itself", async () => {
			const h = await harness({ correspondent: SELF, peers: [online("peer-a")] });
			await h.onAssistantMessage(err(E_429));
			expect(h.inbox(SELF)).toEqual([]);
			expect(h.inbox("peer-a")).toHaveLength(1);
		});

		it("with no correspondent, every online pi peer is mailed and an offline one is skipped", async () => {
			const h = await harness({ peers: [online("peer-a"), online("peer-b"), { name: "peer-away", online: false, kind: "pi" }] });
			await h.onAssistantMessage(err(E_429));
			expect(h.inbox("peer-a")).toHaveLength(1);
			expect(h.inbox("peer-b")).toHaveLength(1);
			expect(h.inbox("peer-away")).toEqual([]);
			expect(h.inbox(SELF)).toEqual([]);
		});

		// :702, :723 (design-changed: WO-2026-107 table row 4)
		asToday(adapter)("with no correspondent, a Claude peer is not in the sweep: alone it mails nothing; beside a pi peer, the pi peer only", async () => {
			const alone = await harness({ peers: [online("claude-8f90", "claude")] });
			await alone.onAssistantMessage(err(E_429));
			expect(alone.inbox("claude-8f90")).toEqual([]);
			expect(alone.warns).toHaveLength(1);
			const both = await harness({ peers: [online("pi-peer"), online("claude-8f90", "claude")] });
			await both.onAssistantMessage(err(E_429));
			expect(both.inbox("pi-peer")).toHaveLength(1);
			expect(both.inbox("claude-8f90")).toEqual([]);
		});

		// WO-2026-107 table row 4, replacing :371, :598, :702, :723.
		asRuled(adapter)("with no correspondent, every online non-subagent peer is mailed, a Claude one included", async () => {
			const h = await harness({ peers: [online("pi-peer"), online("claude-8f90", "claude"), online("sub-1", "subagent")] });
			await h.onAssistantMessage(err(E_429));
			expect(h.inbox("pi-peer")).toHaveLength(1);
			expect(h.inbox("claude-8f90")).toHaveLength(1);
			expect(h.inbox("sub-1")).toEqual([]);
			const alone = await harness({ peers: [online("claude-8f90", "claude")] });
			await alone.onAssistantMessage(err(E_429));
			expect(alone.inbox("claude-8f90")).toHaveLength(1);
			expect(alone.warns).toEqual([]);
		});

		it("composes the machine-generated marker, with the suppressed line only when something was dropped", () => {
			const body = { peerName: "seat", sessionId: "sid", cwd: "/work", provider: "zai", model: "glm-5.2", status: 503, errorMessage: E_503, suppressed: null };
			expect(m.composeModelErrorMail(body)).toBe(
				["[model-error] zai/glm-5.2 returned HTTP 503", "session: seat (sid)", "cwd: /work", `error: ${E_503}`].join("\n"),
			);
			const since = Date.parse("2026-11-03T04:00:00Z");
			expect(m.composeModelErrorMail({ ...body, status: 429, errorMessage: E_429, suppressed: { count: 7, since } }).split("\n").at(-1)).toBe(
				`suppressed: 7 more qualifying failures since ${new Date(since).toISOString()}`,
			);
		});
	});

	describe(`${adapter.name}: model-error mail, wired (model-error-mail.test.ts:506–864)`, () => {
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

		const MARK = "[model-error] opencode-go/deepseek-v4.1-flash returned HTTP 429";

		/** Whether `peer` received the mail: injected (pi) or printed at its next prompt (Claude). */
		async function gotMail(peer: Peer): Promise<boolean> {
			if (peer.kind === "claude") return (await bus.pushed(peer)).out.includes(MARK);
			await Bun.sleep(400);
			return peer.injected.some((x) => x.text.includes(MARK));
		}

		async function gotMailSoon(peer: PiPeer): Promise<void> {
			await injectedWith(peer, MARK);
		}

		// :512, :828
		it("the correspondent recorded on delivery is the only recipient", async () => {
			const corr = await bus.connect(fresh("corr"), "pi");
			const bystander = await bus.connect(fresh("bystander"), "pi");
			const me = await bus.connect(fresh("me"), "pi");
			await bus.send(corr, me.name, "status?");
			await injectedWith(me, "status?");
			await me.emit("message_end", errorEnd());
			await gotMailSoon(corr);
			expect(await gotMail(bystander)).toBe(false);
			expect(await gotMail(me)).toBe(false);
		}, 40_000);

		// :543
		it("the correspondent outlives a restart of the session", async () => {
			const corr = await bus.connect(fresh("corr"), "pi");
			const bystander = await bus.connect(fresh("bystander"), "pi");
			const meName = fresh("me");
			const first = await bus.connect(meName, "pi");
			await bus.send(corr, meName, "status?");
			await injectedWith(first, "status?");
			await bus.disconnect(first);
			const me = await bus.connect(meName, "pi");
			await me.emit("message_end", errorEnd());
			await gotMailSoon(corr);
			expect(await gotMail(bystander)).toBe(false);
		}, 40_000);

		// :558
		it("an offline correspondent falls to the peers online now", async () => {
			const corrName = fresh("corr");
			const corr = await bus.connect(corrName, "pi");
			const live = await bus.connect(fresh("live"), "pi");
			const me = await bus.connect(fresh("me"), "pi");
			await bus.send(corr, me.name, "status?");
			await injectedWith(me, "status?");
			await bus.disconnect(corr);
			await bus.untilOffline(corrName);
			await me.emit("message_end", errorEnd());
			await gotMailSoon(live);
		}, 40_000);

		// :576
		it("no live peer: warns once, mails nothing, and the next failure mails a peer that appeared", async () => {
			const me = await bus.connect(fresh("me"), "pi");
			await me.emit("message_end", errorEnd());
			const warnings = me.notices.filter((n) => n.level === "warning");
			expect(warnings).toHaveLength(1);
			expect(warnings[0].message).toContain("no recipient");
			const late = await bus.connect(fresh("late"), "pi");
			await until(async () => ((await bus.presence(late.name)) === "online" ? true : undefined), 10_000, "late online");
			await me.emit("message_end", errorEnd());
			await gotMailSoon(late);
		}, 40_000);

		// :654, :687
		it("a Claude correspondent receives it, and an online pi peer does not", async () => {
			const claude = await bus.connect(crypto.randomUUID(), "claude");
			const pi = await bus.connect(fresh("pi"), "pi");
			const me = await bus.connect(fresh("me"), "pi");
			await bus.send(claude, me.name, "status?");
			await injectedWith(me, "status?");
			await me.emit("message_end", errorEnd());
			await until(async () => ((await gotMail(claude)) ? true : undefined), 10_000, "mail at the Claude peer's prompt");
			expect(await gotMail(pi)).toBe(false);
		}, 40_000);

		// WO-2026-107 table row 4: no correspondent, so @pi-system DMs each online non-subagent peer.
		asRuled(adapter)("with no correspondent, @pi-system DMs each online non-subagent peer", async () => {
			const pi = await bus.connect(fresh("pi"), "pi");
			const claude = await bus.connect(crypto.randomUUID(), "claude");
			const sub = await bus.connect(fresh("sub"), "subagent");
			const me = await bus.connect(fresh("me"), "pi");
			await me.emit("message_end", errorEnd());
			const got = await injectedWith(pi, MARK);
			expect(got.text.startsWith("[peer:system] ")).toBe(true);
			await until(async () => ((await gotMail(claude)) ? true : undefined), 10_000, "mail at the Claude peer's prompt");
			expect(await gotMail(sub)).toBe(false);
		}, 40_000);

		// :773
		it("the mail adds nothing to the failing session", async () => {
			const corr = await bus.connect(fresh("corr"), "pi");
			const me = await bus.connect(fresh("me"), "pi");
			await bus.send(corr, me.name, "status?");
			await injectedWith(me, "status?");
			const before = me.injected.length;
			await me.emit("message_end", errorEnd());
			await gotMailSoon(corr);
			expect(me.injected.length).toBe(before);
		}, 40_000);
	});
}
