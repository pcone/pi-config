/**
 * WO-2026-091: the build output a subagent worktree leaves behind.
 *
 * Four mechanisms, each pinned here against a fake shared dir rather than a
 * cargo build: M1 drops `<wt>/target` when it is a real directory (never a
 * symlink), M2 route 1 deletes only the artifacts a `.d` attributes to the dead
 * worktree, M2 route 2 cleans the clone's workspace members when route 1 finds
 * nothing, M3's bound plan is pure so a 20 GB box is not needed to test it, and
 * M4 drops a kept tree's target once its branch has landed or is gone. The
 * reap-level rows live with the reap (tests/subagent-worktree-lock.test.ts).
 *
 * Run: bun test tests/build-output-reaper.test.ts
 */

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CARGO_TARGET_BOUND_BYTES,
	cargoWorkspaceMembers,
	cleanCargoWorkspaceMembers,
	dirSizeBytes,
	dropLandedWorktreeTarget,
	enforceCargoTargetBound,
	planCargoBound,
	pruneCargoArtifactsFor,
	pruneExactArtifacts,
	removeWorktreeTarget,
	type CommandRunner,
} from "../extensions/lib/build-output-reaper.ts";

const scratch: string[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	scratch.push(dir);
	return dir;
}

function write(path: string, content = "x"): string {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
	return path;
}

/** Records every command it is asked to run, so a row can prove which route
 *  ran — and that a route that should not run did not. */
function fakeRunner(reply: (cmd: string, args: string[]) => { stdout?: string; stderr?: string; exitCode?: number } = () => ({})) {
	const calls: Array<{ cmd: string; args: string[]; env?: Record<string, string> }> = [];
	const run: CommandRunner = async (cmd, args, opts) => {
		calls.push({ cmd, args, env: opts.env });
		const r = reply(cmd, args);
		return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exitCode ?? 0 };
	};
	return { run, calls };
}

afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ── M1 — the worktree's own target/ ───────────────────────────────────────

describe("removeWorktreeTarget (M1)", () => {
	it("deletes a real target directory", () => {
		const wt = tempDir("pi-reaper-wt-");
		mkdirSync(join(wt, "target", "debug"), { recursive: true });
		writeFileSync(join(wt, "target", "debug", "artifact"), "bytes\n");

		expect(removeWorktreeTarget(wt)).toBe(true);
		expect(existsSync(join(wt, "target"))).toBe(false);
		// The worktree itself is not the target's business.
		expect(existsSync(wt)).toBe(true);
	});

	it("leaves a symlinked target in place (lstat, not stat)", () => {
		const wt = tempDir("pi-reaper-wt-");
		const shared = tempDir("pi-reaper-shared-");
		writeFileSync(join(shared, "artifact"), "keep\n");
		symlinkSync(shared, join(wt, "target"));

		expect(removeWorktreeTarget(wt)).toBe(false);
		expect(lstatSync(join(wt, "target")).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(shared, "artifact"), "utf8")).toBe("keep\n");
	});

	it("leaves a non-directory target alone", () => {
		const wt = tempDir("pi-reaper-wt-");
		writeFileSync(join(wt, "target"), "not a dir\n");

		expect(removeWorktreeTarget(wt)).toBe(false);
		expect(readFileSync(join(wt, "target"), "utf8")).toBe("not a dir\n");
	});

	it("returns false and stays quiet when there is no target", () => {
		const wt = tempDir("pi-reaper-wt-");
		const problems: string[] = [];
		expect(removeWorktreeTarget(wt, (d) => problems.push(d))).toBe(false);
		expect(problems).toEqual([]);
	});
});

// ── M2 route 1 — attribution ──────────────────────────────────────────────

/** A shared dir shaped like a real one: one profile, `.d` files that name a
 *  source under the worktree, and the artifacts of both crates. */
