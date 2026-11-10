/**
 * WO-2026-092: one reaper for every checkout under `~/Developer/wt`.
 *
 * One row per Verification criterion of the order, each against a real git
 * fixture in a temp home — a repo with an origin, worktrees of it, standalone
 * clones, scratch directories and the row's own shared cargo dir. Nothing in
 * this file reads or writes the box's real `~/Developer/wt`,
 * `~/.cache/cargo-target` or process table: the home, the root and the `lsof`
 * cwd probe are all injected, and the reap removes only inside the temp home.
 *
 * The removal path is 091's real `removeWorktreeTree`, so R1's "tree, branch,
 * target and cache attribution all gone" is the production sequence, not a
 * stand-in.
 *
 * Run: bun test tests/checkout-reaper.test.ts
 */

import { afterAll, afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	formatReport,
	IDLE_DAYS,
	parseStatus,
	lsofProcessCwds,
	readReaperReport,
	reapCheckouts,
	_testSetReaperHome,
	reportPath,
	summarizeReport,
	walkCheckouts,
	wtRoots,
	type ProcessCwd,
	type ReaperReport,
} from "../extensions/lib/checkout-reaper.ts";
import subagentFactory, { removeWorktreeTree } from "../extensions/subagent-async/index.ts";
import { addWorktree, backdate, gitDirOf, makeRepo, mustGit } from "./helpers/reaper-fixtures.ts";
import { scrubSubagentEnv } from "./helpers/subagent-env.ts";

// Real git fixtures on a loaded box: clone, worktree add, push and a walk
// that back-dates every mtime all cost more than the 5 s default.
setDefaultTimeout(30_000);

const restoreEnv = scrubSubagentEnv();
afterAll(() => restoreEnv());

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function tempHome(): string {
	const home = mkdtempSync(join(tmpdir(), "pi-reaper-"));
	homes.push(home);
	return home;
}

function roots(home: string): { root: string; subagentBase: string } {
	const root = join(home, "Developer", "wt");
	const subagentBase = join(root, "subagents");
	mkdirSync(subagentBase, { recursive: true });
	return { root, subagentBase };
}

/** Seed one clone's shared cargo dir the way a build of `worktreePath` leaves
 *  it: a `.d` naming the tree in a source rule, the artifacts under its stem,
 *  and its `.fingerprint` / `build` dirs. */
function seedSharedDir(
	home: string,
	repoName: string,
	worktreePath: string,
	opts: { alsoNames?: string } = {},
): { release: string; stem: string; depInfo: string } {
	const release = join(home, ".cache", "cargo-target", repoName, "release");
	mkdirSync(release, { recursive: true });
	const sources = [join(worktreePath, "src", "lib.rs"), ...(opts.alsoNames ? [join(opts.alsoNames, "src", "lib.rs")] : [])];
	const stem = "mypkg-0123456789abcdef";
	const depInfo = join(release, `${stem}.d`);
	writeFileSync(depInfo, `${join(release, "mypkg")}: ${sources.join(" ")}\n`);
	for (const artifact of [`${stem}.rmeta`, `lib${stem}.rlib`, `${stem}`]) writeFileSync(join(release, artifact), "x");
	mkdirSync(join(home, ".cache", "cargo-target", repoName, "release", ".fingerprint", stem), { recursive: true });
	mkdirSync(join(home, ".cache", "cargo-target", repoName, "release", "build", stem), { recursive: true });
	return { release, stem, depInfo };
}

// ── The reap, as the session runs it ───────────────────────────────────────

const noProcesses = async (): Promise<{ cwds: ProcessCwd[]; problem: string | null }> => ({ cwds: [], problem: null });

interface ReapFixture {
	home: string;
	root: string;
	subagentBase: string;
}

function fixture(): ReapFixture {
	const home = tempHome();
	return { home, ...roots(home) };
}

function reap(
	f: ReapFixture,
	extra: Partial<Parameters<typeof reapCheckouts>[0]> = {},
): Promise<{ report: ReaperReport; reportPath: string }> {
	return reapCheckouts({
		root: f.root,
		subagentBase: f.subagentBase,
		home: f.home,
		budgetMs: 60_000,
		removeWorktree: (deps, rs, policy) => removeWorktreeTree(deps, rs, policy),
		listCwds: noProcesses,
		...extra,
	});
}

function rowFor(report: ReaperReport, path: string) {
	return [...report.removed, ...report.kept, ...report.deferred].find((row) => row.path === path);
}

/** Assert a mutation turns the row red: `probe` runs the row's own check against
 *  a mutated module state and returns the verdict string it would produce. */
