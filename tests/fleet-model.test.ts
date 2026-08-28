/**
 * Tests for the fleet flash-seat model resolution (extensions/lib/fleet-model.ts).
 *
 * Covers the decision-020 behavior/failure matrix: missing/malformed/unknown
 * state file fails open to the default; both seats resolve correctly; effort
 * suffixes survive substitution; non-flash models and `undefined` pass through;
 * atomic write/clear; and call-time homedir resolution (HOME redirection).
 *
 * State-file isolation: every test redirects `process.env.HOME` to a fresh
 * mkdtemp dir so no test touches the real `~/.pi/fleet-model.json`.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	FLASH_SEAT,
	DEFAULT_FLASH,
	LEVELS,
	readFlashOverride,
	resolveFlashSeat,
	splitModelLevel,
	resolveFlashModel,
	writeFlashOverride,
	clearFlashOverride,
} from "../extensions/lib/fleet-model.ts";

// ── HOME isolation ──────────────────────────────────────────────────────────

let tmpHome: string;
let originalHome: string | undefined;

beforeEach(() => {
	originalHome = process.env.HOME;
	tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-model-test-"));
	process.env.HOME = tmpHome;
});

afterEach(() => {
	fs.rmSync(tmpHome, { recursive: true, force: true });
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
});

/** Path where the state file must land under the current HOME. */
function statePath(): string {
	return path.join(tmpHome, ".pi", "fleet-model.json");
}

// ── Table/level primitives ──────────────────────────────────────────────────

describe("table constants", () => {
	it("seats are the two flash models (glm default, deepseek override)", () => {
		expect(FLASH_SEAT.glm).toEqual({ provider: "zai", model: "zai/glm-5.3-flash" });
		expect(FLASH_SEAT.deepseek).toEqual({
			provider: "openrouter",
			model: "deepseek/deepseek-v4-flash-0731",
		});
		expect(DEFAULT_FLASH).toBe("glm");
	});

	it("LEVELS is pi's --thinking set", () => {
		expect(LEVELS).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
	});
});

describe("splitModelLevel", () => {
	it("splits a known level suffix at the last colon", () => {
		expect(splitModelLevel("zai/glm-5.3-flash:high")).toEqual({
			base: "zai/glm-5.3-flash",
			level: "high",
		});
		expect(splitModelLevel("zai/glm-5.3:max")).toEqual({ base: "zai/glm-5.3", level: "max" });
	});

	it("leaves non-level suffixes intact (no split)", () => {
		expect(splitModelLevel("z-ai/glm-5.2:batch")).toEqual({
			base: "z-ai/glm-5.2:batch",
			level: null,
		});
	});

	it("returns level null when there is no colon", () => {
		expect(splitModelLevel("zai/glm-5.3-flash")).toEqual({
			base: "zai/glm-5.3-flash",
			level: null,
		});
	});
});

// ── Matrix rows 1–5: state file → seat resolution ──────────────────────────

describe("resolveFlashSeat (matrix 1–5)", () => {
	it("row 1: no state file → glm default", () => {
		expect(resolveFlashSeat()).toEqual({ provider: "zai", model: "zai/glm-5.3-flash" });
		expect(readFlashOverride()).toBeNull();
	});

	it("row 2: {flash: deepseek} → 0731", () => {
		fs.mkdirSync(path.dirname(statePath()), { recursive: true });
		fs.writeFileSync(statePath(), JSON.stringify({ flash: "deepseek" }));
		expect(readFlashOverride()).toBe("deepseek");
		expect(resolveFlashSeat()).toEqual({
			provider: "openrouter",
			model: "deepseek/deepseek-v4-flash-0731",
		});
	});

	it("row 3: {flash: glm} → glm (explicit default)", () => {
		fs.mkdirSync(path.dirname(statePath()), { recursive: true });
		fs.writeFileSync(statePath(), JSON.stringify({ flash: "glm" }));
		expect(resolveFlashSeat()).toEqual({ provider: "zai", model: "zai/glm-5.3-flash" });
	});

	it("row 4: malformed JSON → null override, default seat, no throw", () => {
		fs.mkdirSync(path.dirname(statePath()), { recursive: true });
		fs.writeFileSync(statePath(), "{ not json !!");
		expect(() => readFlashOverride()).not.toThrow();
		expect(readFlashOverride()).toBeNull();
		expect(resolveFlashSeat()).toEqual({ provider: "zai", model: "zai/glm-5.3-flash" });
	});

	it("row 5: {flash: luna} → null override, default seat, no throw", () => {
		fs.mkdirSync(path.dirname(statePath()), { recursive: true });
		fs.writeFileSync(statePath(), JSON.stringify({ flash: "luna" }));
		expect(() => readFlashOverride()).not.toThrow();
		expect(readFlashOverride()).toBeNull();
		expect(resolveFlashSeat()).toEqual({ provider: "zai", model: "zai/glm-5.3-flash" });
	});

	it("state file with extra keys still resolves the flash key", () => {
		fs.mkdirSync(path.dirname(statePath()), { recursive: true });
		fs.writeFileSync(statePath(), JSON.stringify({ flash: "deepseek", other: 1 }));
		expect(resolveFlashSeat().model).toBe("deepseek/deepseek-v4-flash-0731");
	});
});

