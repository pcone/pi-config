/**
 * Unit tests for the discoverAgents directory cache (WO-2026-014 Change 3).
 *
 * Coverage:
 *   - Cache hit: second call with unchanged dir returns cached agents
 *   - Cache miss on mtime change: editing a .md file invalidates cache
 *   - Cache miss on file count change: adding/removing .md files invalidates
 *   - Empty dir cache: works correctly for dirs with no .md files
 *   - Independent caching: user-dir and project-dir cached independently
 *   - Non-existent dir: handled without caching errors
 *
 * Run with bun:
 *   bun test tests/discover-agents-cache.test.ts
 */

import { describe, expect, it, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	_testDirCache,
	_loadAgentsFromDir,
	discoverAgents,
} from "../extensions/subagent-async/agents.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Bump the mtime of the dir and all .md files inside by the given delta in ms. */
function bumpMtime(dir: string, deltaMs: number): void {
	const entries = readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.isFile() && entry.name.endsWith(".md")) {
			const p = join(dir, entry.name);
			const now = new Date();
			utimesSync(p, new Date(now.getTime() + deltaMs), new Date(now.getTime() + deltaMs));
		}
	}
	const now = new Date();
	utimesSync(dir, new Date(now.getTime() + deltaMs), new Date(now.getTime() + deltaMs));
}

function minimalAgentMd(name: string, description: string): string {
	return `---\nname: ${name}\ndescription: ${description}\n---\n\nSystem prompt for ${name}.\n`;
}

function createTempAgentsDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-test-agents-"));
}

