/**
 * Characterisation: the provider quota segment's exact bytes.
 *
 * Every row is a golden captured from the three pre-refactor renderers
 * (`renderQuotaSegment` for z.ai and MiniMax, `renderGoUsageSegment` for
 * OpenCode Go) before the provider-parameterised quota mechanism landed in
 * `extensions/lib/quota.ts`. The rows exist so the refactor is provably
 * behaviour-preserving (WO-2026-065 acceptance row 10): they pass unchanged
 * before and after, and any byte that moves is a rendered-output change.
 *
 * The reset instants are relative to `BASE` rather than absolute, because the
 * z.ai/MiniMax renderers derive reset durations from the real clock
 * (`Date.now()`), not from their `now` argument — that argument only drives
 * the z.ai peak/off-peak multiplier. `BASE + 47m` therefore renders `47m`
 * both before and after the refactor, which is what makes the golden stable
 * without pretending the clock is injectable.
 */
import { describe, expect, it } from "bun:test";
import {
	quotaDescriptorFor,
	renderGoUsageSegment,
	renderQuotaSegment,
	renderQuotaSnapshot,
} from "../extensions/footer-session-id";

/** Theme stub that wraps text in markers, so colour choices are part of the golden. */
const marked = { fg: (color: string, text: string) => `[${color}:${text}]` };
/** Passthrough theme: visible width == string length. */
const plain = { fg: (_color: string, text: string) => text };

const BASE = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A UTC instant that lands on the given Beijing hour (UTC+8). */
const beijing = (hour: number) =>
	new Date(Date.UTC(2026, 6, 20, (hour - 8 + 24) % 24, 0, 0, 0));

/** z.ai shape: 5h + 7d token windows, a monthly MCP cap in use, a plan tier. */
const ZAI = {
	level: "standard",
	limits: [
		{ type: "TOKENS_LIMIT", unit: 3, percentage: 15, currentValue: 85000, usage: 15000, nextResetTime: BASE + 47 * MIN },
		{ type: "TOKENS_LIMIT", unit: 6, percentage: 30, currentValue: 350000, usage: 150000, nextResetTime: BASE + 4.9 * HOUR },
		{ type: "TIME_LIMIT", unit: 5, percentage: 42, currentValue: 3, usage: 3, nextResetTime: BASE + 20 * DAY },
	],
};

/** MiniMax shape: two token windows, exhausted status, no MCP, no tier text. */
const MINIMAX = {
	level: "exhausted",
	limits: [
		{ type: "TOKENS_LIMIT", unit: 3, percentage: 100, nextResetTime: BASE + 12 * MIN },
		{ type: "TOKENS_LIMIT", unit: 6, percentage: 8, nextResetTime: BASE + 6.5 * DAY },
	],
};

/** OpenCode Go shape: three windows with reset instants and no tier. */
const GO = {
	rolling: { percent: 1, resetsAtMs: Date.parse("2026-10-19T01:49:11.000Z") },
	weekly: { percent: 17, resetsAtMs: Date.parse("2026-10-19T21:19:11.000Z") },
	monthly: { percent: 8, resetsAtMs: Date.parse("2026-11-16T21:19:11.000Z") },
};
/** Fixed reference instant for the Go rows (its renderer takes `now`). */
const GO_NOW = Date.parse("2026-10-18T21:19:11.000Z");