function fakeSharedDir(deadPath: string, livePath: string): string {
	const shared = tempDir("pi-reaper-shared-");
	const deps = join(shared, "debug", "deps");
	mkdirSync(deps, { recursive: true });
	writeFileSync(join(deps, "dead-abc123.d"), `${join(deps, "libdead-abc123.rlib")}: ${join(deadPath, "src/lib.rs")}\n`);
	writeFileSync(join(deps, "libdead-abc123.rlib"), "dead\n");
	writeFileSync(join(deps, "libdead-abc123.rmeta"), "dead\n");
	writeFileSync(join(deps, "live-def456.d"), `${join(deps, "liblive-def456.rlib")}: ${join(livePath, "src/lib.rs")}\n`);
	writeFileSync(join(deps, "liblive-def456.rlib"), "live\n");
	for (const [sub, name] of [["debug/.fingerprint", "dead-abc123"], ["debug/.fingerprint", "live-def456"], ["debug/build", "dead-abc123"], ["debug/build", "live-def456"]] as const) {
		mkdirSync(join(shared, sub, name), { recursive: true });
		writeFileSync(join(shared, sub, name, "entry"), name === "dead-abc123" ? "dead\n" : "live\n");
	}
	return shared;
}

describe("pruneExactArtifacts (M2 route 1)", () => {
	it("deletes only the artifacts a .d attributes to the dead worktree", () => {
		const deadPath = tempDir("pi-reaper-dead-");
		const livePath = tempDir("pi-reaper-live-");
		const shared = fakeSharedDir(deadPath, livePath);

		const result = pruneExactArtifacts(shared, deadPath);

		expect(result).toMatchObject({ depInfoScanned: 2, depInfoMatched: 1, problems: [] });
		// The dead crate's unit: dep-info, rlib, rmeta, and its two cargo dirs.
		expect(existsSync(join(shared, "debug", "deps", "dead-abc123.d"))).toBe(false);
		expect(existsSync(join(shared, "debug", "deps", "libdead-abc123.rlib"))).toBe(false);
		expect(existsSync(join(shared, "debug", "deps", "libdead-abc123.rmeta"))).toBe(false);
		expect(existsSync(join(shared, "debug", ".fingerprint", "dead-abc123"))).toBe(false);
		expect(existsSync(join(shared, "debug", "build", "dead-abc123"))).toBe(false);
		// The live worktree's copies are untouched.
		expect(existsSync(join(shared, "debug", "deps", "live-def456.d"))).toBe(true);
		expect(existsSync(join(shared, "debug", "deps", "liblive-def456.rlib"))).toBe(true);
		expect(existsSync(join(shared, "debug", ".fingerprint", "live-def456"))).toBe(true);
		expect(existsSync(join(shared, "debug", "build", "live-def456"))).toBe(true);
	});

	it("does not attribute a .d that merely shares the path's prefix", () => {
		const deadPath = tempDir("pi-reaper-dead-");
		const shared = tempDir("pi-reaper-shared-");
		const deps = join(shared, "debug", "deps");
		mkdirSync(deps, { recursive: true });
		// A sibling path that starts with the dead worktree's path.
		writeFileSync(join(deps, "sibling-999999.d"), `${join(deps, "libsibling-999999.rlib")}: ${deadPath}-sibling/src/lib.rs\n`);
		writeFileSync(join(deps, "libsibling-999999.rlib"), "sibling\n");

		const result = pruneExactArtifacts(shared, deadPath);

		expect(result.depInfoMatched).toBe(0);
		expect(existsSync(join(deps, "libsibling-999999.rlib"))).toBe(true);
	});
});

// ── M2 route 2 — the coarse route ─────────────────────────────────────────

describe("cargoWorkspaceMembers", () => {
	it("reads the members of a [workspace] manifest and rejects a plain package", () => {
		expect(cargoWorkspaceMembers('[workspace]\nmembers = ["parser", "lsp"]\n')).toEqual(["parser", "lsp"]);
		expect(cargoWorkspaceMembers('[workspace]\nmembers = [\n\t# path crates\n\t"parser",\n\t"tfd-rt",\n]\n')).toEqual(["parser", "tfd-rt"]);
		expect(cargoWorkspaceMembers('[package]\nname = "solo"\n')).toBeNull();
	});
});

