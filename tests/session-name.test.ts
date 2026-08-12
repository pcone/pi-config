/**
 * Tests for the friendly-name reverse lookup (extensions/session-name.ts):
 * the pure resolver's match, the 7-day recency rule, ambiguity surfacing,
 * input normalization, and the subagent sentinel name.
 *
 * The 18-bit encoding means several real sessions can share one name, so
 * the resolver must disambiguate: exactly one recent (within 7 days) match
 * wins; otherwise the collision is surfaced.
 */
import { describe, expect, it } from "bun:test";
import { encodeSessionId } from "../extensions/footer-session-id";
import { normalizeFriendlyName, resolveFriendlyName, type FriendlySession } from "../extensions/session-name";

/** UUIDv7-shaped fixture; same one the footer tests use. */
const FIXTURE = "01912a3b-4c5d-7e8f-9a0b-1c2d3e4f5a6b";
const WORDS = encodeSessionId(FIXTURE);

/**
 * Build a DIFFERENT uuid that encodes to the same 18 bits: keep hex chars
 * 13-18 (random_a + variant + random_b head), zero everything else. Real
 * colliding pairs in the archive differ exactly this way.
 */
function collidingUuid(): string {
	const hex = FIXTURE.replace(/-/g, "");
	const keep = hex.slice(13, 19); // chars 13-18
	const z = `0000000000000${keep}0000000000000`; // 13 + 6 + 13 = 32
	return `${z.slice(0, 8)}-${z.slice(8, 12)}-${z.slice(12, 16)}-${z.slice(16, 20)}-${z.slice(20)}`;
}

const COLLIDER = collidingUuid();
const NOW = new Date("2026-08-11T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function mk(partial: Partial<FriendlySession> & { id: string }): FriendlySession {
	return {
		modified: new Date(NOW.getTime() - 30 * DAY),
		cwd: "/tmp/x",
		firstMessage: "hi",
		...partial,
	};
}

describe("collision fixture", () => {
	it("produces two distinct ids with the same friendly name", () => {
		expect(COLLIDER).not.toBe(FIXTURE);
		expect(encodeSessionId(COLLIDER)).toBe(WORDS);
	});
});

describe("resolveFriendlyName", () => {
	it("returns the single match", () => {
		const res = resolveFriendlyName(WORDS, [mk({ id: FIXTURE })], NOW);
		expect(res.status).toBe("found");
		if (res.status === "found") expect(res.session.id).toBe(FIXTURE);
	});

	it("assumes the unique recent match when duplicates exist", () => {
		const recent = mk({ id: FIXTURE, modified: new Date(NOW.getTime() - 2 * DAY) });
		const stale = mk({ id: COLLIDER, modified: new Date(NOW.getTime() - 30 * DAY) });
		const res = resolveFriendlyName(WORDS, [stale, recent], NOW);
		expect(res.status).toBe("found");
		if (res.status === "found") {
			expect(res.session.id).toBe(FIXTURE);
			expect(res.note).toMatch(/assumed the one active/);
		}
	});

	it("surfaces ambiguity when several matches are recent", () => {
		const a = mk({ id: FIXTURE, modified: new Date(NOW.getTime() - 2 * DAY) });
		const b = mk({ id: COLLIDER, modified: new Date(NOW.getTime() - 3 * DAY) });
		const res = resolveFriendlyName(WORDS, [a, b], NOW);
		expect(res.status).toBe("ambiguous");
		if (res.status === "ambiguous") expect(res.candidates).toHaveLength(2);
	});

	it("surfaces ambiguity when no match is recent", () => {
		const a = mk({ id: FIXTURE, modified: new Date(NOW.getTime() - 30 * DAY) });
		const b = mk({ id: COLLIDER, modified: new Date(NOW.getTime() - 40 * DAY) });
		const res = resolveFriendlyName(WORDS, [a, b], NOW);
		expect(res.status).toBe("ambiguous");
		if (res.status === "ambiguous") expect(res.note).toMatch(/none were active/);
	});

	it("treats exactly 7 days as stale (strict cutoff)", () => {
		const atCutoff = mk({ id: FIXTURE, modified: new Date(NOW.getTime() - 7 * DAY) });
		const stale = mk({ id: COLLIDER, modified: new Date(NOW.getTime() - 40 * DAY) });
		expect(resolveFriendlyName(WORDS, [atCutoff, stale], NOW).status).toBe("ambiguous");

		const justInside = mk({ id: FIXTURE, modified: new Date(NOW.getTime() - 7 * DAY + 1) });
		const res = resolveFriendlyName(WORDS, [justInside, stale], NOW);
		expect(res.status).toBe("found");
		if (res.status === "found") expect(res.session.id).toBe(FIXTURE);
	});

	it("orders ambiguous candidates most-recently-used first", () => {
		const old = mk({ id: COLLIDER, modified: new Date(NOW.getTime() - 40 * DAY) });
		const newer = mk({ id: FIXTURE, modified: new Date(NOW.getTime() - 30 * DAY) });
		const res = resolveFriendlyName(WORDS, [old, newer], NOW);
		expect(res.status).toBe("ambiguous");
		if (res.status === "ambiguous") expect(res.candidates.map((c) => c.id)).toEqual([FIXTURE, COLLIDER]);
	});

	it("normalizes case, quotes, and backticks", () => {
		for (const input of [WORDS.toUpperCase(), `"${WORDS}"`, "`" + WORDS + "`", `  ${WORDS}  `]) {
			const res = resolveFriendlyName(input, [mk({ id: FIXTURE })], NOW);
			expect(res.status).toBe("found");
		}
	});

	it("reports not_found for a well-formed name with no match", () => {
		const res = resolveFriendlyName(WORDS, [], NOW);
		expect(res.status).toBe("not_found");
	});

	it("rejects non-friendly input with a hint", () => {
		const res = resolveFriendlyName("not-three-words", [mk({ id: FIXTURE })], NOW);
		expect(res.status).toBe("invalid");
		if (res.status === "invalid") expect(res.message).toMatch(/not a valid friendly name/);
	});

	it("rejects a full session id with a 'use it directly' hint", () => {
		const res = resolveFriendlyName(FIXTURE, [mk({ id: FIXTURE })], NOW);
		expect(res.status).toBe("invalid");
		if (res.status === "invalid") expect(res.message).toMatch(/already a full session id/);
	});

	it("resolves the subagent sentinel name for non-UUID ids", () => {
		const sub = mk({ id: "subagent-1234", modified: new Date(NOW.getTime() - 1 * DAY) });
		const res = resolveFriendlyName("wandering-???-seeker", [sub], NOW);
		expect(res.status).toBe("found");
		if (res.status === "found") expect(res.session.id).toBe("subagent-1234");
	});

	it("keeps session context (cwd, first message) on the match", () => {
		const res = resolveFriendlyName(WORDS, [mk({ id: FIXTURE, cwd: "/repo", firstMessage: "hello there" })], NOW);
		expect(res.status).toBe("found");
		if (res.status === "found") {
			expect(res.session.cwd).toBe("/repo");
			expect(res.session.firstMessage).toBe("hello there");
		}
	});
});

describe("normalizeFriendlyName", () => {
	it("strips quotes/backticks and lowercases", () => {
		expect(normalizeFriendlyName(`"Arcane-Phoenix-Archmage"`)).toBe("arcane-phoenix-archmage");
		expect(normalizeFriendlyName("`arcane-phoenix-archmage`")).toBe("arcane-phoenix-archmage");
		expect(normalizeFriendlyName("  arcane-phoenix-archmage  ")).toBe("arcane-phoenix-archmage");
	});
});
