/**
 * Tests for z.ai peak/off-peak quota multiplier display.
 *
 * Covers the full boundary matrix from the work order for:
 *   - getZaiMultiplier (pure helper)
 *   - renderQuotaSegment (integration: multiplier is prepended to parts)
 *
 * Beijing time computation uses toLocaleString with Asia/Shanghai time zone.
 * Test Date objects are UTC instants that resolve to a known Beijing hour.
 * renderQuotaSegment accepts an optional `now` parameter for controlled
 * time testing, avoiding time-dependent flaky tests.
 */
import { describe, it, expect } from "bun:test";
import { getZaiMultiplier, renderQuotaSegment } from "../extensions/footer-session-id";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a UTC Date that resolves to the given Beijing hour (UTC+8). */
function beijingTime(hour: number): Date {
	// Beijing hour h → UTC hour h-8 (mod 24)
	const utcHour = (hour - 8 + 24) % 24;
	// Use a fixed date far from DST transitions to avoid ambiguity
	return new Date(Date.UTC(2026, 6, 20, utcHour, 0, 0, 0));
}

/** Minimal theme stub that wraps text in ANSI-like markers for color detection. */
const testTheme = {
	fg: (color: string, text: string) => `[${color}:${text}]`,
	bold: (s: string) => `[bold:${s}]`,
};

/** Minimal QuotaData fixture. */
const MINIMAL_QUOTA = {
	level: "standard",
	limits: [
		{ type: "TOKENS_LIMIT", unit: 3, percentage: 15, currentValue: 85000, usage: 15000 },
		{ type: "TOKENS_LIMIT", unit: 6, percentage: 30, currentValue: 350000, usage: 150000 },
	],
};

// ---------------------------------------------------------------------------
// getZaiMultiplier — boundary matrix (rows 1–12)
// ---------------------------------------------------------------------------