function verdictOf(row: { state: string; gate: string | null } | undefined): string {
	return row ? `${row.state}:${row.gate ?? "-"}` : "absent";
}

// ── R1 ─────────────────────────────────────────────────────────────────────

describe("R1 — clean, merged, idle, unused worktree", () => {
	it("removes the tree, its branch, its target and its cache attribution", async () => {
		const f = fixture();
		const { repo } = makeRepo(f.home);
		const tree = join(f.subagentBase, `myrepo-aaaaaaaaaaaa`);
		addWorktree(repo, tree, "wt-r1");
		mkdirSync(join(tree, "target", "debug"), { recursive: true });
		writeFileSync(join(tree, "target", "debug", "out"), "x".repeat(4096));
		const shared = seedSharedDir(f.home, "myrepo", tree);
		backdate(gitDirOf(tree));
		backdate(tree);

		const { report } = await reap(f);
		const row = rowFor(report, tree);

		expect(row?.state).toBe("removed");
		expect(row?.removed?.branchDeleted).toBe("wt-r1");
		expect(existsSync(tree)).toBe(false);
		expect(mustGit(repo, ["branch", "--list", "wt-r1"]).trim()).toBe("");
		expect(mustGit(repo, ["worktree", "list", "--porcelain"])).not.toContain(tree);
		// Cache attribution: the `.d` naming the tree, its artifacts, its
		// `.fingerprint` and `build` dirs are all gone (091's route 1).
		expect(existsSync(shared.depInfo)).toBe(false);
		expect(existsSync(join(shared.release, `${shared.stem}.rmeta`))).toBe(false);
		expect(existsSync(join(shared.release, `${shared.stem}`))).toBe(false);
		expect(existsSync(join(f.home, ".cache", "cargo-target", "myrepo", "release", ".fingerprint", shared.stem))).toBe(false);
		// Gate 3's bytes: the ignored target/ dies with the tree, and the row
		// names the bytes it cost (the tree itself is gone, so 091's M1 finds no
		// target left to drop — the removal took it).
		expect(row?.unsaved?.ignoredBytes ?? 0).toBeGreaterThan(0);
		expect(row?.removed?.buildOutput ?? "").toContain("exact");
	});

	it("the same fixture kept by the idle gate (mutation) is not removable", async () => {
		// Mutation for R1: the removal-time mtime check (gate 5's second half) is
		// what makes it idle. Touch one file in the tree and the row reds to
		// `kept:active` while every other gate still holds.
		const f = fixture();
		const { repo } = makeRepo(f.home);
		const tree = join(f.subagentBase, `myrepo-aaaaaaaaaaaa`);
		addWorktree(repo, tree, "wt-r1");
		backdate(tree);
		// Clean and pushed, but one tracked file changed a moment ago while the
		// metadata was back-dated: the tree's own mtime is what the idle gate reads.
		writeFileSync(join(tree, "seed.txt"), "edited just now\n");
		mustGit(tree, ["add", "-A"]);
		mustGit(tree, ["commit", "-q", "-m", "fresh"]);
		mustGit(repo, ["push", "-q", "origin", "refs/heads/wt-r1:refs/heads/wt-r1"]);
		backdate(gitDirOf(tree));

		const { report } = await reap(f);
		const row = rowFor(report, tree);
		expect(verdictOf(row)).toBe("kept:active");
		expect(row?.unsaved?.newestFileDays ?? NaN).toBeLessThan(IDLE_DAYS);
		expect(existsSync(tree)).toBe(true);
	});
});

// ── R2 ─────────────────────────────────────────────────────────────────────

describe("R2 — a dirty worktree", () => {
	it("is kept and reported with its file count", async () => {
		const f = fixture();
		const { repo } = makeRepo(f.home);
		const tree = join(f.subagentBase, "myrepo-bbbbbbbbbbbb");
		addWorktree(repo, tree, "wt-r2");
		writeFileSync(join(tree, "untracked.txt"), "work\n");
		writeFileSync(join(tree, "seed.txt"), "modified\n");
		backdate(gitDirOf(tree));

		const { report } = await reap(f);
		const row = rowFor(report, tree);
		expect(verdictOf(row)).toBe("kept:dirty");
		expect(row?.unsaved?.dirtyFiles).toBe(2);
		expect(existsSync(tree)).toBe(true);
		// Mutation: the clean gate is what keeps it. Report the same row through
		// the dirty counter to show the count came from git, not from a default.
		expect(formatReport(report)).toContain("2 dirty");
	});
});

// ── R3 ─────────────────────────────────────────────────────────────────────

