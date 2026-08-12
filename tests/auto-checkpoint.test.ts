/**
 * Tests for auto-checkpoint threshold resolution and arming.
 *
 * Two bugs these pin:
 *  1. resolveThreshold's default branch used to multiply defaultThreshold by
 *     contextWindow unconditionally — so an absolute default (e.g. 256000)
 *     resolved to 256000 * window (effectively never fires). The default must
 *     follow the same < 1 = fraction, >= 1 = absolute rule as per-model entries.
 *  2. The nudge never armed for resumed / default-model sessions: model_select
 *     only fires on explicit set/cycle, never on resume/startup, and ctx.model
 *     is undefined at session_start. turn_end must self-heal by (re-)deriving
 *     from ctx.model.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveThreshold, matchPattern, default as loadExtension } from "../extensions/auto-checkpoint";

// ---------------------------------------------------------------------------
// resolveThreshold
// ---------------------------------------------------------------------------

describe("resolveThreshold", () => {
	const base = {
		defaultThreshold: 256000,
		smallWindowFraction: 0.8,
		cooldownTurns: 3,
		cooldownMs: 30_000,
		models: {},
		prompt: "x",
		defaultContextDegradation: true,
	};

	it("uses the absolute default as-is when the window is large enough", () => {
		// 0.8 * window >= 256000  when window >= 320000 → absolute wins.
		for (const cw of [320_000, 400_000, 1_048_576]) {
			expect(resolveThreshold("any/model", cw, base)).toBe(256000);
		}
	});

	it("caps an absolute default at smallWindowFraction when the window is smaller", () => {
		expect(resolveThreshold("any/model", 163_840, base)).toBe(131_072); // 0.8 * 163840
		expect(resolveThreshold("any/model", 200_000, base)).toBe(160_000); // 0.8 * 200000
		expect(resolveThreshold("any/model", 300_000, base)).toBe(240_000); // 0.8 * 300000 < 256000
	});

	it("respects a configured smallWindowFraction", () => {
		const cfg = { ...base, smallWindowFraction: 0.9 };
		expect(resolveThreshold("any/model", 200_000, cfg)).toBe(180_000); // 0.9 * 200000
	});

	it("treats a fractional default (<1) as a fraction of the window", () => {
		const cfg = { ...base, defaultThreshold: 0.75 };
		expect(resolveThreshold("any/model", 200_000, cfg)).toBe(150_000);
		expect(resolveThreshold("any/model", 1_048_576, cfg)).toBe(786_432);
	});

	it("per-model entries override the default and respect absolute vs fractional", () => {
		const cfg = {
			...base,
			defaultThreshold: 256000,
			models: {
				"deepseek/deepseek-v4-flash-*": { threshold: 200_000 }, // absolute (below cap)
				"openai/gpt-*": { threshold: 0.7 }, // fraction (uncapped)
				"weird/huge": { threshold: 500_000 }, // absolute, capped on small windows
			},
		};
		expect(resolveThreshold("deepseek/deepseek-v4-flash-0731", 1_048_576, cfg)).toBe(200_000);
		expect(resolveThreshold("openai/gpt-5", 200_000, cfg)).toBe(140_000);
		expect(resolveThreshold("weird/huge", 200_000, cfg)).toBe(160_000); // capped to 0.8*200000
		expect(resolveThreshold("zai/glm-5.2", 1_048_576, cfg)).toBe(256000); // falls to default
	});
});

describe("matchPattern", () => {
	it("matches exact, *, and ? case-insensitively", () => {
		expect(matchPattern("deepseek/deepseek-v4-flash-0731", "deepseek/deepseek-v4-flash-0731")).toBe(true);
		expect(matchPattern("deepseek/*", "deepseek/deepseek-v4-flash-0731")).toBe(true);
		expect(matchPattern("deepseek/*", "openai/gpt-5")).toBe(false);
		expect(matchPattern("deepseek/deepseek-v4-flash-??31", "deepseek/deepseek-v4-flash-0731")).toBe(true);
		expect(matchPattern("anthropic/claude-sonnet-*", "Anthropic/Claude-Sonnet-4")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Arming self-heal: nudge fires even when session_start saw no model
// (the resumed / default-model case that left 95% of >250k sessions unsteered)
// ---------------------------------------------------------------------------

describe("arming self-heal on turn_end", () => {
	let dir: string;
	const handlers = new Map<string, (event: any, ctx: any) => Promise<any> | any>();

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-acp-test-"));
		await mkdir(join(dir, ".pi"), { recursive: true });
		await writeFile(
			join(dir, ".pi", "auto-checkpoint.json"),
			JSON.stringify({ defaultThreshold: 256000, cooldownTurns: 3, cooldownMs: 30000 }),
		);
		const fakePi: any = {
			on(event: string, handler: any) {
				handlers.set(event, handler);
			},
			registerCommand() {},
		};
		loadExtension(fakePi);

		// session_start with NO model (resume/startup before model is set):
		// loads config but must not arm a threshold.
		await handlers.get("session_start")!({ type: "session_start", reason: "new" }, { cwd: dir, model: undefined });
	});
	afterAll(async () => {
		try { await rm(dir, { recursive: true, force: true }); } catch {}
	});

	it("arms from ctx.model at turn_end and delivers the nudge at before_agent_start", async () => {
		const model = { id: "deepseek/deepseek-v4-flash-0731", contextWindow: 1_048_576 };
		const ctx = {
			cwd: dir,
			model,
			getContextUsage: () => ({ tokens: 300_000, contextWindow: 1_048_576, percent: 28.6 }),
		};
		// Above the 256000 default threshold, past cooldown (turnIndex large,
		// lastNudgedMs < 0 → msSinceLast = Infinity).
		await handlers.get("turn_end")!({ type: "turn_end", turnIndex: 5 }, ctx);

		const res = await handlers.get("before_agent_start")!(
			{ type: "before_agent_start" },
			{ cwd: dir, model },
		);
		expect(res).toBeDefined();
		expect(res.message.customType).toBe("auto-checkpoint");
		expect(res.message.content).toContain("300,000");
	});

	it("does not nudge below the threshold", async () => {
		const model = { id: "deepseek/deepseek-v4-flash-0731", contextWindow: 1_048_576 };
		// Force a distinct model id so the lazy-derive re-arms cleanly, then a
		// below-threshold usage must not pend a nudge.
		const ctx = {
			cwd: dir,
			model,
			getContextUsage: () => ({ tokens: 100_000, contextWindow: 1_048_576, percent: 9.5 }),
		};
		await handlers.get("turn_end")!({ type: "turn_end", turnIndex: 10 }, ctx);
		const res = await handlers.get("before_agent_start")!(
			{ type: "before_agent_start" },
			{ cwd: dir, model },
		);
		expect(res).toBeUndefined();
	});
});
