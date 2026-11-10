/**
 * Real-git fixtures for the two reaper suites: `tests/checkout-reaper.test.ts`
 * (WO-2026-092's general pass) and `tests/subagent-worktree-lock.test.ts`
 * (027's reap, driven through the real `session_start`).
 *
 * One definition per fixture shape. `backdate` is the idle gate's only
 * definition of "idle", so a row in either suite cannot age a tree by a
 * different rule than the gate reads.
 */

import { lstatSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IDLE_DAYS } from "../../extensions/lib/checkout-reaper.ts";
import { childEnv } from "./subagent-env.ts";

/** Synchronous git, so a fixture builds in one line. The env is scrubbed: an
 *  inherited `PI_SUBAGENT_*` set would make the fixture's own git refuse. */
export function git(cwd: string, args: string[]): { code: number; out: string; err: string } {
	const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: childEnv() });
	return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

export function mustGit(cwd: string, args: string[]): string {
	const r = git(cwd, args);
	if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.err}`);
	return r.out;
}

/** A repo with a pushed `main` and a bare `origin`, both under `home`, so a walk
 *  over `home/Developer/wt` sees the worktrees and never the repository. */
export function makeRepo(home: string, name = "myrepo"): { repo: string; origin: string } {
	const origin = join(home, "repos", `${name}.git`);
	const repo = join(home, "repos", name);
	mkdirSync(join(home, "repos"), { recursive: true });
	mustGit(home, ["init", "-q", "--bare", origin]);
	mustGit(home, ["clone", "-q", origin, repo]);
	mustGit(repo, ["config", "user.email", "test@example.com"]);
	mustGit(repo, ["config", "user.name", "Test"]);
	mustGit(repo, ["config", "commit.gpgsign", "false"]);
	writeFileSync(join(repo, "seed.txt"), "seed\n");
	// A cargo repo ignores its build output, so a tree carrying one is clean.
	writeFileSync(join(repo, ".gitignore"), "target/\n");
	mustGit(repo, ["add", "-A"]);
	mustGit(repo, ["commit", "-q", "-m", "init"]);
	mustGit(repo, ["push", "-q", "-u", "origin", "HEAD"]);
	mustGit(repo, ["branch", "-q", "-m", "main"]);
	mustGit(repo, ["push", "-q", "-u", "origin", "main"]);
	return { repo, origin };
}

/** A linked worktree at `path` on `branch`, created at the repo's HEAD and
 *  pushed, so its commits exist on the origin. Subagent trees are locked by
 *  `createWorktree`; a seat-made gate/land tree is not. */
export function addWorktree(repo: string, path: string, branch: string, opts: { lock?: boolean; push?: boolean } = {}): string {
	mkdirSync(join(path, ".."), { recursive: true });
	mustGit(repo, ["worktree", "add", "-q", "-b", branch, path, "HEAD"]);
	if (opts.push !== false) mustGit(repo, ["push", "-q", "origin", `refs/heads/${branch}:refs/heads/${branch}`]);
	if (opts.lock) mustGit(repo, ["worktree", "lock", "--reason", "pi-subagent test", path]);
	return path;
}

/** Push every mtime in `target` back `days`, so the idle gate sees a checkout
 *  nobody has touched. */
export function backdate(target: string, days = IDLE_DAYS + 3): void {
	const when = new Date(Date.now() - days * 86_400_000);
	const walk = (p: string): void => {
		let st;
		try {
			st = lstatSync(p);
		} catch {
			return;
		}
		utimesSync(p, when, when);
		if (!st.isDirectory()) return;
		for (const name of readdirSync(p)) walk(join(p, name));
	};
	walk(target);
}

/** The gitdir a linked worktree's `.git` file names. The age screen reads that
 *  gitdir, so a row that wants an idle tree back-dates it separately. */
export function gitDirOf(worktreePath: string): string {
	const text = readFileSync(join(worktreePath, ".git"), "utf8");
	return /^gitdir:\s*(.+)$/m.exec(text)![1].trim();
}
