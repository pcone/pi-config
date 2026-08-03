#!/usr/bin/env node
/**
 * Regression test for the completion-time carry filter (WO-2026-035).
 *
 * preCommitSteps (extensions/subagent-async/index.ts) now skips auto-
 * committing carried files whose worktree bytes still match the carried-in
 * snapshot: a subagent that only READ the orchestrator's uncommitted doc
 * produces no branch commit (branch stays at parent HEAD, postDeliveryCleanup
 * deletes it). The filter runs AFTER the WO-*.md unstage block and BEFORE the
 * `git diff --cached --quiet` check; `git reset -q -- <rel>` restores each
 * untouched path's index entry to HEAD (so carried deletions stay present on
 * the branch); any failure inside the loop degrades via debugLog, never
 * aborting preCommitSteps. The snapshot lives in-memory only (rs.carried,
 * default null) — no persistence.
 *
 * This test cannot import index.ts — `typebox` and `@earendil-works/*`
 * resolve only under jiti at runtime. Following test-carry-uncommitted.cjs,
 * it mirrors the hash helper + filter (KEEP IN SYNC) and exercises the full
 * preCommitSteps sequence against REAL temp repos, REAL `git worktree add`,
 * REAL `git add -A` / `git reset` / `git diff --cached`. The 12-row matrix
 * below pins every filter behavior from the WO.
 *
 * Run: node test-completion-filter.cjs
 */
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");

// ── hashCarriedFile — KEEP IN SYNC with index.ts ──────────────────────────
// Single source of truth for carry-snapshot hashes: sha256 hex of a file's
// bytes, `"link:" + target` for a symlink, null when absent / not a regular
// file or symlink. Used by both carryUncommittedState (capture) and
// applyCarryFilter (compare) below, exactly as in index.ts.
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

