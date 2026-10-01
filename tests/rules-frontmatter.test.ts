/**
 * Tests for rule frontmatter parsing and load warnings.
 *
 * Covers the Claude-compat scalar `paths` shape (a single glob scalar;
 * Claude Code's parser accepts it; pi used to warn and drop the rule),
 * Cursor-dialect fields (`globs`/`alwaysApply`) getting a precise migration
 * warning, and `paths: []` being an explicit no-op rather than a one-element
 * empty-string pattern that silently never matches.
 *
 * Run: bun test tests/rules-frontmatter.test.ts
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRule, parseFrontmatter } from "../extensions/rules.ts";

function load(content: string) {
	const dir = mkdtempSync(join(tmpdir(), "rules-frontmatter-"));
	const file = join(dir, "sample.md");
	writeFileSync(file, content);
	const warnings: string[] = [];
	const rule = loadRule(file, warnings);
	rmSync(dir, { recursive: true, force: true });
	return { rule, warnings };
}

const ruleFile = (frontmatter: string) =>
	`---\n${frontmatter}\n---\n\n# Sample\n`;

describe("parseFrontmatter — paths shapes", () => {
	it("reads the YAML list form", () => {
		const { frontmatter } = parseFrontmatter(
			ruleFile('paths:\n  - "**/*.tfd"\n  - "tests/**"'),
		);
		expect(frontmatter?.paths).toEqual(["**/*.tfd", "tests/**"]);
	});

	it("reads a quoted scalar (the shape Claude Code accepts)", () => {
		const { frontmatter } = parseFrontmatter(ruleFile('paths: "**/*.tfd"'));
		expect(frontmatter?.paths).toEqual(["**/*.tfd"]);
	});

	it("reads an unquoted scalar", () => {
		const { frontmatter } = parseFrontmatter(ruleFile("paths: **/*.tfd"));
		expect(frontmatter?.paths).toEqual(["**/*.tfd"]);
	});

	it("reads an inline array", () => {
		const { frontmatter } = parseFrontmatter(
			ruleFile('paths: ["a/**", "b/**"]'),
		);
		expect(frontmatter?.paths).toEqual(["a/**", "b/**"]);
	});

	it("treats an empty inline array as no paths", () => {
		const { frontmatter } = parseFrontmatter(ruleFile("paths: []"));
		expect(frontmatter?.paths).toEqual([]);
	});
});

describe("parseFrontmatter — foreign dialects", () => {
	it("records Cursor's globs/alwaysApply", () => {
		const { frontmatter } = parseFrontmatter(
			ruleFile('globs: ["**/*.cs"]\nalwaysApply: false'),
		);
		expect(frontmatter?.foreignFields).toEqual(["globs", "alwaysApply"]);
	});

	it("does not collect globs list items into paths", () => {
		const { frontmatter } = parseFrontmatter(ruleFile('globs:\n  - "**/*.cs"'));
		expect(frontmatter?.paths).toBeUndefined();
		expect(frontmatter?.foreignFields).toEqual(["globs"]);
	});
});

describe("loadRule — warnings", () => {
	it("a scalar-paths rule loads without warning", () => {
		const { rule, warnings } = load(ruleFile('paths: "**/*.tfd"'));
		expect(rule?.paths).toEqual(["**/*.tfd"]);
		expect(warnings).toEqual([]);
	});

	it("warns precisely on Cursor frontmatter instead of never-triggers", () => {
		const { warnings } = load(
			ruleFile('globs: ["**/*.cs"]\nalwaysApply: false'),
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("Cursor-style frontmatter (globs, alwaysApply)");
		expect(warnings[0]).toContain("rename `globs` to `paths`");
		expect(warnings[0]).not.toContain("never triggers");
	});

	it("explains alwaysApply's missing equivalent", () => {
		const { warnings } = load(ruleFile("alwaysApply: true"));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("alwaysApply");
		expect(warnings[0]).toContain("AGENTS.md");
	});

	it("still warns on a rule with no trigger", () => {
		const { warnings } = load(ruleFile("description: unconditional-ish"));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("never triggers");
	});

	it("treats paths: [] as no trigger and warns", () => {
		const { rule, warnings } = load(ruleFile("paths: []"));
		expect(rule?.paths).toEqual([]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("never triggers");
	});

	it("manual-only with no paths is fine", () => {
		const { warnings } = load(ruleFile("disable-model-invocation: true"));
		expect(warnings).toEqual([]);
	});
});
