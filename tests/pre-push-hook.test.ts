/**
 * `bin/pre-push` — the three landing refusals (pi-config#20, owner ruling 2026-11-18, option A).
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
	git("config", "pi.mainline", "main");
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

	it("takes the mainline from the repo, not a literal (tfd's is hamster)", () => {
		// H2: with the mainline configured as hamster, a `hamster` line that is not HEAD is
		// refused and a `main` line is not the mainline at all.
		const head = git("rev-parse", "HEAD");
		const other = git("commit-tree", "HEAD^{tree}", "-p", head, "-m", "elsewhere");
		git("config", "pi.mainline", "hamster");
		const hamster = runHook([line("refs/heads/hamster", other, "refs/heads/hamster", head)]);
		const onMain = runHook([line("refs/heads/main", other, "refs/heads/main", head)]);
		git("config", "pi.mainline", "main");
		expect(hamster.code).toBe(1);
		expect(hamster.stderr).toContain("refs/heads/hamster");
		expect(onMain.code).toBe(0);
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

describe("rule (C): the previous tip stays on the first-parent line", () => {
	// Each row starts from main and leaves the repo on main. Files are unique per row, so a merge
	// conflict is never the verdict.
	function commitFile(name: string): string {
		fs.writeFileSync(path.join(repo, name), `${name}\n`);
		git("add", "-A");
		git("commit", "-q", "-m", `add ${name}`);
		return git("rev-parse", "HEAD");
	}

	it("refuses a merge of the remote tip into local work, naming both shas", () => {
		git("checkout", "-q", "main");
		git("checkout", "-q", "-b", "local-c1");
		commitFile("c1-local.txt");
		git("checkout", "-q", "main");
		const remoteTip = commitFile("c1-remote.txt");
		git("checkout", "-q", "local-c1");
		git("merge", "-q", "--no-ff", "-m", "merge remote into local", "main");
		const tip = git("rev-parse", "HEAD");
		const r = runHook([line("refs/heads/main", tip, "refs/heads/main", remoteTip)]);
		git("checkout", "-q", "main");
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("NOT LANDED");
		expect(r.stderr).toContain(remoteTip);
		expect(r.stderr).toContain(tip);
		// The shape by name: a repo that imports this gate (tfd) asserts the refusal from here,
		// so the wording carries the vocabulary its own check used to (decisions/sessions/004).
		expect(r.stderr).toContain("foxtrot merge");
		expect(r.stderr).toContain("first-parent line");
	});

	it("refuses a force-push that rewinds the mainline to an ancestor", () => {
		// The push a `--force` rewind makes: the local mainline moved back to an ancestor, so the
		// mainline line is HEAD and rule (A) passes. The old tip still reaches every commit the
		// pushed tip does, so the first-parent span is empty — the case that used to fall through.
		git("checkout", "-q", "main");
		const first = commitFile("c3-a.txt");
		const old = commitFile("c3-b.txt");
		git("checkout", "-q", "-B", "main", first);
		const r = runHook([line("refs/heads/main", first, "refs/heads/main", old)]);
		git("checkout", "-q", "-B", "main", old);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("rewinds");
		expect(r.stderr).toContain(old);
		expect(r.stderr).toContain(first);
	});

	it("passes direct commits rebased on top of the previous tip", () => {
		git("checkout", "-q", "main");
		const old = git("rev-parse", "HEAD");
		commitFile("c2-a.txt");
		const tip = commitFile("c2-b.txt");
		const r = runHook([line("refs/heads/main", tip, "refs/heads/main", old)]);
		expect(r).toMatchObject({ code: 0, stderr: "" });
	});

	it("passes a --no-ff merge made from the previous tip, with a mainline merge inside the branch", () => {
		git("checkout", "-q", "main");
		const base = git("rev-parse", "HEAD");
		git("checkout", "-q", "-b", "feat3", base);
		commitFile("f3-work.txt");
		git("checkout", "-q", "main");
		const old = commitFile("f3-main.txt");
		git("checkout", "-q", "feat3");
		git("merge", "-q", "--no-ff", "-m", "feat3 takes main", "main");
		git("checkout", "-q", "main");
		git("merge", "-q", "--no-ff", "-m", "land feat3", "feat3");
		const tip = git("rev-parse", "HEAD");
		const r = runHook([line("refs/heads/main", tip, "refs/heads/main", old)]);
		expect(r).toMatchObject({ code: 0, stderr: "" });
	});

	it("passes a push that creates the mainline ref", () => {
		git("checkout", "-q", "main");
		const tip = commitFile("c4.txt");
		const r = runHook([line("refs/heads/main", tip, "refs/heads/main", ZERO)]);
		expect(r).toMatchObject({ code: 0, stderr: "" });
	});

	it("passes a side-branch push of the same foxtrot shape, since the rule is mainline-only", () => {
		git("checkout", "-q", "main");
		git("checkout", "-q", "-b", "local-c5");
		commitFile("c5-local.txt");
		git("checkout", "-q", "main");
		const remote = commitFile("c5-remote.txt");
		git("checkout", "-q", "local-c5");
		git("merge", "-q", "--no-ff", "-m", "merge main into side", "main");
		const tip = git("rev-parse", "HEAD");
		git("checkout", "-q", "main");
		const r = runHook([line("refs/heads/side5", tip, "refs/heads/side5", remote)]);
		expect(r).toMatchObject({ code: 0, stderr: "" });
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
		expect(r.stderr).toContain("WO-2026-800 is already held by rival");
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
		expect(r.stderr).toContain("WO-2026-812 is already held by rival812");
	});

	it("passes a merge that lands the branch which added the id", () => {
		// H3: reserve-then-dispatch pushes the branch, then `merge --no-ff` lands it. The id is
		// "added" against main's old tip, but `feat` is the lineage being landed, not a rival.
		const base = git("rev-parse", "HEAD");
		git("checkout", "-q", "-b", "feat833");
		const featTip = commitWo("WO-2026-833", "feat");
		git("checkout", "-q", "main");
		git("merge", "-q", "--no-ff", "-m", "merge feat833", "feat833");
		const head = git("rev-parse", "HEAD");
		const r = runHook([line("refs/heads/main", head, "refs/heads/main", base)]);
		expect(r.code).toBe(0);
		expect(featTip).not.toBe(head);
	});

	it("passes a branch that merged the mainline, whose ids main already holds", () => {
		const mainWo = commitWo("WO-2026-834", "on main");
		git("checkout", "-q", "-b", "side834", mainWo);
		fs.writeFileSync(path.join(repo, "side.txt"), "s\n");
		git("add", "-A");
		git("commit", "-q", "-m", "side work");
		git("merge", "-q", "--no-ff", "-m", "merge main", "main");
		const sideTip = git("rev-parse", "HEAD");
		const r = runHook([line("refs/heads/side834", sideTip, "refs/heads/side834", ZERO)]);
		expect(r.code).toBe(0);
	});

	it("refuses a renumbered file that lands on a held id", () => {
		// M1: the reserve step renumbers by renaming. The source has to exist at the remote tip
		// for this to be a rename at all, so the row pushes twice: the branch first holds its own
		// id, then renumbers onto one another line holds. With rename detection the new path is R,
		// not A, and the id slips through; `--no-renames` makes it an add.
		const base = git("rev-parse", "HEAD");
		const heldTip = commitWo("WO-2026-835", "held");
		git("branch", "-f", "rival835", heldTip);
		git("reset", "-q", "--hard", base);
		const pushed = commitWo("WO-2026-836", "slug");
		git("mv", "work-orders/WO-2026-836-demo.md", "work-orders/WO-2026-835-demo.md");
		git("commit", "-q", "-m", "renumber into a held id");
		const head = git("rev-parse", "HEAD");
		const r = runHook([line("refs/heads/main", head, "refs/heads/main", pushed)]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("WO-2026-835 is already held by rival835");
	});

	it("fails hard when the pushed old tip is not in this clone", () => {
		// M2: an unfetched remote tip made `git diff` fail, and the failure read as "nothing
		// added". A force push then lands an unchecked id. Abort instead.
		const head = git("rev-parse", "HEAD");
		const absent = "1234567890123456789012345678901234567890";
		const r = runHook([line("refs/heads/main", head, "refs/heads/main", absent)]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("cannot diff");
	});

	it("fails hard when pi.mainline is not set", () => {
		// H2/M3: no literal fallback, and no silent pass when the mainline ref is absent.
		const head = git("rev-parse", "HEAD");
		const mainline = git("config", "pi.mainline");
		git("config", "--unset", "pi.mainline");
		const r = runHook([line("refs/heads/main", head, "refs/heads/main", head)]);
		git("config", "pi.mainline", mainline);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("pi.mainline is not set");
	});

	it("fails hard when the local mainline ref is missing, rather than passing", () => {
		const head = git("rev-parse", "HEAD");
		git("checkout", "-q", "--detach", head);
		const mainline = git("config", "pi.mainline");
		git("config", "pi.mainline", "no-such-mainline");
		const r = runHook([]);
		git("config", "pi.mainline", mainline);
		git("checkout", "-q", "main");
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("does not exist");
	});

	it("passes a ref delete, and refuses deleting the mainline with a message that says so", () => {
		const head = git("rev-parse", "HEAD");
		const del = runHook([line("(delete)", ZERO, "refs/heads/side-deleted", head)]);
		expect(del.code).toBe(0);
		const main = runHook([line("(delete)", ZERO, "refs/heads/main", head)]);
		expect(main.code).toBe(1);
		expect(main.stderr).toContain("deletes refs/heads/main");
	});

	it("ignores a tooling worktree's pseudo-ref holding the same id", () => {
		// tfd's validator materialises a worktree per push at the commit being landed; its
		// `refs/worktrees/*` pseudo-ref then holds the id the push is adding, and refused tfd's
		// own retry (WO-2026-525). The worktree must be detached at a commit no branch reaches —
		// that is the state where git lists it as a source.
		const base = git("rev-parse", "HEAD");
		const heldTip = commitWo("WO-2026-840", "held");
		git("reset", "-q", "--hard", base);
		git("worktree", "add", "--detach", path.join(repo, "wt-840"), heldTip);
		const head = commitWo("WO-2026-840", "fresh");
		const r = runHook([line("refs/heads/main", head, "refs/heads/main", base)]);
		expect(r.code).toBe(0);
		expect(r.stderr).toBe("");
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