const GOLDEN: ReadonlyArray<{
	name: string;
	render: () => string;
	expected: string;
}> = [
	{
		name: "z.ai 5h+7d+MCP+tier, peak multiplier (GLM-5.2, 15:00 Beijing)",
		render: () => renderQuotaSegment(ZAI, "zai", "glm-5.2", 200, marked, beijing(15)),
		expected: "[warning:3×] 5h:[success:15%] [dim:47m] 7d:[success:30%] [dim:4.9h] MCP:[success:42%] [dim:· standard]",
	},
	{
		name: "z.ai off-peak multiplier (GLM-5.2, 09:00 Beijing)",
		render: () => renderQuotaSegment(ZAI, "zai", "glm-5.2", 200, marked, beijing(9)),
		expected: "[dim:2×] 5h:[success:15%] [dim:47m] 7d:[success:30%] [dim:4.9h] MCP:[success:42%] [dim:· standard]",
	},
	{
		name: "z.ai without a multiplier model (GLM-4.7)",
		render: () => renderQuotaSegment(ZAI, "zai", "glm-4.7", 200, marked, beijing(15)),
		expected: "5h:[success:15%] [dim:47m] 7d:[success:30%] [dim:4.9h] MCP:[success:42%] [dim:· standard]",
	},
	{
		name: "z.ai uncoloured (widths are measured on the visible text)",
		render: () => renderQuotaSegment(ZAI, "zai", "glm-4.7", 200, plain, beijing(15)),
		expected: "5h:15% 47m 7d:30% 4.9h MCP:42% · standard",
	},
	{
		name: "z.ai: MCP dropped first when the segment overflows",
		render: () => renderQuotaSegment(ZAI, "zai", "glm-4.7", 60, plain, beijing(15)),
		expected: "5h:15% 47m 7d:30% 4.9h MCP:42% · standard",
	},
	{
		name: "z.ai: MCP and tier dropped, windows kept (coloured budget is tighter)",
		render: () => renderQuotaSegment(ZAI, "zai", "glm-4.7", 60, marked, beijing(15)),
		expected: "5h:[success:15%] [dim:47m] 7d:[success:30%] [dim:4.9h]",
	},
	{
		name: "z.ai: only the first window when nothing else fits",
		render: () => renderQuotaSegment(ZAI, "zai", "glm-4.7", 30, plain, beijing(15)),
		expected: "5h:15% 47m 7d:30% 4.9h",
	},
	{
		name: "z.ai: last resort is the first part, clipped not ellipsised",
		render: () => renderQuotaSegment(ZAI, "zai", "glm-4.7", 10, marked, beijing(15)),
		expected: "5h:[success:15%] [dim:47m]",
	},
	{
		name: "z.ai: a prefix-only last resort when the multiplier is showing",
		render: () => renderQuotaSegment(ZAI, "zai", "glm-5.2", 60, marked, beijing(15)),
		expected: "[warning:3×]",
	},
	{
		name: "z.ai: no reset instants → percent only",
		render: () =>
			renderQuotaSegment(
				{ level: "standard", limits: [{ type: "TOKENS_LIMIT", unit: 3, percentage: 15, currentValue: 0, usage: 0 }] },
				"zai",
				"glm-5.2",
				200,
				marked,
				beijing(15),
			),
		expected: "[warning:3×] 5h:[success:15%] [dim:· standard]",
	},
	{
		name: "z.ai: MCP-only payload renders alone, with an empty tier suppressed",
		render: () =>
			renderQuotaSegment(
				{ level: "", limits: [{ type: "TIME_LIMIT", unit: 5, percentage: 42, currentValue: 3, usage: 3 }] },
				"zai",
				"glm-4.7",
				200,
				marked,
				beijing(15),
			),
		expected: "MCP:[success:42%]",
	},
	{
		name: "z.ai: a payload with no limits renders nothing",
		render: () => renderQuotaSegment({ level: "standard", limits: [] }, "zai", "glm-5.2", 200, marked, beijing(15)),
		expected: "",
	},
	{
		name: "z.ai: a payload with no renderable window renders nothing, tier included",
		render: () =>
			renderQuotaSegment(
				{ level: "standard", limits: [{ type: "TOKENS_LIMIT", unit: 9, percentage: 50, currentValue: 1, usage: 1 }] },
				"zai",
				"glm-4.7",
				200,
				marked,
				beijing(15),
			),
		expected: "",
	},
	{
		name: "MiniMax: exhausted reads at the error threshold, tier appended",
		render: () => renderQuotaSegment(MINIMAX, "minimax", "minimax-m3", 200, marked, beijing(15)),
		expected: "5h:[error:100%] [dim:12m] 7d:[success:8%] [dim:6.5d] [dim:· exhausted]",
	},
	{
		name: "MiniMax: tier dropped before any window",
		render: () => renderQuotaSegment(MINIMAX, "minimax", "minimax-m3", 60, marked, beijing(15)),
		expected: "5h:[error:100%] [dim:12m] 7d:[success:8%] [dim:6.5d]",
	},
	{
		name: "MiniMax: an unknown provider id renders nothing",
		render: () => renderQuotaSegment(MINIMAX, "minimaxcn" as string, "glm-5.2", 200, marked, beijing(15)),
		expected: "",
	},
	{
		// minimax-cn is its own descriptor entry on its own host; without a row of
		// its own a dropped or mis-parsed entry renders "" and no suite notices.
		name: "minimax-cn: the same payload renders under the second MiniMax host",
		render: () => renderQuotaSegment(MINIMAX, "minimax-cn", "minimax-m3", 200, marked, beijing(15)),
		expected: "5h:[error:100%] [dim:12m] 7d:[success:8%] [dim:6.5d] [dim:· exhausted]",
	},
	{
		name: "minimax-cn: uncoloured",
		render: () => renderQuotaSegment(MINIMAX, "minimax-cn", "minimax-m3", 200, plain, beijing(15)),
		expected: "5h:100% 12m 7d:8% 6.5d · exhausted",
	},
	{
		name: "minimax-cn: the ladder runs for this descriptor too (tier dropped)",
		render: () => renderQuotaSegment(MINIMAX, "minimax-cn", "minimax-m3", 60, marked, beijing(15)),
		expected: "5h:[error:100%] [dim:12m] 7d:[success:8%] [dim:6.5d]",
	},
	{
		name: "minimax-cn: last resort is the first part, clipped",
		render: () => renderQuotaSegment(MINIMAX, "minimax-cn", "minimax-m3", 20, plain, beijing(15)),
		expected: "5h:100% 12m",
	},
	{
		name: "z.ai: a multiplier subject model id does not leak a prefix onto MiniMax",
		render: () => renderQuotaSegment(MINIMAX, "minimax-cn", "glm-5.2", 200, marked, beijing(15)),
		expected: "5h:[error:100%] [dim:12m] 7d:[success:8%] [dim:6.5d] [dim:· exhausted]",
	},
	{
		name: "Go: all three windows",
		render: () => renderGoUsageSegment(GO, "opencode-go", 200, marked, GO_NOW),
		expected: "5h:[success:1%] [dim:4.5h] 7d:[success:17%] [dim:thru86%] [dim:1.0d] mo:[success:8%] [dim:thru6%] [dim:29.0d]",
	},
	{
		name: "Go: uncoloured",
		render: () => renderGoUsageSegment(GO, "opencode-go", 200, plain, GO_NOW),
		expected: "5h:1% 4.5h 7d:17% thru86% 1.0d mo:8% thru6% 29.0d",
	},
	{
		name: "Go: monthly dropped first, then weekly",
		render: () => renderGoUsageSegment(GO, "opencode-go", 30, plain, GO_NOW),
		expected: "5h:1% 4.5h 7d:17% thru86% 1.0d",
	},
	{
		name: "Go: rolling window alone at a tight budget",
		render: () => renderGoUsageSegment(GO, "opencode-go", 10, plain, GO_NOW),
		expected: "5h:1% 4.5h",
	},
	{
		name: "Go: last resort is ellipsised, not clipped",
		render: () => renderGoUsageSegment(GO, "opencode-go", 6, plain, GO_NOW),
		expected: "5h:\u001b[0m...\u001b[0m",
	},
	{
		name: "Go: rolling only",
		render: () => renderGoUsageSegment({ rolling: GO.rolling }, "opencode-go", 200, marked, GO_NOW),
		expected: "5h:[success:1%] [dim:4.5h]",
	},
	{
		name: "Go: weekly only",
		render: () => renderGoUsageSegment({ weekly: GO.weekly }, "opencode-go", 200, marked, GO_NOW),
		expected: "7d:[success:17%] [dim:thru86%] [dim:1.0d]",
	},
	{
		name: "Go: monthly only",
		render: () => renderGoUsageSegment({ monthly: GO.monthly }, "opencode-go", 200, marked, GO_NOW),
		expected: "mo:[success:8%] [dim:thru6%] [dim:29.0d]",
	},
	{
		name: "Go: an empty payload renders nothing",
		render: () => renderGoUsageSegment({}, "opencode-go", 200, marked, GO_NOW),
		expected: "",
	},
	{
		name: "gating: z.ai payload under another provider renders nothing",
		render: () => renderQuotaSegment(ZAI, "opencode-go", "glm-5.2", 200, marked, beijing(15)),
		expected: "",
	},
	{
		name: "gating: Go payload under another provider renders nothing",
		render: () => renderGoUsageSegment(GO, "zai", 200, marked, GO_NOW),
		expected: "",
	},
	{
		name: "gating: undefined payload renders nothing",
		render: () => renderQuotaSegment(undefined, "zai", "glm-5.2", 200, marked, beijing(15)),
		expected: "",
	},
	{
		name: "gating: undefined usage renders nothing",
		render: () => renderGoUsageSegment(undefined, "opencode-go", 200, marked, GO_NOW),
		expected: "",
	},
];

