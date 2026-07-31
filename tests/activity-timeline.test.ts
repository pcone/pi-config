/**
 * Tests for the 3-day logarithmic activity timeline footer row (v2).
 *
 * v2 (WO-2026-017) doubles the time resolution: each physical column is two
 * half-cells (▌ earlier / ▐ later) on a virtual 2×width scale, and the
 * user-vs-LLM distinction moved from glyph (v1's ▒ dither) to color (bright
 * accent vs darkened accent). TimelineCell is now {left, right, isSessionStart}.
 *
 * Covers all 22 matrix rows from WO-2026-017. Every test hits the exported
 * pure helpers (timelineColumn, computeTimelineCells, resolveSessionStartMs,
 * renderTimelineRow, rgbToHsl, darkenAccentFg) — the same boundary the
 * existing multiplier test uses.
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
	rgbToHsl,
	darkenAccentFg,
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

/** Theme stub with a truecolor accent (rows 16, 7-through-getFgAnsi). */
const trueColorTheme = {
	fg: (color: string, text: string) => `[${color}:${text}]`,
	bold: (s: string) => `[bold:${s}]`,
	getFgAnsi: (color: string) =>
		color === "accent" ? "\x1b[38;2;255;100;0m" : "\x1b[39m",
	getColorMode: () => "truecolor" as const,
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

/**
 * v2 half-cell decomposition of the exported mapping:
 * v = timelineColumn(ageMs, 2*width) → (physical column, half).
 */
function halfCell(
	ageMs: number,
	width: number,
): { col: number; side: "left" | "right" } {
	const v = timelineColumn(ageMs, 2 * width);
	return { col: Math.floor(v / 2), side: v % 2 === 0 ? "left" : "right" };
}

/** All-null cell for readability. */
function emptyCell(): TimelineCell {
	return { left: "none", right: "none", isSessionStart: false };
}

// ---------------------------------------------------------------------------
// timelineColumn — boundary matrix (rows 1–3, 5, 7–8 of the v1 spec; kept
// unchanged per WO-2026-017 row 22)
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
// Half-cell mapping anchors (v2 scale) — rows 1, 2, 5
// ---------------------------------------------------------------------------

describe("half-cell mapping (v2 scale, v = timelineColumn(age, 2W))", () => {
	// Row 1: age = MIN_AGE_MS → v = 2W−1 → (W−1, right half)
	it("age = MIN_AGE_MS → (W−1, right half)", () => {
		expect(halfCell(MIN_AGE_MS, 80)).toEqual({ col: 79, side: "right" });
		expect(halfCell(MIN_AGE_MS, 40)).toEqual({ col: 39, side: "right" });
	});

	// Row 2: age = WINDOW_MS → v = 0 → (0, left half)
	// (computeTimelineCells excludes age ≥ WINDOW_MS, so this is a mapping
	// anchor check on the exported timelineColumn at the 2W scale.)
	it("age = WINDOW_MS → (0, left half)", () => {
		expect(halfCell(WINDOW_MS, 80)).toEqual({ col: 0, side: "left" });
		expect(timelineColumn(WINDOW_MS, 160)).toBe(0);
	});

	// Row 5: half boundary at W=80 (between right and left half of col 79
	// at age ≈ 63.22 s) → 63.0 s → col 79 right; 63.4 s → col 79 left
	it("63.0 s → col 79 right half; 63.4 s → col 79 left half (W=80)", () => {
		expect(halfCell(63_000, 80)).toEqual({ col: 79, side: "right" });
		expect(halfCell(63_400, 80)).toEqual({ col: 79, side: "left" });
	});
});

// ---------------------------------------------------------------------------
// computeTimelineCells — half-cell classification matrix (rows 1–12, 15)
// ---------------------------------------------------------------------------

describe("computeTimelineCells", () => {
	// Row 1: age = MIN_AGE_MS → rightmost column, right half
	it("age = MIN_AGE_MS → (W−1, right half) state set", () => {
		const cells = computeTimelineCells([msg(MIN_AGE_MS, "user")], NOW, 80, undefined);
		expect(cells).toHaveLength(80);
		expect(cells[79]).toEqual({ left: "none", right: "bright", isSessionStart: false });
		expect(cells.slice(0, 79).every((c) => c.left === "none" && c.right === "none")).toBe(true);
	});

	// Row 3: age just over WINDOW_MS → excluded (no state)
	it("age just over WINDOW_MS → excluded (all halves none)", () => {
		const cells = computeTimelineCells(
			[msg(WINDOW_MS + 1, "user")],
			NOW,
			40,
			undefined,
		);
		expect(cells).toHaveLength(40);
		expect(cells.every((c) => c.left === "none" && c.right === "none")).toBe(true);
	});

	// Row 4: age < MIN / negative → rightmost column, right half (clamp).
	// NaN is NOT rightmost: timelineColumn's non-finite defense maps it to
	// v = 0 → (0, left half) — pinned by the unchanged v1 NaN test.
	it("age below MIN_AGE_MS (user) → (W−1, right half) bright", () => {
		const cells = computeTimelineCells(
			[msg(MIN_AGE_MS - 1, "user")],
			NOW,
			80,
			undefined,
		);
		expect(cells[79]).toEqual({ left: "none", right: "bright", isSessionStart: false });
	});

	it("negative age (assistant) → (W−1, right half) dark", () => {
		const cells = computeTimelineCells([msg(-5000, "assistant")], NOW, 80, undefined);
		expect(cells[79]).toEqual({ left: "none", right: "dark", isSessionStart: false });
	});

	it("NaN nowMs → no crash; lands (0, left half) per timelineColumn defense", () => {
		const cells = computeTimelineCells([msg(100_000, "user")], NaN, 40, undefined);
		expect(Array.isArray(cells)).toBe(true);
		expect(cells[0]).toEqual({ left: "bright", right: "none", isSessionStart: false });
	});

	// Row 6: user only in earlier half
	it("user in earlier half → left bright, right none", () => {
		// 63.4 s → col 79 left half (row 5 anchor)
		const cells = computeTimelineCells([msg(63_400, "user")], NOW, 80, undefined);
		expect(cells[79]).toEqual({ left: "bright", right: "none", isSessionStart: false });
	});

	// Row 7: llm only in later half
	it("llm in later half → left none, right dark", () => {
		const cells = computeTimelineCells([msg(MIN_AGE_MS, "assistant")], NOW, 80, undefined);
		expect(cells[79]).toEqual({ left: "none", right: "dark", isSessionStart: false });
	});

	// Row 8: user earlier + llm later → both active, bright wins
	it("user earlier + llm later → left bright, right dark", () => {
		const cells = computeTimelineCells(
			[msg(63_400, "user"), msg(MIN_AGE_MS, "assistant")],
			NOW,
			80,
			undefined,
		);
		expect(cells[79]).toEqual({ left: "bright", right: "dark", isSessionStart: false });
	});

	// Row 9: llm both halves → both dark
	it("llm in both halves → left dark, right dark", () => {
		const cells = computeTimelineCells(
			[msg(63_400, "assistant"), msg(MIN_AGE_MS, "assistant")],
			NOW,
			80,
			undefined,
		);
		expect(cells[79]).toEqual({ left: "dark", right: "dark", isSessionStart: false });
	});

	// Row 10: user both halves → both bright
	it("user in both halves → left bright, right bright", () => {
		const cells = computeTimelineCells(
			[msg(63_400, "user"), msg(MIN_AGE_MS, "user")],
			NOW,
			80,
			undefined,
		);
		expect(cells[79]).toEqual({ left: "bright", right: "bright", isSessionStart: false });
	});

	// Precedence: a later llm entry cannot downgrade a bright half.
	it("dark never downgrades an existing bright half", () => {
		const cells = computeTimelineCells(
			[msg(MIN_AGE_MS, "user"), msg(MIN_AGE_MS, "assistant")],
			NOW,
			80,
			undefined,
		);
		expect(cells[79].right).toBe("bright");
	});

	// Row 11: non-message entries + unrecognised roles → halves stay none
	it("non-message entries + compactionSummary/branchSummary/custom roles → none", () => {
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
		expect(cells.every((c) => c.left === "none" && c.right === "none")).toBe(true);
	});

	// Row 12: empty entries → all halves none, exactly width cells
	it("empty entries array → all none, exactly width cells", () => {
		const cells = computeTimelineCells([], NOW, 20, undefined);
		expect(cells).toHaveLength(20);
		expect(cells.every((c) => c.left === "none" && c.right === "none" && !c.isSessionStart)).toBe(true);
	});

	// Row 15: sessionStartMs older than window → no marker
	it("sessionStartMs older than window → no isSessionStart", () => {
		const oldStart = NOW - WINDOW_MS - 1;
		const cells = computeTimelineCells([msg(100_000, "user")], NOW, 40, oldStart);
		expect(cells.every((c) => !c.isSessionStart)).toBe(true);
	});

	// Row 15: sessionStartMs undefined → no marker
	it("sessionStartMs undefined → no marker", () => {
		const cells = computeTimelineCells([msg(100_000, "user")], NOW, 40, undefined);
		expect(cells.every((c) => !c.isSessionStart)).toBe(true);
	});

	// Row 15b: in-range sessionStartMs → marker on the mapped column
	it("sessionStartMs in-range → assigns isSessionStart on correct column", () => {
		const startMs = NOW - 100_000; // 100s ago, in range
		const cells = computeTimelineCells([msg(50_000, "user")], NOW, 40, startMs);
		const markerCol = halfCell(100_000, 40).col;
		expect(cells[markerCol]!.isSessionStart).toBe(true);
		const otherCols = cells.filter((_, i) => i !== markerCol);
		expect(otherCols.every((c) => !c.isSessionStart)).toBe(true);
	});

	// width = 1 → single column, in-range message contributes
	it("width = 1 → single column with in-range message", () => {
		const cells = computeTimelineCells([msg(100_000, "user")], NOW, 1, undefined);
		expect(cells).toHaveLength(1);
		// age 100s at 2W=2 → v=1 → col 0, right half
		expect(cells[0]).toEqual({ left: "none", right: "bright", isSessionStart: false });
	});

	// width = 0 → empty array, no throw (v1 would crash on cells[0])
	it("width = 0 → empty array, no throw even with in-range marker", () => {
		const cells = computeTimelineCells(
			[msg(100_000, "user")],
			NOW,
			0,
			NOW - 50_000,
		);
		expect(cells).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// resolveSessionStartMs — resolution matrix (row 18 of v1; kept unchanged)
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
// rgbToHsl — standard RGB→HSL conversion (row 16's round-trip source)
// ---------------------------------------------------------------------------

describe("rgbToHsl", () => {
	it("white → h 0, s 0, l 100", () => {
		expect(rgbToHsl(255, 255, 255)).toEqual({ h: 0, s: 0, l: 100 });
	});

	it("black → h 0, s 0, l 0", () => {
		expect(rgbToHsl(0, 0, 0)).toEqual({ h: 0, s: 0, l: 0 });
	});

	it("pure red → h 0, s 100, l 50", () => {
		expect(rgbToHsl(255, 0, 0)).toEqual({ h: 0, s: 100, l: 50 });
	});

	it("(255, 100, 0) → h ≈ 23.5, s 100, l 50", () => {
		const hsl = rgbToHsl(255, 100, 0);
		expect(hsl.h).toBeCloseTo(23.5, 0);
		expect(hsl.s).toBeCloseTo(100, 0);
		expect(hsl.l).toBeCloseTo(50, 0);
	});

	it("gray (128, 128, 128) → s 0", () => {
		const hsl = rgbToHsl(128, 128, 128);
		expect(hsl.s).toBe(0);
		expect(hsl.h).toBe(0);
		expect(hsl.l).toBeCloseTo(50.2, 0);
	});
});

// ---------------------------------------------------------------------------
// darkenAccentFg — darkened accent derivation (rows 16–19)
// ---------------------------------------------------------------------------

describe("darkenAccentFg", () => {
	// Row 16: truecolor accent → same hue/sat, lightness ≈ half
	it("truecolor accent → same hue/sat, lightness ≈ half (via RGB→HSL of output)", () => {
		const out = darkenAccentFg(trueColorTheme);
		expect(out).not.toBeNull();
		expect(out).toMatch(/^\x1b\[38;2;\d+;\d+;\d+m$/);
		const m = /^\x1b\[38;2;(\d+);(\d+);(\d+)m$/.exec(out!);
		const hsl = rgbToHsl(Number(m![1]), Number(m![2]), Number(m![3]));
		// Source accent (255,100,0): h 23.5, s 100, l 50 → darkened l ≈ 25
		expect(hsl.h).toBeCloseTo(23.5, 0);
		expect(hsl.s).toBeCloseTo(100, 0);
		expect(hsl.l).toBeCloseTo(25, 0);
		expect(hsl.l).toBeLessThan(30);
	});

	// Row 17: default accent (\x1b[39m) → null
	it("default accent (\\x1b[39m) → null", () => {
		const theme = {
			...trueColorTheme,
			getFgAnsi: () => "\x1b[39m",
		};
		expect(darkenAccentFg(theme)).toBeNull();
	});

	// Row 18: 256-color accent (38;5) → null
	it("256-color accent (\\x1b[38;5;242m) → null", () => {
		const theme = {
			...trueColorTheme,
			getFgAnsi: () => "\x1b[38;5;242m",
		};
		expect(darkenAccentFg(theme)).toBeNull();
	});

	it("malformed ANSI from getFgAnsi → null (anything non-truecolor)", () => {
		const theme = { ...trueColorTheme, getFgAnsi: () => "garbage" };
		expect(darkenAccentFg(theme)).toBeNull();
	});

	// Row 19: theme lacking getFgAnsi → null
	it("theme without getFgAnsi → null", () => {
		expect(darkenAccentFg(testTheme)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// renderTimelineRow — half-cell rendering matrix (rows 6–14, 20–21)
// ---------------------------------------------------------------------------

describe("renderTimelineRow", () => {
	// width < 1 → ""
	it("width < 1 → empty string", () => {
		expect(renderTimelineRow([], testTheme, 0)).toBe("");
		expect(renderTimelineRow([], testTheme, -1)).toBe("");
	});

	// Row 6: single bright left half → accent ▌
	it("bright left half → accent ▌", () => {
		const cells = computeTimelineCells([msg(63_400, "user")], NOW, 80, undefined);
		const row = renderTimelineRow(cells, testTheme, 80);
		expect(row.slice(0, 79)).toBe(" ".repeat(79));
		expect(row.slice(79)).toBe("[accent:▌]");
	});

	it("bright right half → accent ▐", () => {
		const cells: TimelineCell[] = [{ ...emptyCell(), right: "bright" }];
		expect(renderTimelineRow(cells, testTheme, 1)).toBe("[accent:▐]");
	});

	// Row 7: llm in later half → dark ▐ (raw ANSI when darkFg provided,
	// dim fallback when not; row 20 covers the no-getFgAnsi path)
	it("dark right half with explicit darkFg → darkFg + ▐ + reset", () => {
		const cells = computeTimelineCells([msg(MIN_AGE_MS, "assistant")], NOW, 80, undefined);
		const darkFg = "\x1b[38;2;128;50;0m";
		const row = renderTimelineRow(cells, testTheme, 80, darkFg);
		expect(row.endsWith(`${darkFg}\u2590\x1b[39m`)).toBe(true);
	});

	it("dark right half, darkFg undefined, theme with getFgAnsi → darkened accent used", () => {
		const cells = computeTimelineCells([msg(MIN_AGE_MS, "assistant")], NOW, 80, undefined);
		const row = renderTimelineRow(cells, trueColorTheme, 80);
		expect(row).toMatch(/\x1b\[38;2;\d+;\d+;\d+m\u2590\x1b\[39m$/);
	});

	// Row 20: darkFg undefined + no getFgAnsi → dim fallback
	it("dark half, no darkFg and no getFgAnsi → dim fallback", () => {
		const cells: TimelineCell[] = [{ ...emptyCell(), right: "dark" }];
		expect(renderTimelineRow(cells, testTheme, 1)).toBe("[dim:▐]");
	});

	it("dark left half → dim ▌", () => {
		const cells: TimelineCell[] = [{ ...emptyCell(), left: "dark" }];
		expect(renderTimelineRow(cells, testTheme, 1)).toBe("[dim:▌]");
	});

	// Row 8: user earlier + llm later → both active, █ bright (user wins)
	it("bright left + dark right → accent █ (bright wins)", () => {
		const cells = computeTimelineCells(
			[msg(63_400, "user"), msg(MIN_AGE_MS, "assistant")],
			NOW,
			80,
			undefined,
		);
		const row = renderTimelineRow(cells, testTheme, 80);
		expect(row.endsWith("[accent:█]")).toBe(true);
	});

	// Row 9: llm both halves → █ dark
	it("dark both halves with explicit darkFg → darkFg + █ + reset", () => {
		const cells = computeTimelineCells(
			[msg(63_400, "assistant"), msg(MIN_AGE_MS, "assistant")],
			NOW,
			80,
			undefined,
		);
		const darkFg = "\x1b[38;2;128;50;0m";
		const row = renderTimelineRow(cells, testTheme, 80, darkFg);
		expect(row.endsWith(`${darkFg}\u2588\x1b[39m`)).toBe(true);
	});

	it("dark both halves, no darkFg → dim █", () => {
		const cells = computeTimelineCells(
			[msg(63_400, "assistant"), msg(MIN_AGE_MS, "assistant")],
			NOW,
			80,
			undefined,
		);
		expect(renderTimelineRow(cells, testTheme, 80).endsWith("[dim:█]")).toBe(true);
	});

	// Row 10: user both halves → █ bright
	it("bright both halves → accent █", () => {
		const cells = computeTimelineCells(
			[msg(63_400, "user"), msg(MIN_AGE_MS, "user")],
			NOW,
			80,
			undefined,
		);
		const row = renderTimelineRow(cells, testTheme, 80);
		expect(row.endsWith("[accent:█]")).toBe(true);
	});

	// Row 12: empty cells → all-space row, width intact
	it("empty cells → all-space row, width wide", () => {
		const cells = computeTimelineCells([], NOW, 20, undefined);
		const row = renderTimelineRow(cells, testTheme, 20);
		expect(row).toBe(" ".repeat(20));
	});

	// Row 13: marker on active cell → warning █ overrides halves
	it("marker on active cell → warning █ (overrides bright)", () => {
		const cells: TimelineCell[] = [
			{ left: "bright", right: "bright", isSessionStart: true },
		];
		const row = renderTimelineRow(cells, testTheme, 1);
		expect(row).toBe("[warning:█]");
		expect(row).not.toContain("[accent:");
	});

	it("marker on half-active cell → warning █ (overrides dark)", () => {
		const cells: TimelineCell[] = [
			{ left: "none", right: "dark", isSessionStart: true },
		];
		const row = renderTimelineRow(cells, testTheme, 1);
		expect(row).toBe("[warning:█]");
		expect(row).not.toContain("[dim:");
	});

	// Row 14: marker on empty cell → warning █ still rendered
	it("marker on empty cell → warning █", () => {
		const cells: TimelineCell[] = [{ ...emptyCell(), isSessionStart: true }];
		const row = renderTimelineRow(cells, testTheme, 1);
		expect(row).toBe("[warning:█]");
	});

	// cells.length < width → padded with spaces
	it("cells shorter than width → padded with spaces", () => {
		const cells: TimelineCell[] = [emptyCell()];
		const row = renderTimelineRow(cells, testTheme, 5);
		expect(row).toBe(" ".repeat(5));
	});

	// cells.length > width → truncated
	it("cells longer than width → truncated", () => {
		const cells: TimelineCell[] = [
			{ left: "bright", right: "bright", isSessionStart: false },
			{ left: "dark", right: "dark", isSessionStart: false },
			emptyCell(),
		];
		const row = renderTimelineRow(cells, testTheme, 1);
		expect(row).toBe("[accent:█]");
	});

	// Row 21: visibleWidth === width for W ∈ {20, 40, 80, 120}
	it("visibleWidth === width for various widths", () => {
		// ANSI theme so visibleWidth strips escape codes; includes bright
		// halves, dark halves (dim fallback), and a marker column.
		for (const w of [20, 40, 80, 120]) {
			const cells = computeTimelineCells(
				[msg(63_400, "user"), msg(1_000_000, "assistant"), msg(100_000, "user")],
				NOW,
				w,
				NOW - 3_000_000,
			);
			const row = renderTimelineRow(cells, ansiTheme, w);
			expect(visibleWidth(row)).toBe(w);
		}
	});
});

// ---------------------------------------------------------------------------
// Defensive parsing — unparseable timestamps skipped, no crash
// ---------------------------------------------------------------------------

describe("defensive parsing", () => {
	it("unparseable timestamp → skipped, no crash", () => {
		const badEntry = {
			type: "message",
			timestamp: "definitely-not-a-date",
			message: { role: "user" },
		};
		const cells = computeTimelineCells([badEntry], NOW, 40, undefined);
		expect(cells.every((c) => c.left === "none" && c.right === "none")).toBe(true);
	});

	it("entry with no timestamp field → skipped", () => {
		const noTs = { type: "message", message: { role: "user" } };
		const cells = computeTimelineCells([noTs], NOW, 40, undefined);
		expect(cells.every((c) => c.left === "none" && c.right === "none")).toBe(true);
	});

	it("entry with null timestamp → skipped", () => {
		const nullTs = {
			type: "message",
			timestamp: null,
			message: { role: "user" },
		};
		const cells = computeTimelineCells([nullTs], NOW, 40, undefined);
		expect(cells.every((c) => c.left === "none" && c.right === "none")).toBe(true);
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
		const k = halfCell(100_000, 40).col;
		const h = halfCell(100_000, 40).side;
		expect(cells[k]![h]).toBe("bright");
	});

	it("computeTimelineCells does not throw for NaN nowMs", () => {
		const cells = computeTimelineCells([msg(100_000, "user")], NaN, 40, undefined);
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
		expect(typeof mod.rgbToHsl).toBe("function");
		expect(typeof mod.darkenAccentFg).toBe("function");
	});
});
