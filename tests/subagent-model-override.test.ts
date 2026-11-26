/**
 * Decision 054: a spawn's `model` param runs the child on a requested model only
 * when the agent's `allowedModels` lists its id. Resolver rows, allowlist parsing,
 * and the shipped agent files. Pure: no spawn, no network.
 *
 * Run: bun test tests/subagent-model-override.test.ts
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _loadAgentsFromDir } from "../extensions/subagent-async/agents.ts";
import { FLEET_MODEL_SPEC } from "../extensions/lib/fleet-model.ts";
import { resolveChildModel } from "../extensions/subagent-async/index.ts";

const SEAT = "opencode-go/deepseek-v4.1-flash:high";
const OVERRIDE = "runpod/bonsai25-27b-v1";
const ALLOWED = [OVERRIDE];
const AGENTS_DIR = join(import.meta.dir, "..", "agents");

// ── Resolver ────────────────────────────────────────────────────────────────

describe("per-spawn model override: resolver", () => {
	it("accepted override takes the seat's level when it names none", () => {
		expect(
			resolveChildModel({
				agentName: "implement",
				agentModel: SEAT,
				requestedModel: OVERRIDE,
				allowedModels: ALLOWED,
			}),
		).toBe("runpod/bonsai25-27b-v1:high");
	});

	it("accepted override with its own level keeps that level", () => {
		expect(
			resolveChildModel({
				agentName: "implement",
				agentModel: SEAT,
				requestedModel: `${OVERRIDE}:low`,
				allowedModels: ALLOWED,
			}),
		).toBe(`${OVERRIDE}:low`);
	});

	it("accepted override on a seat with a level-less model is the bare id", () => {
		expect(
			resolveChildModel({
				agentName: "implement",
				agentModel: "opencode-go/deepseek-v4.1-flash",
				requestedModel: OVERRIDE,
				allowedModels: ALLOWED,
			}),
		).toBe(OVERRIDE);
	});

	it("accepted override on a seat with no model is the bare id", () => {
		expect(
			resolveChildModel({
				agentName: "implement",
				requestedModel: OVERRIDE,
				allowedModels: ALLOWED,
			}),
		).toBe(OVERRIDE);
	});

	it("an override not in the allowlist throws, naming the agent, the model and the list", () => {
		expect(() =>
			resolveChildModel({
				agentName: "implement",
				agentModel: SEAT,
				requestedModel: "runpod/other-model",
				allowedModels: ALLOWED,
			}),
		).toThrow(/implement.*runpod\/other-model.*runpod\/bonsai25-27b-v1/);
	});

	it("an override with an empty allowlist throws, naming none", () => {
		expect(() =>
			resolveChildModel({
				agentName: "implement",
				agentModel: SEAT,
				requestedModel: OVERRIDE,
				allowedModels: [],
			}),
		).toThrow(/implement.*runpod\/bonsai25-27b-v1.*none/);
	});

	it("an override with no allowlist at all throws, naming none", () => {
		expect(() =>
			resolveChildModel({
				agentName: "implement",
				agentModel: SEAT,
				requestedModel: OVERRIDE,
			}),
		).toThrow(/implement.*runpod\/bonsai25-27b-v1.*none/);
	});

	it("an allowlisted override combined with inheritParentModel throws", () => {
		expect(() =>
			resolveChildModel({
				agentName: "implement",
				agentModel: SEAT,
				parentModel: "openrouter/x/y",
				inheritParentModel: true,
				requestedModel: OVERRIDE,
				allowedModels: ALLOWED,
			}),
		).toThrow(/inheritParentModel/);
	});

	it("an override on the orchestrator throws: it has no allowlist", () => {
		expect(() =>
			resolveChildModel({
				agentName: "orchestrator",
				agentModel: "opencode-go/deepseek-v4.1-flash:max",
				parentModel: "openrouter/deepseek/deepseek-v4.1-flash",
				requestedModel: OVERRIDE,
			}),
		).toThrow(/orchestrator.*runpod\/bonsai25-27b-v1.*none/);
	});
});

// ── No override: today's precedence, pinned by value ────────────────────────

describe("no override: resolver output is unchanged", () => {
	it("plain seat runs on its frontmatter model", () => {
		expect(resolveChildModel({ agentName: "implement", agentModel: SEAT, parentModel: "openrouter/x/y" })).toBe(
			SEAT,
		);
	});

	it("plain seat with no frontmatter model runs on the fleet spec", () => {
		expect(resolveChildModel({ agentName: "implement" })).toBe(FLEET_MODEL_SPEC);
	});

	it("inheritParentModel passes the caller model through unsubstituted", () => {
		expect(
			resolveChildModel({
				agentName: "review-code",
				agentModel: SEAT,
				parentModel: "openrouter/x/y",
				inheritParentModel: true,
			}),
		).toBe("openrouter/x/y");
	});

	it("orchestrator runs on the caller model at the seat's level", () => {
		expect(
			resolveChildModel({
				agentName: "orchestrator",
				agentModel: "opencode-go/deepseek-v4.1-flash:max",
				parentModel: "openrouter/deepseek/deepseek-v4.1-flash",
			}),
		).toBe("openrouter/deepseek/deepseek-v4.1-flash:max");
	});

	it("orchestrator with no caller model runs on the seat model", () => {
		expect(resolveChildModel({ agentName: "orchestrator", agentModel: SEAT })).toBe(SEAT);
	});

	it("resume keeps the recorded model verbatim", () => {
		expect(
			resolveChildModel({ agentName: "implement", agentModel: SEAT, parentModel: "other/z", isResume: true }),
		).toBe(SEAT);
	});

	it("resume with a requestedModel present keeps the recorded model and does not throw", () => {
		expect(
			resolveChildModel({
				agentName: "implement",
				agentModel: SEAT,
				isResume: true,
				requestedModel: OVERRIDE,
				allowedModels: [],
			}),
		).toBe(SEAT);
	});
});

// ── Frontmatter parsing ─────────────────────────────────────────────────────

describe("allowedModels frontmatter", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	/** Write one agent file per `[fileName, allowedModelsLine | null]` and load the dir. */
	function loadAgents(files: [string, string | null][]) {
		const dir = mkdtempSync(join(tmpdir(), "subagent-model-override-"));
		dirs.push(dir);
		for (const [name, line] of files) {
			const fm = [
				`name: ${name.replace(/\.md$/, "")}`,
				"description: fixture",
				...(line === null ? [] : [`allowedModels: ${line}`]),
			];
			writeFileSync(join(dir, name), `---\n${fm.join("\n")}\n---\nbody\n`);
		}
		return _loadAgentsFromDir(dir, "project");
	}

	function agent(agents: ReturnType<typeof loadAgents>, file: string) {
		const found = agents.find((a) => a.filePath.endsWith(`/${file}`));
		if (!found) throw new Error(`fixture ${file} did not load`);
		return found;
	}

	it("parses a comma-separated list and trims entries", () => {
		const agents = loadAgents([["listed.md", " runpod/bonsai25-27b-v1 ,runpod/other-model"]]);
		expect(agent(agents, "listed.md").allowedModels).toEqual(["runpod/bonsai25-27b-v1", "runpod/other-model"]);
	});

	it("is undefined when the key is absent", () => {
		const agents = loadAgents([["none.md", null]]);
		expect(agent(agents, "none.md").allowedModels).toBeUndefined();
	});

	it("keeps a :suffix that is not a thinking level, as part of the id", () => {
		const agents = loadAgents([["free.md", "openrouter/vendor/model:free"]]);
		expect(agent(agents, "free.md").allowedModels).toEqual(["openrouter/vendor/model:free"]);
	});

	it("drops an entry with a :level suffix and warns, keeping the bare entries", () => {
		const warnings: string[] = [];
		const realWarn = console.warn;
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map(String).join(" "));
		};
		let agents: ReturnType<typeof loadAgents>;
		try {
			agents = loadAgents([["leveled.md", "runpod/bonsai25-27b-v1:high, runpod/other-model"]]);
		} finally {
			console.warn = realWarn;
		}
		expect(agent(agents, "leveled.md").allowedModels).toEqual(["runpod/other-model"]);
		expect(warnings.some((w) => w.includes("leveled") && w.includes("runpod/bonsai25-27b-v1:high"))).toBe(true);
	});

	it("is undefined when every entry carries a level", () => {
		const warnings: string[] = [];
		const realWarn = console.warn;
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map(String).join(" "));
		};
		let agents: ReturnType<typeof loadAgents>;
		try {
			agents = loadAgents([["only-leveled.md", "runpod/bonsai25-27b-v1:high"]]);
		} finally {
			console.warn = realWarn;
		}
		expect(agent(agents, "only-leveled.md").allowedModels).toBeUndefined();
		expect(warnings.length).toBe(1);
	});
});

// ── The shipped agent files ─────────────────────────────────────────────────

describe("shipped agents/*.md", () => {
	it("implement lists the self-hosted model and keeps its seat model", () => {
		const agents = _loadAgentsFromDir(AGENTS_DIR, "project");
		const implement = agents.find((a) => a.name === "implement");
		expect(implement).toBeDefined();
		expect(implement?.allowedModels).toEqual([OVERRIDE]);
		expect(implement?.model).toBe("opencode-go/deepseek-v4.1-flash:high");
	});

	it("only implement.md declares allowedModels", () => {
		const declaring = readdirSync(AGENTS_DIR)
			.filter((f) => f.endsWith(".md"))
			.filter((f) => /^allowedModels:/m.test(readFileSync(join(AGENTS_DIR, f), "utf-8")));
		expect(declaring).toEqual(["implement.md"]);
	});
});
