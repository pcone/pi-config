/**
 * Mode definitions after decision 028: two modes (implement/orchestrate);
 * `plan` is retired.
 *
 * Run: bun test tests/modes.test.ts
 */

import { describe, expect, it } from "bun:test";
import { isValidMode, nextMode } from "../extensions/modes.ts";

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