describe("pruneCargoArtifactsFor (M2)", () => {
	it("stops at route 1 when a .d named the dead worktree", async () => {
		const deadPath = tempDir("pi-reaper-dead-");
		const shared = fakeSharedDir(deadPath, tempDir("pi-reaper-live-"));
		const { run, calls } = fakeRunner();

		const result = await pruneCargoArtifactsFor(shared, deadPath, { parentCwd: tempDir("pi-reaper-parent-"), run });

		expect(result.route).toBe("exact");
		expect(calls).toEqual([]); // no cargo at all
	});

	it("falls back to one cargo clean per workspace member when route 1 finds nothing", async () => {
		// dep-info in a workspace build names sources relative to the workspace
		// root, so nothing matches the worktree path: route 1 is empty.
		const shared = tempDir("pi-reaper-shared-");
		mkdirSync(join(shared, "debug", "deps"), { recursive: true });
		writeFileSync(join(shared, "debug", "deps", "alpha-06cf16ea.d"), "members/alpha/src/lib.rs: members/alpha/src/lib.rs\n");
		const parent = tempDir("pi-reaper-parent-");
		writeFileSync(join(parent, "Cargo.toml"), '[workspace]\nmembers = ["parser", "lsp"]\n');
		const { run, calls } = fakeRunner();

		const result = await pruneCargoArtifactsFor(shared, tempDir("pi-reaper-dead-"), { parentCwd: parent, run });

		expect(result.route).toBe("coarse");
		expect(result.membersCleaned).toEqual(["parser", "lsp"]);
		expect(calls.map((c) => c.args)).toEqual([["clean", "-p", "parser"], ["clean", "-p", "lsp"]]);
		// Never a full `cargo clean`: that would rebuild the registry crates the
		// shared dir exists to keep.
		expect(calls.every((c) => c.args[0] === "clean" && c.args[1] === "-p")).toBe(true);
		expect(calls.every((c) => c.env?.CARGO_TARGET_DIR === shared)).toBe(true);
	});

	it("runs no cargo for a repo that is not a workspace", async () => {
		const shared = tempDir("pi-reaper-shared-");
		const parent = tempDir("pi-reaper-parent-");
		writeFileSync(join(parent, "Cargo.toml"), '[package]\nname = "solo"\n');
		const { run, calls } = fakeRunner();

		const result = await pruneCargoArtifactsFor(shared, tempDir("pi-reaper-dead-"), { parentCwd: parent, run });

		expect(result.route).toBe("none");
		expect(calls).toEqual([]);
		expect(result.problems.join(" ")).toContain("not a [workspace] manifest");
	});

	it("runs no cargo when the parent checkout is gone", async () => {
		const shared = tempDir("pi-reaper-shared-");
		const { run, calls } = fakeRunner();

		const result = await pruneCargoArtifactsFor(shared, tempDir("pi-reaper-dead-"), { run });

		expect(result.route).toBe("none");
		expect(calls).toEqual([]);
		expect(result.problems.join(" ")).toContain("no parent checkout");
	});

	it("reports a failed clean without throwing", async () => {
		const shared = tempDir("pi-reaper-shared-");
		const parent = tempDir("pi-reaper-parent-");
		writeFileSync(join(parent, "Cargo.toml"), '[workspace]\nmembers = ["parser", "glob/*"]\n');
		const { run } = fakeRunner((_cmd, args) => (args[2] === "parser" ? { stderr: "boom", exitCode: 101 } : {}));

		const result = await pruneCargoArtifactsFor(shared, tempDir("pi-reaper-dead-"), { parentCwd: parent, run });

		expect(result.membersCleaned).toEqual([]);
		expect(result.problems.join(" ")).toContain("cargo clean -p parser failed: boom");
		expect(result.problems.join(" ")).toContain("workspace member glob not expanded: glob/*");
	});
});

// ── M4 — a worktree kept for gating ───────────────────────────────────────

