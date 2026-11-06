/**
 * WO-2026-088: the viewers' text helpers, characterized before the fold.
 *
 * Commit 1 pins the `.cjs` viewer's answers as it gives them today (Y1–Y5),
 * Y2's included: `"ab\x1b["` measures 4 columns because the regex counts the
 * two bytes of the escape it fails to strip. Commit 2 moves the five helpers to
 * `extensions/lib/view-text.ts` and flips Y2 to 2 — the order's §Ruling makes
 * the manual scan authoritative, since an escape sequence occupies no column.
 *
 * Run: bun test tests/view-text.test.ts
 */

import { describe, expect, it } from "bun:test";

/** The five helpers, as whichever module owns them at this commit. */
interface TextHelpers {
	plainLen(s: string): number;
	truncate(s: string, width: number): string;
	padRight(s: string, width: number): string;
	timeAgo(ms: number): string;
}

/**
 * The `.cjs` viewer installs a process-wide `uncaughtException` handler when it
 * loads (it guards stale-socket `ECONNREFUSED`), so it is required inside the
 * rows that need it rather than at module load, where it would outlive this file
 * and swallow another test file's stray throw — the same seam
 * `tests/watch-session-discovery.test.ts` uses (WO-2026-082).
 */
function text(): TextHelpers {
	return require("../extensions/subagent-async/watch-session.cjs");
}

describe("plainLen counts visible columns (Y1)", () => {
	const TABLE: [string, number][] = [
		["", 0],
		["abc", 3],
		["\x1b[31mred\x1b[0m", 3],
		["\x1b[31mred", 3],
		["a\x1b[1;2Hb", 2],
	];

	for (const [input, width] of TABLE) {
		it(`${JSON.stringify(input)} → ${width}`, () => {
			expect(text().plainLen(input)).toBe(width);
		});
	}
});

describe("plainLen of an escape sequence that never terminates (Y2)", () => {
	it("counts the two bytes it failed to strip", () => {
		expect(text().plainLen("\x1b[")).toBe(2);
	});

	it("counts them after the text that precedes them", () => {
		expect(text().plainLen("ab\x1b[")).toBe(4);
	});

	it("counts a body with no terminating letter", () => {
		expect(text().plainLen("\x1b[31")).toBe(4);
	});
});

describe("truncate cuts at width - 1 visible characters and appends the reset (Y3)", () => {
	it("returns short input unchanged", () => {
		expect(text().truncate("short", 10)).toBe("short");
	});

	it("returns input whose visible width equals the width unchanged", () => {
		expect(text().truncate("12345", 5)).toBe("12345");
	});

	it("keeps a complete escape sequence and cuts the visible text", () => {
		expect(text().truncate("\x1b[34ma long blue string\x1b[0m", 12)).toBe("\x1b[34ma long blue\u2026\x1b[0m");
	});

	it("appends only the ellipsis and the reset when nothing fits", () => {
		expect(text().truncate("ab", 1)).toBe("\u2026\x1b[0m");
	});

	it("leaves a one-character input that fits alone", () => {
		expect(text().truncate("a", 1)).toBe("a");
	});
});

describe("padRight pads to the visible width (Y4)", () => {
	it("pads plain text", () => {
		expect(text().padRight("ab", 5)).toBe("ab   ");
	});

	it("returns input wider than the width unchanged", () => {
		expect(text().padRight("abcdef", 3)).toBe("abcdef");
	});

	it("pads by the visible width, not the byte count", () => {
		expect(text().padRight("\x1b[34mhi\x1b[0m", 5)).toBe("\x1b[34mhi\x1b[0m   ");
	});
});

describe("timeAgo boundaries (Y5)", () => {
	const TABLE: [number, string][] = [
		[59_000, "59s ago"],
		[60_000, "1m ago"],
		[59 * 60_000, "59m ago"],
		[60 * 60_000, "1h ago"],
	];

	for (const [ms, label] of TABLE) {
		it(`${ms} ms → ${label}`, () => {
			expect(text().timeAgo(ms)).toBe(label as never);
		});
	}
});
