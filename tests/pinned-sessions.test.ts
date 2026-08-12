/**
 * Unit tests for the pure helpers in extensions/pinned-sessions.ts.
 *
 * The pi wiring (commands, switchSession) is thin and exercised manually;
 * these tests pin the registry I/O, name derivation, first-user-text
 * extraction, picker-label building (skip-dead + dedup + current-marking),
 * and /unpin name matching.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	deriveName,
	firstUserText,
	readRegistry,
	writeRegistry,
	buildPickerEntries,
	matchPin,
	contractHome,
	type PinnedRegistry,
	type PinnedEntry,
} from "../extensions/pinned-sessions";

let dir: string;
let regFile: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pinned-"));
	regFile = join(dir, "pinned-sessions.json");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const entry = (path: string, over: Partial<PinnedEntry> = {}): PinnedEntry => ({
	name: "Some session",
	cwd: "/Users/scott/Developer/app",
	pinnedAt: 1000,
	sessionId: "019f-aaaa-bbbb",
	...over,
});

const reg = (entries: Record<string, PinnedEntry>): PinnedRegistry => entries;

describe("contractHome", () => {
	it("replaces the home prefix with ~", () => {
		expect(contractHome("/Users/scott/Developer/app", "/Users/scott")).toBe("~/Developer/app");
	});
	it("leaves foreign paths untouched", () => {
		expect(contractHome("/opt/homebrew/bin", "/Users/scott")).toBe("/opt/homebrew/bin");
	});
	it("contracts an exact home to ~", () => {
		expect(contractHome("/Users/scott", "/Users/scott")).toBe("~");
	});
	it("passes empty through", () => {
		expect(contractHome("", "/Users/scott")).toBe("");
	});
});

describe("deriveName", () => {
	it("collapses whitespace", () => {
		expect(deriveName("  foo\n  bar  ")).toBe("foo bar");
	});
	it("truncates with an ellipsis past the limit", () => {
		const long = "x".repeat(80);
		const out = deriveName(long);
		expect(out.length).toBe(60);
		expect(out.endsWith("…")).toBe(true);
	});
	it("leaves short text unchanged", () => {
		expect(deriveName("Auth refactor")).toBe("Auth refactor");
	});
	it("trims to empty on whitespace-only input", () => {
		expect(deriveName("   \n\t ")).toBe("");
	});
});

describe("firstUserText", () => {
	it("returns the first user message text (string content)", () => {
		const entries = [
			{ type: "message", message: { role: "user", content: "Fix the login bug" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
		];
		expect(firstUserText(entries)).toBe("Fix the login bug");
	});
	it("joins array text blocks", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "Look at" },
						{ type: "image", data: "x" },
						{ type: "text", text: "this" },
					],
				},
			},
		];
		expect(firstUserText(entries)).toBe("Look at this");
	});
	it("skips non-user and non-message entries", () => {
		const entries = [
			{ type: "custom", data: { foo: 1 } },
			{ type: "message", message: { role: "assistant", content: "hi" } },
			{ type: "message", message: { role: "toolResult", content: "x" } },
			{ type: "message", message: { role: "user", content: "found me" } },
		];
		expect(firstUserText(entries)).toBe("found me");
	});
	it("returns undefined when there is no user message", () => {
		expect(firstUserText([{ type: "message", message: { role: "assistant", content: "hi" } }])).toBeUndefined();
		expect(firstUserText([])).toBeUndefined();
	});
	it("returns undefined for a user message with only non-text content", () => {
		const entries = [
			{ type: "message", message: { role: "user", content: [{ type: "image", data: "x" }] } },
		];
		expect(firstUserText(entries)).toBeUndefined();
	});
});

describe("readRegistry / writeRegistry", () => {
	it("returns {} for a missing file", () => {
		expect(readRegistry(regFile)).toEqual({});
	});
	it("returns {} for a corrupt file", () => {
		writeFileSync(regFile, "{ not json");
		expect(readRegistry(regFile)).toEqual({});
	});
	it("returns {} for a non-object JSON value", () => {
		writeFileSync(regFile, "[]");
		expect(readRegistry(regFile)).toEqual({});
		writeFileSync(regFile, "42");
		expect(readRegistry(regFile)).toEqual({});
	});
	it("round-trips a populated registry", () => {
		const r = reg({
			"/a/session.jsonl": entry("/a/session.jsonl", { name: "A" }),
			"/b/session.jsonl": entry("/b/session.jsonl", { name: "B", pinnedAt: 2000 }),
		});
		writeRegistry(r, regFile);
		expect(readRegistry(regFile)).toEqual(r);
	});
	it("writeRegistry creates missing parent dirs", () => {
		const nested = join(dir, "deep/nested/pinned.json");
		writeRegistry(reg({}), nested);
		expect(existsSync(nested)).toBe(true);
	});
});

describe("buildPickerEntries", () => {
	it("includes only entries whose file exists", () => {
		const livePath = join(dir, "live.jsonl");
		writeFileSync(livePath, "{}");
		const r = reg({
			[livePath]: entry(livePath, { name: "Live" }),
			["/gone/session.jsonl"]: entry("/gone/session.jsonl", { name: "Gone" }),
		});
		const items = buildPickerEntries(r, { exists: () => true }); // trust all
		expect(items.map((i) => i.name)).toEqual(["Gone", "Live"]); // sorted by name
		// default exists (existsSync) should drop the gone one
		const realItems = buildPickerEntries(r);
		expect(realItems.map((i) => i.name)).toEqual(["Live"]);
	});
	it("sorts case-insensitively by name, then path", () => {
		const a = join(dir, "a.jsonl");
		const b = join(dir, "b.jsonl");
		writeFileSync(a, "{}");
		writeFileSync(b, "{}");
		const r = reg({
			[b]: entry(b, { name: "zebra" }),
			[a]: entry(a, { name: "Apple" }),
		});
		const items = buildPickerEntries(r);
		expect(items.map((i) => i.name)).toEqual(["Apple", "zebra"]);
	});
	it("builds a name · cwd label and contracts home", () => {
		const a = join(dir, "a.jsonl");
		writeFileSync(a, "{}");
		const r = reg({
			[a]: entry(a, { name: "Auth", cwd: join(dir, "Developer", "app") }),
		});
		const items = buildPickerEntries(r, { exists: () => true, home: dir });
		expect(items[0].label).toBe(`Auth  ·  ~/Developer/app`);
	});
	it("uses just the name when cwd is empty", () => {
		const a = join(dir, "a.jsonl");
		writeFileSync(a, "{}");
		const r = reg({ [a]: entry(a, { name: "Solo", cwd: "" }) });
		expect(buildPickerEntries(r, { exists: () => true })[0].label).toBe("Solo");
	});
	it("disambiguates duplicate labels with a short id suffix", () => {
		const a = join(dir, "a.jsonl");
		const b = join(dir, "b.jsonl");
		writeFileSync(a, "{}");
		writeFileSync(b, "{}");
		const r = reg({
			[a]: entry(a, { name: "Same", sessionId: "019f-aaaa-bbbb" }),
			[b]: entry(b, { name: "Same", sessionId: "019f-cccc-dddd" }),
		});
		const items = buildPickerEntries(r, { exists: () => true });
		expect(new Set(items.map((i) => i.label)).size).toBe(2);
		expect(items.every((i) => /#\w{6}$/.test(i.label))).toBe(true);
	});
	it("marks the current session with a leading bullet", () => {
		const a = join(dir, "a.jsonl");
		const b = join(dir, "b.jsonl");
		writeFileSync(a, "{}");
		writeFileSync(b, "{}");
		const r = reg({
			[a]: entry(a, { name: "Alpha" }),
			[b]: entry(b, { name: "Beta" }),
		});
		const items = buildPickerEntries(r, { currentPath: a, exists: () => true });
		const alpha = items.find((i) => i.path === a)!;
		const beta = items.find((i) => i.path === b)!;
		expect(alpha.label.startsWith("● ")).toBe(true);
		expect(beta.label.startsWith("● ")).toBe(false);
	});
	it("returns an empty array for an empty registry", () => {
		expect(buildPickerEntries(reg({}))).toEqual([]);
	});
});

describe("matchPin", () => {
	const r = reg({
		"/path/auth-refactor.jsonl": entry("/path/auth-refactor.jsonl", { name: "Auth refactor" }),
		"/path/auth-tests.jsonl": entry("/path/auth-tests.jsonl", { name: "Auth tests" }),
		"/path/unrelated.jsonl": entry("/path/unrelated.jsonl", { name: "Docs" }),
	});
	it("exact name match (case-insensitive) ranks first", () => {
		const m = matchPin(r, "auth refactor");
		expect(m).toHaveLength(1);
		expect(m[0].entry.name).toBe("Auth refactor");
	});
	it("partial name matches return all hits", () => {
		const m = matchPin(r, "auth");
		expect(m.map((x) => x.entry.name).sort()).toEqual(["Auth refactor", "Auth tests"]);
	});
	it("matches by path substring", () => {
		const m = matchPin(r, "auth-tests.jsonl");
		expect(m).toHaveLength(1);
		expect(m[0].entry.name).toBe("Auth tests");
	});
	it("exact name beats partial even when partial appears first in iteration", () => {
		// "Auth tests" exact should be the sole exact hit and rank before partials.
		const m = matchPin(r, "Auth tests");
		expect(m[0].entry.name).toBe("Auth tests");
	});
	it("returns empty for no match and for empty query", () => {
		expect(matchPin(r, "zzz")).toEqual([]);
		expect(matchPin(r, "")).toEqual([]);
	});
});
