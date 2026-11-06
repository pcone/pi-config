/**
 * WO-2026-088: the viewers' text helpers are one module, and the manual scan is
 * the one that measures.
 *
 * Commit 1 pinned the `.cjs` viewer's answers as it gave them (Y1–Y5), Y2's
 * included: `"ab\x1b["` measured 4 columns because the regex counted the two
 * bytes of the escape sequence it failed to strip. Commit 2 moves the five
 * helpers to `extensions/lib/view-text.ts` and flips Y2 to 2 — the order's
 * §Ruling: an escape sequence moves the cursor and occupies no column, so an
 * unterminated one measures 0.
 *
 * The ruling's table also measured `"\x1b["` (2 → 0) and `"\x1b[31"` (4 → 0), so
 * those rows flip with it, and one block pins the wider class the same reason
 * covers: an escape body outside `[0-9;]` is a sequence the regex could not strip
 * either. One row measures through the `.cjs` viewer's own export, because that
 * is the answer the shipped viewer now gives and the harness's boundary.
 *
 * Run: bun test tests/view-text.test.ts
 */

import { describe, expect, it } from "bun:test";
import { padRight, plainLen, timeAgo, truncate } from "../extensions/lib/view-text.ts";

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
			expect(plainLen(input)).toBe(width);
		});
	}
});

describe("plainLen of an escape sequence that never terminates (Y2)", () => {
	// WO-2026-088 §Ruling: an escape sequence moves the cursor; one that never
	// terminates moves nothing visible, so it occupies no column. The `.cjs`'s
	// regex counted the bytes it failed to strip — `"ab\x1b["` as 4.
	it("counts no columns for a bare introducer", () => {
		expect(plainLen("\x1b[")).toBe(0);
	});

	it("counts only the visible text before it", () => {
		expect(plainLen("ab\x1b[")).toBe(2);
	});

	it("counts no columns for a body with no terminating letter", () => {
		expect(plainLen("\x1b[31")).toBe(0);
	});
});

describe("plainLen on the sequences the regex could not strip (same ruling)", () => {
	it("drops a private-parameter mode set", () => {
		expect(plainLen("\x1b[?25l")).toBe(0);
	});

	it("drops an SGR mouse report", () => {
		expect(plainLen("\x1b[<64;3;5M")).toBe(0);
	});

	it("keeps measuring the text around them", () => {
		expect(plainLen("a\x1b[?25lb")).toBe(2);
	});

	it("counts a stray ESC inside a sequence as a column, so the scan is not always smaller", () => {
		// The scan's `inEscape` arm ends a sequence at a fresh ESC and counts it;
		// the regex measured 2 here. Pre-existing in v2, and why the module's class
		// statement does not claim the scan always measures less.
		expect(plainLen("\x1b[\x1b[0m")).toBe(4);
	});
});

describe("the shipped .cjs viewer answers 2 for a truncated escape (Y2)", () => {
	it("measures through the viewer's own export, as the harness imports it", () => {
		// The `.cjs` installs a process-wide `uncaughtException` handler at load, so it
		// is required inside the row — WO-2026-082's seam, `tests/watch-session-discovery.test.ts`.
		// Its other re-exports are pinned by `test-viewer.cjs`'s 100 rows.
		const viewer = require("../extensions/subagent-async/watch-session.cjs");
		expect(viewer.plainLen("ab\x1b[")).toBe(2);
	});
});

describe("truncate cuts at width - 1 visible characters and appends the reset (Y3)", () => {
	it("returns short input unchanged", () => {
		expect(truncate("short", 10)).toBe("short");
	});

	it("returns input whose visible width equals the width unchanged", () => {
		expect(truncate("12345", 5)).toBe("12345");
	});

	it("keeps a complete escape sequence and cuts the visible text", () => {
		expect(truncate("\x1b[34ma long blue string\x1b[0m", 12)).toBe("\x1b[34ma long blue\u2026\x1b[0m");
	});

	it("appends only the ellipsis and the reset when nothing fits", () => {
		expect(truncate("ab", 1)).toBe("\u2026\x1b[0m");
	});

	it("leaves a one-character input that fits alone", () => {
		expect(truncate("a", 1)).toBe("a");
	});
});

// Q-B1 (owner 2026-11-07): every terminal control code counts as zero width, not
// only the SGR-shaped ones. These are the rows the ruling added — the base regex
// counted a hide-cursor sequence as ten columns and cut lines that fit.
describe("truncate against a non-SGR sequence the regex could not strip (Q-B1)", () => {
	it("does not cut a line that only looked too wide", () => {
		// Four visible characters, width 8. Base truncated this because ESC[?25l
		// measured 6 on top of the text.
		expect(truncate("\x1b[?25labcd", 8)).toBe("\x1b[?25labcd");
	});

	it("counts an SGR mouse report as zero width too", () => {
		expect(truncate("\x1b[<64;3;5Mabcd", 8)).toBe("\x1b[<64;3;5Mabcd");
	});

	it("still cuts the visible text after a hide-cursor sequence", () => {
		// The other direction: 10 visible characters, width 5 — the sequence is
		// kept whole and the text is cut at four, with the ellipsis and reset.
		expect(truncate("\x1b[?25labcdefghij", 5)).toBe("\x1b[?25labcd\u2026\x1b[0m");
	});

	it("pads to the visible width across a hide-cursor sequence", () => {
		expect(padRight("\x1b[?25lab", 6)).toBe("\x1b[?25lab    ");
	});
});

describe("padRight pads to the visible width (Y4)", () => {
	it("pads plain text", () => {
		expect(padRight("ab", 5)).toBe("ab   ");
	});

	it("returns input wider than the width unchanged", () => {
		expect(padRight("abcdef", 3)).toBe("abcdef");
	});

	it("pads by the visible width, not the byte count", () => {
		expect(padRight("\x1b[34mhi\x1b[0m", 5)).toBe("\x1b[34mhi\x1b[0m   ");
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
			expect(timeAgo(ms)).toBe(label as never);
		});
	}
});
