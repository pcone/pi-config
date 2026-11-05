/**
 * WO-2026-074 — the `reviewer_kind` vocabulary, and the requirement vocabulary it
 * must not leak into.
 *
 * `reviewer_kind: plan` marks a plan reviewer. The work-order record gate reads
 * `reviewerKind !== undefined`, so every agent that reviews must declare one of the
 * recognised kinds; `work-record-ownership.test.ts` covers that boundary over the real
 * `agents/` directory. `requires_parent_reviewers` shares the token space but not the
 * vocabulary: a plan review is a phase, not a post-implementation gate, so `plan` there
 * is ignored (Q-074-a, owner 2026-11-05).
 *
 * Run: bun test tests/agents-reviewer-kind.test.ts
 */

import { afterEach, describe, expect, spyOn, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _loadAgentsFromDir, _testDirCache } from "../extensions/subagent-async/agents.ts";

const dirs: string[] = [];

afterEach(() => {
	_testDirCache.clear();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A one-agent project dir. `frontmatter` is raw YAML lines appended after name/description. */
function agentDir(frontmatter: string) {
	const dir = mkdtempSync(join(tmpdir(), "pi-reviewer-kind-"));
	dirs.push(dir);
	writeFileSync(
		join(dir, "fixture.md"),
		`---\nname: fixture\ndescription: fixture agent\n${frontmatter}---\n\nprompt\n`,
	);
	const [agent] = _loadAgentsFromDir(dir, "project");
	return agent;
}

describe("reviewer_kind: plan", () => {
	it("parses as a recognised kind", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const agent = agentDir("reviewer_kind: plan\n");
			expect(agent.reviewerKind).toBe("plan");
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});
});

describe("requires_parent_reviewers never names plan", () => {
	it("ignores a plan-only requirement instead of gating on it", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const agent = agentDir("requires_parent_reviewers: plan\n");
			expect(agent.reviewParentRequirements).toBeUndefined();
			// Ignoring it silently would leave an author believing the gate is live.
			expect(warn).toHaveBeenCalled();
			expect(String(warn.mock.calls[0]?.[0])).toContain("plan");
		} finally {
			warn.mockRestore();
		}
	});

	it("keeps the post-implementation tokens when a list mixes them with plan", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const agent = agentDir("requires_parent_reviewers: implementation,plan,tests\n");
			expect(agent.reviewParentRequirements).toEqual(["implementation", "tests"]);
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it("still skips a typo token, as before", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const agent = agentDir("requires_parent_reviewers: implementation,implementations\n");
			expect(agent.reviewParentRequirements).toEqual(["implementation"]);
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});
});
