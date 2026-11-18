/**
 * `bin/pre-push` — the two landing refusals (pi-config#20, owner ruling 2026-11-18, option A).
 *
 * The hook is bash, and these rows drive the real script against throwaway repos rather than a
 * TS re-implementation: what is pinned is what git runs on a push.
 *
 * Run: bun test tests/pre-push-hook.test.ts
 */

import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HOOK = path.join(import.meta.dir, "..", "bin", "pre-push");
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], {
	encoding: "utf-8",
	env: { ...process.env },
}).trim();
const ZERO = "0".repeat(40);
const repos: string[] = [];

afterEach(() => {
	for (const d of repos.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
		cwd: repo,
		encoding: "utf-8",
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
	}).trim();
}

/** A repo with one commit on `main`. */
function makeRepo(): string {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pre-push-"));
	repos.push(repo);
	git(repo, "init", "-q", "-b", "main");
	fs.writeFileSync(path.join(repo, "README.md"), "x\n");
	git(repo, "add", "README.md");
	git(repo, "commit", "-q", "-m", "init");
	return repo;
}

/** `note` keeps two same-id commits from collapsing to one sha (same tree, parent and message). */
function commitWo(repo: string, id: string, note = ""): string {
	fs.mkdirSync(path.join(repo, "work-orders"), { recursive: true });
	fs.writeFileSync(path.join(repo, "work-orders", `${id}-demo.md`), `# demo ${note}\n`);
	git(repo, "add", "work-orders");
	git(repo, "commit", "-q", "-m", `add ${id} ${note}`);
	return git(repo, "rev-parse", "HEAD");
}

function runHook(repo: string, lines: string[]): { code: number; stderr: string; stdout: string } {
	const r = spawnSync("bash", [HOOK], {
		cwd: repo,
		input: lines.join("\n") + "\n",
		encoding: "utf-8",
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
	});
	return { code: r.status ?? -1, stderr: r.stderr, stdout: r.stdout };
}

const line = (localRef: string, localSha: string, remoteRef: string, remoteSha: string) =>
	`${localRef} ${localSha} ${remoteRef} ${remoteSha}`;

describe("rule (A): a mainline push must be HEAD", () => {
	it("refuses a mainline push whose local sha is not HEAD, naming both", () => {
		const repo = makeRepo();
		const head = git(repo, "rev-parse", "HEAD");
		const other = git(repo, "commit-tree", "HEAD^{tree}", "-p", head, "-m", "elsewhere");
		git(repo, "checkout", "-q", "--detach", head);
		const r = runHook(repo, [line("refs/heads/main", other, "refs/heads/main", head)]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain(other);
		expect(r.stderr).toContain(head);
		expect(r.stderr).toContain("NOT LANDED");
	});

	it("passes a mainline push that is HEAD", () => {
		const repo = makeRepo();
		const head = git(repo, "rev-parse", "HEAD");
		const r = runHook(repo, [line("refs/heads/main", head, "refs/heads/main", head)]);
		expect(r.code).toBe(0);
		expect(r.stderr).toBe("");
	});

	it("passes a side-branch push from a checkout on another commit", () => {
		const repo = makeRepo();
		const head = git(repo, "rev-parse", "HEAD");
		const side = git(repo, "commit-tree", "HEAD^{tree}", "-p", head, "-m", "side");
		const r = runHook(repo, [line("refs/heads/side", side, "refs/heads/side", ZERO)]);
		expect(r.code).toBe(0);
	});

	it("refuses a detached HEAD landing even when the sha is a real commit", () => {
		const repo = makeRepo();
		const head = git(repo, "rev-parse", "HEAD");
		const next = commitWo(repo, "WO-2026-900");
		git(repo, "checkout", "-q", "--detach", head);
		const r = runHook(repo, [line("refs/heads/main", next, "refs/heads/main", head)]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("HEAD is");
	});
});

describe("rule (B): a work-orders id no live ref holds", () => {
	it("refuses an id a live ref already holds, naming the ref", () => {
		const repo = makeRepo();
		const base = git(repo, "rev-parse", "HEAD");
		commitWo(repo, "WO-2026-800");
		git(repo, "branch", "held", "HEAD");
		git(repo, "reset", "-q", "--hard", base);
		const head = commitWo(repo, "WO-2026-800", "rival");
		const r = runHook(repo, [line("refs/heads/main", head, "refs/heads/main", base)]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("WO-2026-800 is already held by held");
	});

	it("passes an id no ref holds", () => {
		const repo = makeRepo();
		const base = git(repo, "rev-parse", "HEAD");
		const head = commitWo(repo, "WO-2026-801");
		const r = runHook(repo, [line("refs/heads/main", head, "refs/heads/main", base)]);
		expect(r.code).toBe(0);
	});

	it("does not scan refs when the push adds no work-orders file", () => {
		const repo = makeRepo();
		const base = git(repo, "rev-parse", "HEAD");
		commitWo(repo, "WO-2026-802");
		git(repo, "branch", "held", "HEAD");
		git(repo, "reset", "-q", "--hard", base);
		fs.writeFileSync(path.join(repo, "code.txt"), "y\n");
		git(repo, "add", "code.txt");
		git(repo, "commit", "-q", "-m", "code only");
		const head = git(repo, "rev-parse", "HEAD");
		// A `git` that logs its own invocations: the scan is `ls-tree`/`for-each-ref` work.
		const shim = path.join(repo, "gitlog");
		fs.mkdirSync(shim);
		const log = path.join(repo, "git-calls.log");
		// Absolute path: a shim that resolves `git` through PATH re-enters itself and hangs.
		fs.writeFileSync(path.join(shim, "git"), `#!/bin/bash\necho "$@" >> ${log}\nexec ${REAL_GIT} "$@"\n`);
		fs.chmodSync(path.join(shim, "git"), 0o755);
		const r = spawnSync("bash", [HOOK], {
			cwd: repo,
			input: line("refs/heads/main", head, "refs/heads/main", base) + "\n",
			encoding: "utf-8",
			env: { ...process.env, PATH: `${shim}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: "/dev/null" },
		});
		expect(r.status).toBe(0);
		const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf-8") : "";
		expect(calls).not.toContain("for-each-ref");
		expect(calls).not.toContain("ls-tree");
	});
});
