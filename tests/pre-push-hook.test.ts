/**
 * `bin/pre-push` — the two landing refusals (pi-config#20, owner ruling 2026-11-18, option A).
 *
 * The hook is bash, and these rows drive the real script rather than a TS re-implementation:
 * what is pinned is what git runs on a push. Each row takes a branch of a shared fixture repo,
 * because a repo per row costs the always-on gate far more than the assertions are worth.
 *
 * Run: bun test tests/pre-push-hook.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
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

let repo = "";

function git(...args: string[]): string {
	return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
		cwd: repo,
		encoding: "utf-8",
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
	}).trim();
}

function commitWo(id: string, note = ""): string {
	fs.mkdirSync(path.join(repo, "work-orders"), { recursive: true });
	fs.writeFileSync(path.join(repo, "work-orders", `${id}-demo.md`), `# demo ${note}\n`);
	git("add", "-A");
	git("commit", "-q", "-m", `add ${id} ${note}`);
	return git("rev-parse", "HEAD");
}

function runHook(lines: string[]): { code: number; stderr: string; stdout: string } {
	const r = spawnSync("bash", [HOOK], {
		cwd: repo,
		input: lines.join("\n") + (lines.length ? "\n" : ""),
		encoding: "utf-8",
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
	});
	return { code: r.status ?? -1, stderr: r.stderr ?? "", stdout: r.stdout ?? "" };
}

const line = (localRef: string, localSha: string, remoteRef: string, remoteSha: string) =>
	`${localRef} ${localSha} ${remoteRef} ${remoteSha}`;

/** A branch at `from` carrying nothing new, for rows that need a second ref holding the same id. */
function branchAt(name: string, from: string) {
	git("branch", "-f", name, from);
}

beforeAll(() => {
	repo = fs.mkdtempSync(path.join(os.tmpdir(), "pre-push-"));
	git("init", "-q", "-b", "main");
	fs.writeFileSync(path.join(repo, "README.md"), "x\n");
	git("add", "-A");
	git("commit", "-q", "-m", "init");
});