describe("quota segment characterisation (pre-refactor goldens)", () => {
	for (const row of GOLDEN) {
		it(row.name, () => {
			expect(row.render()).toBe(row.expected);
		});
	}
});

// ---------------------------------------------------------------------------
// Descriptor-table wiring
//
// The goldens above drive `fromQuotaData`, the pre-refactor shape. These rows
// go through each descriptor's own `parse` and provider tag, so a descriptor
// entry that is dropped, mis-parsed or tagged with another provider reds here
// even though the render goldens would still pass.
// ---------------------------------------------------------------------------

/** A MiniMax payload in the documented shape. */
const MINIMAX_PAYLOAD = {
	base_resp: { status_code: 0 },
	model_remains: [
		{
			model_name: "general",
			current_interval_remaining_percent: 0,
			current_weekly_remaining_percent: 92,
			remains_time: 12 * MIN,
			weekly_remains_time: 6.5 * DAY,
			current_interval_status: 2,
		},
	],
};

/** A z.ai payload in the documented shape. */
const ZAI_PAYLOAD = {
	code: 0,
	success: true,
	data: {
		level: "standard",
		limits: [
			{ type: "TOKENS_LIMIT", unit: 3, percentage: 15, currentValue: 1, usage: 1, nextResetTime: BASE + 47 * MIN },
			{ type: "TOKENS_LIMIT", unit: 6, percentage: 30, currentValue: 1, usage: 1, nextResetTime: BASE + 4.9 * HOUR },
			{ type: "TIME_LIMIT", unit: 5, percentage: 42, currentValue: 3, usage: 3 },
		],
	},
};