describe("dropLandedWorktreeTarget (M4)", () => {
	function keptWorktree(): { worktreePath: string; parentCwd: string } {
		const worktreePath = tempDir("pi-reaper-kept-");
		mkdirSync(join(worktreePath, "target", "debug"), { recursive: true });
		writeFileSync(join(worktreePath, "target", "debug", "artifact"), "bytes\n");
		return { worktreePath, parentCwd: tempDir("pi-reaper-parent-") };
	}

	it("drops the target once the branch is merged into the parent's HEAD", async () => {
		const { worktreePath, parentCwd } = keptWorktree();
		const { run } = fakeRunner(() => ({ stdout: "* main\n  pi-subagent-merged-1\n" }));

		const landed = await dropLandedWorktreeTarget({ worktreePath, branch: "pi-subagent-merged-1", parentCwd }, { run });

		expect(landed).toMatchObject({ dropped: true, state: "merged" });
		expect(existsSync(join(worktreePath, "target"))).toBe(false);
		// The tree itself stays: resume and inspection still work.
		expect(existsSync(worktreePath)).toBe(true);
	});

	it("drops the target once the branch is gone", async () => {
		const { worktreePath, parentCwd } = keptWorktree();
		const { run } = fakeRunner((_cmd, args) => (args[0] === "rev-parse" ? { exitCode: 1 } : { stdout: "* main\n" }));

		const landed = await dropLandedWorktreeTarget({ worktreePath, branch: "pi-subagent-abandoned-1", parentCwd }, { run });

		expect(landed).toMatchObject({ dropped: true, state: "gone" });
		expect(existsSync(join(worktreePath, "target"))).toBe(false);
	});

	it("keeps the target while the branch still holds unlanded work", async () => {
		const { worktreePath, parentCwd } = keptWorktree();
		const { run } = fakeRunner((_cmd, args) => (args[0] === "rev-parse" ? { stdout: "abc\n" } : { stdout: "* main\n" }));

		const landed = await dropLandedWorktreeTarget({ worktreePath, branch: "pi-subagent-live-1", parentCwd }, { run });

		expect(landed).toMatchObject({ dropped: false, state: "live" });
		expect(existsSync(join(worktreePath, "target", "debug", "artifact"))).toBe(true);
	});
});

// ── M3 — the bound ────────────────────────────────────────────────────────

const GiB = 1024 ** 3;

describe("planCargoBound (M3)", () => {
	// A fake home: the plan's repo-name derivation is exercised without the real
	// namespace, and nothing here touches disk.
	const home = "/fake/home";
	const deadUnder = (repo: string, suffix: string) => join(home, "Developer", "wt", "subagents", `${repo}-${suffix}`);
	const sharedFor = (repo: string) => join(home, ".cache", "cargo-target", repo);

	it("plans both passes for a dir over the bound", () => {
		const cargoTargetDir = sharedFor("tfd-d");
		const dead = [{ worktreePath: deadUnder("tfd-d", "77a40e201285"), parentCwd: "/fake/home/Developer/tfd-d" }];

		const actions = planCargoBound([{ cargoTargetDir, bytes: 21 * GiB }], dead, CARGO_TARGET_BOUND_BYTES, home);

		expect(actions).toEqual([{ cargoTargetDir, worktreePaths: [dead[0].worktreePath], coarsePrune: true }]);
	});

	it("plans nothing for a dir under the bound", () => {
		const cargoTargetDir = sharedFor("tfd-d");
		const dead = [{ worktreePath: deadUnder("tfd-d", "77a40e201285"), parentCwd: "/fake/home/Developer/tfd-d" }];

		expect(planCargoBound([{ cargoTargetDir, bytes: 19 * GiB }], dead, CARGO_TARGET_BOUND_BYTES, home)).toEqual([]);
	});

	it("ignores dead paths of another clone and paths outside the namespace", () => {
		const cargoTargetDir = sharedFor("tfd-d");
		const dead = [
			{ worktreePath: deadUnder("other-repo", "abcdef123456"), parentCwd: "/x" },
			{ worktreePath: join(home, "Developer", "wt", "tfd-hand-made"), parentCwd: "/x" },
		];

		const actions = planCargoBound([{ cargoTargetDir, bytes: 21 * GiB }], dead, CARGO_TARGET_BOUND_BYTES, home);

		expect(actions).toEqual([{ cargoTargetDir, worktreePaths: [], coarsePrune: true }]);
	});
});