describe("R3 — an unpushed commit", () => {
	it("is kept, and the report names the branch and the count", async () => {
		const f = fixture();
		const { repo } = makeRepo(f.home);
		const tree = join(f.subagentBase, "myrepo-cccccccccccc");
		addWorktree(repo, tree, "wt-r3", { push: false });
		writeFileSync(join(tree, "work.txt"), "unpushed\n");
		mustGit(tree, ["add", "-A"]);
		mustGit(tree, ["commit", "-q", "-m", "work only here"]);
		backdate(gitDirOf(tree));
		backdate(tree);

		const { report } = await reap(f);
		const row = rowFor(report, tree);
		expect(verdictOf(row)).toBe("kept:unpushed");
		expect(row?.unsaved?.unpushedCommits).toBe(1);
		expect(row?.unsaved?.unpushedBranches).toEqual(["wt-r3"]);
		expect(existsSync(tree)).toBe(true);
	});
});

// ── R4 ─────────────────────────────────────────────────────────────────────

describe("R4 — a merged branch beside one that exists only locally", () => {
	it("keeps a clone whose other branch holds the only copy of a commit", async () => {
		const f = fixture();
		const { repo } = makeRepo(f.home, "clone-r4");
		const clone = join(f.root, "clone-r4");
		mustGit(f.home, ["clone", "-q", repo, clone]);
		mustGit(clone, ["config", "user.email", "test@example.com"]);
		mustGit(clone, ["config", "user.name", "Test"]);
		mustGit(clone, ["checkout", "-q", "-b", "wip"]);
		writeFileSync(join(clone, "wip.txt"), "only here\n");
		mustGit(clone, ["add", "-A"]);
		mustGit(clone, ["commit", "-q", "-m", "local only"]);
		// HEAD is back where the remote holds it; the work is on `wip`.
		mustGit(clone, ["checkout", "-q", "main"]);
		backdate(join(clone, ".git"));
		backdate(clone);

		const { report } = await reap(f);
		const row = rowFor(report, clone);
		expect(verdictOf(row)).toBe("kept:unpushed");
		expect(row?.unsaved?.unpushedBranches).toEqual(["wip"]);
		expect(existsSync(clone)).toBe(true);
	});

	it("keeps a clone left on a detached HEAD whose commit no branch names", async () => {
		// `--branches` alone starts from `refs/heads/*`, so a clone left on a
		// detached HEAD would look fully pushed and be deleted with the commit.
		const f = fixture();
		const { repo } = makeRepo(f.home, "clone-detached");
		const clone = join(f.root, "clone-detached");
		mustGit(f.home, ["clone", "-q", repo, clone]);
		mustGit(clone, ["config", "user.email", "test@example.com"]);
		mustGit(clone, ["config", "user.name", "Test"]);
		mustGit(clone, ["checkout", "-q", "--detach", "main"]);
		writeFileSync(join(clone, "detached.txt"), "only here\n");
		mustGit(clone, ["add", "-A"]);
		mustGit(clone, ["commit", "-q", "-m", "no branch names this"]);
		backdate(join(clone, ".git"));
		backdate(clone);

		const { report } = await reap(f);
		const row = rowFor(report, clone);
		expect(verdictOf(row)).toBe("kept:unpushed");
		expect(row?.unsaved?.unpushedCommits).toBe(1);
		expect(row?.unsaved?.unpushedBranches).toEqual(["HEAD"]);
		expect(existsSync(clone)).toBe(true);
	});

	it("keeps a clone whose only ref to a commit is a local tag", async () => {
		// `--tags` is a decision, not an accident: a tag can be a commit's only
		// ref, so leaving tags out would delete the commit with the clone.
		const f = fixture();
		const { repo } = makeRepo(f.home, "clone-tagged");
		const clone = join(f.root, "clone-tagged");
		mustGit(f.home, ["clone", "-q", repo, clone]);
		mustGit(clone, ["config", "user.email", "test@example.com"]);
		mustGit(clone, ["config", "user.name", "Test"]);
		mustGit(clone, ["checkout", "-q", "--detach", "main"]);
		writeFileSync(join(clone, "tagged.txt"), "only here\n");
		mustGit(clone, ["add", "-A"]);
		mustGit(clone, ["commit", "-q", "-m", "released here only"]);
		const sha = mustGit(clone, ["rev-parse", "HEAD"]).trim();
		mustGit(clone, ["checkout", "-q", "main"]);
		mustGit(clone, ["tag", "release-only", sha]);
		backdate(join(clone, ".git"));
		backdate(clone);

		const { report } = await reap(f);
		const row = rowFor(report, clone);
		expect(verdictOf(row)).toBe("kept:unpushed");
		expect(row?.unsaved?.unpushedBranches).toEqual(["release-only"]);
		expect(existsSync(clone)).toBe(true);
	});
});

