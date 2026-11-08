/**
 * WO-2026-091 preparatory refactor: the one unlock → remove → branch-delete
 * sequence both removal sites call (`removeWorktreeTree`).
 *
 * Post-delivery cleanup and the session-start reap disagreed about `--force`
 * and about the branch, and agreed on everything else while each carrying its
 * own copy. These rows pin the sequence's behaviour — forced removal after
 * delivery, the plain remove the reap's cleanliness check buys, a dirty tree
 * kept and re-locked, the branch-delete decision (WO-2026-049), and a removal
 * whose parent checkout is gone — so the "same behaviour, one place" claim is
 * checkable, and so the build-output pass that lands on top of it has a pinned
 * base. The two sites' own rows (tests/subagent-worktree-lock.test.ts) are the
 * behavioural pin at the seam they call through.
 *
 * Run: bun test tests/worktree-removal.test.ts
 */

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeWorktreeTree } from "../extensions/subagent-async/index.ts";
import { childEnv } from "./helpers/subagent-env.ts";

// ── Real git helpers ───────────────────────────────────────────────────────

function git(cwd: string, args: string[]): { code: number; out: string; err: string } {
	const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: childEnv() });
	return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

const repos: string[] = [];
const dirs: string[] = [];

function makeRepo(): string {
	const repo = mkdtempSync(join(tmpdir(), "pi-removal-repo-"));
	repos.push(repo);
	git(repo, ["init", "-q", "."]);
	git(repo, ["config", "user.email", "test@example.com"]);
	git(repo, ["config", "user.name", "Test"]);
	writeFileSync(join(repo, "seed.txt"), "seed\n");
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "-q", "-m", "init"]);
	return repo;
}

/** A locked worktree on branch `pi-subagent-<sid>`, as `createWorktree` leaves
 *  it: the lock is what a removal must drop before git will remove the tree. */
function makeWorktree(repo: string, sid: string): { worktreePath: string; branch: string; parentHeadCommit: string } {
	const worktreePath = join(mkdtempSync(join(tmpdir(), "pi-removal-wt-")), "tree");
	const branch = `pi-subagent-${sid}`;
	const add = git(repo, ["worktree", "add", "-q", worktreePath, "-b", branch]);
	if (add.code !== 0) throw new Error(`worktree add failed: ${add.err}`);
	git(repo, ["worktree", "lock", "--reason", `pi-subagent ${sid}`, worktreePath]);
	return { worktreePath, branch, parentHeadCommit: git(repo, ["rev-parse", "HEAD"]).out.trim() };
}

/** The `git worktree list --porcelain` block for `path`, or null. git
 *  canonicalises paths (/var → /private/var on macOS), so compare realpaths. */
function worktreeEntry(repo: string, path: string): string | null {
	let target = path;
	try { target = realpathSync(path); } catch { /* directory already removed */ }
	for (const block of git(repo, ["worktree", "list", "--porcelain"]).out.split("\n\n")) {
		const first = block.split("\n")[0];
		if (!first?.startsWith("worktree ")) continue;
		let registered = first.slice("worktree ".length);
		try { registered = realpathSync(registered); } catch { /* gone */ }
		if (registered === target) return block;
	}
	return null;
}

function branchExists(repo: string, branch: string): boolean {
	return git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).code === 0;
}

afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

afterAll(() => {
	for (const r of repos.splice(0)) {
		git(r, ["worktree", "prune"]);
		rmSync(r, { recursive: true, force: true });
	}
});

// ── The sequence ───────────────────────────────────────────────────────────

