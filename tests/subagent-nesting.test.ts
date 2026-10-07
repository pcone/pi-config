/**
 * Decision 028: orchestrator nesting is capped at one level.
 *
 * - `subagentDepth` parses the current process depth from PI_SUBAGENT_DEPTH.
 * - `buildSubagentEnv` stamps the child's depth (parent + 1).
 * - `subagentNestingBlock` refuses orchestrator spawns at depth >= 2.
 *
 * Run: bun test tests/subagent-nesting.test.ts
 */

import { describe, expect, it } from "bun:test";
import {
	MAX_ORCHESTRATOR_NESTING_DEPTH,
	buildSubagentEnv,
	subagentDepth,
	subagentNestingBlock,
} from "../extensions/subagent-async/index.ts";

const baseConfig = {
	sessionId: "subagent-x",
	allowlist: ["orchestrator", "implement"],
	worktreePath: null,
	parentCwdForCleanup: "",
};

describe("subagentDepth", () => {
	it("treats an unset depth as the root session (0)", () => {
		expect(subagentDepth({})).toBe(0);
	});

	it("parses the stamped depth", () => {
		expect(subagentDepth({ PI_SUBAGENT_DEPTH: "1" })).toBe(1);
		expect(subagentDepth({ PI_SUBAGENT_DEPTH: "2" })).toBe(2);
	});

	it("treats garbage, zero, and negatives as 0", () => {
		expect(subagentDepth({ PI_SUBAGENT_DEPTH: "nope" })).toBe(0);
		expect(subagentDepth({ PI_SUBAGENT_DEPTH: "0" })).toBe(0);
		expect(subagentDepth({ PI_SUBAGENT_DEPTH: "-3" })).toBe(0);
	});
});

describe("buildSubagentEnv depth stamping", () => {
	it("stamps depth 1 for a spawn from the root session", () => {
		// buildSubagentEnv receives the CHILD's depth; the caller computes
		// subagentDepth() + 1, so a root-session spawn passes 1.
		const env = buildSubagentEnv({ ...baseConfig, depth: 1 });
		expect(env.PI_SUBAGENT_DEPTH).toBe("1");
	});

	it("stamps depth 2 for a spawn from a depth-1 orchestrator", () => {
		const env = buildSubagentEnv({ ...baseConfig, depth: 2 });
		expect(env.PI_SUBAGENT_DEPTH).toBe("2");
	});
});

describe("subagentNestingBlock (decision 028 cap)", () => {
	it("allows a root session to dispatch an orchestrator", () => {
		expect(subagentNestingBlock("orchestrator", 0)).toBeNull();
	});

	it("allows a depth-1 orchestrator to nest once", () => {
		expect(subagentNestingBlock("orchestrator", 1)).toBeNull();
	});

	it("refuses an orchestrator spawn at the cap", () => {
		for (const depth of [MAX_ORCHESTRATOR_NESTING_DEPTH, 3, 7]) {
			const msg = subagentNestingBlock("orchestrator", depth);
			expect(msg).toContain("capped at one level");
			expect(msg).toContain(`PI_SUBAGENT_DEPTH=${depth}`);
		}
	});

	it("does not cap non-orchestrator agents", () => {
		expect(subagentNestingBlock("implement", 5)).toBeNull();
		expect(subagentNestingBlock("review-code", 2)).toBeNull();
	});
});