// ── R5 ─────────────────────────────────────────────────────────────────────

describe("R5 — a process whose cwd is inside", () => {
	it("is kept, and the report names the pid", async () => {
		const f = fixture();
		const { repo } = makeRepo(f.home);
		const tree = join(f.subagentBase, "myrepo-dddddddddddd");
		addWorktree(repo, tree, "wt-r5");
		backdate(gitDirOf(tree));
		backdate(tree);

		const { report } = await reap(f, {
			listCwds: async () => ({ cwds: [{ pid: 4321, cwd: join(tree, "src") }], problem: null }),
		});
		const row = rowFor(report, tree);
		expect(verdictOf(row)).toBe("kept:in-use");
		expect(row?.unsaved?.pid).toBe(4321);
		expect(existsSync(tree)).toBe(true);
		// Mutation: the same fixture with no cwd inside is removable, so the pid
		// is what kept it.
		const { report: clean } = await reap(f);
		expect(verdictOf(rowFor(clean, tree))).toBe("removed:-");
	});

	it("keeps everything when lsof itself is unavailable", async () => {
		const f = fixture();
		const { repo } = makeRepo(f.home);
		const tree = join(f.subagentBase, "myrepo-ddddddddddd2");
		addWorktree(repo, tree, "wt-r5b");
		backdate(gitDirOf(tree));
		backdate(tree);
		const { report } = await reap(f, {
			listCwds: async () => ({ cwds: [], problem: "lsof -d cwd failed: exit 1" }),
		});
		expect(verdictOf(rowFor(report, tree))).toBe("kept:no-cwd-evidence");
		expect(report.problems.join()).toContain("lsof -d cwd failed");
		expect(existsSync(tree)).toBe(true);
	});
});

// ── R6 ─────────────────────────────────────────────────────────────────────

describe("R6 — a checkout active inside the window", () => {
	it("is kept and not listed as actionable", async () => {
		const f = fixture();
		const { repo } = makeRepo(f.home);
		const tree = join(f.subagentBase, "myrepo-eeeeeeeeeeee");
		addWorktree(repo, tree, "wt-r6"); // fresh: no backdate

		const { report } = await reap(f);
		const row = rowFor(report, tree);
		expect(verdictOf(row)).toBe("kept:active");
		// The age screen is what stopped it, not the removal-time mtime walk: the
		// row carries no "a file changed" detail.
		expect(row?.detail).toBeUndefined();
		expect(existsSync(tree)).toBe(true);
		const text = formatReport(report);
		expect(text).toContain("active, not actionable (1)");
		expect(text).not.toMatch(/kept \(\d+\):\n.*myrepo-eeeeeeeeeeee/);
		expect(summarizeReport(report)).not.toContain("active");
	});
});

// ── R7 / R8 ────────────────────────────────────────────────────────────────

describe("R7 — a standalone clone that is fully pushed and idle", () => {
	it("is removed whole", async () => {
		const f = fixture();
		const { repo } = makeRepo(f.home, "clone-r7");
		const clone = join(f.root, "clone-r7");
		mustGit(f.home, ["clone", "-q", repo, clone]);
		backdate(join(clone, ".git"));
		backdate(clone);

		const { report } = await reap(f);
		const row = rowFor(report, clone);
		expect(row?.state).toBe("removed");
		expect(row?.removed?.branchDeleted).toBe("main");
		expect(existsSync(clone)).toBe(false);
	});
});

describe("R8 — a standalone clone with an unpushed commit", () => {
	it("is kept", async () => {
		const f = fixture();
		const { repo } = makeRepo(f.home, "clone-r8");
		const clone = join(f.root, "clone-r8");
		mustGit(f.home, ["clone", "-q", repo, clone]);
		mustGit(clone, ["config", "user.email", "test@example.com"]);
		mustGit(clone, ["config", "user.name", "Test"]);
		writeFileSync(join(clone, "local.txt"), "only here\n");
		mustGit(clone, ["add", "-A"]);
		mustGit(clone, ["commit", "-q", "-m", "local"]);
		backdate(join(clone, ".git"));
		backdate(clone);

		const { report } = await reap(f);
		const row = rowFor(report, clone);
		expect(verdictOf(row)).toBe("kept:unpushed");
		expect(row?.unsaved?.unpushedCommits).toBe(1);
		expect(existsSync(clone)).toBe(true);
	});
});

// ── R9 ─────────────────────────────────────────────────────────────────────