describe("removeWorktreeTree (real git)", () => {
	it("force removes a tree that still carries uncommitted bytes (post-delivery's case)", async () => {
		const repo = makeRepo();
		const { worktreePath, branch, parentHeadCommit } = makeWorktree(repo, "forced-1");
		writeFileSync(join(worktreePath, "scratch.txt"), "uncommitted\n");

		// The build-output pass is the same call for both sites (WO-2026-091):
		// one removal, one place to prune.
		const disposed: Array<[string, string]> = [];
		const outcome = await removeWorktreeTree(
			{
				disposeBuildOutput: async (path, parent) => {
					disposed.push([path, parent]);
					return { targetRemoved: true, problems: [] };
				},
			},
			{ worktreePath, isolationBranch: branch, parentHeadCommit, parentCwd: repo },
			{
				force: true,
				finalCommit: parentHeadCommit,
				relockReason: `pi-subagent forced-1 (cleanup failed)`,
			},
		);

		expect(outcome).toMatchObject({ ok: true, buildOutput: { targetRemoved: true } });
		expect(disposed).toEqual([[worktreePath, repo]]);
		expect(existsSync(worktreePath)).toBe(false);
		expect(worktreeEntry(repo, worktreePath)).toBeNull();
	});

	it("refuses the plain remove on a dirty tree, keeps the bytes, and re-locks (the reap's case)", async () => {
		const repo = makeRepo();
		const { worktreePath, branch, parentHeadCommit } = makeWorktree(repo, "dirty-1");
		writeFileSync(join(worktreePath, "uncommitted.txt"), "bytes\n");

		const outcome = await removeWorktreeTree({}, { worktreePath, isolationBranch: branch, parentHeadCommit, parentCwd: repo }, {
			force: false,
			finalCommit: null,
			relockReason: "pi-subagent dirty-1 (reap failed)",
		});

		expect(outcome.ok).toBe(false);
		expect(outcome.stage).toBe("remove");
		// Never a rmtree fallback: the uncommitted bytes are what the lock exists
		// for, and the tree is still registered and locked against a hand reap.
		expect(readFileSync(join(worktreePath, "uncommitted.txt"), "utf8")).toBe("bytes\n");
		const entry = worktreeEntry(repo, worktreePath);
		expect(entry).not.toBeNull();
		expect(entry!).toContain("locked");
		expect(entry!).toContain("(reap failed)");
	});

	it("deletes the branch only when it never moved past the parent commit (WO-2026-049)", async () => {
		const repo = makeRepo();

		// Unmoved: finalCommit === parentHeadCommit.
		const unmoved = makeWorktree(repo, "branch-unmoved");
		const dropped = await removeWorktreeTree(
			{},
			{ worktreePath: unmoved.worktreePath, isolationBranch: unmoved.branch, parentHeadCommit: unmoved.parentHeadCommit, parentCwd: repo },
			{ force: true, finalCommit: unmoved.parentHeadCommit, relockReason: "t" },
		);
		expect(dropped.ok).toBe(true);
		expect(branchExists(repo, unmoved.branch)).toBe(false);

		// Moved: the subagent committed its own work, so the branch is the only
		// copy of it.
		const moved = makeWorktree(repo, "branch-moved");
		writeFileSync(join(moved.worktreePath, "work.txt"), "work\n");
		git(moved.worktreePath, ["add", "-A"]);
		git(moved.worktreePath, ["commit", "-q", "-m", "the work"]);
		const tip = git(moved.worktreePath, ["rev-parse", "HEAD"]).out.trim();
		expect(tip).not.toBe(moved.parentHeadCommit);
		const kept = await removeWorktreeTree(
			{},
			{ worktreePath: moved.worktreePath, isolationBranch: moved.branch, parentHeadCommit: moved.parentHeadCommit, parentCwd: repo },
			{ force: true, finalCommit: tip, relockReason: "t" },
		);
		expect(kept.ok).toBe(true);
		expect(branchExists(repo, moved.branch)).toBe(true);
		expect(git(repo, ["rev-parse", moved.branch]).out.trim()).toBe(tip);

		// Unknown final commit (the reap: the tree was clean, the work is on the
		// branch): the branch stays.
		const unknown = makeWorktree(repo, "branch-unknown");
		const keptUnknown = await removeWorktreeTree(
			{},
			{ worktreePath: unknown.worktreePath, isolationBranch: unknown.branch, parentHeadCommit: unknown.parentHeadCommit, parentCwd: repo },
			{ force: false, finalCommit: null, relockReason: "t" },
		);
		expect(keptUnknown.ok).toBe(true);
		expect(branchExists(repo, unknown.branch)).toBe(true);
	});

	it("reports an unlock failure without touching the tree", async () => {
		const repo = makeRepo();
		const { branch, parentHeadCommit } = makeWorktree(repo, "unregistered-1");
		// A directory the repo does not know as a worktree: the unlock fails with
		// "is not a working tree", which is not the tolerated "is not locked", so
		// the lock may still be in force and nothing may be removed.
		const worktreePath = mkdtempSync(join(tmpdir(), "pi-removal-unregistered-"));
		writeFileSync(join(worktreePath, "bytes.txt"), "keep me\n");

		const outcome = await removeWorktreeTree({}, { worktreePath, isolationBranch: branch, parentHeadCommit, parentCwd: repo }, {
			force: true,
			finalCommit: parentHeadCommit,
			relockReason: "t",
		});

		expect(outcome.ok).toBe(false);
		expect(outcome.stage).toBe("unlock");
		expect(outcome.detail).toContain("is not a working tree");
		expect(readFileSync(join(worktreePath, "bytes.txt"), "utf8")).toBe("keep me\n");
	});

	it("removes a tree whose parent checkout is gone (the reap's case)", async () => {
		const repo = makeRepo();
		const { worktreePath, branch, parentHeadCommit } = makeWorktree(repo, "orphan-1");
		const parentCwd = join(mkdtempSync(join(tmpdir(), "pi-removal-parent-")), "gone");
		dirs.push(parentCwd);

		const outcome = await removeWorktreeTree({}, { worktreePath, isolationBranch: branch, parentHeadCommit, parentCwd }, {
			force: false,
			finalCommit: null,
			relockReason: "t",
		});

		expect(outcome.ok).toBe(true);
		expect(existsSync(worktreePath)).toBe(false);
		expect(worktreeEntry(repo, worktreePath)).toBeNull();
	});
});