// ── carryUncommittedState — KEEP IN SYNC with index.ts ────────────────────
// Mirror of the carry overlay + CarriedSnapshot capture in
// extensions/subagent-async/index.ts (carryUncommittedState + unsafeCarryPath
// + copyCarriedFile + hashCarriedFile). Same porcelain -z parsing, same
// copy/delete/rename/copy decisions, same path safety, same symlink-as-link
// and exec-bit handling — and now also records per-path snapshot entries:
// present (sha256 of the exact bytes written into the worktree), absent for
// carried deletions, nothing for skipped `.git`/unsafe paths. Returns a Map,
// never null (empty map when `git status` fails).
function unsafeCarryPath(p) {
	return p.length === 0 || p.includes("..") || p === ".git" || p.startsWith(".git/");
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

function recordPresent(snapshot, worktreePath, rel) {
	const hash = hashCarriedFile(path.join(worktreePath, rel));
	if (hash !== null) snapshot.set(rel, { state: "present", hash });
}

function carryUncommittedState(topLevel, worktreePath) {
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
// cleanup, `git worktree add`, then the optional carry. Returns the carried
// snapshot (present — possibly empty — when the overlay ran, absent when
// skipped or when the overlay threw), matching the real return shape.
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

// ── preCommitSteps mirrors — KEEP IN SYNC with index.ts ───────────────────
// The completion filter: after `git add -A` + the WO-*.md unstage block,
// reset every carried path whose worktree bytes still match the snapshot
// (or whose carried deletion is still absent). Failures degrade — the filter
// must never abort preCommitSteps.
function applyCarryFilter(worktreePath, carried) {
	const untouched = [];
	try {
		for (const [rel, snap] of carried) {
			const abs = path.join(worktreePath, rel);
			if (snap.state === "absent") {
				if (!fs.existsSync(abs)) untouched.push(rel);
			} else {
				const cur = hashCarriedFile(abs);
				if (cur === snap.hash) untouched.push(rel);
			}
		}
	} catch {
		// degrade: continue with the untouched list computed so far
	}
	if (untouched.length > 0) {
		execFileSync("git", ["reset", "-q", "--", ...untouched], { cwd: worktreePath });
	}
}

function commitIfChanges(worktreePath, subject) {
	let hadChanges = false;
	try {
		git(worktreePath, ["diff", "--cached", "--quiet"]);
	} catch (e) {
		if (e.status !== 1) throw e;
		hadChanges = true;
		git(worktreePath, ["commit", "-q", "-m", subject]);
	}
	return hadChanges;
}

// The full preCommitSteps sequence in mirror form. Returns hadChanges.
function preCommitStepsMirror(worktreePath, carried, subject) {
	git(worktreePath, ["add", "-A"]);
	const stagedNames = git(worktreePath, ["diff", "--cached", "--name-only"]);
	const scratch = stagedNames.split("\n").filter((p) => p.length > 0 && /^WO-.*\.md$/i.test(p));
	if (scratch.length > 0) git(worktreePath, ["reset", "-q", "--", ...scratch]);
	if (carried && carried.size > 0) applyCarryFilter(worktreePath, carried);
	return commitIfChanges(worktreePath, subject);
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

function commitCount(dir) {
	return git(dir, ["rev-list", "--count", "HEAD"]).trim();
}

function cleanupWorktree(parentDir, result) {
	if (!result) return;
	try { execFileSync("git", ["worktree", "remove", "--force", result.worktreePath], { cwd: parentDir, stdio: "ignore" }); } catch { /* */ }
	try { fs.rmSync(result.worktreePath, { recursive: true, force: true }); } catch { /* */ }
	try { execFileSync("git", ["branch", "-D", result.branchName], { cwd: parentDir, stdio: "ignore" }); } catch { /* */ }
}

// Real temp repo + real `git worktree add` + real carry (with snapshot), then
// the phaseFn runs the subagent phase + preCommitSteps mirror + assertions.
function withCarryFlow(opts, baselineFn, setupFn, phaseFn) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-filter-repo-"));
	let result = null;
	try {
		initRepo(dir);
		baselineFn(dir);
		git(dir, ["add", "-A"]);
		git(dir, ["commit", "-q", "-m", "baseline"]);
		setupFn(dir, git);
		result = createWorktreeMirror(dir, newSessionId(), opts.baseRef, opts.carryUncommitted ?? true);
		phaseFn(result, dir, git);
	} finally {
		cleanupWorktree(dir, result);
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
	}
}

const defaultBaseline = (dir) => {
	fs.writeFileSync(path.join(dir, "plan.md"), "v1\n");
	fs.writeFileSync(path.join(dir, "gone.txt"), "x\n");
	fs.writeFileSync(path.join(dir, "target.txt"), "target\n");
};

const SUBJECT = "subagent(implement): test";

// ── The 12-row matrix ──────────────────────────────────────────────────────

test("1. carried file read-only (never edited) — not in diff; no commit", () => {
	withCarryFlow({}, defaultBaseline, (dir) => {
		fs.writeFileSync(path.join(dir, "plan.md"), "v2\n"); // parent uncommitted edit
	}, (result, dir) => {
		const wt = result.worktreePath;
		eq(fs.readFileSync(path.join(wt, "plan.md"), "utf8"), "v2\n", "carried bytes present");
		fs.readFileSync(path.join(wt, "plan.md"), "utf8"); // subagent reads, never edits
		const hadChanges = preCommitStepsMirror(wt, result.carried, SUBJECT);
		eq(hadChanges, false, "no commit produced");
		eq(commitCount(dir), "1", "branch still at baseline");
		eq(git(wt, ["diff", "--cached", "--name-only"]).trim(), "", "carried file not staged");
	});
});

test("2. carried file edited by subagent — in diff; committed", () => {
	withCarryFlow({}, defaultBaseline, (dir) => {
		fs.writeFileSync(path.join(dir, "plan.md"), "v2\n");
	}, (result, dir) => {
		const wt = result.worktreePath;
		fs.writeFileSync(path.join(wt, "plan.md"), "v3\n"); // subagent edit
		const hadChanges = preCommitStepsMirror(wt, result.carried, SUBJECT);
		eq(hadChanges, true, "changes committed");
		eq(git(wt, ["show", "HEAD:plan.md"]), "v3\n", "edit landed on the branch");
	});
});

test("3. subagent-created new file — committed (carried file still filtered)", () => {
	withCarryFlow({}, defaultBaseline, (dir) => {
		fs.writeFileSync(path.join(dir, "plan.md"), "v2\n");
	}, (result, dir) => {
		const wt = result.worktreePath;
		fs.writeFileSync(path.join(wt, "new.txt"), "subagent work\n");
		const hadChanges = preCommitStepsMirror(wt, result.carried, SUBJECT);
		eq(hadChanges, true, "new file committed");
		eq(git(wt, ["show", "HEAD:new.txt"]), "subagent work\n");
		eq(git(wt, ["show", "HEAD:plan.md"]), "v1\n", "untouched carried file NOT on branch");
	});
});

test("4. carried deletion untouched (still absent) — deletion NOT staged; file present on branch", () => {
	withCarryFlow({}, defaultBaseline, (dir) => {
		fs.rmSync(path.join(dir, "gone.txt")); // parent uncommitted deletion
	}, (result, dir) => {
		const wt = result.worktreePath;
		assert.ok(!fs.existsSync(path.join(wt, "gone.txt")), "carried deletion absent in worktree");
		const hadChanges = preCommitStepsMirror(wt, result.carried, SUBJECT);
		eq(hadChanges, false, "no commit produced");
		eq(commitCount(dir), "1", "branch still at baseline");
		eq(git(wt, ["diff", "--cached", "--name-only"]).trim(), "", "deletion not staged");
		git(wt, ["show", "HEAD:gone.txt"]); // still tracked on the branch
	});
});

test("5. carried deletion undone (recreated with content) — committed", () => {
	withCarryFlow({}, defaultBaseline, (dir) => {
		fs.rmSync(path.join(dir, "gone.txt"));
	}, (result, dir) => {
		const wt = result.worktreePath;
		fs.writeFileSync(path.join(wt, "gone.txt"), "recreated\n"); // subagent undoes the deletion
		const hadChanges = preCommitStepsMirror(wt, result.carried, SUBJECT);
		eq(hadChanges, true, "recreated file committed");
		eq(git(wt, ["show", "HEAD:gone.txt"]), "recreated\n");
	});
});

test("6. carried symlink untouched — not committed", () => {
	withCarryFlow({}, defaultBaseline, (dir) => {
		fs.symlinkSync("target.txt", path.join(dir, "mylink")); // parent untracked symlink
	}, (result, dir) => {
		const wt = result.worktreePath;
		const snap = result.carried.get("mylink");
		assert.ok(snap, "symlink in snapshot");
		eq(snap.hash, "link:target.txt", "snapshot hash is the link prefix + target");
		assert.ok(fs.lstatSync(path.join(wt, "mylink")).isSymbolicLink(), "carried as link");
		const hadChanges = preCommitStepsMirror(wt, result.carried, SUBJECT);
		eq(hadChanges, false, "no commit produced");
		eq(commitCount(dir), "1");
		eq(git(wt, ["diff", "--cached", "--name-only"]).trim(), "", "symlink not staged");
	});
});

test("7. carried file + subagent WO-x.md scratch — both filtered; no commit", () => {
	withCarryFlow({}, defaultBaseline, (dir) => {
		fs.writeFileSync(path.join(dir, "plan.md"), "v2\n");
	}, (result, dir) => {
		const wt = result.worktreePath;
		fs.writeFileSync(path.join(wt, "WO-2026-999.md"), "# scratch the subagent wrote\n");
		const hadChanges = preCommitStepsMirror(wt, result.carried, SUBJECT);
		eq(hadChanges, false, "no commit produced");
		eq(commitCount(dir), "1");
		eq(git(wt, ["diff", "--cached", "--name-only"]).trim(), "", "neither the WO doc nor the carried file staged");
	});
});

test("8. rs.carried null (carryUncommitted:false) — old behavior, unchanged", () => {
	withCarryFlow({ carryUncommitted: false }, defaultBaseline, (dir) => {
		fs.writeFileSync(path.join(dir, "plan.md"), "v2\n");
	}, (result, dir) => {
		const wt = result.worktreePath;
		// This asserts the createWorktree return SHAPE (no `carried` key when
		// carry is skipped) — the pipeline-level null is asserted below by
		// passing null into preCommitStepsMirror, matching rs.carried's null
		// default in production (spawnSubagent: carriedSnapshot ?? null).
		eq(result.carried, undefined, "no snapshot when carry skipped");
		fs.writeFileSync(path.join(wt, "new.txt"), "work\n");
		const hadChanges = preCommitStepsMirror(wt, null, SUBJECT);
		eq(hadChanges, true, "commit proceeds as before");
		eq(git(wt, ["show", "HEAD:new.txt"]), "work\n");
	});
});

test("9. empty carried map — no-op", () => {
	withCarryFlow({}, defaultBaseline, () => { /* clean parent tree → empty snapshot */ }, (result, dir) => {
		const wt = result.worktreePath;
		assert.ok(result.carried, "snapshot present (empty map) even with no changes");
		eq(result.carried.size, 0, "empty map");
		fs.writeFileSync(path.join(wt, "new.txt"), "work\n");
		const hadChanges = preCommitStepsMirror(wt, result.carried, SUBJECT);
		eq(hadChanges, true, "no-op filter, commit proceeds");
		eq(git(wt, ["show", "HEAD:new.txt"]), "work\n");
	});
});

test("10. path with a space, carried & untouched — not committed (args-array reset)", () => {
	withCarryFlow({}, defaultBaseline, (dir) => {
		fs.writeFileSync(path.join(dir, "my file.txt"), "spaced\n"); // parent untracked
	}, (result, dir) => {
		const wt = result.worktreePath;
		assert.ok(result.carried.has("my file.txt"), "spaced path in snapshot");
		eq(fs.readFileSync(path.join(wt, "my file.txt"), "utf8"), "spaced\n");
		const hadChanges = preCommitStepsMirror(wt, result.carried, SUBJECT);
		eq(hadChanges, false, "no commit produced");
		eq(commitCount(dir), "1");
		eq(git(wt, ["diff", "--cached", "--name-only"]).trim(), "", "spaced path not staged");
	});
});

test("11. carried file edited then reverted to identical bytes — treated as untouched; no commit", () => {
	withCarryFlow({}, defaultBaseline, (dir) => {
		fs.writeFileSync(path.join(dir, "plan.md"), "v2\n");
	}, (result, dir) => {
		const wt = result.worktreePath;
		fs.writeFileSync(path.join(wt, "plan.md"), "v3\n"); // edit
		fs.writeFileSync(path.join(wt, "plan.md"), "v2\n"); // revert to exact carried bytes
		const hadChanges = preCommitStepsMirror(wt, result.carried, SUBJECT);
		eq(hadChanges, false, "net-zero edit is untouched — no commit");
		eq(commitCount(dir), "1");
	});
});

test("12. filter failure (carried file unreadable) — preCommitSteps continues; commit proceeds", () => {
	const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
	if (isRoot) {
		// chmod 000 does not make a file unreadable to root, so the filter
		// cannot be made to fail; count it as skipped rather than passed.
		skip("running as root — chmod 000 does not make a file unreadable");
	}
	withCarryFlow({}, defaultBaseline, (dir) => {
		fs.writeFileSync(path.join(dir, "plan.md"), "v2\n");
	}, (result, dir) => {
		const wt = result.worktreePath;
		const carriedFile = path.join(wt, "plan.md");
		// Stage while readable (git add cannot read a chmod-000 file), then
		// break readability so hashCarriedFile fails mid-filter.
		git(wt, ["add", "-A"]);
		fs.chmodSync(carriedFile, 0o000);
		applyCarryFilter(wt, result.carried); // must not throw
		const staged = git(wt, ["diff", "--cached", "--name-only"]).trim();
		assert.ok(staged.includes("plan.md"), "unverifiable carried file stays staged");
		const hadChanges = commitIfChanges(wt, SUBJECT);
		eq(hadChanges, true, "commit proceeds with whatever remains staged");
		eq(git(wt, ["show", "HEAD:plan.md"]), "v2\n", "unreadable-but-staged file committed");
		fs.chmodSync(carriedFile, 0o644);
	});
});

// ── Result ─────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(failed === 0 ? 0 : 1);