describe("enforceCargoTargetBound (M3)", () => {
	/** A fake home with one clone's shared dir, so the bound walks a temp tree. */
	function fakeHome(repo: string): { home: string; cargoTargetDir: string; deadPath: string } {
		const home = tempDir("pi-reaper-home-");
		const cargoTargetDir = join(home, ".cache", "cargo-target", repo);
		mkdirSync(cargoTargetDir, { recursive: true });
		const deadPath = join(home, "Developer", "wt", "subagents", `${repo}-77a40e201285`);
		return { home, cargoTargetDir, deadPath };
	}

	it("prunes the dead shares, then reports a dir still over the bound without a full clean", async () => {
		const { home, cargoTargetDir, deadPath } = fakeHome("tfd-d");
		const parentCwd = tempDir("pi-reaper-parent-");
		writeFileSync(join(parentCwd, "Cargo.toml"), '[workspace]\nmembers = ["parser"]\n');
		// Over the bound at every measurement: route 1 frees nothing here, so the
		// coarse pass runs and the dir stays over.
		const { run, calls } = fakeRunner();

		const report = await enforceCargoTargetBound({
			home,
			deadWorktrees: [{ worktreePath: deadPath, parentCwd }],
			sizeOf: () => 25 * GiB,
			run,
		});

		expect(report.boundBytes).toBe(CARGO_TARGET_BOUND_BYTES);
		expect(report.entries).toHaveLength(1);
		expect(report.entries[0]).toMatchObject({
			cargoTargetDir,
			beforeBytes: 25 * GiB,
			afterBytes: 25 * GiB,
			overBound: true,
			worktreePathsPruned: 0,
			membersCleaned: ["parser"],
			route: "coarse",
		});
		// Never a full `cargo clean`.
		expect(calls.map((c) => c.args)).toEqual([["clean", "-p", "parser"]]);
	});

	it("takes no action for a dir under the bound", async () => {
		const { home } = fakeHome("tfd-d");
		const { run, calls } = fakeRunner();

		const report = await enforceCargoTargetBound({ home, deadWorktrees: [], sizeOf: () => 5 * GiB, run });

		expect(report.entries).toEqual([]);
		expect(calls).toEqual([]);
	});

	it("uses route 1 when the dead worktree's artifacts can be attributed", async () => {
		const { home, cargoTargetDir, deadPath } = fakeHome("tfd-d");
		mkdirSync(join(cargoTargetDir, "debug", "deps"), { recursive: true });
		writeFileSync(join(cargoTargetDir, "debug", "deps", "tfd-abc123.d"), `${deadPath}/src/lib.rs: ${deadPath}/src/lib.rs\n`);
		const { run, calls } = fakeRunner();

		const report = await enforceCargoTargetBound({
			home,
			deadWorktrees: [{ worktreePath: deadPath, parentCwd: tempDir("pi-reaper-parent-") }],
			sizeOf: () => 25 * GiB,
			run,
		});

		expect(report.entries[0]).toMatchObject({
			route: "exact",
			depInfoMatched: 1,
			worktreePathsPruned: 1,
			overBound: true,
		});
		expect(existsSync(join(cargoTargetDir, "debug", "deps", "tfd-abc123.d"))).toBe(false);
		// No `[workspace]` in that parent checkout, so no coarse pass — and never a
		// full clean either way.
		expect(calls.filter((c) => c.args[0] === "clean" && c.args[1] !== "-p")).toEqual([]);
	});
});

describe("dirSizeBytes", () => {
	const MiB = 1024 ** 2;

	it("sums nested file sizes and does not follow symlinks", async () => {
		const dir = tempDir("pi-reaper-size-");
		const outside = tempDir("pi-reaper-size-outside-");
		writeFileSync(join(dir, "a"), Buffer.alloc(MiB));
		mkdirSync(join(dir, "nested", "deeper"), { recursive: true });
		writeFileSync(join(dir, "nested", "deeper", "b"), Buffer.alloc(MiB));
		// A link to a third MiB outside: following it would double-count the
		// shared dir a symlinked target/ points at.
		writeFileSync(join(outside, "c"), Buffer.alloc(MiB));
		symlinkSync(join(outside, "c"), join(dir, "link"));

		expect(await dirSizeBytes(dir)).toBe(2 * MiB);
	});

	it("answers 0 for a path that is not there", async () => {
		expect(await dirSizeBytes(join(tempDir("pi-reaper-size-"), "nope"))).toBe(0);
	});
});