describe("descriptor table wiring", () => {
	const parse = (provider: string, payload: unknown) => {
		const descriptor = quotaDescriptorFor(provider);
		expect(descriptor).toBeDefined();
		const parts = descriptor!.parse(payload, { now: BASE, warn: () => {} });
		expect(parts).not.toBeUndefined();
		return renderQuotaSnapshot(
			{ provider: descriptor!.provider, parts: parts!, overflow: descriptor!.overflow },
			provider,
			undefined,
			200,
			plain,
		);
	};

	it("z.ai parses its own payload", () => {
		expect(parse("zai", ZAI_PAYLOAD)).toBe("5h:15% 47m 7d:30% 4.9h MCP:42% · standard");
	});

	it("minimax parses its own payload", () => {
		expect(parse("minimax", MINIMAX_PAYLOAD)).toBe("5h:100% 12m 7d:8% 6.5d · exhausted");
	});

	it("minimax-cn parses the same payload under its own entry", () => {
		expect(parse("minimax-cn", MINIMAX_PAYLOAD)).toBe("5h:100% 12m 7d:8% 6.5d · exhausted");
	});

	it("a payload from another provider yields no parts", () => {
		for (const [provider, payload] of [
			["zai", MINIMAX_PAYLOAD],
			["minimax", ZAI_PAYLOAD],
			["minimax-cn", ZAI_PAYLOAD],
		] as const) {
			expect(quotaDescriptorFor(provider)!.parse(payload, { now: BASE, warn: () => {} })).toBeUndefined();
		}
	});
});
