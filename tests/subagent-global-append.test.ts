/**
 * Tests for injecting the shared global APPEND_SYSTEM.md into subagent
 * spawn args (decision 025).
 *
 * pi discovers <agentDir>/APPEND_SYSTEM.md only when no explicit
 * --append-system-prompt is given, and the spawner always passes the agent
 * body — so the global file must be injected explicitly. These tests pin:
 *   1. buildSubagentArgs emits one flag per source, in order (global first,
 *      agent body last so the role prompt has the last word).
 *   2. undefined/empty sources produce no argument — pi reads a nonexistent
 *      path as literal prompt text, so a bogus value must never be emitted.
 *   3. resolveGlobalAppendPrompt derives the path from getAgentDir() and
 *      returns undefined when the file is absent.
 *
 * Run: bun test tests/subagent-global-append.test.ts
 */

import { describe, expect, it, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildSubagentArgs,
	resolveGlobalAppendPrompt,
} from "../extensions/subagent-async/index.ts";

// getAgentDir() honors <APP_NAME>_CODING_AGENT_DIR; APP_NAME is "pi".
const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

const dirsToClean: string[] = [];
const savedEnv = process.env[ENV_AGENT_DIR];

afterEach(() => {
	for (const dir of dirsToClean) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
	dirsToClean.length = 0;
	if (savedEnv === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = savedEnv;
});

/** Point getAgentDir() at a fresh empty temp dir for the duration of a test. */
function tempAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-agent-dir-"));
	dirsToClean.push(dir);
	process.env[ENV_AGENT_DIR] = dir;
	return dir;
}

// ── buildSubagentArgs: append-flag composition ────────────────────────────

describe("buildSubagentArgs (append-system-prompt composition)", () => {
	function appendValues(args: string[]): string[] {
		return args.filter((arg, i) => args[i - 1] === "--append-system-prompt");
	}

	it("emits the global prompt before the agent body", () => {
		const globalPath = "/agent/APPEND_SYSTEM.md";
		const agentPath = "/tmp/pi-async-subagent-x/prompt-implement.md";
		const args = buildSubagentArgs({
			model: "m",
			tools: [],
			excludeTools: [],
			appendSystemPrompts: [globalPath, agentPath],
		});

		expect(appendValues(args)).toEqual([globalPath, agentPath]);
		// Ordering is explicit: the role body must be the last append source.
		expect(args.indexOf(globalPath)).toBeLessThan(args.indexOf(agentPath));
	});

	it("skips undefined and empty sources — no bogus literal argument", () => {
		const agentPath = "/tmp/pi-async-subagent-x/prompt-implement.md";
		const args = buildSubagentArgs({
			model: "m",
			tools: [],
			excludeTools: [],
			appendSystemPrompts: [undefined as unknown as string, "", agentPath],
		});

		expect(appendValues(args)).toEqual([agentPath]);
		expect(args).not.toContain("undefined");
	});

	it("omits the flag entirely when there are no sources", () => {
		const args = buildSubagentArgs({ model: "m", tools: [], excludeTools: [] });
		expect(args).not.toContain("--append-system-prompt");
	});
});

// ── resolveGlobalAppendPrompt: path derivation + absence ──────────────────

describe("resolveGlobalAppendPrompt", () => {
	it("returns <agentDir>/APPEND_SYSTEM.md when the file exists", () => {
		const dir = tempAgentDir();
		const expected = join(dir, "APPEND_SYSTEM.md");
		writeFileSync(expected, "shared rules");

		expect(resolveGlobalAppendPrompt()).toBe(expected);
	});

	it("returns undefined when the global file is absent", () => {
		tempAgentDir(); // empty dir — no APPEND_SYSTEM.md
		expect(resolveGlobalAppendPrompt()).toBeUndefined();
	});
});