describe("R9 — a non-git scratch directory", () => {
	it("is reported with its size and never deleted", async () => {
		const f = fixture();
		const scratch = join(f.root, "probes");
		mkdirSync(join(scratch, "deep"), { recursive: true });
		writeFileSync(join(scratch, "deep", "notes.md"), "x".repeat(4096));

		const { report } = await reap(f);
		const row = rowFor(report, scratch);
		expect(verdictOf(row)).toBe("kept:scratch");
		expect(row?.bytes ?? 0).toBeGreaterThan(0);
		expect(existsSync(join(scratch, "deep", "notes.md"))).toBe(true);
	});
});

// ── R10 ────────────────────────────────────────────────────────────────────

describe("R10 — a subagent tree 027 still holds", () => {
	it("is untouched: the namespace's gates are 027's, not the general walk's", async () => {
		const f = fixture();
		const { repo } = makeRepo(f.home);
		// A tree every general gate would remove: clean, pushed, idle, unused,
		// unlocked. 027's meta names it but reached no verdict — a meta whose child
		// has no terminal footer is skipped — so `subagentMetaPaths` is the only
		// thing that covers it here. A verdict for it would hide the handover.
		const held = join(f.subagentBase, "myrepo-ffffffffffff");
		addWorktree(repo, held, "pi-subagent-ffffffffffff");
		backdate(gitDirOf(held));
		backdate(held);
		// A tree 027 did decide: its verdict, not the general gates, is its row.
		const live = join(f.subagentBase, "myrepo-111111111111");
		addWorktree(repo, live, "pi-subagent-111111111111", { lock: true });
		backdate(gitDirOf(live));
		backdate(live);

		const { report } = await reap(f, {
			subagentMetaPaths: [held],
			subagentResults: [{ worktreePath: live, outcome: "kept-uncommitted" }],
			listCwds: async () => ({ cwds: [{ pid: 991, cwd: live }], problem: null }),
		});

		expect(verdictOf(rowFor(report, held))).toBe("kept:subagent");
		expect(rowFor(report, held)?.detail).toContain("held by 027's gates");
		expect(verdictOf(rowFor(report, live))).toBe("kept:subagent");
		expect(rowFor(report, live)?.detail).toContain("subagent kept-uncommitted");
		expect(existsSync(held)).toBe(true);
		expect(existsSync(live)).toBe(true);
		// R10's own mutation, one field at a time: with `subagentMetaPaths` dropped
		// and the verdict set kept, the general gates take the held tree. 027's
		// verdict for `live` cannot stand in for it — the two paths differ, which is
		// why dropping both fields together pinned neither.
		const { report: ungated } = await reap(f, {
			subagentResults: [{ worktreePath: live, outcome: "kept-uncommitted" }],
			listCwds: noProcesses,
		});
		expect(rowFor(ungated, held)?.state).toBe("removed");
	});

	it("judges no namespace checkout when 027's own reap failed", async () => {
		// A half-read meta set is not knowledge: the general pass reports the
		// subtree and decides none of it, even for a tree every gate would remove.
		const f = fixture();
		const { repo } = makeRepo(f.home);
		const tree = join(f.subagentBase, "myrepo-888888888888");
		addWorktree(repo, tree, "pi-subagent-888888888888");
		backdate(gitDirOf(tree));
		backdate(tree);

		const { report } = await reap(f, { subagentScopeFailed: true });
		const row = rowFor(report, tree);
		expect(verdictOf(row)).toBe("kept:subagent");
		expect(row?.detail).toContain("027's scan was incomplete");
		expect(existsSync(tree)).toBe(true);
	});
});

// ── R11 ────────────────────────────────────────────────────────────────────

describe("R11 — an empty report", () => {
	it("writes the file, so 'nothing held' is distinguishable from a stale report", async () => {
		const f = fixture();
		const { report } = await reap(f);
		const file = reportPath(f.root);
		expect(existsSync(file)).toBe(true);
		expect(report.removed).toEqual([]);
		expect(report.kept).toEqual([]); // the namespace dir is a scope, not a row
		const read = readReaperReport(f.root);
		expect(read?.generatedAt).toBe(report.generatedAt);
		expect(JSON.parse(readFileSync(file, "utf8")).budgetMs).toBe(60_000);
		expect(formatReport(report)).toContain("nothing held");
	});
});

// ── R12 ────────────────────────────────────────────────────────────────────

