/**
 * Mode definitions after decision 028: two modes (implement/orchestrate);
 * `plan` is retired. `readModeFile` pins the persisted-mode parse, including
 * the fallback leg `loadMode() = project ?? global ?? "implement"` relies on.
 *
 * Run: bun test tests/modes.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isValidMode, nextMode, readModeFile } from "../extensions/modes.ts";

describe("mode set (decision 028)", () => {
	it("accepts implement and orchestrate", () => {
		expect(isValidMode("implement")).toBe(true);
		expect(isValidMode("orchestrate")).toBe(true);
	});

	it("rejects the retired plan mode", () => {
		expect(isValidMode("plan")).toBe(false);
	});

	it("cycles implement <-> orchestrate", () => {
		expect(nextMode("implement")).toBe("orchestrate");
		expect(nextMode("orchestrate")).toBe("implement");
	});
});

describe("readModeFile (persisted mode fallback)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-modes-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const write = (content: string) => {
		const path = join(dir, "mode.json");
		writeFileSync(path, content);
		return path;
	};

	it("returns null for a persisted plan mode (loadMode falls through to implement)", () => {
		expect(readModeFile(write(JSON.stringify({ mode: "plan" })))).toBeNull();
	});

	it("parses valid persisted modes", () => {
		expect(readModeFile(write(JSON.stringify({ mode: "orchestrate" })))).toBe("orchestrate");
		expect(readModeFile(write(JSON.stringify({ mode: "implement" })))).toBe("implement");
	});

	it("returns null for a missing file", () => {
		expect(readModeFile(join(dir, "nope.json"))).toBeNull();
	});

	it("returns null for malformed JSON or a missing mode key", () => {
		expect(readModeFile(write("{not json"))).toBeNull();
		expect(readModeFile(write(JSON.stringify({ other: true })))).toBeNull();
	});
});
