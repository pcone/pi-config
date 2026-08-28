/**
 * Tests for `parseWorkOrderPolicy` — decision 014's review-gate source of truth.
 *
 * The function accepts two encodings of the same declaration: the canonical
 * bolded bullet the work-order template prescribes, and YAML frontmatter.
 * Frontmatter support was added 2026-08-26; before that a frontmatter
 * declaration was silently read as `required`.
 *
 * Run: bun test tests/work-order-policy.test.ts
 */

import { describe, expect, it } from "bun:test";
import { parseWorkOrderPolicy } from "../extensions/subagent-async/index.ts";

describe("parseWorkOrderPolicy — canonical bolded bullet", () => {
	it("reads skip", () => {
		expect(parseWorkOrderPolicy("- **review_policy**: skip")).toBe("skip");
	});

	it("reads required", () => {
		expect(parseWorkOrderPolicy("- **review_policy**: required")).toBe("required");
	});

	it("ignores trailing rationale after the first token", () => {
		const wo = "- **review_policy**: skip (documentation-only; orchestrator reviews the diff)";
		expect(parseWorkOrderPolicy(wo)).toBe("skip");
	});

	it("treats the template literal `required | skip` as required", () => {
		const wo = "- **review_policy**: required | skip — default `required`.";
		expect(parseWorkOrderPolicy(wo)).toBe("required");
	});
});

describe("parseWorkOrderPolicy — YAML frontmatter", () => {
	it("reads skip (the 2026-08-26 regression fix)", () => {
		const wo = ["---", "work_order_id: WO-2026-067", "review_policy: skip", "---", "", "# Body"].join("\n");
		expect(parseWorkOrderPolicy(wo)).toBe("skip");
	});

	it("reads required", () => {
		const wo = ["---", "review_policy: required", "---"].join("\n");
		expect(parseWorkOrderPolicy(wo)).toBe("required");
	});

	it("ignores trailing rationale after the first token", () => {
		const wo = "---\nreview_policy: skip — process-hygiene sweep; orchestrator reviews the diff.\n---";
		expect(parseWorkOrderPolicy(wo)).toBe("skip");
	});

	it("does not match an indented occurrence (not a frontmatter key)", () => {
		expect(parseWorkOrderPolicy("  review_policy: skip")).toBe("required");
	});
});

describe("parseWorkOrderPolicy — precedence and defaults", () => {
	it("defaults to required when no declaration is present", () => {
		expect(parseWorkOrderPolicy("# WO\n\nSome body text.")).toBe("required");
	});

	it("prefers the canonical bullet over frontmatter when both are present", () => {
		const wo = ["---", "review_policy: required", "---", "", "- **review_policy**: skip"].join("\n");
		expect(parseWorkOrderPolicy(wo)).toBe("skip");
	});

	it("is not a substring match for skip", () => {
		expect(parseWorkOrderPolicy("review_policy: skipped-for-now")).toBe("required");
	});
});