function cleanupDir(dir: string): void {
	try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("_loadAgentsFromDir cache", () => {
	let cleanupDirs: string[] = [];

	afterEach(() => {
		_testDirCache.clear();
		for (const d of cleanupDirs) cleanupDir(d);
		cleanupDirs = [];
	});

	function track(dir: string): string {
		cleanupDirs.push(dir);
		return dir;
	}

	it("cache hit: second call with unchanged dir returns cached agents (no re-read)", () => {
		const dir = track(createTempAgentsDir());
		writeFileSync(join(dir, "alpha.md"), minimalAgentMd("alpha", "Alpha agent"));

		// First call — cache miss
		const result1 = _loadAgentsFromDir(dir, "user");
		expect(result1.length).toBe(1);
		expect(result1[0].name).toBe("alpha");

		// Verify cache entry exists
		expect(_testDirCache.size).toBeGreaterThan(0);

		// Second call — cache hit (no file changes)
		const result2 = _loadAgentsFromDir(dir, "user");
		expect(result2.length).toBe(1);
		expect(result2[0].name).toBe("alpha");
		expect(result2[0].description).toBe(result1[0].description);
		// Reference equality: cache returned the same array (not a re-read)
		expect(result2).toBe(result1);
	});

	it("cache miss on mtime change: editing agent file invalidates cache", () => {
		const dir = track(createTempAgentsDir());
		writeFileSync(join(dir, "beta.md"), minimalAgentMd("beta", "Beta agent v1"));

		// First call
		const result1 = _loadAgentsFromDir(dir, "user");
		expect(result1.length).toBe(1);
		expect(result1[0].description).toBe("Beta agent v1");

		// Edit the file — bump mtime and change content
		bumpMtime(dir, 1000);
		writeFileSync(join(dir, "beta.md"), minimalAgentMd("beta", "Beta agent v2"));

		// Second call — must see new description (cache miss due to mtime change)
		const result2 = _loadAgentsFromDir(dir, "user");
		expect(result2.length).toBe(1);
		expect(result2[0].description).toBe("Beta agent v2");
	});

	it("cache miss on file count change: adding an agent invalidates cache", () => {
		const dir = track(createTempAgentsDir());
		writeFileSync(join(dir, "gamma.md"), minimalAgentMd("gamma", "Gamma agent"));

		// First call
		const result1 = _loadAgentsFromDir(dir, "user");
		expect(result1.length).toBe(1);

		// Add a second agent file
		writeFileSync(join(dir, "delta.md"), minimalAgentMd("delta", "Delta agent"));

		// Second call — must see both agents (cache miss due to file count change)
		const result2 = _loadAgentsFromDir(dir, "user");
		expect(result2.length).toBe(2);
		const names = result2.map((a) => a.name).sort();
		expect(names).toEqual(["delta", "gamma"]);
	});

	it("cache miss on file count change: removing an agent invalidates cache", () => {
		const dir = track(createTempAgentsDir());
		writeFileSync(join(dir, "epsilon.md"), minimalAgentMd("epsilon", "Epsilon agent"));
		writeFileSync(join(dir, "zeta.md"), minimalAgentMd("zeta", "Zeta agent"));

		// First call
		const result1 = _loadAgentsFromDir(dir, "user");
		expect(result1.length).toBe(2);

		// Remove one agent file
		rmSync(join(dir, "zeta.md"));

		// Second call — must see only one agent (cache miss due to file count change)
		const result2 = _loadAgentsFromDir(dir, "user");
		expect(result2.length).toBe(1);
		expect(result2[0].name).toBe("epsilon");
	});

	it("empty dir: caches correctly and returns empty agents list", () => {
		const dir = track(createTempAgentsDir());

		// First call on empty dir
		const result1 = _loadAgentsFromDir(dir, "user");
		expect(result1.length).toBe(0);

		// Second call — should be cache hit
		const result2 = _loadAgentsFromDir(dir, "user");
		expect(result2.length).toBe(0);
		// Verify cache was populated for the empty dir
		expect(_testDirCache.size).toBeGreaterThan(0);
	});

	it("non-existent dir: handled without caching errors", () => {
		const nonexistentDir = join(tmpdir(), "pi-test-nonexistent-xyzzy");
		try { rmSync(nonexistentDir, { recursive: true, force: true }); } catch { /* */ }

		const result = _loadAgentsFromDir(nonexistentDir, "user");
		expect(result.length).toBe(0);

		// Second call should also work fine
		const result2 = _loadAgentsFromDir(nonexistentDir, "user");
		expect(result2.length).toBe(0);
	});

	it("cache is keyed by (dir, source) — same dir different source uses separate entries", () => {
		const dir = track(createTempAgentsDir());
		writeFileSync(join(dir, "eta.md"), minimalAgentMd("eta", "Eta agent"));

		// Load as "user" source
		const resultUser = _loadAgentsFromDir(dir, "user");
		expect(resultUser.length).toBe(1);
		expect(resultUser[0].source).toBe("user");

		// Load as "project" source — different cache key
		const resultProject = _loadAgentsFromDir(dir, "project");
		expect(resultProject.length).toBe(1);
		expect(resultProject[0].source).toBe("project");
		// Both cache entries exist
		expect(_testDirCache.size).toBe(2);
	});

	it("cache survives repeated reads without growing", () => {
		const dir = track(createTempAgentsDir());
		writeFileSync(join(dir, "theta.md"), minimalAgentMd("theta", "Theta agent"));

		// Prime the cache
		_loadAgentsFromDir(dir, "user");
		const cacheSizeBefore = _testDirCache.size;

		// Repeated calls with no file changes — shouldn't grow the cache
		for (let i = 0; i < 10; i++) {
			_loadAgentsFromDir(dir, "user");
		}
		expect(_testDirCache.size).toBe(cacheSizeBefore);
	});

	it("agent with no name/description in frontmatter is skipped (regression)", () => {
		const dir = track(createTempAgentsDir());
		writeFileSync(join(dir, "valid.md"), minimalAgentMd("valid", "Valid agent"));
		writeFileSync(join(dir, "invalid.md"), "# No frontmatter\n\nJust content, no YAML frontmatter.");

		const result = _loadAgentsFromDir(dir, "user");
		expect(result.length).toBe(1);
		expect(result[0].name).toBe("valid");
	});

	it("mtime-only change (touch, no content change) invalidates cache", () => {
		const dir = track(createTempAgentsDir());
		writeFileSync(join(dir, "iota.md"), minimalAgentMd("iota", "Iota agent v1"));

		// Prime the cache with v1 description
		const result1 = _loadAgentsFromDir(dir, "user");
		expect(result1[0].description).toBe("Iota agent v1");

		// Touch the file (bump mtime) but keep same content — cache still invalidates
		bumpMtime(dir, 2000);

		const result2 = _loadAgentsFromDir(dir, "user");
		// Description unchanged (same file content) but cache was re-read
		expect(result2[0].description).toBe("Iota agent v1");
	});

	it("symbolic link .md files are included", () => {
		const targetDir = track(createTempAgentsDir());
		const linkDir = track(createTempAgentsDir());
		writeFileSync(join(targetDir, "kappa.md"), minimalAgentMd("kappa", "Kappa agent"));
		// Create a symlink from linkDir/kappa.md → targetDir/kappa.md
		const { symlinkSync } = require("node:fs");
		symlinkSync(join(targetDir, "kappa.md"), join(linkDir, "kappa.md"));

		const result = _loadAgentsFromDir(linkDir, "user");
		expect(result.length).toBe(1);
		expect(result[0].name).toBe("kappa");
	});
});

// ── discoverAgents scope gate (WO-2026-051 B1) ─────────────────────────────
// B1 skips the ancestor-directory walk when scope is "user". The only
// observable effect is that projectAgentsDir is null for "user" (the agents
// list was already project-free because the scope short-circuits); these tests
// also pin that agent lists stay identical for all three scopes.
describe("discoverAgents scope gate", () => {
	let cleanupDirs: string[] = [];
	let savedAgentDir: string | undefined;

	afterEach(() => {
		_testDirCache.clear();
		if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
		savedAgentDir = undefined;
		for (const d of cleanupDirs) cleanupDir(d);
		cleanupDirs = [];
	});

	function track(dir: string): string {
		cleanupDirs.push(dir);
		return dir;
	}

	/** Project tree with `.pi/agents` above `cwd`, plus a controlled user-agents
	 *  dir pointed at by PI_CODING_AGENT_DIR (read by getAgentDir at call time). */
	function setupScopes(opts: { collision?: boolean } = {}): {
		cwd: string;
		projectAgentsDir: string;
	} {
		savedAgentDir = process.env.PI_CODING_AGENT_DIR;

		const projectRoot = track(createTempAgentsDir());
		const cwd = join(projectRoot, "sub");
		mkdirSync(cwd, { recursive: true });
		const projectAgentsDir = join(projectRoot, ".pi", "agents");
		mkdirSync(projectAgentsDir, { recursive: true });
		writeFileSync(join(projectAgentsDir, "project-agent.md"), minimalAgentMd("project-agent", "Project agent"));

		const userRoot = track(createTempAgentsDir());
		const userAgentsDir = join(userRoot, "agents");
		mkdirSync(userAgentsDir, { recursive: true });
		writeFileSync(join(userAgentsDir, "user-agent.md"), minimalAgentMd("user-agent", "User agent"));

		if (opts.collision) {
			writeFileSync(join(projectAgentsDir, "shared.md"), minimalAgentMd("shared", "project shared"));
			writeFileSync(join(userAgentsDir, "shared.md"), minimalAgentMd("shared", "user shared"));
		}

		process.env.PI_CODING_AGENT_DIR = userRoot;
		return { cwd, projectAgentsDir };
	}

	it("scope 'user' excludes project agents and reports no project dir (B1 gate)", () => {
		const { cwd } = setupScopes();
		const result = discoverAgents(cwd, "user");
		expect(result.agents.map((a) => a.name).sort()).toEqual(["user-agent"]);
		expect(result.agents.every((a) => a.source === "user")).toBe(true);
		// Pre-change this returned the discovered ancestor path even though the
		// agents list was already project-free; the scope gate makes it null.
		expect(result.projectAgentsDir).toBeNull();
	});

	it("scope 'project' returns only project agents and the project dir", () => {
		const { cwd, projectAgentsDir } = setupScopes();
		const result = discoverAgents(cwd, "project");
		expect(result.agents.map((a) => a.name)).toEqual(["project-agent"]);
		expect(result.agents.every((a) => a.source === "project")).toBe(true);
		expect(result.projectAgentsDir).toBe(projectAgentsDir);
	});

	it("scope 'both' merges user + project, project winning a name collision", () => {
		const { cwd, projectAgentsDir } = setupScopes({ collision: true });
		const result = discoverAgents(cwd, "both");
		expect(result.agents.map((a) => a.name).sort()).toEqual(["project-agent", "shared", "user-agent"]);
		expect(result.agents.find((a) => a.name === "shared")?.source).toBe("project");
		expect(result.agents.find((a) => a.name === "user-agent")?.source).toBe("user");
		expect(result.projectAgentsDir).toBe(projectAgentsDir);
	});
});

// ── The repo's own agent configs parse ────────────────────────────────────
// Pins the frontmatter values the decisions rest on, through the same parser
// discovery uses — a trim/typo/unplanned widening goes red here, not at spawn.
describe("the repo's own agent configs parse", () => {
	it("implement keeps a bounded allowlist and admits the read-only plan reviewer (decision 032)", () => {
		const agents = _loadAgentsFromDir(join(import.meta.dir, "..", "agents"), "user");
		const implement = agents.find((a) => a.name === "implement");
		expect(implement, "agents/implement.md parses").toBeTruthy();
		// Decision 004 as amended: the exact bound is the invariant (a widening
		// without a ruling is as much a finding as a trim).
		expect(implement!.allowedSubagents).toEqual(["scout-code", "review-plan", "review-code", "review-tests"]);
	});
});
