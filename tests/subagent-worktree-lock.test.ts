/**
 * tfd process-controls R3-2 (owner, 2026-10-19): the worktree lock/reap
 * lifecycle, driven against real git in a real temp repo.
 *
 * Lock: `createWorktree` locks immediately after `worktree add`, so
 * `git worktree remove --force` on a live child's tree fails; the harness's own
 * cleanup unlocks only after the completion is recorded, then removes.
 * Reap: `reapFinishedWorktrees` needs 027's adoption gate AND child-side
 * terminal evidence; a clean tree is unlocked and removed (no `--force`), a
 * dirty tree is kept and marked `worktreeKept`, a live foreign owner or a
 * legacy meta is left untouched.
 *
 * Run: bun test tests/subagent-worktree-lock.test.ts
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import subagentFactory, {
	_testSetLiveSessionCtx,
	metaPath,
	readMetaJson,
	reapFinishedWorktrees,
	removeWorktreeTree,
	resolveRunningSession,
	updateMetaJson,
	writeMetaJson,
} from "../extensions/subagent-async/index.ts";
import { _testSetReaperHome, readReaperReport, reapCheckouts } from "../extensions/lib/checkout-reaper.ts";
import { PI_SUBAGENT_META_DIR_ENV } from "../extensions/lib/subagent-state.ts";
import { PI_SUBAGENT_CARGO_HOME_ENV, PI_SUBAGENT_WT_ROOT_ENV, subagentCargoHome } from "../extensions/lib/subagent-worktree.ts";
import { UnusableEnvPathError } from "../extensions/lib/env-path.ts";
import { addWorktree, backdate, git, gitDirOf, makeRepo as reaperRepo, mustGit } from "./helpers/reaper-fixtures.ts";
import { scrubSubagentEnv, setEnvForRow } from "./helpers/subagent-env.ts";
import { STANDIN_EPILOGUE } from "./helpers/standin-epilogue.ts";
import { isolateSubagentWorktrees } from "./helpers/subagent-wt-root.ts";

// The rows spawn isolated out of a temp `pi-lock-repo-*`; without this the tree
// is created in the real ~/Developer/wt/subagents and survives the repo
// (tests/helpers/subagent-wt-root.ts).
const wtRoot = isolateSubagentWorktrees("pi-lock-wt-");

// ── Real git helpers ───────────────────────────────────────────────────────

function makeRepo(): string {
	const repo = mkdtempSync(join(tmpdir(), "pi-lock-repo-"));
	expectedRepos.push(repo);
	git(repo, ["init", "-q", "."]);
	git(repo, ["config", "user.email", "test@example.com"]);
	git(repo, ["config", "user.name", "Test"]);
	writeFileSync(join(repo, "seed.txt"), "seed\n");
	// A cargo repo ignores its build output; a tree carrying one is clean.
	writeFileSync(join(repo, ".gitignore"), "target/\n");
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "-q", "-m", "init"]);
	return repo;
}

/** `git worktree list --porcelain` entry for `path`, when registered. git
 *  canonicalises the path (/var → /private/var on macOS), so compare realpaths. */
function worktreeEntry(repo: string, path: string): string | null {
	let target = path;
	try { target = realpathSync(path); } catch { /* directory already removed */ }
	const out = git(repo, ["worktree", "list", "--porcelain"]).out;
	for (const block of out.split("\n\n")) {
		const first = block.split("\n")[0];
		if (!first?.startsWith("worktree ")) continue;
		let registered = first.slice("worktree ".length);
		try { registered = realpathSync(registered); } catch { /* gone */ }
		if (registered === target) return block;
	}
	return null;
}

const expectedRepos: string[] = [];
const expectedDirs: string[] = [];
const children: Array<{ sid: string; cwd: string; ctx: any; tools: Map<string, any> }> = [];

function tempDir(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	expectedDirs.push(d);
	return d;
}

// ── Spawn plumbing ─────────────────────────────────────────────────────────

let fixtureRoot: string;
let argv1Before: string | undefined;
let agentDirBefore: string | undefined;
/** The file's cargo home for WO-2026-091's bound (WO-2026-099: process-wide
 *  env, so the file pins it once and restores the preload's value in `afterAll`). */
let restoreCargoHome: () => void = () => {};


