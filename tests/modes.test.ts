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
import { isValidMode, loadModeFrom, nextMode, readModeFile, resolveModeArg } from "../extensions/modes.ts";

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

describe("loadModeFrom (project -> global -> implement)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-modes-chain-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});
	const write = (name: string, content: string) => {
		const path = join(dir, name);
		writeFileSync(path, content);
		return path;
	};

	it("falls back to implement when the project file has a retired plan mode and no global file", () => {
		const project = write("project.json", JSON.stringify({ mode: "plan" }));
		expect(loadModeFrom(project, join(dir, "missing.json"))).toBe("implement");
	});

	it("uses the global file when the project file is invalid", () => {
		const project = write("project.json", JSON.stringify({ mode: "plan" }));
		const global = write("global.json", JSON.stringify({ mode: "orchestrate" }));
		expect(loadModeFrom(project, global)).toBe("orchestrate");
	});

	it("project file beats a valid global file", () => {
		const project = write("project.json", JSON.stringify({ mode: "implement" }));
		const global = write("global.json", JSON.stringify({ mode: "orchestrate" }));
		expect(loadModeFrom(project, global)).toBe("implement");
	});

	it("defaults to implement when neither file exists", () => {
		expect(loadModeFrom(join(dir, "a.json"), join(dir, "b.json"))).toBe("implement");
	});
});

describe("resolveModeArg (/mode argument logic)", () => {
	it("cycles on an empty or whitespace-only argument", () => {
		expect(resolveModeArg("implement", "")).toBe("orchestrate");
		expect(resolveModeArg("orchestrate", "  ")).toBe("implement");
	});

	it("accepts an explicit mode, case- and whitespace-insensitively", () => {
		expect(resolveModeArg("implement", "orchestrate")).toBe("orchestrate");
		expect(resolveModeArg("orchestrate", " IMPLEMENT ")).toBe("implement");
	});

	it("returns null for the retired plan mode and unknown arguments", () => {
		expect(resolveModeArg("implement", "plan")).toBeNull();
		expect(resolveModeArg("implement", "bogus")).toBeNull();
	});
});