afterAll(() => {
	if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

describe("rule (A): a mainline push must be HEAD", () => {
	it("refuses a mainline push whose local sha is not HEAD, naming both", () => {
		const head = git("rev-parse", "HEAD");
		const other = git("commit-tree", "HEAD^{tree}", "-p", head, "-m", "elsewhere");
		const r = runHook([line("refs/heads/main", other, "refs/heads/main", head)]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain(other);
		expect(r.stderr).toContain(head);
		expect(r.stderr).toContain("NOT LANDED");
	});

	it("passes a mainline push that is HEAD", () => {
		const head = git("rev-parse", "HEAD");
		const r = runHook([line("refs/heads/main", head, "refs/heads/main", head)]);
		expect(r.code).toBe(0);
		expect(r.stderr).toBe("");
	});

	it("passes a side-branch push from a checkout on another commit", () => {
		const head = git("rev-parse", "HEAD");
		const side = git("commit-tree", "HEAD^{tree}", "-p", head, "-m", "side");
		const r = runHook([line("refs/heads/side", side, "refs/heads/side", ZERO)]);
		expect(r.code).toBe(0);
	});

	it("refuses a detached HEAD landing even when the sha is a real commit", () => {
		const head = git("rev-parse", "HEAD");
		git("checkout", "-q", "--detach", head);
		const ahead = git("commit-tree", "HEAD^{tree}", "-p", head, "-m", "ahead");
		const r = runHook([line("refs/heads/main", ahead, "refs/heads/main", head)]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("HEAD is");
		git("checkout", "-q", "main");
	});

	it("passes when a push has nothing to push from an attached HEAD", () => {
		expect(runHook([])).toMatchObject({ code: 0, stderr: "" });
	});

	it("passes a detached HEAD that is still on the mainline's history", () => {
		const older = git("rev-parse", "HEAD");
		fs.writeFileSync(path.join(repo, "moved.txt"), "m\n");
		git("add", "-A");
		git("commit", "-q", "-m", "main moves");
		const mainSha = git("rev-parse", "HEAD");
		git("checkout", "-q", "--detach", older);
		const r = runHook([]);
		git("checkout", "-q", "main");
		expect(mainSha).not.toBe(older);
		expect(r).toMatchObject({ code: 0, stderr: "" });
	});

	it("refuses an empty push from a detached HEAD off the mainline, naming HEAD", () => {
		// Rule (A2): the WO-2026-102 incident. The reachable shape is an explicit refspec whose
		// target is already current (`git push origin main` while detached) — git proceeds, sends
		// the hook nothing, and reports "Everything up-to-date". A bare `git push` from a detached
		// HEAD never reaches the hook: git exits 128 before it runs.
		const mainSha = git("rev-parse", "HEAD");
		git("checkout", "-q", "--detach");
		git("commit", "-q", "--allow-empty", "-m", "stranded");
		const stranded = git("rev-parse", "HEAD");
		const r = runHook([]);
		git("checkout", "-q", "main");
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("NOT LANDED");
		expect(r.stderr).toContain(stranded);
		expect(r.stderr).toContain(mainSha);
	});
});

describe("rule (B): a work-orders id no live ref holds", () => {
	it("refuses an id a live ref already holds, naming the ref", () => {
		const base = git("rev-parse", "HEAD");
		const heldTip = commitWo("WO-2026-800");
		branchAt("rival", heldTip);
		git("reset", "-q", "--hard", base);
		const head = commitWo("WO-2026-800", "rival-copy");
		const r = runHook([line("refs/heads/main", head, "refs/heads/main", base)]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("WO-2026-800 is already held by refs/heads/rival");
	});

	it("passes an id no ref holds", () => {
		const base = git("rev-parse", "HEAD");
		const head = commitWo("WO-2026-801");
		const r = runHook([line("refs/heads/main", head, "refs/heads/main", base)]);
		expect(r.code).toBe(0);
	});

	it("passes the first push of an alias branch, whose ids other refs all hold", () => {
		// bug-triage's repro: a new ref whose tree's ids are held by refs on other commits.
		// Nothing new is claimed, so nothing may be refused — this row is red under a
		// whole-tree measure of what a new ref "adds".
		const featTip = commitWo("WO-2026-810");
		fs.writeFileSync(path.join(repo, "code.txt"), "y\n");
		git("add", "-A");
		git("commit", "-q", "-m", "main moves on");
		branchAt("rival810", featTip);
		const r = runHook([line("refs/heads/feat", featTip, "refs/heads/feat", ZERO)]);
		expect(r.code).toBe(0);
		expect(r.stderr).toBe("");
	});

	it("passes the first push of a branch that adds an id no ref holds", () => {
		const base = git("rev-parse", "HEAD");
		const head = commitWo("WO-2026-811");
		const r = runHook([line("refs/heads/feat811", head, "refs/heads/feat811", ZERO)]);
		expect(r.code).toBe(0);
		expect(base).not.toBe(head);
	});

	it("refuses a new branch that reuses an id another ref holds", () => {
		const base = git("rev-parse", "HEAD");
		const heldTip = commitWo("WO-2026-812");
		branchAt("rival812", heldTip);
		git("reset", "-q", "--hard", base);
		const head = commitWo("WO-2026-812", "dup");
		const r = runHook([line("refs/heads/feat812", head, "refs/heads/feat812", ZERO)]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("WO-2026-812 is already held by refs/heads/rival812");
	});

	it("does not scan refs when the push adds no work-orders file", () => {
		const base = git("rev-parse", "HEAD");
		commitWo("WO-2026-820");
		branchAt("rival820", "HEAD");
		git("reset", "-q", "--hard", base);
		fs.writeFileSync(path.join(repo, "code.txt"), "z\n");
		git("add", "-A");
		git("commit", "-q", "-m", "code only");
		const head = git("rev-parse", "HEAD");
		// A `git` that logs its own invocations: the id scan is `for-each-ref`/`ls-tree` work.
		const shim = fs.mkdtempSync(path.join(os.tmpdir(), "pre-push-shim-"));
		const log = path.join(shim, "git-calls.log");
		// Absolute path: a shim resolving `git` through PATH re-enters itself and hangs.
		fs.writeFileSync(path.join(shim, "git"), `#!/bin/bash\necho "$@" >> ${log}\nexec ${REAL_GIT} "$@"\n`);
		fs.chmodSync(path.join(shim, "git"), 0o755);
		const r = spawnSync("bash", [HOOK], {
			cwd: repo,
			input: line("refs/heads/main", head, "refs/heads/main", base) + "\n",
			encoding: "utf-8",
			env: { ...process.env, PATH: `${shim}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: "/dev/null" },
		});
		fs.rmSync(shim, { recursive: true, force: true });
		expect(r.status).toBe(0);
		const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf-8") : "";
		expect(calls).not.toContain("for-each-ref");
		expect(calls).not.toContain("ls-tree");
	});
});
