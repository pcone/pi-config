/**
 * Tests for the session block on the footer's top line: the greyed-out raw
 * session UUID, the staleness glyph, and the three-word friendly name — plus
 * layoutPwdLine's width-tight degradation (full block → words-only →
 * truncated pwd).
 *
 * The words encode only an 18-bit fingerprint of the UUID, so the raw id is
 * genuinely new information; buildSessionBlock puts it greyed-out (dim) to
 * the LEFT of the words, and layoutPwdLine drops it before the words when the
 * terminal is narrow.
 *
 * Theme stubs follow the multiplier-test convention: an identity stub (fg
 * passes text through) for width assertions, and a marker stub (dim wraps in
 * `<dim:…>`) for dim/not-dim assertions.
 */
import { describe, it, expect } from "bun:test";
import {
	buildSessionBlock,
	encodeSessionId,
	decodeSessionFingerprint,
	layoutPwdLine,
	type SessionBlock,
} from "../extensions/footer-session-id";
import { visibleWidth } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Stubs & fixtures
// ---------------------------------------------------------------------------

const identityTheme = { fg: (_c: string, t: string) => t };
const markTheme = { fg: (c: string, t: string) => (c === "dim" ? `<dim:${t}>` : t) };

/** UUIDv7-shaped id; the same fixture throughout so widths are comparable. */
const SESSION_ID = "01912a3b-4c5d-7e8f-9a0b-1c2d3e4f5a6b";
const WORDS = encodeSessionId(SESSION_ID);
const FRESH = { glyph: "●", lightness: 60 };
const PWD = "~/Developer/pi-config";

/** Strip ANSI SGR codes so plain-string structure can be asserted. */
function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ---------------------------------------------------------------------------
// buildSessionBlock — content
// ---------------------------------------------------------------------------

describe("buildSessionBlock", () => {
	it("prepends the raw session id, greyed out, to the left of the words", () => {
		const block = buildSessionBlock(SESSION_ID, FRESH, markTheme);
		// dim-wrapped uuid, dim-wrapped glyph, and words that are NOT dim-wrapped.
		expect(block.text).toContain(`<dim:${SESSION_ID}>`);
		expect(block.text).toContain(`<dim:●>`);
		expect(block.text).not.toContain(`<dim:${WORDS}>`);
		// id sits before the glyph and the words.
		const idAt = block.text.indexOf(SESSION_ID);
		const wordsAt = block.text.indexOf(WORDS);
		expect(idAt).toBeGreaterThanOrEqual(0);
		expect(wordsAt).toBeGreaterThan(idAt);
	});

	it("words match encodeSessionId and the id is the only non-colored part", () => {
		const block = buildSessionBlock(SESSION_ID, FRESH, identityTheme);
		const plain = stripAnsi(block.text);
		expect(plain).toBe(`${SESSION_ID} ● ${WORDS}`);
	});

	it("session id → fingerprint round-trip still holds through the words", () => {
		const block = buildSessionBlock(SESSION_ID, FRESH, identityTheme);
		const plain = stripAnsi(block.text);
		const words = plain.split(" ").slice(2).join(" ");
		expect(decodeSessionFingerprint(words)).toBe(decodeSessionFingerprint(WORDS));
	});
});

// ---------------------------------------------------------------------------
// buildSessionBlock — width accounting (identity theme ⇒ visible = plain)
// ---------------------------------------------------------------------------

describe("buildSessionBlock width", () => {
	const block: SessionBlock = buildSessionBlock(SESSION_ID, FRESH, identityTheme);

	it("reports the visible width of the assembled text", () => {
		expect(block.width).toBe(visibleWidth(block.text));
		expect(block.wordsWidth).toBe(visibleWidth(block.wordsText));
	});

	it("widths equal the plain component lengths (ANSI ignored)", () => {
		expect(block.width).toBe(SESSION_ID.length + 1 + 1 + 1 + WORDS.length);
		expect(block.wordsWidth).toBe(1 + 1 + WORDS.length); // glyph + space + words
	});

	it("wordsText omits the id but keeps glyph + words", () => {
		expect(stripAnsi(block.wordsText)).toBe(`● ${WORDS}`);
	});
});

// ---------------------------------------------------------------------------
// layoutPwdLine — three-fit branches
// ---------------------------------------------------------------------------

describe("layoutPwdLine", () => {
	const block = buildSessionBlock(SESSION_ID, FRESH, identityTheme);

	it("full block fits: pwd left, session id + words right, exactly width", () => {
		const width = PWD.length + 2 + block.width;
		const line = layoutPwdLine(PWD, block, width, identityTheme);
		expect(visibleWidth(line)).toBe(width);
		expect(line).toBe(`${PWD}  ${block.text}`);
	});

	it("id doesn't fit but words do: drops the greyed-out uuid, keeps words", () => {
		const width = PWD.length + 2 + block.wordsWidth;
		const line = layoutPwdLine(PWD, block, width, identityTheme);
		expect(visibleWidth(line)).toBe(width);
		expect(line).toBe(`${PWD}  ${block.wordsText}`);
		expect(line).not.toContain(SESSION_ID);
		expect(line).toContain(WORDS);
	});

	it("too narrow for even the words: truncates pwd with ellipsis", () => {
		const width = 10; // narrower than pwd itself, let alone pwd + words
		const line = layoutPwdLine(PWD, block, width, identityTheme);
		expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		expect(stripAnsi(line)).toEndWith("...");
		expect(line).not.toContain(SESSION_ID);
		expect(line).not.toContain(WORDS);
	});
});