describe("getZaiMultiplier", () => {
	// Row 1: GLM-5.2 at 14:00 Beijing (peak boundary, inclusive)
	it("GLM-5.2 at 14:00 Beijing → 3 (peak start, inclusive)", () => {
		expect(getZaiMultiplier("glm-5.2", beijingTime(14))).toBe(3);
	});

	// Row 2: GLM-5.2 at 15:00 Beijing (mid-peak)
	it("GLM-5.2 at 15:00 Beijing → 3 (mid-peak)", () => {
		expect(getZaiMultiplier("glm-5.2", beijingTime(15))).toBe(3);
	});

	// Row 3: GLM-5.2 at 17:00 Beijing (peak end, exclusive boundary just before 18)
	it("GLM-5.2 at 17:00 Beijing → 3 (peak end, exclusive boundary)", () => {
		expect(getZaiMultiplier("glm-5.2", beijingTime(17))).toBe(3);
	});

	// Row 4: GLM-5.2 at 18:00 Beijing (off-peak, 18 is exclusive)
	it("GLM-5.2 at 18:00 Beijing → 2 (off-peak, 18 exclusive)", () => {
		expect(getZaiMultiplier("glm-5.2", beijingTime(18))).toBe(2);
	});

	// Row 5: GLM-5.2 at 13:00 Beijing (off-peak, just before 14)
	it("GLM-5.2 at 13:00 Beijing → 2 (off-peak, just before peak start)", () => {
		expect(getZaiMultiplier("glm-5.2", beijingTime(13))).toBe(2);
	});

	// Row 6: GLM-5.2 at 09:00 Beijing (off-peak, morning)
	it("GLM-5.2 at 09:00 Beijing → 2 (off-peak, morning)", () => {
		expect(getZaiMultiplier("glm-5.2", beijingTime(9))).toBe(2);
	});

	// Row 7: GLM-5-Turbo at 14:00 Beijing (peak)
	it("GLM-5-Turbo at 14:00 Beijing → 3", () => {
		expect(getZaiMultiplier("glm-5-turbo", beijingTime(14))).toBe(3);
	});

	// Row 8: GLM-5-Turbo caps variant at 11:00 Beijing (off-peak)
	it("GLM-5-Turbo (caps) at 11:00 Beijing → 2", () => {
		expect(getZaiMultiplier("GLM-5-Turbo", beijingTime(11))).toBe(2);
	});

	// Row 9: GLM-4.7 at any time → undefined
	it("GLM-4.7 at peak → undefined (not subject to multiplier)", () => {
		expect(getZaiMultiplier("glm-4.7", beijingTime(14))).toBeUndefined();
	});

	// Row 10: Provider-prefixed variant
	it("z-ai/glm-5.2 at 14:00 Beijing → 3 (provider prefix)", () => {
		expect(getZaiMultiplier("z-ai/glm-5.2", beijingTime(14))).toBe(3);
	});

	// Row 11: OpenCode-style variant
	it("zai-coding-plan/glm-5.2 at 14:00 Beijing → 3 (OpenCode prefix)", () => {
		expect(getZaiMultiplier("zai-coding-plan/glm-5.2", beijingTime(14))).toBe(3);
	});

	// Row 12: Model id undefined → undefined
	it("model id undefined → undefined", () => {
		expect(getZaiMultiplier(undefined, beijingTime(14))).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// renderQuotaSegment — multiplier prefix in rendered output (rows 13–15)
//
// All time-sensitive tests pass explicit `now` to avoid flaky time-dependent
// failures. The `renderQuotaSegment` function accepts an optional 6th `now`
// parameter that controls the reference time for peak/off-peak computation.
// ---------------------------------------------------------------------------

describe("renderQuotaSegment with multiplier", () => {
	// Row 13: GLM-5.2 peak (15:00 Beijing) → renders with warning-colored 3× prefix
	it("GLM-5.2 peak (15:00 Beijing) → quota string starts with warning-colored 3×", () => {
		const result = renderQuotaSegment(
			MINIMAL_QUOTA,
			"zai",
			"glm-5.2",
			200,
			testTheme,
			beijingTime(15),
		);
		expect(result).toMatch(/^\[warning:3×\]/);
		expect(result).toContain("5h:");
		expect(result).toContain("7d:");
	});

	// Row 13b (supplementary): GLM-5.2 off-peak (09:00 Beijing) → dim-colored 2× prefix
	it("GLM-5.2 off-peak (09:00 Beijing) → quota string starts with dim-colored 2×", () => {
		const result = renderQuotaSegment(
			MINIMAL_QUOTA,
			"zai",
			"glm-5.2",
			200,
			testTheme,
			beijingTime(9),
		);
		expect(result).toMatch(/^\[dim:2×\]/);
		expect(result).toContain("5h:");
	});

	// Row 14: GLM-4.7 → no multiplier prefix
	it("GLM-4.7 on zai → no multiplier prefix", () => {
		const result = renderQuotaSegment(
			MINIMAL_QUOTA,
			"zai",
			"glm-4.7",
			200,
			testTheme,
			beijingTime(15),
		);
		expect(result).not.toMatch(/[×]/);
		expect(result).toMatch(/^5h:/);
	});

	// Row 15: MiniMax provider → no multiplier even if model were glm-5.2
	it("MiniMax provider → no multiplier even with glm-5.2 model id", () => {
		const result = renderQuotaSegment(
			MINIMAL_QUOTA,
			"minimax",
			"glm-5.2",
			200,
			testTheme,
		);
		expect(result).not.toMatch(/[×]/);
	});

	// Row 15b (supplementary): minimax-cn provider → also no multiplier
	it("minimax-cn provider → no multiplier even with glm-5.2 model id", () => {
		const result = renderQuotaSegment(
			MINIMAL_QUOTA,
			"minimax-cn",
			"glm-5.2",
			200,
			testTheme,
		);
		expect(result).not.toMatch(/[×]/);
	});
});

// ---------------------------------------------------------------------------
// renderQuotaSegment — regression: non-quota providers still return ""
// ---------------------------------------------------------------------------

describe("renderQuotaSegment regression", () => {
	it("non-quota provider returns empty string", () => {
		const result = renderQuotaSegment(
			MINIMAL_QUOTA,
			"openai",
			undefined,
			200,
			testTheme,
		);
		expect(result).toBe("");
	});

	it("undefined quota returns empty string", () => {
		const result = renderQuotaSegment(
			undefined,
			"zai",
			"glm-5.2",
			200,
			testTheme,
		);
		expect(result).toBe("");
	});
});
