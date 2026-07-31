/**
 * Tests for the 3-day logarithmic activity timeline footer row.
 *
 * Covers all 21 matrix rows from WO-2026-016. Every test hits the exported
 * pure helpers (timelineColumn, computeTimelineCells, resolveSessionStartMs,
 * renderTimelineRow) — the same boundary the existing multiplier test uses.
 *
 * Deterministic time: a fixed NOW instant, explicit ageMs/nowMs parameters —
 * never Date.now() inside helpers. Theme stubs match the multiplier test
 * convention except row 21 which uses an ANSI-wrapping theme so visibleWidth
 * can correctly strip escape codes.
 */
import { describe, it, expect } from "bun:test";
import {
	timelineColumn,
	computeTimelineCells,
	resolveSessionStartMs,
	renderTimelineRow,
	type TimelineCell,
} from "../extensions/footer-session-id";
import { visibleWidth } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Constants mirroring the implementation
// ---------------------------------------------------------------------------

const WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // 259 200 000
const MIN_AGE_MS = 60 * 1000; // 60 000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fixed reference instant for deterministic time tests. */
const NOW = 1700000000000; // 2023-11-14T22:13:20.000Z

/** Minimal theme stub matching the multiplier test convention. */
const testTheme = {
	fg: (color: string, text: string) => `[${color}:${text}]`,
	bold: (s: string) => `[bold:${s}]`,
};

/** ANSI-wrapping theme for visibleWidth tests (row 21). */
const ansiTheme = {
	fg: (_color: string, text: string) => `\x1b[38;5;6m${text}\x1b[39m`,
	bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
};

/** Build a message entry with the given age (ms before NOW) and role. */
function msg(ageMs: number, role: string): unknown {
	return {
		type: "message",
		timestamp: new Date(NOW - ageMs).toISOString(),
		message: { role },
	};
}

/** Build a non-message entry with the given age (ms before NOW) and type. */
function nonMsg(ageMs: number, type: string): unknown {
	return {
		type,
		timestamp: new Date(NOW - ageMs).toISOString(),
	};
}

// ---------------------------------------------------------------------------
// timelineColumn — boundary matrix (rows 1–3, 5, 7–8)
// ---------------------------------------------------------------------------

describe("timelineColumn", () => {
	// Row 1: age = MIN_AGE_MS exactly → rightmost column (W−1)
	it("age = MIN_AGE_MS exactly → rightmost column", () => {
		expect(timelineColumn(MIN_AGE_MS, 80)).toBe(79);
		expect(timelineColumn(MIN_AGE_MS, 40)).toBe(39);
		expect(timelineColumn(MIN_AGE_MS, 1)).toBe(0);
	});

	// Row 2: age = WINDOW_MS exactly → leftmost column (0)
	it("age = WINDOW_MS exactly → leftmost column", () => {
		expect(timelineColumn(WINDOW_MS, 80)).toBe(0);
		expect(timelineColumn(WINDOW_MS, 40)).toBe(0);
	});

	// Row 3: age just under WINDOW_MS → leftmost column (0)
	it("age just under WINDOW_MS → leftmost column (0)", () => {
		expect(timelineColumn(WINDOW_MS - 1, 80)).toBe(0);
	});

	// Row 5: age < MIN_AGE_MS (incl. 0, negative, just under) → rightmost
	it("age < MIN_AGE_MS (0, negative, just under, NaN) → rightmost", () => {
		expect(timelineColumn(0, 80)).toBe(79);
		expect(timelineColumn(-5000, 80)).toBe(79);
		expect(timelineColumn(MIN_AGE_MS - 1, 80)).toBe(79);
		// NaN defense (explicit invariant from work order)
		expect(timelineColumn(NaN, 80)).toBe(0);
		expect(timelineColumn(Infinity, 80)).toBe(0);
	});

	// Row 7: width < 1 → 0
	it("width < 1 → 0", () => {
		expect(timelineColumn(100_000, 0)).toBe(0);
		expect(timelineColumn(100_000, -1)).toBe(0);
		expect(timelineColumn(100_000, -100)).toBe(0);
	});

	// Row 8: monotonicity at W=80, boundary 79/78 at ~66.6s
	it("monotonicity: 66.5s → col 79, 66.7s → col 78 (W=80)", () => {
		expect(timelineColumn(66_500, 80)).toBe(79);
		expect(timelineColumn(66_700, 80)).toBe(78);
	});
});

