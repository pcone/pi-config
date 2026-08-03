#!/usr/bin/env node
/**
 * Regression test for the uncommitted-state carry into isolated worktrees.
 *
 * createWorktree (extensions/subagent-async/index.ts) now overlays the
 * parent's uncommitted working-tree state (untracked / modified / staged /
 * deleted / renamed / copied files) into the freshly-created worktree,
 * gated on `carryUncommitted && !baseRef`. The subagent therefore sees what
 * the orchestrator prepared instead of hitting ENOENT on first read.
 *
 * This test cannot import index.ts — `typebox` and `@earendil-works/*`
 * resolve only under jiti at runtime. So, following the test-subject.cjs
 * precedent, it mirrors the carry logic (porcelain parsing + copy/delete
 * decisions + the CarriedSnapshot capture used by the WO-2026-035 completion
 * filter) and exercises it end-to-end against REAL temp repos and REAL
 * `git worktree add`. Every row of the behavior/failure matrix is a case,
 * and the parser is pinned against real `git status --porcelain=v1 -uall -z`
 * output (including a rename `R  new\0old\0` and a copy `C  new\0old\0`).
 *
 * Run: node test-carry-uncommitted.cjs
 */
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");

// ── carryUncommittedState — KEEP IN SYNC with index.ts ────────────────────
// Mirror of the carry overlay in extensions/subagent-async/index.ts
// (carryUncommittedState + unsafeCarryPath + copyCarriedFile + hashCarriedFile).
// Same porcelain -z parsing, same copy/delete/rename/copy decisions, same path
// safety, same symlink-as-link and exec-bit handling. It now ALSO returns the
// CarriedSnapshot (per-path sha256 hash / `"link:" + target` / `absent`) that
// preCommitSteps' completion filter compares against — the filter itself is
// mirrored by test-completion-filter.cjs. When changing one side, change the
// other. Both are pinned below against real `git status` output.
function unsafeCarryPath(p) {
	return p.length === 0 || p.includes("..") || p === ".git" || p.startsWith(".git/");
}

// ── hashCarriedFile — KEEP IN SYNC with index.ts ──────────────────────────
// sha256 hex of a file's bytes, `"link:" + target` for a symlink, null when
// absent / not a regular file or symlink. Single source of truth for the
// snapshot hashes (capture here, compare in test-completion-filter.cjs).
function hashCarriedFile(absPath) {
	try {
		const st = fs.lstatSync(absPath);
		if (st.isSymbolicLink()) return "link:" + fs.readlinkSync(absPath);
		if (!st.isFile()) return null;
		return createHash("sha256").update(fs.readFileSync(absPath)).digest("hex");
	} catch {
		return null;
	}
}

function recordPresent(snapshot, worktreePath, rel) {
	const hash = hashCarriedFile(path.join(worktreePath, rel));
	if (hash !== null) snapshot.set(rel, { state: "present", hash });
}

function copyCarriedFile(topLevel, worktreePath, rel) {
	const src = path.join(topLevel, rel);
	const dst = path.join(worktreePath, rel);
	fs.mkdirSync(path.dirname(dst), { recursive: true });
	const st = fs.lstatSync(src);
	if (st.isSymbolicLink()) {
		fs.symlinkSync(fs.readlinkSync(src), dst);
	} else if (st.isDirectory()) {
		return; // gitlink/submodule — known limitation, not carried
	} else {
		fs.copyFileSync(src, dst);
		fs.chmodSync(dst, st.mode & 0o7777);
	}
}

