/**
 * A worktree created by a test belongs beside that test's temp repo, never in
 * the human `~/Developer/wt/subagents`.
 *
 * The leak this pins: `createWorktree` resolves its path from
 * `subagentWorktreeBase()`, and a test that spawns through the `subagent` tool
 * cannot pass a base in. Without `PI_SUBAGENT_WT_ROOT` the tree landed in the
 * real namespace and outlived the `$TMPDIR` repo it was branched from, leaving
 * a `.git` file pointing at nothing (149 of them on 2026-11-27).
 *
 * Row 1 is the mechanism. Row 2 is the whole set of files that spawn a
 * worktree, run with the override scrubbed so each file must isolate itself.
 *
 * Run: bun test tests/subagent-worktree-root-isolation.test.ts
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	PI_SUBAGENT_WT_ROOT_ENV,
	UnusableWorktreeRootError,
	subagentWorktreeBase,
} from "../extensions/lib/subagent-worktree.ts";
import { isolateSubagentWorktrees } from "./helpers/subagent-wt-root.ts";

const REPO_ROOT = join(import.meta.dir, "..");

/** The human tree. Read through the derivation, not the override this file sets. */
const REAL_WT_ROOT = join(homedir(), "Developer", "wt");
const REAL_BASE = subagentWorktreeBase(homedir());

/**
 * Every test file that reaches `createWorktree`, found by running each spawning
 * file with the override set and reading the trees that appeared: the `subagent`
 * tool spawns in turn-cap, subagent-worktree-lock and work-record-landing; the
 * paths file calls `createWorktree` directly. A file added to the suite that
 * spawns a worktree without isolating itself shows up in row 2 as a new entry
 * under the real base, and belongs in this list.
 */
const SPAWNING_FILES = [
	"tests/subagent-worktree-paths.test.ts",
	"tests/work-record-landing.test.ts",
	"tests/subagent-worktree-lock.test.ts",
	"tests/turn-cap.test.ts",
];

const wtRoot = isolateSubagentWorktrees("pi-wt-root-isolation-");
afterAll(() => wtRoot.dispose());

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** A temp repo with one commit — a worktree needs a HEAD to branch from. */
function makeRepo(prefix: string): string {
	const repo = mkdtempSync(join(tmpdir(), prefix));
	git(repo, "init", "-q");
	git(repo, "config", "user.email", "probe@example.invalid");
	git(repo, "config", "user.name", "probe");
	writeFileSync(join(repo, "file.txt"), "x\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "probe");
	return repo;
}

/** Names in the human worktree root and its subagent namespace, sorted. */
function snapshotRealWtRoot(): string[] {
	const names: string[] = [];
	for (const dir of [REAL_WT_ROOT, REAL_BASE]) {
		if (!existsSync(dir)) continue;
		for (const name of readdirSync(dir)) names.push(`${dir.slice(REAL_WT_ROOT.length + 1)}/${name}`);
	}
	return names.sort();
}

describe("worktree root isolation", () => {
	test("with the override set, createWorktree lands under it and the real base gains nothing", async () => {
		const { createWorktree } = await import("../extensions/subagent-async/index.ts");
		const repo = makeRepo("wt-root-row-");
		const sessionId = "subagent-0b5f1a2c-1111-2222-3333-abcdefabcdef";
		const expectedName = `${basename(repo)}-${sessionId.slice(-12)}`;
		const realBefore = snapshotRealWtRoot();

		const wt = await createWorktree(repo, sessionId);
		try {
			expect(wt).not.toBeNull();
			expect(wt!.worktreePath).toBe(join(wtRoot.root, expectedName));
			expect(existsSync(join(wt!.worktreePath, "file.txt"))).toBe(true);
			// The tree is registered in the temp repo, under the redirected path.
			expect(git(repo, "worktree", "list")).toContain(wt!.worktreePath);
			expect(existsSync(wt!.worktreePath)).toBe(true);
		} finally {
			if (wt) {
				git(repo, "worktree", "unlock", wt.worktreePath);
				git(repo, "worktree", "remove", "--force", wt.worktreePath);
				git(repo, "branch", "-D", wt.branchName);
				git(repo, "worktree", "prune");
			}
			rmSync(repo, { recursive: true, force: true });
		}

		expect(existsSync(join(REAL_BASE, expectedName))).toBe(false);
		expect(snapshotRealWtRoot()).toEqual(realBefore);
	});

	test("the spawning test files leave the human worktree root unchanged", () => {
		const before = snapshotRealWtRoot();
		// The nested run must not inherit this file's override: each spawning file
		// is what keeps its own trees out of the human namespace.
		const env = { ...process.env };
		delete env[PI_SUBAGENT_WT_ROOT_ENV];

		const nested = Bun.spawnSync(["bun", "test", ...SPAWNING_FILES], {
			cwd: REPO_ROOT,
			env,
			stdout: "pipe",
			stderr: "pipe",
			timeout: 540_000,
		});
		const output = `${nested.stdout.toString()}${nested.stderr.toString()}`;
		if (nested.exitCode !== 0) throw new Error(`a spawning file failed under a scrubbed run:\n${output}`);

		expect(snapshotRealWtRoot()).toEqual(before);
	}, 600_000);

	test("an override that cannot name a base is refused, never replaced by the human path", async () => {
		const { createWorktree } = await import("../extensions/subagent-async/index.ts");
		const repo = makeRepo("wt-root-row-");
		const realBefore = snapshotRealWtRoot();
		const override = process.env[PI_SUBAGENT_WT_ROOT_ENV];
		try {
			for (const bad of ["", "relative/wt", "Developer/wt/subagents"]) {
				process.env[PI_SUBAGENT_WT_ROOT_ENV] = bad;
				expect(() => subagentWorktreeBase()).toThrow(UnusableWorktreeRootError);
				// The spawn path fails loud too: `null` says "not a git repo or
				// worktree add failed", and this is neither.
				await expect(createWorktree(repo, "subagent-0b5f1a2c-2222-3333-4444-abcdefabcdef")).rejects.toThrow(
					UnusableWorktreeRootError,
				);
			}
		} finally {
			if (override === undefined) delete process.env[PI_SUBAGENT_WT_ROOT_ENV];
			else process.env[PI_SUBAGENT_WT_ROOT_ENV] = override;
			rmSync(repo, { recursive: true, force: true });
		}
		expect(snapshotRealWtRoot()).toEqual(realBefore);
	});
});
