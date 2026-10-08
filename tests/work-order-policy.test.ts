/**
 * Tests for `parseWorkOrderPolicy` — decision 014's review-gate source of truth
 * — and its task-text sibling `taskDeclaresPolicySkip`.
 *
 * The field accepts two encodings of the same declaration: the bold line (the
 * leading bullet is optional since the 2026-10-07 ruling) and YAML
 * frontmatter. Frontmatter support was added 2026-08-26; before that a
 * frontmatter declaration was silently read as `required`. The bare bold line
 * had the same failure mode until the 2026-10-07 ruling.
 *
 * Run: bun test tests/work-order-policy.test.ts
 */

import { describe, expect, it } from "bun:test";
import {
	parseWorkOrderPolicy,
	taskDeclaresPolicySkip,
} from "../extensions/subagent-async/index.ts";

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

describe("parseWorkOrderPolicy — bare bold line (2026-10-07 ruling)", () => {
	it("reads skip without the leading bullet", () => {
		const wo = "**review_policy**: skip (documentation-only; orchestrator reviews the diff)";
		expect(parseWorkOrderPolicy(wo)).toBe("skip");
	});

	it("reads required without the leading bullet", () => {
		expect(parseWorkOrderPolicy("**review_policy**: required")).toBe("required");
	});

	it("ignores trailing rationale after the first token", () => {
		expect(parseWorkOrderPolicy("**review_policy**: skip — docs only")).toBe("skip");
	});

	it("still requires the marker at line start", () => {
		expect(parseWorkOrderPolicy("Rationale: **review_policy**: skip")).toBe("required");
	});

	it("prefers the bare bold line over frontmatter when both are present", () => {
		const wo = "review_policy: required\n**review_policy**: skip";
		expect(parseWorkOrderPolicy(wo)).toBe("skip");
	});

	it("tolerates leading whitespace, as the bulleted form always has", () => {
		// Not a new class introduced by the ruling: the pre-ruling bullet regex
		// anchored with `^\s*-`, so an indented bulleted declaration already
		// parsed. Dropping the dash made the same tolerance apply without it —
		// one rule for the bold line, dash or no dash.
		expect(parseWorkOrderPolicy("  **review_policy**: skip")).toBe("skip");
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

describe("taskDeclaresPolicySkip — the task-text scope", () => {
	it("reads the canonical bullet", () => {
		expect(taskDeclaresPolicySkip("Do X\n\n- **review_policy**: skip (orchestrator review)")).toBe(true);
	});

	it("reads the bare bold line (the ruling's real-world failure)", () => {
		expect(taskDeclaresPolicySkip("Do X\n\n**review_policy**: skip (docs-only; orchestrator reviews the diff)")).toBe(true);
	});

	it("does not read the YAML spelling — that is work-order scope only", () => {
		expect(taskDeclaresPolicySkip("Do X\n\nreview_policy: skip")).toBe(false);
	});

	it("does not read `required` as skip", () => {
		expect(taskDeclaresPolicySkip("**review_policy**: required | skip")).toBe(false);
	});

	it("uses first-token semantics (`skip,` is not the token `skip`)", () => {
		expect(taskDeclaresPolicySkip("- **review_policy**: skip,")).toBe(false);
	});

	it("requires the marker at line start", () => {
		expect(taskDeclaresPolicySkip("Note: **review_policy**: skip")).toBe(false);
	});
});