describe("R12 — a `.d` that names two worktrees", () => {
	it("names the live checkout whose copy the prune took", async () => {
		const f = fixture();
		const { repo } = makeRepo(f.home);
		const dead = join(f.subagentBase, "myrepo-222222222222");
		const live = join(f.subagentBase, "myrepo-333333333333");
		addWorktree(repo, dead, "pi-subagent-222222222222");
		addWorktree(repo, live, "pi-subagent-333333333333");
		// One `.d`, two owners: the shared unit the dead tree's removal takes with
		// it. The live tree is dirty, so only the dead one is reaped.
		const shared = seedSharedDir(f.home, "myrepo", dead, { alsoNames: live });
		writeFileSync(join(live, "uncommitted.txt"), "the live tree's work\n");
		backdate(gitDirOf(dead));
		backdate(dead);
		backdate(gitDirOf(live));

		const { report } = await reap(f);
		const row = rowFor(report, dead);
		expect(row?.state).toBe("removed");
		expect(row?.removed?.sharedWith?.length).toBe(1);
		expect(row?.removed?.sharedWith?.[0].depInfo).toBe(shared.depInfo);
		expect(row?.removed?.sharedWith?.[0].checkouts).toEqual([live]);
		// The take is real: the `.d` and the binary beside it are gone, and the
		// live tree is still there — it rebuilds.
		expect(existsSync(shared.depInfo)).toBe(false);
		expect(existsSync(join(shared.release, shared.stem))).toBe(false);
		expect(existsSync(live)).toBe(true);
		expect(formatReport(report)).toContain("also named");
	});
});

// ── R13 ────────────────────────────────────────────────────────────────────

describe("R13 — an orphaned worktree", () => {
	it("removes a directory whose .git names a gitdir that no longer exists", async () => {
		const f = fixture();
		const { repo } = makeRepo(f.home);
		const orphan = join(f.subagentBase, "wo-landing-repo-444444444444");
		addWorktree(repo, orphan, "wt-r13", { push: false });
		const gitdir = gitDirOf(orphan);
		writeFileSync(join(orphan, "seed.txt"), "stays\n");
		// The repository that owned it is gone: nothing can be preserved, nothing
		// can remove a worktree from it.
		rmSync(repo, { recursive: true, force: true });
		expect(existsSync(gitdir)).toBe(false);

		const { report } = await reap(f);
		const row = rowFor(report, orphan);
		expect(row?.state).toBe("removed");
		expect(row?.removed?.orphaned?.gitdir).toBe(gitdir);
		expect(existsSync(orphan)).toBe(false);
		// Not one of the ordinary rows: no branch, no build output, no gates.
		expect(row?.removed?.branchDeleted).toBeUndefined();
		expect(formatReport(report)).toContain("orphaned: no repository left to remove it from");
	});

	it("is never treated as orphaned when the gitdir exists", async () => {
		const f = fixture();
		const { repo } = makeRepo(f.home);
		const tree = join(f.subagentBase, "myrepo-555555555555");
		addWorktree(repo, tree, "wt-r13b", { push: false });
		backdate(gitDirOf(tree));
		backdate(tree);

		const { report } = await reap(f);
		// A real worktree whose branch holds the only copy of nothing? Here the
		// branch is pushed at creation, so it is removable — the point is that the
		// orphan route did not fire.
		expect(rowFor(report, tree)?.removed?.orphaned).toBeUndefined();
		expect(existsSync(tree)).toBe(false);

		// A `.git` file naming something that exists but is not a gitdir: git
		// fails in the tree, so the row is a git error, not an orphan.
		const broken = join(f.root, "broken");
		mkdirSync(join(f.home, "not-a-gitdir"), { recursive: true });
		mkdirSync(broken, { recursive: true });
		writeFileSync(join(broken, ".git"), `gitdir: ${join(f.home, "not-a-gitdir")}\n`);
		backdate(broken);
		const { report: second } = await reap(f);
		const brokenRow = rowFor(second, broken);
		expect(brokenRow?.state).toBe("kept");
		expect(brokenRow?.gate).toBe("age-unknown");
		expect(brokenRow?.removed?.orphaned).toBeUndefined();
		expect(existsSync(broken)).toBe(true);
	});

	it("mutation: without the orphan condition the directory is kept forever", async () => {
		// The gate the row pins: `classify` marks `orphaned` only when the gitdir
		// is missing. With that condition dropped, the same directory reaches the
		// ordinary gates, `git status` fails there, and it is kept as a git error
		// on every pass — the 149-directory case the owner cleaned by hand.
		const f = fixture();
		const { repo } = makeRepo(f.home);
		const orphan = join(f.subagentBase, "wo-landing-repo-666666666666");
		addWorktree(repo, orphan, "wt-r13c", { push: false });
		rmSync(repo, { recursive: true, force: true });
		const entries = walkCheckouts({ root: f.root, subagentBase: f.subagentBase });
		expect(entries.find((e) => e.path === orphan)?.orphaned).toBe(true);
		// The same directory with its gitdir present is not an orphan, so the
		// distinguishing fact is the missing target and nothing else.
		const surviving = join(f.subagentBase, "myrepo-777777777777");
		const { repo: repo2 } = makeRepo(f.home, "repo2");
		addWorktree(repo2, surviving, "wt-r13d");
		expect(walkCheckouts({ root: f.root, subagentBase: f.subagentBase }).find((e) => e.path === surviving)?.orphaned).toBe(false);
	});

	it("keeps an orphan a process is working in", async () => {
		// R13 removes debris: a directory someone has a cwd inside is not debris,
		// so the orphan path still pays the unused probe.
		const f = fixture();
		const { repo } = makeRepo(f.home);
		const orphan = join(f.subagentBase, "wo-landing-repo-999999999999");
		addWorktree(repo, orphan, "wt-r13e", { push: false });
		rmSync(repo, { recursive: true, force: true });

		const { report } = await reap(f, {
			listCwds: async () => ({ cwds: [{ pid: 2718, cwd: join(orphan, "src") }], problem: null }),
		});
		const row = rowFor(report, orphan);
		expect(verdictOf(row)).toBe("kept:in-use");
		expect(row?.unsaved?.pid).toBe(2718);
		expect(existsSync(orphan)).toBe(true);
	});
});