// The harness injects PI_SUBAGENT_* into every subagent, and the gate reads them
// (an inherited allowlist refuses the fixture spawns) — so the suite scrubs them
// to be green from inside a subagent, where the reviewers run. Snapshot/unset in
// beforeAll, restore in afterAll (tests/helpers/subagent-env.ts).
let restoreSubagentEnv: () => void = () => {};
beforeAll(() => {
	restoreSubagentEnv = scrubSubagentEnv();
	fixtureRoot = mkdtempSync(join(tmpdir(), "pi-lock-fixture-"));
	const fakePi = join(fixtureRoot, "stand-in-pi.mjs");
	writeFileSync(
		fakePi,
		`
import { appendFileSync, readFileSync } from "node:fs";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { try { appendFileSync("stdin-echo.txt", d); } catch {} });
process.stdin.on("end", () => process.exit(0));
let last = null;
setInterval(() => {
	let report = "";
	try { report = readFileSync("standin-report.txt", "utf8"); } catch { /* not yet */ }
	if (report.length > 0 && report !== last) {
		last = report;
		process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant",
			content: [{ type: "text", text: report }],
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } }) + "\\n");
	}
}, 200);
setInterval(() => {}, 1 << 30);
` + STANDIN_EPILOGUE,
	);
	argv1Before = process.argv[1];
	process.argv[1] = fakePi;

	const agentsDir = join(fixtureRoot, "agent", "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(join(agentsDir, "worker.md"), "---\nname: worker\ndescription: lock fixture\n---\n\nDo the work.\n");
	agentDirBefore = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(fixtureRoot, "agent");
	// WO-2026-091: the reap's bound walks `~/.cache/cargo-target` and, over the
	// bound, runs `cargo clean -p`. No row here is about the bound (that is
	// tests/build-output-reaper.test.ts), and no row may measure or clean the
	// box's real shared dirs. WO-2026-099: process-wide, so the file pins it here
	// rather than through a per-file setter.
	restoreCargoHome = setEnvForRow(PI_SUBAGENT_CARGO_HOME_ENV, join(fixtureRoot, "home"));
});

afterAll(() => {
	restoreCargoHome();
	restoreSubagentEnv();
	if (argv1Before !== undefined) process.argv[1] = argv1Before;
	if (agentDirBefore === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = agentDirBefore;
	rmSync(fixtureRoot, { recursive: true, force: true });
	wtRoot.dispose();
});

async function spawnIsolated(cwd: string, opts: { steers?: string[] } = {}) {
	const tools = new Map<string, any>();
	const pi: any = {
		events: { emit: () => {} },
		registerTool: (def: any) => tools.set(def.name, def),
		registerCommand: () => {},
		on: () => {},
		sendUserMessage: (text: string) => opts.steers?.push(text),
		ui: { setStatus: () => {}, notify: () => {}, setWidget: () => {} },
	};
	subagentFactory(pi);
	const ctx: any = {
		cwd,
		ui: { setStatus: () => {}, notify: () => {}, setWidget: () => {}, clearStatus: () => {} },
		getModel: () => ({ provider: "openrouter", id: "xiaomi/mimo-v2.6-flash" }),
		sessionManager: { getBranch: () => [], getEntries: () => [], getSessionId: () => "sess-lock" },
	};
	_testSetLiveSessionCtx(ctx);

	const res = await tools
		.get("subagent")
		.execute("tc", { agent: "worker", task: "wait for the signal", cwd, isolate: true, review_policy: "skip" }, undefined, undefined, ctx);
	const text = res.content[0].text as string;
	if (res.isError) throw new Error(`spawn failed: ${text}`);
	const sid = /session: (subagent-[0-9a-f-]+)/.exec(text)?.[1];
	if (!sid) throw new Error(`no session id in:\n${text}`);
	children.push({ sid, cwd, ctx, tools });
	return { sid, text, ctx, tools };
}

async function waitFor(check: () => boolean, ms = 15_000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (check()) return true;
		await new Promise((r) => setTimeout(r, 50));
	}
	return check();
}

afterEach(async () => {
	_testSetLiveSessionCtx(undefined);
	for (const child of children.splice(0)) {
		try {
			const rs = resolveRunningSession(child.sid);
			if (rs) {
				if (rs.staleTimer) clearTimeout(rs.staleTimer);
				if (rs.silenceTimer) clearTimeout(rs.silenceTimer);
				rs.proc?.kill("SIGKILL");
			}
		} catch { /* best-effort */ }
		await new Promise((r) => setTimeout(r, 100));
		for (const f of [metaPath(child.sid), `/tmp/pi-subagent-${child.sid}.log`, `/tmp/pi-subagent-${child.sid}.sock`]) {
			try { if (existsSync(f)) unlinkSync(f); } catch { /* best-effort */ }
		}
	}
	for (const d of expectedDirs.splice(0)) rmSync(d, { recursive: true, force: true });
	for (const r of expectedRepos.splice(0)) {
		git(r, ["worktree", "prune"]);
		rmSync(r, { recursive: true, force: true });
	}
});

// ── Lock lifecycle ─────────────────────────────────────────────────────────

/** The scan reads the live session id off ctx; a bare `{}` cannot answer it. */
function scanCtx(): any {
	return { sessionManager: { getSessionId: () => "session-under-test" } };
}

describe("worktree lock lifecycle (real git)", () => {
	it("locks after `worktree add`, refuses force-remove while the child lives, and removes after completion", async () => {
		const repo = makeRepo();
		const { sid } = await spawnIsolated(repo);

		const meta = readMetaJson(sid) as any;
		const worktreePath: string = meta.worktreePath;
		expect(typeof worktreePath).toBe("string");
		expect(existsSync(worktreePath)).toBe(true);

		// Locked: git records the lock, and a hand force-remove of the live
		// child's tree fails loudly.
		const entry = worktreeEntry(repo, worktreePath);
		expect(entry).not.toBeNull();
		expect(entry!).toContain("locked");
		expect(entry!).toContain(`pi-subagent ${sid}`);
		const forced = git(repo, ["worktree", "remove", "--force", worktreePath]);
		expect(forced.code).not.toBe(0);
		expect(forced.err).toContain("locked");
		expect(existsSync(worktreePath)).toBe(true);

		// Completion recorded → the harness's own cleanup unlocks and removes.
		writeFileSync(join(worktreePath, "standin-report.txt"), "**status:** complete\n");
		const removed = await waitFor(() => !existsSync(worktreePath), 20_000);
		expect(removed).toBe(true);
		// The registration is gone too (cleanup used `worktree remove`, not rmtree).
		expect(worktreeEntry(repo, worktreePath)).toBeNull();
	}, 40_000);

	it("a cleanup failure keeps the tree, re-locks it, and warns the parent", async () => {
		const repo = makeRepo();
		const steers: string[] = [];
		const { sid } = await spawnIsolated(repo, { steers });
		const worktreePath = (readMetaJson(sid) as any).worktreePath;
		expectedDirs.push(worktreePath);

		// Break the removal in a way git refuses before deregistering: remove the
		// worktree's own `.git` pointer, so `worktree remove --force` fails its
		// validation while the lock is still ours to restore. The uncommitted
		// bytes are what the failure branch must not destroy.
		unlinkSync(join(worktreePath, ".git"));
		writeFileSync(join(worktreePath, "uncommitted.txt"), "bytes\n");

		writeFileSync(join(worktreePath, "standin-report.txt"), "**status:** complete\n");
		expect(
			await waitFor(() => steers.some((m) => m.includes("worktree cleanup failed")), 20_000),
		).toBe(true);

		// No rmtree fallback: the tree and its uncommitted bytes survive.
		expect(existsSync(join(worktreePath, "uncommitted.txt"))).toBe(true);
		expect(readFileSync(join(worktreePath, "uncommitted.txt"), "utf8")).toBe("bytes\n");

		// Re-locked, so a hand reap still refuses instead of deleting the work.
		const entry = worktreeEntry(repo, worktreePath);
		expect(entry).not.toBeNull();
		expect(entry!).toContain("locked");
		expect(entry!).toContain("(cleanup failed)");
		const forced = git(repo, ["worktree", "remove", "--force", worktreePath]);
		expect(forced.code).not.toBe(0);
	}, 40_000);

	it("unlocks only after the completion is recorded (kill path cleans up, live tree stays locked)", async () => {
		const repo = makeRepo();
		const { sid, tools, ctx } = await spawnIsolated(repo);
		const worktreePath = (readMetaJson(sid) as any).worktreePath;

		// While the child lives the lock is in force.
		expect(worktreeEntry(repo, worktreePath)).toContain("locked");

		// A kill records the completion, so the harness may unlock and remove.
		await tools.get("subagent_kill").execute("tk", { session_id: sid }, undefined, undefined, ctx);
		await waitFor(() => !resolveRunningSession(sid), 10_000);
		expect(await waitFor(() => !existsSync(worktreePath), 10_000)).toBe(true);
		expect(worktreeEntry(repo, worktreePath)).toBeNull();
	}, 40_000);
});

// ── Reap ───────────────────────────────────────────────────────────────────

/** A meta + log pair wired to a real locked worktree. */
function makeEntryFor(
	repo: string,
	sid: string,
	opts: {
		logLastLine?: string;
		ownerPid?: number | null;
		ownerStartToken?: string | null;
		sessionFile?: string;
		dirty?: boolean;
		/** Exact path to create the tree at (rows about the namespace). */
		worktreePath?: string;
		/** Recorded parent checkout (rows about M4's branch check). */
		parentCwd?: string;
		/** Give the tree a `target/` dir with a file in it. */
		target?: boolean;
	},
): { dir: string; worktreePath: string } {
	const worktreePath = opts.worktreePath ?? join(tempDir("pi-reap-wt-"), "tree");
	if (opts.worktreePath) mkdirSync(join(opts.worktreePath, ".."), { recursive: true });
	const add = git(repo, ["worktree", "add", "-q", worktreePath, "-b", `pi-subagent-${sid}`]);
	if (add.code !== 0) throw new Error(`worktree add failed: ${add.err}`);
	git(repo, ["worktree", "lock", "--reason", `pi-subagent ${sid}`, worktreePath]);
	if (opts.dirty) writeFileSync(join(worktreePath, "uncommitted.txt"), "bytes\n");
	if (opts.target) {
		mkdirSync(join(worktreePath, "target", "debug"), { recursive: true });
		writeFileSync(join(worktreePath, "target", "debug", "artifact"), "bytes\n");
	}

	const dir = tempDir("pi-reap-registry-");
	writeMetaJson(sid, {
		agentName: "worker",
		task: "wait for the signal",
		worktreePath,
		isolationBranch: `pi-subagent-${sid}`,
		parentCwd: opts.parentCwd,
		ownerPid: opts.ownerPid === undefined ? process.pid : opts.ownerPid,
		ownerStartToken: opts.ownerStartToken ?? null,
		sessionFile: opts.sessionFile,
	});
	// writeMetaJson writes to /tmp; relocate the fixture into the injected dir.
	const tmpMeta = metaPath(sid);
	writeFileSync(join(dir, `pi-subagent-${sid}.meta.json`), readFileSync(tmpMeta, "utf8"));
	unlinkSync(tmpMeta);
	writeFileSync(join(dir, `pi-subagent-${sid}.log`), opts.logLastLine ?? "── Turn 1 ──\nwork\n");
	return { dir, worktreePath };
}

describe("reapFinishedWorktrees (real git, injected registry)", () => {
	it("removes a clean finished tree (unlock-then-remove, no --force)", async () => {
		const repo = makeRepo();
		const { dir, worktreePath } = makeEntryFor(repo, "clean-1", {
			logLastLine: "── Completed (3 turns, exit 0) ──\n",
		});

		const results = await reapFinishedWorktrees({} as any, scanCtx(), { dir, selfPid: process.pid });
		expect(results.map((r) => r.outcome)).toEqual(["removed"]);
		expect(existsSync(worktreePath)).toBe(false);
		expect(worktreeEntry(repo, worktreePath)).toBeNull();
	});

	it("keeps a finished tree with uncommitted work and marks it (meta)", async () => {
		const repo = makeRepo();
		const { dir, worktreePath } = makeEntryFor(repo, "dirty-1", {
			logLastLine: "── Exited (3 turns, exit 1) ──\n",
			dirty: true,
		});

		const results = await reapFinishedWorktrees({} as any, scanCtx(), { dir, selfPid: process.pid });
		expect(results.map((r) => r.outcome)).toEqual(["kept-uncommitted"]);
		expect(existsSync(join(worktreePath, "uncommitted.txt"))).toBe(true);
		const meta = JSON.parse(readFileSync(join(dir, "pi-subagent-dirty-1.meta.json"), "utf8"));
		expect(meta.worktreeKept.reason).toBe("uncommitted work");
	});

	it("leaves a tree whose child has no terminal footer (could still be running)", async () => {
		const repo = makeRepo();
		const { dir, worktreePath } = makeEntryFor(repo, "unfinished-1", { logLastLine: "── Turn 1 ──\nworking…\n" });

		const results = await reapFinishedWorktrees({} as any, scanCtx(), { dir, selfPid: process.pid });
		expect(results).toEqual([]);
		expect(existsSync(worktreePath)).toBe(true);
		expect(worktreeEntry(repo, worktreePath)).not.toBeNull();
	});

	it("skips a live foreign owner's tree and a legacy meta (027)", async () => {
		const repo = makeRepo();
		const foreign = makeEntryFor(repo, "foreign-1", {
			logLastLine: "── Completed (1 turns, exit 0) ──\n",
			ownerPid: process.pid === 1 ? 2 : process.ppid,
			ownerStartToken: "not-our-token",
		});
		// A legacy meta: no owner fields at all.
		const legacy = makeEntryFor(repo, "legacy-1", { logLastLine: "── Completed (1 turns, exit 0) ──\n", ownerPid: null });
		const legacyPath = join(legacy.dir, "pi-subagent-legacy-1.meta.json");
		const legacyMeta = JSON.parse(readFileSync(legacyPath, "utf8"));
		delete legacyMeta.ownerPid;
		delete legacyMeta.ownerStartToken;
		writeFileSync(legacyPath, JSON.stringify(legacyMeta));

		// Probe stub: every recorded pid is alive with an unknown token.
		const probe = { exists: () => true, startToken: () => null };

		const results = await reapFinishedWorktrees({} as any, scanCtx(), { dir: foreign.dir, selfPid: -1, probe });
		expect(results).toEqual([]);
		expect(existsSync(foreign.worktreePath)).toBe(true);
		expect(existsSync(legacy.worktreePath)).toBe(true);
	});

	it("does not touch a tree the running map still tracks", async () => {
		const repo = makeRepo();
		const { dir, worktreePath } = makeEntryFor(repo, "tracked-1", {
			logLastLine: "── Completed (1 turns, exit 0) ──\n",
			target: true,
		});
		const { _testRunning } = await import("../extensions/subagent-async/index.ts");
		_testRunning.set("tracked-1", { sessionId: "tracked-1" } as any);
		try {
			const results = await reapFinishedWorktrees({} as any, scanCtx(), { dir, selfPid: process.pid });
			expect(results).toEqual([]);
			expect(existsSync(worktreePath)).toBe(true);
			expect(existsSync(join(worktreePath, "target", "debug", "artifact"))).toBe(true);
		} finally {
			_testRunning.delete("tracked-1");
		}
	});

	it("re-locks a tree it could not remove (never leaves it unlocked)", async () => {
		const repo = makeRepo();
		// An initialized submodule makes `git worktree remove` refuse *at
		// validation* — registration intact, so the re-lock is observable — while
		// the reap's own cleanliness check still sees a clean tree.
		const sub = makeRepo();
		git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub"]);
		git(repo, ["commit", "-q", "-m", "add submodule"]);

		const { dir, worktreePath } = makeEntryFor(repo, "submod-1", {
			logLastLine: "── Completed (1 turns, exit 0) ──\n",
			// M4's funnel covers every kept outcome, not only kept-uncommitted.
			target: true,
			parentCwd: repo,
		});
		git(worktreePath, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q"]);
		expect(git(worktreePath, ["status", "--porcelain", "-uall"]).out.trim()).toBe("");

		const results = await reapFinishedWorktrees({} as any, scanCtx(), { dir, selfPid: process.pid });
		expect(results.map((r) => r.outcome)).toEqual(["kept-remove-failed"]);
		expect(existsSync(worktreePath)).toBe(true);

		const entry = worktreeEntry(repo, worktreePath);
		expect(entry).not.toBeNull();
		expect(entry!).toContain("locked");
		expect(entry!).toContain("(reap failed)");
		// The branch sits at the parent commit, so the kept tree's build output
		// goes even though the tree could not be removed.
		expect(existsSync(join(worktreePath, "target"))).toBe(false);
		expect(results[0].detail).toContain("branch merged");
		// Two repos, a submodule add/update and a refused worktree remove: ~6 s
		// alone, over the 5 s default on a loaded box.
	}, 30_000);

	// ── One failing meta among several (R10) ────────────────────────────────

	interface PerMetaFixture {
		home: string;
		root: string;
		subagentBase: string;
		registry: string;
		/** The meta whose processing throws, and the tree it names. */
		failing: { sid: string; worktreePath: string };
		/** The metas that must still be reaped. */
		reaped: Array<{ sid: string; worktreePath: string }>;
	}

	/** Several metas in one registry dir, the first in the scan's own order
	 *  corrupted so its processing throws: its tree is dirty, and its recorded
	 *  isolation branch holds a byte no spawn accepts, so 027's own keep path
	 *  (`dropKeptTarget` → git) rejects. The other metas are clean and finished,
	 *  so the reap removes their trees. Which meta fails is read from `readdir`
	 *  order, the order `listSubagentMetas` iterates, so the failing one is always
	 *  first and every other meta is one a single-`try` loop would abandon. */
	function perMetaFixture(): PerMetaFixture {
		const repo = makeRepo();
		const home = tempDir("pi-permeta-home-");
		const root = join(home, "Developer", "wt");
		const subagentBase = join(root, "subagents");
		mkdirSync(subagentBase, { recursive: true });
		const registry = tempDir("pi-permeta-registry-");
		const sids = ["permeta-a", "permeta-b", "permeta-c"];
		const entries = sids.map((sid) =>
			makeEntryFor(repo, sid, {
				worktreePath: join(subagentBase, `myrepo-${sid}`),
				parentCwd: repo,
				logLastLine: "── Completed (1 turns, exit 0) ──\n",
			}),
		);
		// One registry: `makeEntryFor` writes each meta and log into its own dir.
		for (const entry of entries) {
			for (const name of readdirSync(entry.dir)) {
				writeFileSync(join(registry, name), readFileSync(join(entry.dir, name)));
			}
		}

		const firstName = readdirSync(registry).filter((f) => f.endsWith(".meta.json"))[0];
		const failingSid = firstName.slice("pi-subagent-".length, -".meta.json".length);
		const failingPath = entries[sids.indexOf(failingSid)].worktreePath;
		// Dirty, so the reap takes its keep path — the one that reaches the throw.
		writeFileSync(join(failingPath, "uncommitted.txt"), "bytes\n");
		const metaFile = join(registry, firstName);
		const meta = JSON.parse(readFileSync(metaFile, "utf8"));
		meta.isolationBranch = "pi-subagent-\u0000-corrupt";
		writeFileSync(metaFile, JSON.stringify(meta));

		return {
			home,
			root,
			subagentBase,
			registry,
			failing: { sid: failingSid, worktreePath: failingPath },
			reaped: entries
				.map((entry, i) => ({ sid: sids[i], worktreePath: entry.worktreePath }))
				.filter((entry) => entry.sid !== failingSid),
		};
	}

	it("one meta's failure leaves the rest of the list reaped, and hands its own tree over ungoverned (R10)", async () => {
		const f = perMetaFixture();
		const metaPaths = new Set<string>();
		let scopeFailed = false;

		const results = await reapFinishedWorktrees({} as any, scanCtx(), {
			dir: f.registry,
			selfPid: process.pid,
			subagentMetaPaths: metaPaths,
			onScopeFailed: () => {
				scopeFailed = true;
			},
		});

		// The metas after the failing one still ran: their trees went, with a
		// verdict each. Restoring the single `try` around the loop loses them.
		expect(results.map((r) => r.sid).sort()).toEqual(f.reaped.map((entry) => entry.sid).sort());
		expect(results.every((r) => r.outcome === "removed")).toBe(true);
		for (const entry of f.reaped) expect(existsSync(entry.worktreePath)).toBe(false);
		// The failed meta's tree keeps its bytes — 027 reached no verdict on it.
		// (Its survival alone proves nothing: the tree is dirty, so the general
		// gates would keep it as `dirty`. The `gate` assertion below is the pin.)
		expect(readFileSync(join(f.failing.worktreePath, "uncommitted.txt"), "utf8")).toBe("bytes\n");
		// Its path was recorded before anything threw, and the failure was reported.
		expect(metaPaths.has(f.failing.worktreePath)).toBe(true);
		expect(scopeFailed).toBe(true);

		// What the general pass does with that handover: 027's verdicts where it
		// reached one, and "ungoverned" — never the general gates' judgement — for
		// the failed meta's tree. Every general gate would remove that tree.
		const { report } = await reapCheckouts({
			root: f.root,
			subagentBase: f.subagentBase,
			home: f.home,
			budgetMs: 60_000,
			subagentResults: results,
			subagentMetaPaths: metaPaths,
			subagentScopeFailed: scopeFailed,
			removeWorktree: (deps, rs, policy) => removeWorktreeTree(deps, rs, policy),
			listCwds: async () => ({ cwds: [], problem: null }),
		});
		const row = report.kept.find((r) => r.path === f.failing.worktreePath);
		expect(row?.gate).toBe("subagent");
		expect(row?.detail).toContain("027's scan was incomplete");
	}, 60_000);

	it("a meta that records no worktree does not mark the namespace ungoverned (R10)", async () => {
		// `buildSpawnMeta` writes `worktreePath: null` for every non-isolated spawn,
		// which is most of them (reviewers isolate: false). Treating that as a
		// corrupt meta would ungovern the namespace on every session start.
		const repo = reaperRepo(tempDir("pi-nullmeta-repo-"));
		const home = tempDir("pi-nullmeta-home-");
		const root = join(home, "Developer", "wt");
		const subagentBase = join(root, "subagents");
		mkdirSync(subagentBase, { recursive: true });
		const registry = tempDir("pi-nullmeta-registry-");
		const withTree = makeEntryFor(repo.repo, "nullmeta-a", {
			worktreePath: join(subagentBase, "myrepo-nullmeta-a"),
			parentCwd: repo.repo,
			logLastLine: "── Completed (1 turns, exit 0) ──\n",
		});
		const noTree = makeEntryFor(repo.repo, "nullmeta-b", {
			worktreePath: join(subagentBase, "myrepo-nullmeta-b"),
			parentCwd: repo.repo,
			logLastLine: "── Completed (1 turns, exit 0) ──\n",
		});
		for (const entry of [withTree, noTree]) {
			for (const name of readdirSync(entry.dir)) {
				writeFileSync(join(registry, name), readFileSync(join(entry.dir, name)));
			}
		}
		// Exactly as the spawn writes it: the key present, the value null.
		const noTreeMeta = join(registry, "pi-subagent-nullmeta-b.meta.json");
		const meta = JSON.parse(readFileSync(noTreeMeta, "utf8"));
		meta.worktreePath = null;
		writeFileSync(noTreeMeta, JSON.stringify(meta));

		const causes: string[] = [];
		const results = await reapFinishedWorktrees({} as any, scanCtx(), {
			dir: registry,
			selfPid: process.pid,
			onScopeFailed: ({ error }) => {
				causes.push(error);
			},
		});

		expect(causes).toEqual([]);
		expect(results.map((r) => r.sid)).toEqual(["nullmeta-a"]);
		expect(results[0].outcome).toBe("removed");
		expect(existsSync(withTree.worktreePath)).toBe(false);
		// The meta that names no tree leaves its fixture tree alone.
		expect(existsSync(noTree.worktreePath)).toBe(true);
	}, 60_000);

	it("a meta whose worktreePath is not a path marks the namespace ungoverned (R10)", async () => {
		const repo = reaperRepo(tempDir("pi-badpath-repo-"));
		const registry = tempDir("pi-badpath-registry-");
		const entry = makeEntryFor(repo.repo, "badpath-a", { parentCwd: repo.repo });
		for (const name of readdirSync(entry.dir)) {
			writeFileSync(join(registry, name), readFileSync(join(entry.dir, name)));
		}
		const metaFile = join(registry, "pi-subagent-badpath-a.meta.json");
		const meta = JSON.parse(readFileSync(metaFile, "utf8"));
		meta.worktreePath = 42;
		writeFileSync(metaFile, JSON.stringify(meta));

		const causes: string[] = [];
		await reapFinishedWorktrees({} as any, scanCtx(), {
			dir: registry,
			selfPid: process.pid,
			onScopeFailed: ({ error }) => {
				causes.push(error);
			},
		});

		expect(causes).toHaveLength(1);
		expect(causes[0]).toContain("worktreePath is not a path");
		// Which value was wrong, not only that one was: the operator's next step
		// is to find that meta.
		expect(causes[0]).toContain("42");
	}, 60_000);

	it("a meta that will not parse leaves the namespace ungoverned, and the readable metas after it still reap (R10)", async () => {
		// Three metas, the first in scan order torn. A scan that stops at the drop
		// leaves the other two trees behind; one that skips it silently leaves the
		// torn meta's tree to the general gates, which remove it (clean, unlocked,
		// backdated).
		const repo = reaperRepo(tempDir("pi-tornmeta-repo-"));
		const home = tempDir("pi-tornmeta-home-");
		const root = join(home, "Developer", "wt");
		const subagentBase = join(root, "subagents");
		mkdirSync(subagentBase, { recursive: true });
		const registry = tempDir("pi-tornmeta-registry-");
		const sids = ["tornmeta-a", "tornmeta-b", "tornmeta-c"];
		const entries = sids.map((sid) =>
			makeEntryFor(repo.repo, sid, {
				worktreePath: join(subagentBase, `myrepo-${sid}`),
				parentCwd: repo.repo,
				logLastLine: "── Completed (1 turns, exit 0) ──\n",
			}),
		);
		for (const entry of entries) {
			for (const name of readdirSync(entry.dir)) {
				writeFileSync(join(registry, name), readFileSync(join(entry.dir, name)));
			}
		}

		const firstName = readdirSync(registry).filter((f) => f.endsWith(".meta.json"))[0];
		const tornSid = firstName.slice("pi-subagent-".length, -".meta.json".length);
		const tornPath = entries[sids.indexOf(tornSid)].worktreePath;
		writeFileSync(join(registry, firstName), "{ not json");
		// Nothing but 027's ownership keeps this tree: unlocked, clean, pushed, old.
		mustGit(repo.repo, ["worktree", "unlock", tornPath]);
		backdate(gitDirOf(tornPath));
		backdate(tornPath);
		const readable = sids.filter((sid) => sid !== tornSid);

		const metaPaths = new Set<string>();
		let scopeFailed = false;
		let cause: string | undefined;
		const results = await reapFinishedWorktrees({} as any, scanCtx(), {
			dir: registry,
			selfPid: process.pid,
			subagentMetaPaths: metaPaths,
			onScopeFailed: ({ error }) => {
				scopeFailed = true;
				cause ??= error;
			},
		});

		// A scan that stopped at the torn meta leaves these behind.
		expect(results.map((r) => r.sid).sort()).toEqual(readable.slice().sort());
		expect(results.every((r) => r.outcome === "removed")).toBe(true);
		for (const sid of readable) expect(existsSync(join(subagentBase, `myrepo-${sid}`))).toBe(false);
		expect(scopeFailed).toBe(true);

		const { report } = await reapCheckouts({
			root,
			subagentBase,
			home,
			budgetMs: 60_000,
			subagentResults: results,
			subagentMetaPaths: metaPaths,
			subagentScopeFailed: scopeFailed,
			subagentScopeDetail: cause,
			removeWorktree: (deps, rs, policy) => removeWorktreeTree(deps, rs, policy),
			listCwds: async () => ({ cwds: [], problem: null }),
		});

		// The torn meta's tree is clean, unlocked and old: every general gate would
		// remove it. Without the flag it is reported `removed`.
		const tornRow = report.kept.find((r) => r.path === tornPath);
		expect(tornRow?.gate).toBe("subagent");
		// The row names the file, so a torn meta is actionable rather than mystery.
		expect(tornRow?.detail).toContain(firstName);
		expect(report.removed).toEqual([]);
		expect(existsSync(tornPath)).toBe(true);
	}, 60_000);

	/** Register the extension for real and keep the handlers it captured. Every
	 *  wiring row fires the captured `session_start`: the reap is fire-and-forget
	 *  inside it, so the effect (not a return value) is what proves the wiring. */
	function registerHandler(): Map<string, Function> {
		const handlers = new Map<string, Function>();
		const pi: any = {
			events: { emit: () => {} },
			registerTool: () => {},
			registerCommand: () => {},
			on: (event: string, cb: Function) => handlers.set(event, cb),
			sendUserMessage: () => {},
			ui: { setStatus: () => {}, notify: () => {}, setWidget: () => {} },
		};
		subagentFactory(pi);
		return handlers;
	}

	it("the real session_start handler runs the reap (wiring)", async () => {
		const repo = makeRepo();
		const { dir, worktreePath } = makeEntryFor(repo, "wiring-1", {
			logLastLine: "── Completed (1 turns, exit 0) ──\n",
		});
		// The handler also runs WO-2026-092's reaper, which walks
		// `homedir()/Developer/wt` and `homedir()/.cache/cargo-target`: on the box's
		// home that is every real checkout. Bun's `homedir()` is fixed at process
		// start, so the pin is the module's home seam (and the cargo home the
		// file's beforeAll sets), not `HOME`.
		const home = tempDir("pi-wiring-home-");
		mkdirSync(join(home, "Developer", "wt"), { recursive: true });
		_testSetReaperHome(home);

		// Dropping the call leaves the tree.
		const handlers = registerHandler();
		const restore = setEnvForRow(PI_SUBAGENT_META_DIR_ENV, dir);
		try {
			await handlers.get("session_start")!(
				{ type: "session_start", reason: "reload" },
				{ cwd: repo, sessionManager: { getSessionId: () => "sess-lock-wiring" }, ui: {} },
			);
			expect(await waitFor(() => !existsSync(worktreePath), 20_000)).toBe(true);
			expect(worktreeEntry(repo, worktreePath)).toBeNull();
			// The general pass ran too, and wrote its report under the pinned home:
			// with the wiring dropped there is no report at all.
			expect(await waitFor(() => existsSync(join(home, "Developer", "wt", ".reaper-report.json")), 20_000)).toBe(true);
		} finally {
			restore();
			_testSetReaperHome(undefined);
		}
		// Two reaps and a report write on a loaded box.
	}, 30_000);

	// ── The general pass, driven through the same handler ──────────────────

	it("the wired general pass removes a checkout its gates clear (wiring)", async () => {
		const home = tempDir("pi-wiring-home-");
		const root = join(home, "Developer", "wt");
		mkdirSync(join(root, "subagents"), { recursive: true });
		// A checkout every gate clears: clean, pushed to the origin under this home,
		// idle past the window, nothing working in it. A bare `mkdir` here would show
		// only that the pass wrote a report; this tree shows what the report means.
		const { repo } = reaperRepo(home);
		const branch = "pi-subagent-wired00000001";
		const tree = addWorktree(repo, join(root, "myrepo-wired"), branch);
		backdate(gitDirOf(tree));
		backdate(tree);
		_testSetReaperHome(home);
		const restore = setEnvForRow(PI_SUBAGENT_META_DIR_ENV, tempDir("pi-wiring-registry-"));

		const handlers = registerHandler();
		try {
			await handlers.get("session_start")!(
				{ type: "session_start", reason: "reload" },
				{ cwd: repo, sessionManager: { getSessionId: () => "sess-reaper-wiring" }, ui: {} },
			);
			expect(await waitFor(() => !existsSync(tree), 20_000)).toBe(true);
			// The removal the call site wires in, not an rmtree: the registration went
			// with the tree, and the branch delete is inside that same sequence.
			expect(worktreeEntry(repo, tree)).toBeNull();
			expect(git(repo, ["branch", "--list", branch]).out.trim()).toBe("");
			expect(await waitFor(() => existsSync(join(root, ".reaper-report.json")), 20_000)).toBe(true);
			const row = readReaperReport(root)?.removed.find((r) => r.path === tree);
			expect(row?.state).toBe("removed");
			expect(row?.gate).toBeNull();
		} finally {
			restore();
			_testSetReaperHome(undefined);
		}
		// A real reap: the git gates, the lsof sweep and a worktree removal.
	}, 60_000);

	it("hands 027's verdict for a tree it keeps into the general report (wiring)", async () => {
		const repo = makeRepo();
		const home = tempDir("pi-wiring-home-");
		const root = join(home, "Developer", "wt");
		const subagentBase = join(root, "subagents");
		mkdirSync(subagentBase, { recursive: true });
		// A tree 027 keeps: uncommitted work. Its verdict, not the general gates'
		// (which would remove it), is the row the report must carry.
		const { dir, worktreePath } = makeEntryFor(repo, "wiring-kept", {
			worktreePath: join(subagentBase, "myrepo-wiring-kept"),
			dirty: true,
			logLastLine: "── Completed (1 turns, exit 0) ──\n",
		});
		_testSetReaperHome(home);
		const restore = setEnvForRow(PI_SUBAGENT_META_DIR_ENV, dir);

		const handlers = registerHandler();
		try {
			await handlers.get("session_start")!(
				{ type: "session_start", reason: "reload" },
				{ cwd: repo, sessionManager: { getSessionId: () => "sess-verdict-wiring" }, ui: {} },
			);
			expect(await waitFor(() => existsSync(join(root, ".reaper-report.json")), 20_000)).toBe(true);
			const row = readReaperReport(root)?.kept.find((r) => r.path === worktreePath);
			// What the handover changes is the row, not the tree: `makeEntryFor`
			// locks the tree, so a general-pass judgement would report gate "locked"
			// and keep it anyway. `existsSync` here would pass either way; these two
			// lines are the ones a broken handoff reds.
			expect(row?.gate).toBe("subagent");
			expect(row?.detail).toBe("subagent kept-uncommitted");
		} finally {
			restore();
			_testSetReaperHome(undefined);
		}
		// 027's reap, then the general pass over the same registry.
	}, 60_000);

	it("hands one failed meta's tree over as ungoverned through the real handler (wiring)", async () => {
		const f = perMetaFixture();
		_testSetReaperHome(f.home);
		const restore = setEnvForRow(PI_SUBAGENT_META_DIR_ENV, f.registry);

		const handlers = registerHandler();
		try {
			await handlers.get("session_start")!(
				{ type: "session_start", reason: "reload" },
				{ cwd: f.root, sessionManager: { getSessionId: () => "sess-scope-wiring" }, ui: {} },
			);
			expect(await waitFor(() => existsSync(join(f.root, ".reaper-report.json")), 20_000)).toBe(true);
			// The flag's producer, end to end: without it this tree is reported as
			// "held by 027's gates" — a verdict 027 never reached — and the general
			// gates judge it, which is the deletion a failed 027 reap must prevent.
			const row = readReaperReport(f.root)?.kept.find((r) => r.path === f.failing.worktreePath);
			expect(row?.gate).toBe("subagent");
			expect(row?.detail).toContain("027's scan was incomplete");
			expect(existsSync(f.failing.worktreePath)).toBe(true);
			// The metas after the failing one still ran through the handler too.
			for (const entry of f.reaped) expect(existsSync(entry.worktreePath)).toBe(false);
		} finally {
			restore();
			_testSetReaperHome(undefined);
		}
		// Two reaps over three trees, then the general pass.
	}, 60_000);

	it("names the cause in the report through the real handler, first cause plus a count (wiring)", async () => {
		// Two causes, both real: a torn meta file (reported by the scan) and a meta
		// whose processing throws (reported per meta). The row must carry the first
		// cause and admit there is another, or an operator fixes one and re-runs to
		// discover the second.
		const f = perMetaFixture();
		const tornName = `pi-subagent-torn-extra.meta.json`;
		writeFileSync(join(f.registry, tornName), "{ not json");
		_testSetReaperHome(f.home);
		const restore = setEnvForRow(PI_SUBAGENT_META_DIR_ENV, f.registry);

		const handlers = registerHandler();
		try {
			await handlers.get("session_start")!(
				{ type: "session_start", reason: "reload" },
				{ cwd: f.root, sessionManager: { getSessionId: () => "sess-scope-detail" }, ui: {} },
			);
			expect(await waitFor(() => existsSync(join(f.root, ".reaper-report.json")), 20_000)).toBe(true);
			const row = readReaperReport(f.root)?.kept.find((r) => r.path === f.failing.worktreePath);
			expect(row?.gate).toBe("subagent");
			expect(row?.detail).toContain("027's scan was incomplete");
			// The scan's cause comes first and names the file; the throw is counted.
			expect(row?.detail).toContain(tornName);
			expect(row?.detail).toContain("1 more");
		} finally {
			restore();
			_testSetReaperHome(undefined);
		}
	}, 60_000);

	it("an unlistable metas dir marks the namespace ungoverned (R10)", async () => {
		// The dir arm of the same funnel. Nothing can be attributed, so the scan
		// reports itself incomplete; the handover that follows is pinned by the
		// wiring row above and by the torn-meta row.
		const missing = join(tempDir("pi-nodir-parent-"), "not-there");

		const causes: string[] = [];
		const results = await reapFinishedWorktrees({} as any, scanCtx(), {
			dir: missing,
			selfPid: process.pid,
			onScopeFailed: ({ error }) => {
				causes.push(error);
			},
		});

		expect(results).toEqual([]);
		expect(causes).toHaveLength(1);
		// Which path, not only that one was unlistable.
		expect(causes[0]).toContain(`unlistable metas dir ${missing}`);
	}, 60_000);

	it("a child session's start runs no reaper pass (PI_SUBAGENT_DEPTH)", async () => {
		// N children would pay N passes and each would overwrite the report the
		// parent announced. The child's start is not the pass.
		const home = tempDir("pi-wiring-home-");
		mkdirSync(join(home, "Developer", "wt"), { recursive: true });
		const depthBefore = process.env.PI_SUBAGENT_DEPTH;
		_testSetReaperHome(home);
		const restore = setEnvForRow(PI_SUBAGENT_META_DIR_ENV, tempDir("pi-wiring-registry-"));
		try {
			const handlers = registerHandler();
			const reportFile = join(home, "Developer", "wt", ".reaper-report.json");
			// Positive control: the same home and the same registry write a report
			// when the pass runs, so the child's silence below is the depth gate and
			// not a fixture that never writes.
			delete process.env.PI_SUBAGENT_DEPTH;
			const controlStart = Date.now();
			await handlers.get("session_start")!(
				{ type: "session_start", reason: "startup" },
				{ cwd: home, sessionManager: { getSessionId: () => "sess-parent-control" }, ui: {} },
			);
			expect(await waitFor(() => existsSync(reportFile), 20_000)).toBe(true);
			const controlMs = Date.now() - controlStart;
			unlinkSync(reportFile);

			process.env.PI_SUBAGENT_DEPTH = "1";
			await handlers.get("session_start")!(
				{ type: "session_start", reason: "startup" },
				{ cwd: home, sessionManager: { getSessionId: () => "sess-child-wiring" }, ui: {} },
			);
			// The pass is fire-and-forget, so the negative needs a window: the
			// control's own measured time to write, doubled, with a floor — a fixed
			// 500 ms would pass while a real pass was still gating.
			await Bun.sleep(Math.max(1_000, controlMs * 2));
			expect(existsSync(reportFile)).toBe(false);
		} finally {
			restore();
			_testSetReaperHome(undefined);
			if (depthBefore === undefined) delete process.env.PI_SUBAGENT_DEPTH;
			else process.env.PI_SUBAGENT_DEPTH = depthBefore;
		}
	}, 30_000);
});

// ── Reap: build output (WO-2026-091) ───────────────────────────────────────

describe("reap build output (real git, injected registry)", () => {
	/** A meta + log pair, as `makeEntryFor` builds them, at an exact tree path. */
	function entryAt(
		repo: string,
		sid: string,
		worktreePath: string,
		opts: { dirty?: boolean; target?: boolean; logLastLine?: string; parentCwd?: string; branch?: string } = {},
	): { dir: string; worktreePath: string } {
		const entry = makeEntryFor(repo, sid, {
			worktreePath,
			dirty: opts.dirty,
			target: opts.target,
			parentCwd: opts.parentCwd,
			logLastLine: opts.logLastLine,
		});
		if (opts.branch !== undefined) {
			const metaFile = join(entry.dir, `pi-subagent-${sid}.meta.json`);
			const meta = JSON.parse(readFileSync(metaFile, "utf8"));
			meta.isolationBranch = opts.branch;
			writeFileSync(metaFile, JSON.stringify(meta));
		}
		return entry;
	}

	it("a reaped worktree leaves no target/ and no attributed shared artifacts (R1)", async () => {
		const home = tempDir("pi-reap-home-");
		const repo = makeRepo();
		const repoName = repo.split("/").pop()!;
		const worktreePath = join(home, "Developer", "wt", "subagents", `${repoName}-4add98737109`);
		const shared = join(home, ".cache", "cargo-target", repoName);
		const deps = join(shared, "debug", "deps");
		mkdirSync(deps, { recursive: true });
		writeFileSync(join(deps, `${repoName}-abc123.d`), `${join(deps, `lib${repoName}-abc123.rlib`)}: ${worktreePath}/src/lib.rs\n`);
		writeFileSync(join(deps, `lib${repoName}-abc123.rlib`), "dead\n");
		mkdirSync(join(shared, "debug", ".fingerprint", `${repoName}-abc123`), { recursive: true });

		const { dir } = entryAt(repo, "reaped-target", worktreePath, {
			target: true,
			logLastLine: "── Completed (1 turns, exit 0) ──\n",
		});

		// The two roots are separate values in production; this row's fixture puts
		// the tree and its shared cargo dir under one home, so both point there.
		const restoreWtRoot = setEnvForRow(PI_SUBAGENT_WT_ROOT_ENV, join(home, "Developer/wt/subagents"));
		const restore = setEnvForRow(PI_SUBAGENT_CARGO_HOME_ENV, home);
		try {
			const results = await reapFinishedWorktrees({} as any, scanCtx(), { dir, selfPid: process.pid });

			expect(results.map((r) => r.outcome)).toEqual(["removed"]);
			// R1: neither the tree nor its target survives. These two lines cannot
			// fail on their own: `removeWorktreeTree` disposes only after git removed
			// the tree, and `git worktree remove` deletes an ignored target/ with it.
			// What pins the mechanism is the shared-dir assertions below; M1's own
			// firing is pinned by the M4 rows (a kept tree keeps its directory).
			expect(existsSync(worktreePath)).toBe(false);
			expect(existsSync(join(worktreePath, "target"))).toBe(false);
			// ... and the worktree's share of the clone's shared dir goes too.
			expect(existsSync(join(deps, `${repoName}-abc123.d`))).toBe(false);
			expect(existsSync(join(deps, `lib${repoName}-abc123.rlib`))).toBe(false);
			expect(existsSync(join(shared, "debug", ".fingerprint", `${repoName}-abc123`))).toBe(false);
			// The row reports what it dropped and by which route. `target/` is not
			// in the line because `git worktree remove` already deletes an ignored
			// target/ with the tree — see the row's note in the report.
			expect(results[0].detail).toContain("(exact)");
		} finally {
			restoreWtRoot();
			restore();
		}
	});

	it("a live worktree keeps its target/ (R2)", async () => {
		const repo = makeRepo();
		// No terminal footer: the child may still be running, so nothing about its
		// tree — its build output least of all — is the reap's to touch.
		const { dir, worktreePath } = entryAt(repo, "live-target", join(tempDir("pi-reap-wt-"), "tree"), {
			target: true,
			logLastLine: "── Turn 1 ──\nworking…\n",
		});

		const results = await reapFinishedWorktrees({} as any, scanCtx(), { dir, selfPid: process.pid });

		expect(results).toEqual([]);
		expect(existsSync(join(worktreePath, "target", "debug", "artifact"))).toBe(true);
	});

	it("a failed prune reaches ReapResult.detail (reported, not swallowed)", async () => {
		const home = tempDir("pi-reap-home-");
		const repo = makeRepo();
		const repoName = repo.split("/").pop()!;
		const worktreePath = join(home, "Developer", "wt", "subagents", `${repoName}-4add98737109`);
		const deps = join(home, ".cache", "cargo-target", repoName, "debug", "deps");
		mkdirSync(deps, { recursive: true });
		// A `.d` the prune cannot read: the row is that the failure is reported,
		// not that the artifacts went.
		const unreadable = join(deps, `${repoName}_x-deadbeefdeadbeef.d`);
		writeFileSync(unreadable, `${worktreePath}/src/lib.rs: ${worktreePath}/src/lib.rs\n`);
		chmodSync(unreadable, 0o000);

		const { dir } = entryAt(repo, "reaped-unreadable", worktreePath, {
			logLastLine: "── Completed (1 turns, exit 0) ──\n",
		});

		// The two roots are separate values in production; this row's fixture puts
		// the tree and its shared cargo dir under one home, so both point there.
		const restoreWtRoot = setEnvForRow(PI_SUBAGENT_WT_ROOT_ENV, join(home, "Developer/wt/subagents"));
		const restore = setEnvForRow(PI_SUBAGENT_CARGO_HOME_ENV, home);
		try {
			const results = await reapFinishedWorktrees({} as any, scanCtx(), { dir, selfPid: process.pid });

			expect(results.map((r) => r.outcome)).toEqual(["removed"]);
			expect(results[0].detail).toContain("problems:");
			expect(results[0].detail).toContain("not readable");
		} finally {
			chmodSync(unreadable, 0o644);
			restoreWtRoot();
			restore();
		}
	});

	it("the bound prunes a dead worktree's share of an over-bound clone", async () => {
		const home = tempDir("pi-reap-home-");
		const repo = makeRepo();
		const repoName = repo.split("/").pop()!;
		// A tree that is already gone (its meta still names it), and its share of
		// the clone's shared dir, which only the bound's pass can reach.
		const deadPath = join(home, "Developer", "wt", "subagents", `${repoName}-1234567890ab`);
		const deps = join(home, ".cache", "cargo-target", repoName, "debug", "deps");
		mkdirSync(deps, { recursive: true });
		const depInfo = join(deps, `${repoName}-deadbeefdeadbeef.d`);
		writeFileSync(depInfo, `${deadPath}/src/lib.rs: ${deadPath}/src/lib.rs\n`);
		const entry = makeEntryFor(repo, "dead-under-bound", {
			worktreePath: join(tempDir("pi-reap-wt-"), "tree"),
			logLastLine: "── Completed (1 turns, exit 0) ──\n",
		});
		// Rewrite the meta to the gone path, with a foreign owner that is dead, so
		// the reap's own loop skips it and only the bound can act on it.
		const metaFile = join(entry.dir, "pi-subagent-dead-under-bound.meta.json");
		const meta = JSON.parse(readFileSync(metaFile, "utf8"));
		meta.worktreePath = deadPath;
		meta.ownerPid = process.pid === 1 ? 2 : process.ppid;
		meta.ownerStartToken = "not-our-token";
		writeFileSync(metaFile, JSON.stringify(meta));

		// The two roots are separate values in production; this row's fixture puts
		// the tree and its shared cargo dir under one home, so both point there.
		const restoreWtRoot = setEnvForRow(PI_SUBAGENT_WT_ROOT_ENV, join(home, "Developer/wt/subagents"));
		const restore = setEnvForRow(PI_SUBAGENT_CARGO_HOME_ENV, home);
		try {
			const results = await reapFinishedWorktrees({} as any, scanCtx(), {
				dir: entry.dir,
				selfPid: -1,
				probe: { exists: () => false, startToken: () => null },
				sizeOf: () => 25 * 1024 ** 3,
			});

			// The reap's loop did not touch it (foreign, dead owner) ...
			expect(results).toEqual([]);
			// ... so the bound is what pruned the dead path's share.
			expect(existsSync(depInfo)).toBe(false);
		} finally {
			restoreWtRoot();
			restore();
		}
	});

	it("a kept tree whose branch is merged into the parent HEAD loses its target/ (R6)", async () => {
		const repo = makeRepo();
		const { dir, worktreePath } = entryAt(repo, "kept-merged", join(tempDir("pi-reap-wt-"), "tree"), {
			target: true,
			dirty: true,
			parentCwd: repo,
			logLastLine: "── Exited (1 turns, exit 1) ──\n",
		});

		const results = await reapFinishedWorktrees({} as any, scanCtx(), { dir, selfPid: process.pid });

		expect(results.map((r) => r.outcome)).toEqual(["kept-uncommitted"]);
		// The tree stays (resume and inspection still work); only the build output
		// goes, because the branch holds nothing unlanded.
		expect(existsSync(worktreePath)).toBe(true);
		expect(existsSync(join(worktreePath, "target"))).toBe(false);
		expect(readFileSync(join(worktreePath, "uncommitted.txt"), "utf8")).toBe("bytes\n");
		expect(results[0].detail).toContain("branch merged");
	});

	it("a kept tree whose target cannot be dropped reports it in ReapResult.detail", async () => {
		const repo = makeRepo();
		const { dir, worktreePath } = entryAt(repo, "kept-locked-target", join(tempDir("pi-reap-wt-"), "tree"), {
			target: true,
			dirty: true,
			parentCwd: repo,
			logLastLine: "── Exited (1 turns, exit 1) ──\n",
		});
		// A read-only dir inside target/: M4's unlink fails and must be reported,
		// not swallowed, while the tree stays.
		const inner = join(worktreePath, "target", "debug");
		chmodSync(inner, 0o500);
		try {
			const results = await reapFinishedWorktrees({} as any, scanCtx(), { dir, selfPid: process.pid });

			expect(results.map((r) => r.outcome)).toEqual(["kept-uncommitted"]);
			expect(results[0].detail ?? "").toContain("not removed");
			expect(existsSync(inner)).toBe(true);
		} finally {
			chmodSync(inner, 0o755);
		}
	});

	it("a kept tree whose branch still holds unlanded work keeps its target/ (R6)", async () => {
		const repo = makeRepo();
		const worktreePath = join(tempDir("pi-reap-wt-"), "tree");
		const { dir } = entryAt(repo, "kept-live", worktreePath, {
			target: true,
			parentCwd: repo,
			logLastLine: "── Exited (1 turns, exit 1) ──\n",
		});
		// A commit on the branch, then an uncommitted change: the tree is kept and
		// the branch has work of its own.
		writeFileSync(join(worktreePath, "landed.txt"), "landed\n");
		git(worktreePath, ["add", "-A"]);
		git(worktreePath, ["commit", "-q", "-m", "the work"]);
		writeFileSync(join(worktreePath, "uncommitted.txt"), "bytes\n");

		const results = await reapFinishedWorktrees({} as any, scanCtx(), { dir, selfPid: process.pid });

		expect(results.map((r) => r.outcome)).toEqual(["kept-uncommitted"]);
		expect(existsSync(join(worktreePath, "target", "debug", "artifact"))).toBe(true);
	});

	it("a kept tree whose recorded branch is gone loses its target/ (R6)", async () => {
		const repo = makeRepo();
		const { dir, worktreePath } = entryAt(repo, "kept-gone", join(tempDir("pi-reap-wt-"), "tree"), {
			target: true,
			dirty: true,
			parentCwd: repo,
			branch: "pi-subagent-branch-that-was-abandoned",
			logLastLine: "── Exited (1 turns, exit 1) ──\n",
		});

		const results = await reapFinishedWorktrees({} as any, scanCtx(), { dir, selfPid: process.pid });

		expect(results.map((r) => r.outcome)).toEqual(["kept-uncommitted"]);
		expect(existsSync(worktreePath)).toBe(true);
		expect(existsSync(join(worktreePath, "target"))).toBe(false);
		expect(results[0].detail).toContain("branch gone");
	});
});

describe("the worktree base and the cargo home are separate roots (WO-2026-099)", () => {
	/** A tree under the worktree base and its share of the clone's shared dir
	 *  under a *different* cargo home: the shape the suite now runs in, since the
	 *  preload gives each root its own temp dir. Every row here is red when the
	 *  prune is handed one root for both — attribution then names no clone and the
	 *  share survives. */
	function splitRoots(repoName: string) {
		const base = tempDir("pi-reap-base-");
		const cargoHome = tempDir("pi-reap-home-");
		const worktreePath = join(base, `${repoName}-4add98737109`);
		const deps = join(cargoHome, ".cache", "cargo-target", repoName, "debug", "deps");
		mkdirSync(deps, { recursive: true });
		return { base, cargoHome, worktreePath, deps, depInfo: join(deps, `${repoName}-abc123.d`) };
	}

	/** Point both overrides at the row's two roots; returns the restore. */
	function pointAt(base: string, cargoHome: string): () => void {
		const restoreWtRoot = setEnvForRow(PI_SUBAGENT_WT_ROOT_ENV, base);
		const restoreCargo = setEnvForRow(PI_SUBAGENT_CARGO_HOME_ENV, cargoHome);
		return () => {
			restoreWtRoot();
			restoreCargo();
		};
	}

	it("a bad WT root refuses the reap before it judges a tree", async () => {
		// The pass reads its three roots up front and threads the base down
		// (WO-2026-099 round 4). Read at its two points of use instead — the
		// removal's clone-name derivation, inside its best-effort catch, and the
		// bound's, outside every `try` — this row goes red the other way: the clean,
		// finished tree is removed first (with the prune failure swallowed), and
		// only then does the over-bound measurement reach the base and reject the
		// pass. A refusal after the work is not a refusal.
		const repo = makeRepo();
		const repoName = repo.split("/").pop()!;
		const cargoHome = tempDir("pi-bad-base-home-");
		// A clone dir that exists and measures over the bound, so the bound reaches
		// clone-name attribution instead of returning on an absent cache root.
		mkdirSync(join(cargoHome, ".cache", "cargo-target", repoName), { recursive: true });
		const { dir, worktreePath } = makeEntryFor(repo, "bad-base-1", {
			logLastLine: "── Completed (1 turns, exit 0) ──\n",
		});
		const restore = setEnvForRow(PI_SUBAGENT_WT_ROOT_ENV, "relative/wt");
		try {
			await expect(
				reapFinishedWorktrees({} as any, scanCtx(), {
					dir,
					selfPid: process.pid,
					home: cargoHome,
					sizeOf: () => 25 * 1024 ** 3,
				}),
			).rejects.toThrow(`${PI_SUBAGENT_WT_ROOT_ENV} must be an absolute path, got "relative/wt"`);
			expect(existsSync(worktreePath)).toBe(true);
			expect(worktreeEntry(repo, worktreePath)).not.toBeNull();
		} finally {
			restore();
		}
	});

	it("a reaped tree under the WT root loses its share from a cargo home set elsewhere", async () => {
		const repo = makeRepo();
		const repoName = repo.split("/").pop()!;
		const r = splitRoots(repoName);
		writeFileSync(r.depInfo, `${join(r.deps, `lib${repoName}-abc123.rlib`)}: ${r.worktreePath}/src/lib.rs\n`);
		writeFileSync(join(r.deps, `lib${repoName}-abc123.rlib`), "dead\n");
		const { dir } = makeEntryFor(repo, "split-roots-removed", {
			worktreePath: r.worktreePath,
			logLastLine: "── Completed (1 turns, exit 0) ──\n",
		});

		const restore = pointAt(r.base, r.cargoHome);
		try {
			const results = await reapFinishedWorktrees({} as any, scanCtx(), { dir, selfPid: process.pid });

			expect(results.map((x) => x.outcome)).toEqual(["removed"]);
			expect(existsSync(r.worktreePath)).toBe(false);
			// Route 1, not the coarse pass: the `.d` was attributed to the clone.
			expect(existsSync(r.depInfo)).toBe(false);
			expect(results[0].detail).toContain("(exact)");
		} finally {
			restore();
		}
	});

	it("the bound attributes a gone tree from the WT root, not the cargo home", async () => {
		const repo = makeRepo();
		const repoName = repo.split("/").pop()!;
		const r = splitRoots(repoName);
		// The tree is already gone: only the bound can reach its share.
		writeFileSync(r.depInfo, `${r.worktreePath}/src/lib.rs: ${r.worktreePath}/src/lib.rs\n`);
		const entry = makeEntryFor(repo, "split-roots-bound", {
			worktreePath: join(tempDir("pi-reap-wt-"), "tree"),
			logLastLine: "── Completed (1 turns, exit 0) ──\n",
		});
		// A foreign, dead owner: the reap's own loop skips the meta, so the bound
		// below is the only pass that can act on the path.
		const metaFile = join(entry.dir, "pi-subagent-split-roots-bound.meta.json");
		const meta = JSON.parse(readFileSync(metaFile, "utf8"));
		meta.worktreePath = r.worktreePath;
		meta.ownerPid = process.pid === 1 ? 2 : process.ppid;
		meta.ownerStartToken = "not-our-token";
		writeFileSync(metaFile, JSON.stringify(meta));

		const restore = pointAt(r.base, r.cargoHome);
		try {
			const results = await reapFinishedWorktrees({} as any, scanCtx(), {
				dir: entry.dir,
				selfPid: -1,
				probe: { exists: () => false, startToken: () => null },
				sizeOf: () => 25 * 1024 ** 3,
			});

			expect(results).toEqual([]);
			expect(existsSync(r.depInfo)).toBe(false);
		} finally {
			restore();
		}
	});

	it("an explicit `deps.home` wins over the override", async () => {
		const repo = makeRepo();
		const repoName = repo.split("/").pop()!;
		const r = splitRoots(repoName);
		const overrideHome = tempDir("pi-reap-override-");
		writeFileSync(r.depInfo, `${join(r.deps, `lib${repoName}-abc123.rlib`)}: ${r.worktreePath}/src/lib.rs\n`);
		writeFileSync(join(r.deps, `lib${repoName}-abc123.rlib`), "dead\n");
		const { dir } = makeEntryFor(repo, "deps-home-wins", {
			worktreePath: r.worktreePath,
			logLastLine: "── Completed (1 turns, exit 0) ──\n",
		});

		// The override points at a home with no shared dir; `deps.home` names the
		// one the row's fixture uses, and the row is red if the override wins.
		const restore = pointAt(r.base, overrideHome);
		try {
			const results = await reapFinishedWorktrees({} as any, scanCtx(), {
				dir,
				selfPid: process.pid,
				home: r.cargoHome,
			});

			expect(results.map((x) => x.outcome)).toEqual(["removed"]);
			expect(existsSync(r.depInfo)).toBe(false);
			expect(results[0].detail).toContain("(exact)");
		} finally {
			restore();
		}
	});
});

describe("the reap's cargo home is process-wide, not a per-file setter (WO-2026-099)", () => {
	it("a set-but-unusable value throws, naming the variable and the value", () => {
		for (const bad of ["", "relative/home"]) {
			const restore = setEnvForRow(PI_SUBAGENT_CARGO_HOME_ENV, bad);
			try {
				expect(() => subagentCargoHome()).toThrow(UnusableEnvPathError);
				expect(() => subagentCargoHome()).toThrow(
					`${PI_SUBAGENT_CARGO_HOME_ENV} must be an absolute path, got ${JSON.stringify(bad)}`,
				);
			} finally {
				restore();
			}
		}
	});

	it("unset, it is still the box's own home — the production path", () => {
		const restore = setEnvForRow(PI_SUBAGENT_CARGO_HOME_ENV, undefined);
		try {
			expect(subagentCargoHome()).toBe(homedir());
		} finally {
			restore();
		}
	});

	it("the reap resolves it with no `home` argument, and the refusal is not swallowed", async () => {
		const dir = tempDir("pi-cargo-env-");
		const restore = setEnvForRow(PI_SUBAGENT_CARGO_HOME_ENV, "relative/home");
		try {
			// No `deps.home`: the reap's own resolution is what must refuse, and the
			// rejection must reach the caller instead of becoming an ungoverned scan.
			await expect(
				reapFinishedWorktrees({} as any, scanCtx(), { dir, selfPid: process.pid }),
			).rejects.toThrow(`${PI_SUBAGENT_CARGO_HOME_ENV} must be an absolute path`);
		} finally {
			restore();
		}
	});
});

describe("updateMetaJson keeps the reap marker (wiring)", () => {
	it("round-trips worktreeKept through the meta file", () => {
		writeMetaJson("marker-check", { ownerPid: process.pid });
		updateMetaJson("marker-check", { worktreeKept: { reason: "uncommitted work" } });
		expect((readMetaJson("marker-check") as any).worktreeKept.reason).toBe("uncommitted work");
		unlinkSync(metaPath("marker-check"));
	});
});
