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
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CARGO_TARGET_BOUND_BYTES,
	cargoWorkspaceMembers,
	cleanCargoWorkspaceMembers,
	describePrune,
	dirSizeBytes,
	dropLandedWorktreeTarget,
	enforceCargoTargetBound,
	planCargoBound,
	createReapBuildOutput,
	pruneCargoArtifactsFor,
	pruneExactArtifacts,
	removeWorktreeTarget,
	type CommandRunner,
} from "../extensions/lib/build-output-reaper.ts";

const scratch: string[] = [];

/** Both homes at one fixture home. This file's trees and their shared cargo
 *  dirs live under the same temp dir, so the two agree — the rows that keep them
 *  apart are the reap's (`tests/subagent-worktree-lock.test.ts`). */
const homesAt = (home: string) => ({ cargoHome: home, baseHome: home });

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

	it("records an unlink failure instead of throwing (reported, never swallowed)", () => {
		const wt = tempDir("pi-reaper-wt-");
		// A read-only directory inside target/: recursive delete cannot empty it,
		// so the unlink really fails and must be reported, not swallowed.
		mkdirSync(join(wt, "target", "sub"), { recursive: true });
		writeFileSync(join(wt, "target", "sub", "artifact"), "bytes\n");
		const locked = lstatSync(join(wt, "target", "sub"));
		const originalMode = locked.mode & 0o777;
		chmodSync(join(wt, "target", "sub"), 0o500);
		const problems: string[] = [];
		try {
			expect(removeWorktreeTarget(wt, (d) => problems.push(d))).toBe(false);
		} finally {
			chmodSync(join(wt, "target", "sub"), originalMode);
		}
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("not removed");
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
 *  source under the worktree, and the artifacts of both crates.
 *
 * The crate names carry cargo's divergence on purpose: dep-info and the linked
 * artifacts use the *target* name (`tfd_d-<16hex>.d`, `libtfd_d-<16hex>.rlib`),
 * while `.fingerprint` and `build` dirs use the *package* name
 * (`tfd-d-<16hex>`). Both spellings must be derived from one stem. */
function fakeSharedDir(deadPath: string, livePath: string): string {
	const shared = tempDir("pi-reaper-shared-");
	const deps = join(shared, "debug", "deps");
	mkdirSync(deps, { recursive: true });
	writeFileSync(join(deps, "tfd_d-06cf16eab8d292f7.d"), `${join(deps, "libtfd_d-06cf16eab8d292f7.rlib")}: ${join(deadPath, "src/lib.rs")}\n`);
	writeFileSync(join(deps, "libtfd_d-06cf16eab8d292f7.rlib"), "dead\n");
	writeFileSync(join(deps, "libtfd_d-06cf16eab8d292f7.rmeta"), "dead\n");
	writeFileSync(join(deps, "tfd_rt-bd8665ddd11f8381.d"), `${join(deps, "libtfd_rt-bd8665ddd11f8381.rlib")}: ${join(livePath, "src/lib.rs")}\n`);
	writeFileSync(join(deps, "libtfd_rt-bd8665ddd11f8381.rlib"), "live\n");
	for (const [sub, name, body] of [
		["debug/.fingerprint", "tfd-d-06cf16eab8d292f7", "dead\n"],
		["debug/.fingerprint", "tfd-rt-bd8665ddd11f8381", "live\n"],
		["debug/build", "tfd-d-06cf16eab8d292f7", "dead\n"],
		["debug/build", "tfd-rt-bd8665ddd11f8381", "live\n"],
	] as const) {
		mkdirSync(join(shared, sub, name), { recursive: true });
		writeFileSync(join(shared, sub, name, "entry"), body);
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
		// The dead crate's unit: dep-info, rlib, rmeta, and its two cargo dirs —
		// the fingerprint/build dirs spelled with the package name, not the target
		// name the `.d` stem carries.
		expect(existsSync(join(shared, "debug", "deps", "tfd_d-06cf16eab8d292f7.d"))).toBe(false);
		expect(existsSync(join(shared, "debug", "deps", "libtfd_d-06cf16eab8d292f7.rlib"))).toBe(false);
		expect(existsSync(join(shared, "debug", "deps", "libtfd_d-06cf16eab8d292f7.rmeta"))).toBe(false);
		expect(existsSync(join(shared, "debug", ".fingerprint", "tfd-d-06cf16eab8d292f7"))).toBe(false);
		expect(existsSync(join(shared, "debug", "build", "tfd-d-06cf16eab8d292f7"))).toBe(false);
		// The live worktree's copies are untouched.
		expect(existsSync(join(shared, "debug", "deps", "tfd_rt-bd8665ddd11f8381.d"))).toBe(true);
		expect(existsSync(join(shared, "debug", "deps", "libtfd_rt-bd8665ddd11f8381.rlib"))).toBe(true);
		expect(existsSync(join(shared, "debug", ".fingerprint", "tfd-rt-bd8665ddd11f8381"))).toBe(true);
		expect(existsSync(join(shared, "debug", "build", "tfd-rt-bd8665ddd11f8381"))).toBe(true);
	});

	it("reports a dep-info file it cannot read instead of swallowing it", async () => {
		const deadPath = tempDir("pi-reaper-dead-");
		const shared = tempDir("pi-reaper-shared-");
		const deps = join(shared, "debug", "deps");
		mkdirSync(deps, { recursive: true });
		const unreadable = write(join(deps, "unreadable-abc123.d"), `${deadPath}/src/lib.rs: ${deadPath}/src/lib.rs\n`);
		chmodSync(unreadable, 0o000);
		try {
			const result = await pruneCargoArtifactsFor(shared, deadPath, { run: fakeRunner().run });

			expect(result.depInfoMatched).toBe(0);
			expect(result.problems.join(" ")).toContain("not readable");
			// And the failure reaches the caller's report line, which is what a
			// ReapResult.detail carries.
			expect(describePrune(result)).toContain("problems:");
		} finally {
			chmodSync(unreadable, 0o644);
		}
	});

	// ── WO-2026-096: the scan covers every profile-level dep-info location ──

	/** The nested layout of WO-2026-091's probe, in the shape real cargo wrote
	 *  it on 2026-11-08 (`~/Developer/probe-depinfo/probe-tD`): the workspace
	 *  sits at `<W>/ws`, its path dep at `<W>/inside-lib` — inside the checkout,
	 *  outside the workspace root cargo built. Cargo therefore absolutizes the
	 *  dep's sources, and the *example* target's dep-info (which pulls a source
	 *  from the dep by `#[path]`) lands in `<profile>/examples/`, not `deps/`. */
	function nestedLayout(deadPath: string): string {
		const target = tempDir("pi-reaper-nested-target-");
		const profile = join(target, "debug");
		const depSource = join(deadPath, "inside-lib", "src", "lib.rs");
		write(
			join(profile, "examples", "inside_demo.d"),
			`${join(profile, "examples", "inside_demo")}: ${depSource} ${join(deadPath, "ws/app/examples/inside_demo.rs")}\n`,
		);
		write(join(profile, "examples", "inside_demo"));
		write(
			join(profile, "deps", "inside_lib-50965d21f0660055.d"),
			`${join(profile, "deps", "libinside_lib-50965d21f0660055.rlib")}: ${depSource}\n`,
		);
		write(join(profile, "deps", "libinside_lib-50965d21f0660055.rlib"));
		write(join(profile, "deps", "libinside_lib-50965d21f0660055.rmeta"));
		mkdirSync(join(profile, ".fingerprint", "inside-lib-50965d21f0660055"), { recursive: true });
		mkdirSync(join(profile, "build", "inside-lib-50965d21f0660055"), { recursive: true });
		return target;
	}

	it("R1: attributes the dep in a nested workspace, from a .d outside deps/", () => {
		const deadPath = tempDir("pi-reaper-dead-");
		const target = nestedLayout(deadPath);

		const result = pruneExactArtifacts(target, deadPath);

		// Both the dep's own unit and the example that pulled a source from it.
		expect(result).toMatchObject({ depInfoScanned: 2, depInfoMatched: 2, problems: [] });
		expect(existsSync(join(target, "debug", "examples", "inside_demo.d"))).toBe(false);
		expect(existsSync(join(target, "debug", "examples", "inside_demo"))).toBe(false);
		expect(existsSync(join(target, "debug", "deps", "inside_lib-50965d21f0660055.d"))).toBe(false);
		expect(existsSync(join(target, "debug", "deps", "libinside_lib-50965d21f0660055.rlib"))).toBe(false);
		expect(existsSync(join(target, "debug", "deps", "libinside_lib-50965d21f0660055.rmeta"))).toBe(false);
		expect(existsSync(join(target, "debug", ".fingerprint", "inside-lib-50965d21f0660055"))).toBe(false);
		expect(existsSync(join(target, "debug", "build", "inside-lib-50965d21f0660055"))).toBe(false);
	});

	/** This box's shape, measured 2026-11-08 on
	 *  `~/.cache/cargo-target/tfd-d-487`: absolutized worktree paths at
	 *  `<profile>/*.d` (linked bin targets) and `<profile>/examples/*.d`, none
	 *  under `deps/` — plus a live worktree's `.d` and one naming no worktree,
	 *  which R3 keeps. */
	function boxLayout(deadPath: string, livePath: string): string {
		const target = tempDir("pi-reaper-box-target-");
		const release = join(target, "release");
		const examples = join(target, "debug", "examples");
		write(join(release, "tfd.d"), `${join(release, "tfd")}: ${join(deadPath, "binary/src/main.rs")} ${join(deadPath, "parser/src/lib.rs")}\n`);
		write(join(release, "tfd"));
		write(join(examples, "alloc_cost.d"), `${join(examples, "alloc_cost")}: ${join(deadPath, "tfd-mem/examples/alloc_cost.rs")}\n`);
		write(join(examples, "alloc_cost"));
		write(join(examples, "borrows.d"), `${join(examples, "borrows")}: ${join(deadPath, "tfd-mem/examples/borrows.rs")}\n`);
		write(join(examples, "borrows"));
		// The live worktree's copy, and a `.d` whose sources all sit inside the
		// workspace root cargo built, so it names no worktree at all.
		write(join(examples, "views.d"), `${join(examples, "views")}: ${join(livePath, "tfd-mem/examples/views.rs")}\n`);
		write(join(examples, "views"));
		write(join(examples, "scale.d"), `${join(examples, "scale")}: tfd-mem/examples/scale.rs tfd-mem/src/arena.rs\n`);
		write(join(examples, "scale"));
		// A crate unit under deps/ whose sources are relative: the inert case the
		// old deps-only scan saw here.
		write(join(target, "debug", "deps", "mtime_probe-5e932e2c4a3b9b6e.d"), "src/lib.rs: src/lib.rs\n");
		write(join(target, "debug", "deps", "libmtime_probe-5e932e2c4a3b9b6e.rlib"));
		return target;
	}

	it("R2: deletes the dead worktree's share of a profile-level scan", () => {
		const deadPath = tempDir("pi-reaper-dead-");
		const target = boxLayout(deadPath, tempDir("pi-reaper-live-"));

		const result = pruneExactArtifacts(target, deadPath);

		expect(result).toMatchObject({ depInfoScanned: 6, depInfoMatched: 3, problems: [] });
		expect(existsSync(join(target, "release", "tfd.d"))).toBe(false);
		expect(existsSync(join(target, "release", "tfd"))).toBe(false);
		expect(existsSync(join(target, "debug", "examples", "alloc_cost.d"))).toBe(false);
		expect(existsSync(join(target, "debug", "examples", "alloc_cost"))).toBe(false);
		expect(existsSync(join(target, "debug", "examples", "borrows.d"))).toBe(false);
		expect(existsSync(join(target, "debug", "examples", "borrows"))).toBe(false);
	});

	it("R3: never touches a .d naming another worktree or none", () => {
		const deadPath = tempDir("pi-reaper-dead-");
		const livePath = tempDir("pi-reaper-live-");
		const target = boxLayout(deadPath, livePath);

		const result = pruneExactArtifacts(target, deadPath);

		expect(result.depInfoMatched).toBe(3);
		// Deletion is the irreversible half: a live worktree's unit, and one
		// attributed to nobody, both survive with their siblings.
		expect(existsSync(join(target, "debug", "examples", "views.d"))).toBe(true);
		expect(existsSync(join(target, "debug", "examples", "views"))).toBe(true);
		expect(existsSync(join(target, "debug", "examples", "scale.d"))).toBe(true);
		expect(existsSync(join(target, "debug", "examples", "scale"))).toBe(true);
		expect(existsSync(join(target, "debug", "deps", "mtime_probe-5e932e2c4a3b9b6e.d"))).toBe(true);
		expect(existsSync(join(target, "debug", "deps", "libmtime_probe-5e932e2c4a3b9b6e.rlib"))).toBe(true);
	});

	it("R4: an env-dep-only .d is counted and left alone; one with a source rule is attributed", () => {
		const deadPath = tempDir("pi-reaper-dead-");
		const target = tempDir("pi-reaper-box-target-");
		const examples = join(target, "debug", "examples");
		// Cargo's build-script dep-info spells the worktree only in `env-dep:`:
		// `<pkg>.d: src/... env-dep:CARGO_MANIFEST_DIR=<worktree>/parser`.
		write(
			join(examples, "envonly.d"),
			`${join(examples, "envonly")}: parser/src/lib.rs env-dep:CARGO_MANIFEST_DIR=${join(deadPath, "parser")} env-dep:INSTA_WORKSPACE_ROOT\n`,
		);
		write(join(examples, "envonly"));
		write(
			join(examples, "mixed.d"),
			`${join(examples, "mixed")}: ${join(deadPath, "parser/src/lib.rs")} env-dep:CARGO_MANIFEST_DIR=${join(deadPath, "parser")}\n`,
		);
		write(join(examples, "mixed"));

		const result = pruneExactArtifacts(target, deadPath);

		expect(result).toMatchObject({ depInfoScanned: 2, depInfoMatched: 1, depInfoEnvDepOnly: 1, problems: [] });
		expect(existsSync(join(examples, "envonly.d"))).toBe(true);
		expect(existsSync(join(examples, "envonly"))).toBe(true);
		expect(existsSync(join(examples, "mixed.d"))).toBe(false);
		expect(existsSync(join(examples, "mixed"))).toBe(false);
	});

	it("carries the env-dep-only count from the real scan to the operator's line", async () => {
		const deadPath = tempDir("pi-reaper-dead-");
		const target = tempDir("pi-reaper-box-target-");
		const examples = join(target, "debug", "examples");
		write(
			join(examples, "envonly.d"),
			`${join(examples, "envonly")}: parser/src/lib.rs env-dep:CARGO_MANIFEST_DIR=${join(deadPath, "parser")}\n`,
		);
		write(join(examples, "envonly"));
		write(join(examples, "mixed.d"), `${join(examples, "mixed")}: ${join(deadPath, "parser/src/lib.rs")}\n`);
		write(join(examples, "mixed"));

		// The count travels the whole path a removal takes: the scan's result, the
		// route-1 base `pruneCargoArtifactsFor` hands the caller, and the line that
		// becomes `ReapResult.detail`. A constant anywhere on it shows up here.
		const result = await pruneCargoArtifactsFor(target, deadPath, { run: fakeRunner().run });

		expect(result).toMatchObject({ route: "exact", depInfoScanned: 2, depInfoMatched: 1, depInfoEnvDepOnly: 1 });
		expect(describePrune(result)).toContain("1 env-dep-only .d left alone");
	});

	it("does not count an env-dep naming a longer path that starts with the dead one", () => {
		const deadPath = tempDir("pi-reaper-dead-");
		const target = tempDir("pi-reaper-box-target-");
		const examples = join(target, "debug", "examples");
		// A sibling path whose name starts with the dead worktree's — this box's
		// `…/live-e3ifza2` against `…/live-e3ifza`. A substring test called that
		// file env-dep-only; the field, its comment and the report line say
		// `env-dep:`-only, so the match carries the same path boundary the source
		// rule does.
		write(
			join(examples, "sibling.d"),
			`${join(examples, "sibling")}: parser/src/lib.rs env-dep:CARGO_MANIFEST_DIR=${deadPath}2/parser\n`,
		);
		write(join(examples, "sibling"));

		const result = pruneExactArtifacts(target, deadPath);

		expect(result).toMatchObject({ depInfoScanned: 1, depInfoMatched: 0, depInfoEnvDepOnly: 0 });
		expect(existsSync(join(examples, "sibling.d"))).toBe(true);
	});

	it("counts an env-dep value at a line end, before another token, and with no newline", () => {
		const deadPath = tempDir("pi-reaper-dead-");
		const target = tempDir("pi-reaper-box-target-");
		const examples = join(target, "debug", "examples");
		// The value is the bare worktree root, and each file ends differently: a
		// newline, the next `env-dep:` token, and no trailing newline at all. The
		// three are the value matcher's alternatives beyond `/`, one file each.
		write(
			join(examples, "rootline.d"),
			`${join(examples, "rootline")}: parser/src/lib.rs env-dep:CARGO_MANIFEST_DIR=${deadPath}\n`,
		);
		write(join(examples, "rootline"));
		write(
			join(examples, "roottoken.d"),
			`${join(examples, "roottoken")}: parser/src/lib.rs env-dep:CARGO_MANIFEST_DIR=${deadPath} env-dep:TFD_BUILD_ID=1\n`,
		);
		write(join(examples, "roottoken"));
		write(
			join(examples, "rootbare.d"),
			`${join(examples, "rootbare")}: parser/src/lib.rs env-dep:CARGO_MANIFEST_DIR=${deadPath}`,
		);
		write(join(examples, "rootbare"));

		const result = pruneExactArtifacts(target, deadPath);

		expect(result).toMatchObject({ depInfoScanned: 3, depInfoMatched: 0, depInfoEnvDepOnly: 3 });
		expect(existsSync(join(examples, "rootline.d"))).toBe(true);
		expect(existsSync(join(examples, "roottoken.d"))).toBe(true);
		expect(existsSync(join(examples, "rootbare.d"))).toBe(true);
	});

	it("scans no build-script output dir, so its .d is neither counted nor attributed", () => {
		const deadPath = tempDir("pi-reaper-dead-");
		const target = tempDir("pi-reaper-box-target-");
		// Owner 2026-11-09: `<profile>/build/<pkg>/<hash>/out/*.d` stays out of the
		// scan, and this row is the pin. On this box 12 of the 1433 `.d` there name a
		// worktree and all 12 name it only in an `env-dep:CARGO_MANIFEST_DIR=` token,
		// so scanning them attributes nothing; what it would widen is the delete
		// surface, since a build script's `.d` stem is the name of its own `build/`
		// dir. Adding the location to `DEP_INFO_SUBDIRS` is red here.
		const out = join(target, "debug", "build", "parser-1a2b3c4d5e6f7890", "out");
		write(join(out, "inputs.d"), `${join(out, "inputs")}: ${join(deadPath, "parser/src/lib.rs")}\n`);
		// Directly under `build/`, so a plain `"build"` entry in the scan list is
		// red here too, not only a `build/**/out` widening.
		write(join(target, "debug", "build", "held.d"), `held: ${join(deadPath, "src/lib.rs")}\n`);

		const result = pruneExactArtifacts(target, deadPath);

		expect(result).toMatchObject({ depInfoScanned: 0, depInfoMatched: 0 });
		expect(existsSync(join(out, "inputs.d"))).toBe(true);
		expect(existsSync(join(target, "debug", "build", "held.d"))).toBe(true);
	});

	it("counts a .d named exactly `.d`, and attributes nothing to its empty stem", () => {
		const deadPath = tempDir("pi-reaper-dead-");
		const target = tempDir("pi-reaper-box-target-");
		const examples = join(target, "debug", "examples");
		write(join(examples, ".d"), `${join(examples, "nothing")}: ${join(deadPath, "parser/src/lib.rs")}\n`);
		// The artefact a naive empty-stem match would take with it: every dotfile in
		// the directory starts with the empty string.
		write(join(examples, ".env"), "keep\n");

		const result = pruneExactArtifacts(target, deadPath);

		expect(result).toMatchObject({ depInfoScanned: 1, depInfoMatched: 0, filesDeleted: 0 });
		expect(existsSync(join(examples, ".d"))).toBe(true);
		expect(existsSync(join(examples, ".env"))).toBe(true);
	});

	it("reports a profile directory it cannot list instead of reading it as empty", () => {
		const deadPath = tempDir("pi-reaper-dead-");
		const target = tempDir("pi-reaper-box-target-");
		const profile = join(target, "debug");
		mkdirSync(profile, { recursive: true });
		const problems = (() => {
			chmodSync(profile, 0o000);
			try {
				return pruneExactArtifacts(target, deadPath).problems;
			} finally {
				chmodSync(profile, 0o700);
			}
		})();

		// One level up is reported already; a profile the scan could not read is the
		// same failure and hides the same artifacts.
		expect(problems.join(" ")).toContain(`${profile} not readable`);
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

	it("keeps the target when no isolation branch was recorded", async () => {
		const { worktreePath, parentCwd } = keptWorktree();
		const { run, calls } = fakeRunner();

		const landed = await dropLandedWorktreeTarget({ worktreePath, branch: null, parentCwd }, { run });

		expect(landed).toMatchObject({ dropped: false, state: "unknown" });
		expect(landed.detail).toContain("no isolation branch");
		expect(calls).toEqual([]);
		expect(existsSync(join(worktreePath, "target", "debug", "artifact"))).toBe(true);
	});

	it("keeps the target when the parent checkout is gone", async () => {
		const { worktreePath } = keptWorktree();
		const parentCwd = join(tempDir("pi-reaper-parent-"), "gone");
		const { run, calls } = fakeRunner();

		const landed = await dropLandedWorktreeTarget({ worktreePath, branch: "pi-subagent-orphan-1", parentCwd }, { run });

		expect(landed).toMatchObject({ dropped: false, state: "unknown" });
		expect(landed.detail).toContain("parent checkout gone");
		expect(calls).toEqual([]);
		expect(existsSync(join(worktreePath, "target", "debug", "artifact"))).toBe(true);
	});

	it("keeps the target when the branch list cannot be read", async () => {
		const { worktreePath, parentCwd } = keptWorktree();
		const { run } = fakeRunner(() => ({ exitCode: 128, stderr: "fatal: not a git repository" }));

		const landed = await dropLandedWorktreeTarget({ worktreePath, branch: "pi-subagent-unknown-1", parentCwd }, { run });

		// Unknown is not merged and not gone: the target stays.
		expect(landed).toMatchObject({ dropped: false, state: "unknown" });
		expect(landed.detail).toContain("git branch --merged failed");
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

		const actions = planCargoBound([{ cargoTargetDir, bytes: 21 * GiB }], dead, CARGO_TARGET_BOUND_BYTES, homesAt(home));

		expect(actions).toEqual([{ cargoTargetDir, worktreePaths: [dead[0].worktreePath], coarsePrune: true }]);
	});

	it("plans nothing for a dir under the bound", () => {
		const cargoTargetDir = sharedFor("tfd-d");
		const dead = [{ worktreePath: deadUnder("tfd-d", "77a40e201285"), parentCwd: "/fake/home/Developer/tfd-d" }];

		expect(planCargoBound([{ cargoTargetDir, bytes: 19 * GiB }], dead, CARGO_TARGET_BOUND_BYTES, homesAt(home))).toEqual([]);
	});

	it("treats exactly the bound as under it", () => {
		const cargoTargetDir = sharedFor("tfd-d");

		expect(planCargoBound([{ cargoTargetDir, bytes: CARGO_TARGET_BOUND_BYTES }], [], CARGO_TARGET_BOUND_BYTES, homesAt(home))).toEqual([]);
		expect(
			planCargoBound([{ cargoTargetDir, bytes: CARGO_TARGET_BOUND_BYTES + 1 }], [], CARGO_TARGET_BOUND_BYTES, homesAt(home)),
		).toHaveLength(1);
	});

	it("ignores dead paths of another clone and paths outside the namespace", () => {
		const cargoTargetDir = sharedFor("tfd-d");
		const dead = [
			{ worktreePath: deadUnder("other-repo", "abcdef123456"), parentCwd: "/x" },
			{ worktreePath: join(home, "Developer", "wt", "tfd-hand-made"), parentCwd: "/x" },
		];

		const actions = planCargoBound([{ cargoTargetDir, bytes: 21 * GiB }], dead, CARGO_TARGET_BOUND_BYTES, homesAt(home));

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
			...homesAt(home),
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

	it("reports an over-bound dir that route 1 brought under as under, not as unmeasured", async () => {
		const { home, cargoTargetDir, deadPath } = fakeHome("tfd-d");
		const deps = join(cargoTargetDir, "debug", "deps");
		mkdirSync(deps, { recursive: true });
		const depInfo = join(deps, "tfd_d-abc123.d");
		writeFileSync(depInfo, `${deadPath}/src/lib.rs: ${deadPath}/src/lib.rs\n`);
		// Over the bound on the walk, under it once the dead share is pruned: the
		// verdict "under" is the third arm of the comparison, and it is the one
		// that tells a reader the prune did its job. One counter per sweep.
		const sizes = () => {
			let n = 0;
			return () => (n++ === 0 ? 25 * GiB : 10 * GiB);
		};

		const report = await enforceCargoTargetBound({
			...homesAt(home),
			deadWorktrees: [{ worktreePath: deadPath, parentCwd: "" }],
			sizeOf: sizes(),
			run: fakeRunner().run,
		});

		expect(report.entries[0]).toMatchObject({
			cargoTargetDir,
			beforeBytes: 25 * GiB,
			afterBytes: 10 * GiB,
			overBound: false,
			route: "exact",
		});
		expect(existsSync(depInfo)).toBe(false);

		const lines = await createReapBuildOutput({
			...homesAt(home),
			sizeOf: sizes(),
			run: fakeRunner().run,
		}).enforceBound();
		expect(lines.join("\n")).toContain("shared dir under bound");
		expect(lines.join("\n")).not.toContain("UNMEASURED");
	});

	it("reports a dir it could not measure instead of calling it under-bound", async () => {
		const home = tempDir("pi-reaper-home-");
		mkdirSync(join(home, ".cache", "cargo-target", "tfd-d"), { recursive: true });
		const { run, calls } = fakeRunner();

		const report = await enforceCargoTargetBound({
			...homesAt(home),
			deadWorktrees: [],
			sizeOf: () => {
				throw new Error("du: permission denied");
			},
			run,
		});

		expect(report.entries).toEqual([]);
		expect(report.problems).toHaveLength(1);
		expect(report.problems[0]).toContain("could not measure");
		expect(calls).toEqual([]);
	});

	it("reports an unmeasurable re-measure as unknown instead of a verdict", async () => {
		const { home, cargoTargetDir } = fakeHome("tfd-d");
		const { run, calls } = fakeRunner();
		let measure = 0;

		const report = await enforceCargoTargetBound({
			...homesAt(home),
			deadWorktrees: [],
			sizeOf: () => {
				measure++;
				if (measure === 1) return 25 * GiB;
				throw new Error("du: permission denied");
			},
			run,
		});

		// No size was read after the route-1 pass, so there is no verdict to give:
		// not over, not under, and no coarse pass on the strength of a guess.
		expect(report.entries).toHaveLength(1);
		expect(report.entries[0]).toMatchObject({ cargoTargetDir, beforeBytes: 25 * GiB, afterBytes: null, overBound: null });
		expect(report.entries[0].problems.join(" ")).toContain("could not re-measure");
		expect(calls).toEqual([]);
	});

	it("reports an unmeasurable re-measure after the coarse pass as unknown", async () => {
		const { home, deadPath } = fakeHome("tfd-d");
		const parentCwd = tempDir("pi-reaper-parent-");
		writeFileSync(join(parentCwd, "Cargo.toml"), '[workspace]\nmembers = ["parser"]\n');
		const { run, calls } = fakeRunner();
		let measure = 0;

		const report = await enforceCargoTargetBound({
			...homesAt(home),
			deadWorktrees: [{ worktreePath: deadPath, parentCwd }],
			sizeOf: () => {
				measure++;
				if (measure < 3) return 25 * GiB;
				throw new Error("du: permission denied");
			},
			run,
		});

		// The coarse pass ran, its effect could not be read back, and the entry says
		// so rather than reporting the pre-clean size as the post-clean one.
		expect(report.entries[0]).toMatchObject({ membersCleaned: ["parser"], route: "coarse", afterBytes: null, overBound: null });
		expect(report.entries[0].problems.join(" ")).toContain("could not re-measure");
		expect(calls.map((c) => c.args)).toEqual([["clean", "-p", "parser"]]);
	});

	it("measures each clone's dir on its own, so one bad dir does not hide another", async () => {
		// Arity production has: this box carries three clone dirs, and every other
		// bound row builds one. One dir cannot be sized; the other is over-bound.
		const home = tempDir("pi-reaper-home-");
		const root = join(home, ".cache", "cargo-target");
		const unmeasurable = join(root, "aaa-d");
		const overBound = join(root, "zzz-d");
		mkdirSync(join(unmeasurable, "debug"), { recursive: true });
		const deps = join(overBound, "debug", "deps");
		mkdirSync(deps, { recursive: true });
		const deadPath = join(home, "Developer", "wt", "subagents", "zzz-d-77a40e201285");
		const depInfo = join(deps, "zzz-d-abc123.d");
		writeFileSync(depInfo, `${deadPath}/src/lib.rs: ${deadPath}/src/lib.rs\n`);
		const { run } = fakeRunner();

		const report = await enforceCargoTargetBound({
			...homesAt(home),
			deadWorktrees: [{ worktreePath: deadPath, parentCwd: "" }],
			sizeOf: (dir) => {
				if (dir === unmeasurable) throw new Error("du: permission denied");
				return 25 * GiB;
			},
			run,
		});

		// The bad dir reports and does not abort the walk ...
		expect(report.problems).toHaveLength(1);
		expect(report.problems[0]).toContain("aaa-d");
		// ... the other dir is still judged against the bound, with its own size,
		// and its dead path's share is pruned.
		expect(report.entries).toHaveLength(1);
		expect(report.entries[0]).toMatchObject({ cargoTargetDir: overBound, beforeBytes: 25 * GiB, overBound: true });
		expect(existsSync(depInfo)).toBe(false);
	});

	it("reports unmeasurable dirs in walk order, not completion order", async () => {
		const home = tempDir("pi-reaper-home-");
		const root = join(home, ".cache", "cargo-target");
		const first = join(root, "aaa-first");
		const second = join(root, "zzz-second");
		mkdirSync(first, { recursive: true });
		mkdirSync(second, { recursive: true });
		// Walk order is the listing's order, whatever that is on this filesystem.
		const walkOrder = readdirSync(root).map((name) => join(root, name));

		const report = await enforceCargoTargetBound({
			...homesAt(home),
			deadWorktrees: [],
			sizeOf: async (dir) => {
				// Delay the failure that comes first in walk order, so a result folded
				// in completion order lands in the wrong place. A synchronous throw
				// makes completion order equal walk order, and the row then passes
				// against the very bug it exists to pin.
				if (dir === walkOrder[0]) await new Promise((r) => setTimeout(r, 50));
				throw new Error(`du: cannot read ${dir}`);
			},
			run: fakeRunner().run,
		});

		expect(report.entries).toEqual([]);
		expect(report.problems).toHaveLength(2);
		const named = report.problems.map((p) => (p.includes("aaa-first") ? first : second));
		expect(named).toEqual(walkOrder);
	});

	it("takes no action for a dir under the bound", async () => {
		const { home } = fakeHome("tfd-d");
		const { run, calls } = fakeRunner();

		const report = await enforceCargoTargetBound({ ...homesAt(home), deadWorktrees: [], sizeOf: () => 5 * GiB, run });

		expect(report.entries).toEqual([]);
		expect(calls).toEqual([]);
	});

	it("counts the dead paths' env-dep-only .d in its entry, not as a constant", async () => {
		const { home, cargoTargetDir, deadPath } = fakeHome("tfd-d");
		// Two dead paths of the one clone, each with its own env-dep-only `.d`: the
		// entry's count is a sum over paths, so `=` in place of `+=` at the
		// aggregation site keeps only the last path's file.
		const deadPath2 = deadPath.replace("77a40e201285", "abcdef123456");
		const examples = join(cargoTargetDir, "debug", "examples");
		write(
			join(examples, "envonly.d"),
			`${join(examples, "envonly")}: parser/src/lib.rs env-dep:CARGO_MANIFEST_DIR=${join(deadPath, "parser")}\n`,
		);
		write(
			join(examples, "envonly2.d"),
			`${join(examples, "envonly2")}: parser/src/lib.rs env-dep:CARGO_MANIFEST_DIR=${join(deadPath2, "parser")}\n`,
		);

		const report = await enforceCargoTargetBound({
			...homesAt(home),
			deadWorktrees: [
				{ worktreePath: deadPath, parentCwd: "" },
				{ worktreePath: deadPath2, parentCwd: "" },
			],
			sizeOf: () => 25 * GiB,
			run: fakeRunner().run,
		});

		// Both files are read once per dead path (4 reads); each is env-dep-only for
		// the one path it names, so the entry's sum over paths is 2.
		expect(report.entries[0]).toMatchObject({ depInfoScanned: 4, depInfoMatched: 0, depInfoEnvDepOnly: 2, worktreePathsPruned: 0 });
	});

	it("uses route 1 when the dead worktree's artifacts can be attributed", async () => {
		const { home, cargoTargetDir, deadPath } = fakeHome("tfd-d");
		mkdirSync(join(cargoTargetDir, "debug", "deps"), { recursive: true });
		writeFileSync(join(cargoTargetDir, "debug", "deps", "tfd-abc123.d"), `${deadPath}/src/lib.rs: ${deadPath}/src/lib.rs\n`);
		const { run, calls } = fakeRunner();

		const report = await enforceCargoTargetBound({
			...homesAt(home),
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

	it("counts a hard link once, the reason it shells out to du", async () => {
		const dir = tempDir("pi-reaper-size-");
		writeFileSync(join(dir, "a"), Buffer.alloc(MiB));
		linkSync(join(dir, "a"), join(dir, "b"));

		expect(await dirSizeBytes(dir)).toBe(MiB);
	});

	it("reports a failed measure instead of answering 0", async () => {
		const dir = tempDir("pi-reaper-size-");
		const failing: CommandRunner = async () => ({ stdout: "", stderr: "du: permission denied", exitCode: 1 });
		await expect(dirSizeBytes(dir, failing)).rejects.toThrow("du -sk");

		const silent: CommandRunner = async () => ({ stdout: "", stderr: "", exitCode: 0 });
		await expect(dirSizeBytes(dir, silent)).rejects.toThrow("printed no size");
	});

	it("throws for a path that is not there rather than reporting an under-bound 0", async () => {
		await expect(dirSizeBytes(join(tempDir("pi-reaper-size-"), "nope"))).rejects.toThrow("du -sk");
	});
});