// ── Gate 4a — the lock ────────────────────────────────────────────────────

describe("gate 4a — a worktree git has locked", () => {
	it("is kept, and the row names the lock", async () => {
		const f = fixture();
		const { repo } = makeRepo(f.home);
		// Clean, pushed, idle and unused: the lock is the only thing holding it.
		const tree = join(f.subagentBase, "myrepo-lockedaaaaaa");
		addWorktree(repo, tree, "wt-locked", { lock: true });
		backdate(gitDirOf(tree));
		backdate(tree);

		const { report } = await reap(f);
		const row = rowFor(report, tree);
		expect(verdictOf(row)).toBe("kept:locked");
		expect(row?.detail).toBe("git worktree lock");
		expect(existsSync(tree)).toBe(true);
	});
});

// ── Gate 1b — the stash ───────────────────────────────────────────────────

describe("gate 1b — a stash entry of this checkout's own", () => {
	it("keeps the branch's stash and leaves a sibling with none removable", async () => {
		const f = fixture();
		const { repo } = makeRepo(f.home);
		const mine = join(f.subagentBase, "myrepo-stashmine000");
		const sibling = join(f.subagentBase, "myrepo-stashother0");
		addWorktree(repo, mine, "wt-stash-mine");
		addWorktree(repo, sibling, "wt-stash-other");
		writeFileSync(join(mine, "seed.txt"), "the only copy\n");
		mustGit(mine, ["stash", "push", "-q", "-m", "keep me"]);
		backdate(gitDirOf(mine));
		backdate(mine);
		backdate(gitDirOf(sibling));
		backdate(sibling);

		const { report } = await reap(f);
		const kept = rowFor(report, mine);
		expect(verdictOf(kept)).toBe("kept:stash");
		expect(kept?.unsaved?.stashes).toBe(1);
		expect(existsSync(mine)).toBe(true);
		// The entry names `wt-stash-mine`, so the sibling's own branch holds none:
		// a repo-wide reading of `refs/stash` would keep every sibling forever.
		expect(verdictOf(rowFor(report, sibling))).toBe("removed:-");
		expect(existsSync(sibling)).toBe(false);
	});
});

// ── A probe that cannot answer ────────────────────────────────────────────

describe("a probe that cannot answer", () => {
	it("reports an unmeasurable ignored-byte count in problems and keeps gating", async () => {
		const f = fixture();
		const { repo } = makeRepo(f.home);
		const tree = join(f.subagentBase, "myrepo-dufailure000");
		addWorktree(repo, tree, "wt-du");
		mkdirSync(join(tree, "target", "debug"), { recursive: true });
		writeFileSync(join(tree, "target", "debug", "out"), "x".repeat(4096));
		writeFileSync(join(tree, "untracked.txt"), "work\n");
		backdate(gitDirOf(tree));

		const { report } = await reap(f, {
			run: async () => ({ stdout: "", stderr: "du: cannot read", exitCode: 1 }),
		});
		const row = rowFor(report, tree);
		expect(verdictOf(row)).toBe("kept:dirty");
		expect(row?.unsaved?.ignoredBytes).toBeUndefined();
		expect(report.problems.join("\n")).toContain("ignored bytes not measured");
		expect(existsSync(tree)).toBe(true);
	});
});