// ---------------------------------------------------------------------------
// computeTimelineCells — classification matrix (rows 4, 6, 9–13, 16–17, 20)
// ---------------------------------------------------------------------------

describe("computeTimelineCells", () => {
	// Row 4: age just over WINDOW_MS → excluded (no contribution)
	it("age just over WINDOW_MS → excluded (all cells empty)", () => {
		const cells = computeTimelineCells(
			[msg(WINDOW_MS + 1, "user")],
			NOW,
			40,
			undefined,
		);
		expect(cells).toHaveLength(40);
		expect(cells.every((c) => c.status === "empty")).toBe(true);
	});

	// Row 6: width = 1 → single column, in-range message contributes
	it("width = 1 → single column with in-range message", () => {
		const cells = computeTimelineCells([msg(100_000, "user")], NOW, 1, undefined);
		expect(cells).toHaveLength(1);
		expect(cells[0]!.status).toBe("solid");
	});

	// Row 9: user + assistant in same column → solid
	it("user + assistant in same column → solid (user wins)", () => {
		// 100_000 ms → col 37 at width 40
		const cells = computeTimelineCells(
			[msg(100_000, "assistant"), msg(100_001, "user")],
			NOW,
			40,
			undefined,
		);
		const col = timelineColumn(100_000, 40);
		expect(cells[col]!.status).toBe("solid");
	});

	// Row 10: assistant only → half
	it("assistant only → half", () => {
		const cells = computeTimelineCells([msg(100_000, "assistant")], NOW, 40, undefined);
		const col = timelineColumn(100_000, 40);
		expect(cells[col]!.status).toBe("half");
	});

	// Row 11: toolResult only → half
	it("toolResult only → half", () => {
		const cells = computeTimelineCells([msg(100_000, "toolResult")], NOW, 40, undefined);
		const col = timelineColumn(100_000, 40);
		expect(cells[col]!.status).toBe("half");
	});

	// Row 12: bashExecution only → half
	it("bashExecution only → half", () => {
		const cells = computeTimelineCells(
			[msg(100_000, "bashExecution")],
			NOW,
			40,
			undefined,
		);
		const col = timelineColumn(100_000, 40);
		expect(cells[col]!.status).toBe("half");
	});

	// Row 13: non-message entries + unrecognised roles → empty
	it("non-message entries + compactionSummary/branchSummary/custom roles → empty", () => {
		const cells = computeTimelineCells(
			[
				nonMsg(100_000, "model_change"),
				nonMsg(100_000, "thinking_level_change"),
				nonMsg(100_000, "compaction"),
				nonMsg(100_000, "branch_summary"),
				nonMsg(100_000, "custom"),
				nonMsg(100_000, "custom_message"),
				nonMsg(100_000, "label"),
				nonMsg(100_000, "session_info"),
				msg(100_000, "compactionSummary"),
				msg(100_000, "branchSummary"),
				msg(100_000, "custom"),
			],
			NOW,
			40,
			undefined,
		);
		expect(cells.every((c) => c.status === "empty")).toBe(true);
	});

	// Row 16: sessionStartMs older than window → no marker
	it("sessionStartMs older than window → no isSessionStart", () => {
		const oldStart = NOW - WINDOW_MS - 1;
		const cells = computeTimelineCells(
			[msg(100_000, "user")],
			NOW,
			40,
			oldStart,
		);
		expect(cells.every((c) => !c.isSessionStart)).toBe(true);
	});

	// Row 17: sessionStartMs undefined → no marker
	it("sessionStartMs undefined → no marker", () => {
		const cells = computeTimelineCells(
			[msg(100_000, "user")],
			NOW,
			40,
			undefined,
		);
		expect(cells.every((c) => !c.isSessionStart)).toBe(true);
	});

	// Row 17b: sessionStartMs in-range → assigns isSessionStart
	it("sessionStartMs in-range → assigns isSessionStart on correct column", () => {
		const startMs = NOW - 100_000; // 100s ago, in range
		const cells = computeTimelineCells(
			[msg(50_000, "user")],
			NOW,
			40,
			startMs,
		);
		const markerCol = timelineColumn(100_000, 40);
		expect(cells[markerCol]!.isSessionStart).toBe(true);
		// Other columns should not have the marker
		const otherCols = cells.filter((_, i) => i !== markerCol);
		expect(otherCols.every((c) => !c.isSessionStart)).toBe(true);
	});

	// Row 20: empty entries array → all empty cells, exactly width
	it("empty entries array → all empty, exactly width cells", () => {
		const cells = computeTimelineCells([], NOW, 20, undefined);
		expect(cells).toHaveLength(20);
		expect(cells.every((c) => c.status === "empty" && !c.isSessionStart)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// resolveSessionStartMs — resolution matrix (row 18)
// ---------------------------------------------------------------------------

describe("resolveSessionStartMs", () => {
	// Row 18: valid header → header ts; missing header → first-entry fallback; neither → undefined
	it("valid header timestamp", () => {
		const headerDate = new Date(NOW - 5000);
		expect(resolveSessionStartMs(headerDate.toISOString(), [])).toBe(
			headerDate.getTime(),
		);
	});

	it("missing header, first-entry fallback", () => {
		expect(resolveSessionStartMs(undefined, [msg(10_000, "user")])).toBe(
			NOW - 10_000,
		);
	});

	it("missing header, no entries → undefined", () => {
		expect(resolveSessionStartMs(undefined, [])).toBeUndefined();
	});

	it("unparseable header, valid first entry → fallback", () => {
		expect(
			resolveSessionStartMs("not-a-date", [msg(10_000, "user")]),
		).toBe(NOW - 10_000);
	});

	it("unparseable header, no entries → undefined", () => {
		expect(resolveSessionStartMs("not-a-date", [])).toBeUndefined();
	});

	it("header undefined, first entry has unparseable timestamp → skips to undefined", () => {
		const badEntry = { type: "message", timestamp: "garbage", message: { role: "user" } };
		expect(resolveSessionStartMs(undefined, [badEntry])).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// renderTimelineRow — rendering matrix (rows 7, 14–15, 20–21)
// ---------------------------------------------------------------------------

describe("renderTimelineRow", () => {
	// Row 7 (renderTimelineRow part): width < 1 → ""
	it("width < 1 → empty string", () => {
		expect(renderTimelineRow([], testTheme, 0)).toBe("");
		expect(renderTimelineRow([], testTheme, -1)).toBe("");
	});

	// Row 14: marker on solid/half cell → warning █ overrides
	it("marker on solid cell → warning █ (overrides accent)", () => {
		const cells: TimelineCell[] = [
			{ status: "solid", isSessionStart: true },
		];
		const row = renderTimelineRow(cells, testTheme, 1);
		expect(row).toContain("[warning:█]");
		expect(row).not.toContain("[accent:█]");
	});

	it("marker on half cell → warning █ (overrides accent)", () => {
		const cells: TimelineCell[] = [
			{ status: "half", isSessionStart: true },
		];
		const row = renderTimelineRow(cells, testTheme, 1);
		expect(row).toContain("[warning:█]");
		expect(row).not.toContain("[accent:▒]");
	});

	// Row 15: marker on empty cell → warning █ (still visible)
	it("marker on empty cell → warning █", () => {
		const cells: TimelineCell[] = [
			{ status: "empty", isSessionStart: true },
		];
		const row = renderTimelineRow(cells, testTheme, 1);
		expect(row).toContain("[warning:█]");
	});

	// cells.length < width → padded with spaces
	it("cells shorter than width → padded with spaces", () => {
		const cells: TimelineCell[] = [
			{ status: "empty", isSessionStart: false },
		];
		const row = renderTimelineRow(cells, testTheme, 5);
		expect(row).toBe(" ".repeat(5));
	});

	// cells.length > width → truncated
	it("cells longer than width → truncated", () => {
		const cells: TimelineCell[] = [
			{ status: "solid", isSessionStart: false },
			{ status: "half", isSessionStart: false },
			{ status: "empty", isSessionStart: false },
		];
		const row = renderTimelineRow(cells, testTheme, 1);
		expect(row).toBe("[accent:█]");
	});

	// Row 20: empty cells array → all-space row, still width wide
	it("empty cells → all-space row, width wide", () => {
		const cells = computeTimelineCells([], NOW, 20, undefined);
		const row = renderTimelineRow(cells, testTheme, 20);
		expect(row).toBe(" ".repeat(20));
	});

	// Row 21: visibleWidth === width for W ∈ {20, 40, 80, 120}
	it("visibleWidth === width for various widths", () => {
		// Use ANSI theme so visibleWidth strips escape codes correctly.
		for (const w of [20, 40, 80, 120]) {
			const cells = computeTimelineCells(
				[msg(100_000, "user"), msg(200_000, "assistant")],
				NOW,
				w,
				NOW - 50_000,
			);
			const row = renderTimelineRow(cells, ansiTheme, w);
			expect(visibleWidth(row)).toBe(w);
		}
	});
});

// ---------------------------------------------------------------------------
// renderTimelineRow — status rendering symbols
// ---------------------------------------------------------------------------

describe("renderTimelineRow symbols", () => {
	it("solid → accent █", () => {
		const cells: TimelineCell[] = [
			{ status: "solid", isSessionStart: false },
		];
		expect(renderTimelineRow(cells, testTheme, 1)).toBe("[accent:█]");
	});

	it("half → accent ▒", () => {
		const cells: TimelineCell[] = [
			{ status: "half", isSessionStart: false },
		];
		expect(renderTimelineRow(cells, testTheme, 1)).toBe("[accent:▒]");
	});

	it("empty → space", () => {
		const cells: TimelineCell[] = [
			{ status: "empty", isSessionStart: false },
		];
		expect(renderTimelineRow(cells, testTheme, 1)).toBe(" ");
	});
});

// ---------------------------------------------------------------------------
// Row 19: unparseable entry timestamps → skipped, no crash
// ---------------------------------------------------------------------------

describe("defensive parsing", () => {
	it("unparseable timestamp → skipped, no crash", () => {
		const badEntry = {
			type: "message",
			timestamp: "definitely-not-a-date",
			message: { role: "user" },
		};
		const cells = computeTimelineCells([badEntry], NOW, 40, undefined);
		expect(cells.every((c) => c.status === "empty")).toBe(true);
	});

	it("entry with no timestamp field → skipped", () => {
		const noTs = { type: "message", message: { role: "user" } };
		const cells = computeTimelineCells([noTs], NOW, 40, undefined);
		expect(cells.every((c) => c.status === "empty")).toBe(true);
	});

	it("entry with null timestamp → skipped", () => {
		const nullTs = {
			type: "message",
			timestamp: null,
			message: { role: "user" },
		};
		const cells = computeTimelineCells([nullTs], NOW, 40, undefined);
		expect(cells.every((c) => c.status === "empty")).toBe(true);
	});

	it("mixed valid and invalid → valid contributes", () => {
		const cells = computeTimelineCells(
			[
				{ type: "message", timestamp: "bad", message: { role: "user" } },
				msg(100_000, "user"),
			],
			NOW,
			40,
			undefined,
		);
		const col = timelineColumn(100_000, 40);
		expect(cells[col]!.status).toBe("solid");
	});

	it("computeTimelineCells does not throw for NaN nowMs", () => {
		// Defensive: nowMs could be NaN if caller passes bad value
		const cells = computeTimelineCells([msg(100_000, "user")], NaN, 40, undefined);
		// Should not throw; specific output is unspecified but should be safe
		expect(Array.isArray(cells)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Regression: existing imports still work (multiplier test compatibility)
// ---------------------------------------------------------------------------

describe("existing exports unchanged", () => {
	it("getZaiMultiplier and renderQuotaSegment are still importable", async () => {
		const mod = await import("../extensions/footer-session-id");
		expect(typeof mod.getZaiMultiplier).toBe("function");
		expect(typeof mod.renderQuotaSegment).toBe("function");
	});
});