// ── carryUncommittedState — KEEP IN SYNC with index.ts ────────────────────
// Mirror of the carry overlay in extensions/subagent-async/index.ts
// (carryUncommittedState + unsafeCarryPath + copyCarriedFile + hashCarriedFile).
// Same porcelain -z parsing, same copy/delete/rename/copy decisions, same path
// safety, same symlink-as-link and exec-bit handling. It now ALSO returns the
// CarriedSnapshot (per-path sha256 hash / `"link:" + target` / `absent`) that
// preCommitSteps' completion filter compares against — the filter itself is
// mirrored by test-completion-filter.cjs. When changing one side, change the
// other. Both are pinned below against real `git status` output.
//
// WIRING HAZARD (do not "simplify"): index.ts's createWorktree destructures the
// git() result OBJECT and must extract the path string via .stdout.trim()
// before calling carryUncommittedState. Passing the object instead of the
// string makes the overlay silently no-op in production (spawn cwd invalid →
// best-effort catch). The fail-fast typeof guard below exists on BOTH sides;
// matrix row 1 pins the end-to-end wiring through createWorktreeMirror, and
// row 21 pins the guard itself.
function unsafeCarryPath(p) {
	return p.length === 0 || p.includes("..") || p === ".git" || p.startsWith(".git/");
}

// ── carryUncommittedState entry — KEEP IN SYNC with index.ts ──────────────
// The mirror receives the extracted path STRING from createWorktreeMirror,
// exactly like production. A non-string (e.g. the git result object) throws,
// matching the production fail-fast guard.
function assertTopLevelString(topLevel) {
	if (typeof topLevel !== "string" || topLevel.length === 0) {
		throw new TypeError("carryUncommittedState: topLevel must be the repo path string");
	}
}

function carryUncommittedState(topLevel, worktreePath) {
	assertTopLevelString(topLevel);
	const snapshot = new Map();
	let out;
	try {
		out = execFileSync("git", ["status", "--porcelain=v1", "-uall", "-z"], {
			cwd: topLevel,
			encoding: "utf8",
		});
	} catch {
		return snapshot; // git status failed — empty snapshot, mirror of index.ts
	}
	const tokens = out.split("\0");
	for (let i = 0; i < tokens.length; i++) {
		const rec = tokens[i];
		if (rec.length === 0) continue;
		const x = rec[0];
		const y = rec[1];
		const p = rec.slice(3);
		if (unsafeCarryPath(p)) continue;

		if (x === "R" || x === "C") {
			// Rename/copy: the record path is the NEW path; the next NUL
			// token holds the ORIGINAL path.
			const orig = tokens[i + 1] ?? "";
			i++;
			if (unsafeCarryPath(orig)) continue;
			if (x === "R") {
				fs.rmSync(path.join(worktreePath, orig), { recursive: true, force: true });
				snapshot.set(orig, { state: "absent" });
			}
			copyCarriedFile(topLevel, worktreePath, p);
			recordPresent(snapshot, worktreePath, p);
			continue;
		}
		if (x === "D" || y === "D") {
			fs.rmSync(path.join(worktreePath, p), { recursive: true, force: true });
			snapshot.set(p, { state: "absent" });
			continue;
		}
		if (x === "?" && y === "?") {
			copyCarriedFile(topLevel, worktreePath, p);
			recordPresent(snapshot, worktreePath, p);
			continue;
		}
		if (["M", "A", "T", "U"].includes(x) || ["M", "A", "T", "U"].includes(y)) {
			if (fs.existsSync(path.join(topLevel, p))) {
				copyCarriedFile(topLevel, worktreePath, p);
				recordPresent(snapshot, worktreePath, p);
			}
		}
	}
	return snapshot;
}