// ── A symlink under wt/ ───────────────────────────────────────────────────

describe("a symlink under wt/", () => {
	it("is reported as other, and the tree it names is never traversed", async () => {
		const f = fixture();
		const { repo } = makeRepo(f.home);
		// A live linked worktree outside the walk, and a link to it inside wt/.
		// Following the link would classify the target as the link's entry, and
		// 091 would remove the target rather than the link.
		const target = join(f.home, "repos", "linked-target");
		addWorktree(repo, target, "wt-target");
		backdate(gitDirOf(target));
		backdate(target);
		const link = join(f.root, "linked-target");
		symlinkSync(target, link);

		const { report } = await reap(f);
		expect(verdictOf(rowFor(report, link))).toBe("kept:other");
		expect(existsSync(link)).toBe(true);
		expect(existsSync(target)).toBe(true);
		expect(mustGit(repo, ["worktree", "list", "--porcelain"])).toContain(target);
	});
});

// ── /reaper ───────────────────────────────────────────────────────────────

describe("/reaper", () => {
	it("prints the last pass's report, and says when there is none", async () => {
		const f = fixture();
		// The handler reads `wtRoots()`, which reads `homedir()`, and Bun's
		// `homedir()` is fixed at process start: pin the home with the module's
		// test seam so the row reads the temp report and never the box's.
		_testSetReaperHome(f.home);
		try {
			const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
			const pi: any = {
				events: { emit: () => {} },
				registerTool: () => {},
				registerCommand: (name: string, def: { handler: (args: string, ctx: any) => Promise<void> }) =>
					commands.set(name, def.handler),
				on: () => {},
				sendUserMessage: () => {},
			};
			subagentFactory(pi);
			const notices: string[] = [];
			const ui = { notify: (text: string) => notices.push(text), setStatus: () => {}, setWidget: () => {} };

			await commands.get("reaper")!("", { ui });
			expect(notices.at(-1)).toContain("No reaper report yet");

			await reap(f);
			await commands.get("reaper")!("", { ui });
			expect(notices.at(-1)).toContain("nothing held");
			expect(notices.at(-1)).toContain(".reaper-report.json");
		} finally {
			_testSetReaperHome(undefined);
		}
	});
});

// ── The probes' own parsing ────────────────────────────────────────────────

describe("the probes", () => {
	it("reads branch, upstream, dirty count and ignored paths from one status", () => {
		const parsed = parseStatus({
			ok: true,
			timedOut: false,
			err: "",
			out: [
				"## wo-479...origin/hamster [ahead 5, behind 717]",
				" M work-orders/records/WO-2026-425.md",
				"?? new.txt",
				"!! scripts/__pycache__/",
			].join("\n"),
		});
		expect(parsed.branch).toBe("wo-479");
		expect(parsed.upstream).toBe("origin/hamster");
		expect(parsed.ahead).toBe(5);
		expect(parsed.dirtyFiles).toBe(2);
		expect(parsed.ignoredPaths).toEqual(["scripts/__pycache__/"]);
	});

	it("treats a detached HEAD and a gone upstream as no evidence of being pushed", () => {
		expect(parseStatus({ ok: true, timedOut: false, err: "", out: "## HEAD (no branch)\n" }).ahead).toBeNull();
		const gone = parseStatus({ ok: true, timedOut: false, err: "", out: "## main...origin/main [gone]\n" });
		expect(gone.upstream).toBeNull();
		expect(gone.ahead).toBeNull();
	});

	it("parses the one lsof pass into pid/cwd pairs", async () => {
		const probe = await lsofProcessCwds(async () => ({
			stdout: "p101\nn/Users/x/a\np202\nn/Users/x/b\nf3\n",
			stderr: "",
			exitCode: 0,
		}));
		expect(probe.problem).toBeNull();
		expect(probe.cwds).toEqual([
			{ pid: 101, cwd: "/Users/x/a" },
			{ pid: 202, cwd: "/Users/x/b" },
		]);
	});

	it("reports a failed lsof rather than an empty process table", async () => {
		const probe = await lsofProcessCwds(async () => ({ stdout: "", stderr: "lsof: not found", exitCode: 127 }));
		expect(probe.cwds).toEqual([]);
		expect(probe.problem).toContain("lsof -d cwd failed");
	});

	it("finds the worktree roots under a home", () => {
		const r = wtRoots("/home/x");
		expect(r.root).toBe("/home/x/Developer/wt");
		expect(r.subagentBase).toBe("/home/x/Developer/wt/subagents");
	});
});
