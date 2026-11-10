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
 * The guarantee is structural, not a list of files: `bunfig.toml` preloads
 * `tests/preload-worktree-root.ts`, which points the variable at a temp dir for
 * the whole run, so a spawning file that never thinks about it still cannot
 * reach the human namespace. Row 1 pins the preload, row 2 the creation path,
 * row 3 the refusal. No row compares the human root before and after a nested
 * run: live peer dispatches create and remove trees there, so that comparison
 * was noise (a single directory created and deleted mid-run flipped it).
 *
 * Run: bun test tests/subagent-worktree-root-isolation.test.ts
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, sep } from "node:path";
import {
	PI_SUBAGENT_WT_ROOT_ENV,
	UnusableWorktreeRootError,
	subagentWorktreeBase,
} from "../extensions/lib/subagent-worktree.ts";
import { childEnv } from "./helpers/subagent-env.ts";

/** The human tree. Read through the derivation with an explicit home, so it is
 *  the human base whatever the run's override is. */
const REAL_WT_ROOT = join(homedir(), "Developer", "wt");
const REAL_BASE = subagentWorktreeBase(homedir());

/** The run's base, set by the preload before this file loaded. */
const RUN_ROOT = process.env[PI_SUBAGENT_WT_ROOT_ENV] ?? "";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		env: childEnv(),
	}).trim();
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
	test("the preload points the base at a temp dir, so no file has to isolate itself", () => {
		expect(RUN_ROOT.length).toBeGreaterThan(0);
		expect(isAbsolute(RUN_ROOT)).toBe(true);
		expect(statSync(RUN_ROOT).isDirectory()).toBe(true);
		// Symlink-resolved: the guard compares realpath'd prefixes.
		expect(RUN_ROOT).toBe(realpathSync(RUN_ROOT));
		expect(RUN_ROOT.startsWith(realpathSync(tmpdir()) + sep)).toBe(true);
		expect(RUN_ROOT.startsWith(homedir() + sep)).toBe(false);
		// The derivation the spawn path uses answers it, not the human namespace.
		expect(subagentWorktreeBase()).toBe(RUN_ROOT);
	});

	test("with the override set, createWorktree lands under it and the real base gains nothing", async () => {
		const { createWorktree } = await import("../extensions/subagent-async/index.ts");
		const repo = makeRepo("wt-root-row-");
		const sessionId = "subagent-0b5f1a2c-1111-2222-3333-abcdefabcdef";
		const expectedName = `${basename(repo)}-${sessionId.slice(-12)}`;
		const realBefore = snapshotRealWtRoot();

		const wt = await createWorktree(repo, sessionId);
		try {
			expect(wt).not.toBeNull();
			expect(wt!.worktreePath).toBe(join(RUN_ROOT, expectedName));
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