// ── Matrix rows 6–12: resolveFlashModel substitution ───────────────────────

describe("resolveFlashModel (matrix 6–12)", () => {
	it("row 6: flash model, default state → unchanged", () => {
		expect(resolveFlashModel("zai/glm-5.3-flash")).toBe("zai/glm-5.3-flash");
	});

	it("row 7: flash model + :high under deepseek override → 0731:high (suffix preserved)", () => {
		fs.mkdirSync(path.dirname(statePath()), { recursive: true });
		fs.writeFileSync(statePath(), JSON.stringify({ flash: "deepseek" }));
		expect(resolveFlashModel("zai/glm-5.3-flash:high")).toBe(
			"deepseek/deepseek-v4-flash-0731:high",
		);
	});

	it("row 8: same call, default state → unchanged", () => {
		expect(resolveFlashModel("zai/glm-5.3-flash:high")).toBe("zai/glm-5.3-flash:high");
	});

	it("row 9: oracle model :max under deepseek override → unchanged (never substituted)", () => {
		fs.mkdirSync(path.dirname(statePath()), { recursive: true });
		fs.writeFileSync(statePath(), JSON.stringify({ flash: "deepseek" }));
		expect(resolveFlashModel("deepseek/deepseek-v4-pro-0813:max")).toBe(
			"deepseek/deepseek-v4-pro-0813:max",
		);
	});

	it("row 10: non-flash models → unchanged", () => {
		expect(resolveFlashModel("zai/glm-5.3:high")).toBe("zai/glm-5.3:high");
		expect(resolveFlashModel("zai/glm-5.2")).toBe("zai/glm-5.2");
	});

	it("row 11: non-level suffix keeps the string intact (no split)", () => {
		expect(resolveFlashModel("z-ai/glm-5.2:batch")).toBe("z-ai/glm-5.2:batch");
	});

	it("row 12: undefined → undefined (inherit-parent path preserved)", () => {
		expect(resolveFlashModel(undefined)).toBeUndefined();
	});

	it("0731 string under deepseek override is stable (no double substitution)", () => {
		fs.mkdirSync(path.dirname(statePath()), { recursive: true });
		fs.writeFileSync(statePath(), JSON.stringify({ flash: "deepseek" }));
		expect(resolveFlashModel("deepseek/deepseek-v4-flash-0731:medium")).toBe(
			"deepseek/deepseek-v4-flash-0731:medium",
		);
	});
});

// ── Matrix rows 13–15: write / clear / HOME redirection ────────────────────

describe("write/clear (matrix 13–15)", () => {
	it("row 13: writeFlashOverride('deepseek') → exact file content, seat resolves", () => {
		writeFlashOverride("deepseek");
		expect(fs.existsSync(statePath())).toBe(true);
		expect(fs.readFileSync(statePath(), "utf8")).toBe('{\n  "flash": "deepseek"\n}');
		expect(readFlashOverride()).toBe("deepseek");
		expect(resolveFlashSeat().model).toBe("deepseek/deepseek-v4-flash-0731");
	});

	it("row 14: clear removes the file; resolve back to default; clear on missing = no-op", () => {
		writeFlashOverride("deepseek");
		clearFlashOverride();
		expect(fs.existsSync(statePath())).toBe(false);
		expect(resolveFlashSeat().model).toBe("zai/glm-5.3-flash");
		expect(() => clearFlashOverride()).not.toThrow(); // no-op on missing file
		expect(fs.existsSync(statePath())).toBe(false);
	});

	it("row 15: state file lands under the redirected HOME (call-time homedir)", () => {
		writeFlashOverride("glm");
		expect(fs.existsSync(statePath())).toBe(true);
		expect(fs.readFileSync(statePath(), "utf8")).toBe('{\n  "flash": "glm"\n}');
	});
});

// ── Source invariants ───────────────────────────────────────────────────────

describe("lib source invariants", () => {
	it("lib has no pi-package imports (pure module)", async () => {
		const src = await Bun.file("extensions/lib/fleet-model.ts").text();
		expect(src).not.toMatch(/@earendil-works\//);
	});
});