// ── createWorktree mirror — control flow only ──────────────────────────────
// Mirrors createWorktree's git/fs flow: rev-parse toplevel + base ref, stale
// cleanup, `git worktree add`, then the optional carry. The pieces under test
// here are the overlay gate (`carryUncommitted && !baseRef`) and the
// best-effort catch — a carry failure must never fail the dispatch, while a
// `worktree add` failure must (returns null). Also returns the carried
// CarriedSnapshot (present — possibly empty — when the overlay ran, absent
// when skipped or when the overlay threw).
//
// WIRING: production destructures the git() RESULT OBJECT and extracts the
// path string via .stdout.trim(); this mirror does the same with the
// execFileSync stdout string (which is already the raw path). The extract-
// then-pass-string shape is what row 1 exercises end-to-end; row 21 pins the
// fail-fast guard that makes an object-wiring regression loud instead of
// silent.
function createWorktreeMirror(parentCwd, sessionId, baseRef, carryUncommitted = true) {
	let topLevel;
	try {
		topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd: parentCwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null; // not a git repo
	}
	const baseCommitRef = baseRef || "HEAD";
	let headCommit;
	try {
		headCommit = execFileSync("git", ["rev-parse", baseCommitRef], {
			cwd: parentCwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
	const suffix = String(sessionId).slice(-12);
	const branchName = `pi-subagent-${suffix}`;
	const worktreePath = path.join(os.tmpdir(), `pi-subagent-wt-${suffix}`);

	const quiet = { cwd: parentCwd, stdio: "ignore" };
	try { execFileSync("git", ["worktree", "remove", "--force", worktreePath], quiet); } catch { /* */ }
	try { execFileSync("git", ["branch", "-D", branchName], quiet); } catch { /* */ }
	try {
		execFileSync("git", ["worktree", "add", worktreePath, "-b", branchName, headCommit], quiet);
	} catch {
		return null; // worktree add failure is fatal, like the real code
	}
	let carried;
	if (carryUncommitted && !baseRef) {
		try {
			carried = carryUncommittedState(topLevel, worktreePath);
		} catch {
			// best-effort: degrade to HEAD-only, never fail the dispatch
		}
	}
	return {
		worktreePath,
		branchName,
		parentHeadCommit: headCommit,
		...(carried !== undefined ? { carried } : {}),
	};
}

// ── Test harness ───────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
let skipped = 0;

function test(name, fn) {
	try {
		fn();
		console.log(`  ✅ ${name}`);
		passed++;
	} catch (e) {
		if (e && e.__piSkip) {
			console.log(`  ⏭  ${name} (skipped: ${e.message})`);
			skipped++;
			return;
		}
		console.log(`  ❌ ${name}`);
		console.log(`     ${e.message}`);
		failed++;
	}
}

function skip(msg) {
	const e = new Error(msg);
	e.__piSkip = true;
	throw e;
}

function eq(actual, expected, msg) {
	assert.strictEqual(actual, expected, msg);
}

let nextId = 0;
function newSessionId() {
	return `test-${Date.now().toString(36)}-${nextId++}`;
}

function initRepo(dir) {
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
}

function git(dir, args) {
	return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function cleanupWorktree(parentDir, result) {
	if (!result) return;
	try { execFileSync("git", ["worktree", "remove", "--force", result.worktreePath], { cwd: parentDir, stdio: "ignore" }); } catch { /* */ }
	try { fs.rmSync(result.worktreePath, { recursive: true, force: true }); } catch { /* */ }
	try { execFileSync("git", ["branch", "-D", result.branchName], { cwd: parentDir, stdio: "ignore" }); } catch { /* */ }
}

// Real temp repo + real `git worktree add`, then the mirror carry, then the
// assertion. baselineFn writes the tracked file set (committed); setupFn
// creates the uncommitted state (and may stage/commit further).
function withCarryFlow(opts, baselineFn, setupFn, assertFn) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-carry-repo-"));
	let result = null;
	try {
		initRepo(dir);
		baselineFn(dir);
		git(dir, ["add", "-A"]);
		git(dir, ["commit", "-q", "-m", "baseline"]);
		setupFn(dir, git);
		result = createWorktreeMirror(dir, newSessionId(), opts.baseRef, opts.carryUncommitted ?? true);
		assertFn(result, dir, git);
	} finally {
		cleanupWorktree(dir, result);
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
	}
}

const defaultBaseline = (dir) => {
	fs.writeFileSync(path.join(dir, "baseline.txt"), "baseline\n");
};

// ── Behavior / failure matrix ──────────────────────────────────────────────

test("1. untracked file (`?? docs/plans/foo.md`) is carried", () => {
	withCarryFlow({}, defaultBaseline, (dir) => {
		fs.mkdirSync(path.join(dir, "docs", "plans"), { recursive: true });
		fs.writeFileSync(path.join(dir, "docs", "plans", "foo.md"), "# plan\n");
		// space-in-path pin: the porcelain `XY ` separator must not eat a
		// leading space of the path, and the path itself survives verbatim.
		fs.writeFileSync(path.join(dir, "docs", "plans", "with space.md"), "spaced\n");
	}, (result) => {
		const wt = result.worktreePath;
		const carried = path.join(wt, "docs", "plans", "foo.md");
		assert.ok(fs.existsSync(carried), "untracked file present in worktree");
		eq(fs.readFileSync(carried, "utf8"), "# plan\n");
		eq(fs.readFileSync(path.join(wt, "docs", "plans", "with space.md"), "utf8"), "spaced\n", "path with spaces survives verbatim");
	});
});

test("2. modified tracked file (` M`) is carried with parent bytes", () => {
	withCarryFlow({}, defaultBaseline, (dir) => {
		fs.writeFileSync(path.join(dir, "baseline.txt"), "modified\n");
	}, (result) => {
		const f = path.join(result.worktreePath, "baseline.txt");
		assert.ok(fs.existsSync(f));
		eq(fs.readFileSync(f, "utf8"), "modified\n", "parent worktree bytes win over HEAD");
	});
});

test("3. staged-added file (`A `) is carried", () => {
	withCarryFlow({}, defaultBaseline, (dir, git) => {
		fs.writeFileSync(path.join(dir, "staged-new.txt"), "new\n");
		git(dir, ["add", "staged-new.txt"]);
	}, (result) => {
		eq(fs.readFileSync(path.join(result.worktreePath, "staged-new.txt"), "utf8"), "new\n");
	});
});

test("4. staged+worktree modified (`MM`) — parent worktree bytes win", () => {
	withCarryFlow({}, (dir) => {
		fs.writeFileSync(path.join(dir, "mm.txt"), "v1\n");
	}, (dir, git) => {
		fs.writeFileSync(path.join(dir, "mm.txt"), "v2\n");
		git(dir, ["add", "mm.txt"]);
		fs.writeFileSync(path.join(dir, "mm.txt"), "v3\n");
		const out = git(dir, ["status", "--porcelain=v1", "-uall", "-z"]);
		assert.ok(out.startsWith("MM "), `expected an MM record, got: ${JSON.stringify(out.split("\0"))}`);
	}, (result) => {
		eq(fs.readFileSync(path.join(result.worktreePath, "mm.txt"), "utf8"), "v3\n");
	});
});

test("5. deleted in worktree (` D`) — file absent from worktree", () => {
	withCarryFlow({}, (dir) => {
		fs.writeFileSync(path.join(dir, "gone-wt.txt"), "x\n");
	}, (dir) => {
		fs.rmSync(path.join(dir, "gone-wt.txt"));
	}, (result) => {
		assert.ok(!fs.existsSync(path.join(result.worktreePath, "gone-wt.txt")), "deleted file absent");
	});
});

test("6. staged deletion (`D `) — file absent from worktree", () => {
	withCarryFlow({}, (dir) => {
		fs.writeFileSync(path.join(dir, "gone-staged.txt"), "x\n");
	}, (dir, git) => {
		git(dir, ["rm", "-q", "gone-staged.txt"]);
	}, (result) => {
		assert.ok(!fs.existsSync(path.join(result.worktreePath, "gone-staged.txt")), "deleted file absent");
	});
});

test("7. rename (`R  new\0old\0`) — old removed, new present with parent bytes", () => {
	withCarryFlow({}, (dir) => {
		fs.writeFileSync(path.join(dir, "oldname.txt"), "old content\n");
	}, (dir, git) => {
		git(dir, ["mv", "oldname.txt", "newname.txt"]);
		// pin the rename record shape against real git output
		const tokens = git(dir, ["status", "--porcelain=v1", "-uall", "-z"]).split("\0");
		const ri = tokens.findIndex((t) => t.startsWith("R "));
		assert.ok(ri !== -1, `expected a rename record, got: ${JSON.stringify(tokens)}`);
		eq(tokens[ri + 1], "oldname.txt", "rename original path is the next NUL token");
	}, (result) => {
		const wt = result.worktreePath;
		assert.ok(!fs.existsSync(path.join(wt, "oldname.txt")), "old path removed");
		eq(fs.readFileSync(path.join(wt, "newname.txt"), "utf8"), "old content\n");
	});
});

test("8. copy (`C  new\0old\0`, status.renames=copies) — new present", () => {
	withCarryFlow({}, (dir) => {
		fs.writeFileSync(path.join(dir, "orig.txt"), "hello\n");
	}, (dir, git) => {
		// Copy detection in `git status` only fires when the source is also
		// modified and status.renames is set to "copies" — and this is a
		// per-repo config, so the plain carry command emits the C record.
		fs.writeFileSync(path.join(dir, "orig.txt"), "hello modified\n");
		fs.writeFileSync(path.join(dir, "newcopy.txt"), "hello\n");
		git(dir, ["add", "-A"]);
		git(dir, ["config", "status.renames", "copies"]);
		const tokens = git(dir, ["status", "--porcelain=v1", "-uall", "-z"]).split("\0");
		const ci = tokens.findIndex((t) => t.startsWith("C "));
		assert.ok(ci !== -1, `expected a copy record, got: ${JSON.stringify(tokens)}`);
		eq(tokens[ci + 1], "orig.txt", "copy original path is the next NUL token");
	}, (result) => {
		const wt = result.worktreePath;
		eq(fs.readFileSync(path.join(wt, "newcopy.txt"), "utf8"), "hello\n", "copy carried");
		eq(fs.readFileSync(path.join(wt, "orig.txt"), "utf8"), "hello modified\n", "modified source also carried");
	});
});

test("9. .gitignore-matched file — NOT carried", () => {
	withCarryFlow({}, defaultBaseline, (dir, git) => {
		fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.log\n");
		fs.writeFileSync(path.join(dir, "ignored.log"), "ignored\n");
		const out = git(dir, ["status", "--porcelain=v1", "-uall", "-z"]);
		assert.ok(!out.includes("ignored.log"), "ignored file absent from status");
	}, (result) => {
		assert.ok(!fs.existsSync(path.join(result.worktreePath, "ignored.log")), "ignored file not carried");
	});
});

test("10. exec-bit file — mode preserved in worktree", () => {
	withCarryFlow({}, defaultBaseline, (dir) => {
		fs.writeFileSync(path.join(dir, "run.sh"), "#!/bin/sh\necho hi\n");
		fs.chmodSync(path.join(dir, "run.sh"), 0o755);
	}, (result, dir) => {
		const wtMode = fs.statSync(path.join(result.worktreePath, "run.sh")).mode & 0o777;
		const srcMode = fs.statSync(path.join(dir, "run.sh")).mode & 0o777;
		eq(wtMode, srcMode, "exec bit preserved (carried mode matches parent)");
		eq(wtMode, 0o755);
	});
});

test("11. symlink — carried as link, same target string, not dereferenced", () => {
	withCarryFlow({}, defaultBaseline, (dir) => {
		fs.symlinkSync("baseline.txt", path.join(dir, "newlink"));
	}, (result, dir) => {
		const wtLink = path.join(result.worktreePath, "newlink");
		const st = fs.lstatSync(wtLink);
		assert.ok(st.isSymbolicLink(), "carried as a symlink, not a regular file");
		eq(fs.readlinkSync(wtLink), fs.readlinkSync(path.join(dir, "newlink")), "identical target string");
		eq(fs.readlinkSync(wtLink), "baseline.txt");
	});
});

test("12. path containing `..` — rejected, no escape", () => {
	withCarryFlow({}, defaultBaseline, (dir, git) => {
		fs.writeFileSync(path.join(dir, "a..b"), "dotdot\n");
		const out = git(dir, ["status", "--porcelain=v1", "-uall", "-z"]);
		assert.ok(out.includes("?? a..b"), "real status lists the ..-containing path");
	}, (result) => {
		assert.ok(!fs.existsSync(path.join(result.worktreePath, "a..b")), "unsafe path skipped");
	});
});

test("13. carryUncommitted: false — no overlay, worktree still created", () => {
	withCarryFlow({ carryUncommitted: false }, defaultBaseline, (dir) => {
		fs.writeFileSync(path.join(dir, "untracked.txt"), "x\n");
	}, (result) => {
		assert.ok(result, "worktree created");
		assert.ok(!fs.existsSync(path.join(result.worktreePath, "untracked.txt")), "no carry");
		eq(fs.readFileSync(path.join(result.worktreePath, "baseline.txt"), "utf8"), "baseline\n");
	});
});

test("14. baseRef set — no overlay even with carry default true", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-carry-repo-"));
	let result = null;
	try {
		initRepo(dir);
		fs.writeFileSync(path.join(dir, "baseline.txt"), "baseline\n");
		git(dir, ["add", "-A"]);
		git(dir, ["commit", "-q", "-m", "base1"]);
		const base1 = git(dir, ["rev-parse", "HEAD"]).trim();
		fs.writeFileSync(path.join(dir, "second.txt"), "second\n");
		git(dir, ["add", "-A"]);
		git(dir, ["commit", "-q", "-m", "base2"]);
		fs.writeFileSync(path.join(dir, "third.txt"), "third\n");
		fs.writeFileSync(path.join(dir, "baseline.txt"), "modified\n");

		result = createWorktreeMirror(dir, newSessionId(), base1, true);
		assert.ok(result, "worktree created");
		const wt = result.worktreePath;
		eq(git(wt, ["rev-parse", "HEAD"]).trim(), base1, "branches from baseRef tree, not HEAD");
		eq(fs.readFileSync(path.join(wt, "baseline.txt"), "utf8"), "baseline\n", "baseRef tree content, no carry");
		assert.ok(!fs.existsSync(path.join(wt, "second.txt")), "base1 tree, not HEAD");
		assert.ok(!fs.existsSync(path.join(wt, "third.txt")), "no carry of uncommitted state");
	} finally {
		cleanupWorktree(dir, result);
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
	}
});

test("15. clean tree — no-op; worktree add still succeeds", () => {
	withCarryFlow({}, defaultBaseline, () => { /* no uncommitted state */ }, (result) => {
		assert.ok(result, "worktree created");
		const entries = fs.readdirSync(result.worktreePath).filter((e) => e !== ".git").sort();
		assert.deepStrictEqual(entries, ["baseline.txt"], "only the tracked baseline file");
		eq(fs.readFileSync(path.join(result.worktreePath, "baseline.txt"), "utf8"), "baseline\n");
	});
});

test("16. nested new dirs (`-uall` untracked in subdir) — parent dirs created", () => {
	withCarryFlow({}, defaultBaseline, (dir) => {
		fs.mkdirSync(path.join(dir, "a", "b", "c"), { recursive: true });
		fs.writeFileSync(path.join(dir, "a", "b", "c", "deep.txt"), "deep\n");
	}, (result) => {
		const f = path.join(result.worktreePath, "a", "b", "c", "deep.txt");
		assert.ok(fs.existsSync(f), "nested file carried");
		eq(fs.readFileSync(f, "utf8"), "deep\n");
	});
});

test("17. carry failure (source unreadable) — dispatch continues, no throw", () => {
	const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
	if (isRoot) {
		// chmod 000 does not make a file unreadable to root, so the failure
		// cannot be simulated; count it as skipped rather than passed.
		skip("running as root — chmod 000 does not make a file unreadable");
	}
	withCarryFlow({}, defaultBaseline, (dir) => {
		fs.writeFileSync(path.join(dir, "locked.txt"), "secret\n");
		fs.chmodSync(path.join(dir, "locked.txt"), 0o000);
	}, (result) => {
		assert.ok(result, "dispatch continues: worktree still returned, carry skipped");
		assert.ok(fs.existsSync(result.worktreePath), "worktree exists");
		assert.ok(!fs.existsSync(path.join(result.worktreePath, "locked.txt")), "carry skipped on failure");
	});
});

test("18. non-git cwd — createWorktree returns null", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-carry-nongit-"));
	try {
		const result = createWorktreeMirror(dir, newSessionId(), undefined, true);
		eq(result, null, "not a git repo → null");
	} finally {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
	}
});

test("19. carried snapshot — present hashes, absent deletions, link-prefixed symlinks", () => {
	withCarryFlow({}, (dir) => {
		fs.writeFileSync(path.join(dir, "baseline.txt"), "baseline\n");
		fs.writeFileSync(path.join(dir, "gone-wt.txt"), "x\n");
	}, (dir) => {
		// Mixed uncommitted state: modified file, deleted file, untracked
		// symlink, untracked file. Each must land in the snapshot correctly.
		fs.writeFileSync(path.join(dir, "baseline.txt"), "modified\n");
		fs.rmSync(path.join(dir, "gone-wt.txt"));
		fs.symlinkSync("baseline.txt", path.join(dir, "newlink"));
		fs.writeFileSync(path.join(dir, "untracked.txt"), "u\n");
	}, (result) => {
		const snap = result.carried;
		assert.ok(snap instanceof Map, "snapshot is a Map");
		const h1 = snap.get("baseline.txt");
		assert.ok(h1 && h1.state === "present", "modified file recorded as present");
		eq(h1.hash, hashCarriedFile(path.join(result.worktreePath, "baseline.txt")), "hash = sha256 of the carried bytes");
		eq(h1.hash, hashCarriedFile(path.join(result.worktreePath, "baseline.txt")), "stable across reads");
		const del = snap.get("gone-wt.txt");
		assert.deepStrictEqual(del, { state: "absent" }, "deletion recorded as absent");
		const link = snap.get("newlink");
		assert.ok(link && link.state === "present", "symlink recorded as present");
		eq(link.hash, "link:baseline.txt", "symlink hash is the link prefix + target");
		const unt = snap.get("untracked.txt");
		assert.ok(unt && unt.state === "present", "untracked file recorded as present");
		eq(snap.size, 4, "exactly the four carried paths, nothing else");
	});
});

test("20. clean tree — snapshot is a present empty map", () => {
	withCarryFlow({}, defaultBaseline, () => { /* no uncommitted state */ }, (result) => {
		assert.ok(result.carried instanceof Map, "snapshot present even with no changes");
		eq(result.carried.size, 0, "empty map for a clean tree");
	});
});

test("21. wiring regression — carryUncommittedState rejects a non-string topLevel (git result object)", () => {
	// WO-2026-034 production bug: createWorktree passed the git() RESULT
	// OBJECT as topLevel → spawn cwd invalid → best-effort catch → carry
	// silently never ran. The fail-fast guard (index.ts + this mirror) makes
	// that loud. Pinning both sides.
	const obj = { stdout: "/some/repo\n", stderr: "", exitCode: 0 };
	assert.throws(
		() => carryUncommittedState(obj, "/tmp/pi-subagent-wt-wiringpin"),
		/\btopLevel must be the repo path string\b/,
		"non-string topLevel must throw the fail-fast TypeError",
	);
	// The extracted path STRING must be accepted.
	assert.doesNotThrow(
		() => carryUncommittedState("/nonexistent-repo-path", "/tmp/pi-subagent-wt-wiringpin"),
		"string topLevel must not trigger the guard",
	);
});

// ── Result ─────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(failed === 0 ? 0 : 1);
