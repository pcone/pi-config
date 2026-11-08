/**
 * Seat checkout sync (extensions/seat-sync.ts + extensions/lib/seat-sync.ts),
 * rows R1–R9 of WO-2026-093.
 *
 * Every row fires the extension's real `session_start` handler against a real
 * git checkout in a temp dir and reads what a human would see — the status note
 * and the warning — plus the report the handler's background task produced.
 * Nothing here is a mock of the decision: the fixtures are a bare remote and
 * clones of it, so "fast-forwarded" means HEAD moved to the pushed commit.
 *
 * The fetch-failure and never-returning-fetch rows put a `git` shim first on
 * PATH: async `execFile`/`execFileSync` see live `process.env` mutations (only
 * sync spawns get Bun's startup env snapshot — see tests/owner-asks.test.ts).
 *
 * The rows after R9 are about the report and the shared fetch: the debug line,
 * print mode, a join into `owner-asks`' background fetch, a ctx that went stale
 * under the task, and git's read/merge failures.
 *
 * Run: bun test tests/seat-sync.test.ts
 */

import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import seatSync, { _testLastReport, _testLastSync, _testSetFetchTimeout } from "../extensions/seat-sync.ts";
import { FETCH_TIMEOUT_MS } from "../extensions/lib/git-fetch.ts";
import { seatScope, type SeatReport } from "../extensions/lib/seat-sync.ts";
import { ownerAsks } from "../extensions/owner-asks/lib.ts";

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@t",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@t",
	GIT_TERMINAL_PROMPT: "0",
};

const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

const git = (cwd: string, ...args: string[]): string =>
	execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

const commit = (cwd: string, message: string): string => {
	git(cwd, "add", "-A");
	git(cwd, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
	return git(cwd, "rev-parse", "HEAD");
};

const tmpRoots: string[] = [];
function tmp(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), `seat-sync-${prefix}-`)));
	tmpRoots.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

/** A bare remote and a clone of it: the seat checkout every row starts from. */
function makeSeat(): { root: string; remote: string } {
	const remote = tmp("remote");
	git(remote, "init", "-q", "--bare", "-b", "main");

	const root = tmp("seat");
	git(root, "init", "-q", "-b", "main");
	writeFileSync(join(root, "a.txt"), "a\n");
	commit(root, "base");
	git(root, "remote", "add", "origin", remote);
	git(root, "push", "-q", "-u", "origin", "main");
	return { root, remote };
}

/** A commit pushed to `remote`'s main from a second clone; returns its sha. */
function pushRemote(remote: string, file: string, message = `add ${file}`): string {
	const other = tmp("other");
	git(other, "clone", "-q", remote, ".");
	writeFileSync(join(other, file), `${file}\n`);
	commit(other, message);
	git(other, "push", "-q", "origin", "HEAD:main");
	return git(other, "rev-parse", "HEAD");
}

// ── Driving the extension ──────────────────────────────────────────────────

interface Surfaces {
	report: SeatReport | undefined;
	statuses: [string, string | undefined][];
	notes: { message: string; level?: string }[];
	/** Wall time the `session_start` handler took to return — the blocking cost. */
	blockingMs: number;
}

function loadExtension(): Record<string, (event: unknown, ctx: unknown) => unknown> {
	const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
	seatSync({ on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers[event] = handler; } } as never);
	return handlers;
}

function fakeCtx(cwd: string) {
	const statuses: [string, string | undefined][] = [];
	const notes: { message: string; level?: string }[] = [];
	return {
		statuses,
		notes,
		ctx: {
			cwd,
			hasUI: true,
			ui: {
				setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
				notify: (message: string, level?: string) => notes.push({ message, level }),
				theme: { fg: (_color: string, text: string) => text },
			},
		},
	};
}

/** Fire `session_start` the way pi does and wait for the task it started. */
async function fire(cwd: string): Promise<Surfaces> {
	const { ctx, statuses, notes } = fakeCtx(cwd);
	const started = Date.now();
	loadExtension().session_start({ type: "session_start", reason: "startup" }, ctx);
	const blockingMs = Date.now() - started;
	await _testLastSync();
	return { report: _testLastReport(), statuses, notes, blockingMs };
}

/** Capture `console.warn` while `body` runs — the print-mode channel. */
async function withWarnCapture<T>(body: () => Promise<T>): Promise<{ value: T; warns: string[] }> {
	const warns: string[] = [];
	const saved = console.warn;
	console.warn = (...args: unknown[]) => {
		warns.push(args.map((arg) => String(arg)).join(" "));
	};
	try {
		return { value: await body(), warns };
	} finally {
		console.warn = saved;
	}
}

/** Resolve once `ready()` holds, or give up after `ms` (the assertion after it then fails). */
async function waitFor(ready: () => boolean, ms: number): Promise<void> {
	const deadline = Date.now() + ms;
	while (!ready() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
}

/** Prepend `dir` to PATH for the duration of `body`, restoring on failure too. */
async function withPathPrefix<T>(dir: string, body: () => Promise<T>): Promise<T> {
	const saved = process.env.PATH;
	process.env.PATH = saved === undefined ? dir : `${dir}:${saved}`;
	try {
		return await body();
	} finally {
		if (saved === undefined) delete process.env.PATH;
		else process.env.PATH = saved;
	}
}

/**
 * A `git` that logs its argv, runs `bodies[subcommand]` when one is given, and
 * delegates to the real git otherwise. A body that must fail exits non-zero.
 */
function gitShim(bodies: Record<string, string> = {}): { dir: string; calls: () => string[] } {
	const dir = tmp("shim");
	const log = join(dir, "calls.log");
	const cases = Object.entries(bodies)
		.map(([verb, body]) => `if [ "$1" = "${verb}" ]; then\n${body}\nfi`)
		.join("\n");
	writeFileSync(join(dir, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n${cases}\nexec '${REAL_GIT}' "$@"\n`);
	chmodSync(join(dir, "git"), 0o755);
	const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter((line) => line !== "") : []);
	return { dir, calls };
}

// ── Rows ───────────────────────────────────────────────────────────────────

describe("R1 clean and behind", () => {
	it("fast-forwards, and HEAD equals the upstream afterwards", async () => {
		const { root, remote } = makeSeat();
		const pushed = pushRemote(remote, "new.txt");

		const { report, statuses, notes } = await fire(root);

		expect(report!.outcome).toBe("fast-forwarded");
		expect(statuses).toEqual([["seat-sync", "seat sync: fast-forwarded 1 commit"]]);
		expect(notes).toEqual([]);
		expect(git(root, "rev-parse", "HEAD")).toBe(pushed);
		expect(git(root, "rev-parse", "HEAD")).toBe(git(root, "rev-parse", "@{u}"));
		// The working tree moved, not just the ref.
		expect(existsSync(join(root, "new.txt"))).toBe(true);
		// The move was the one command the order allows, and no other verb ran.
		expect(report!.commands.at(-1)).toBe("git merge --ff-only @{u}");
		expect(report!.commands.filter((command) => /\b(reset|stash|checkout)\b|--force|--no-ff/.test(command))).toEqual([]);
	}, 60_000);
});

describe("R2 dirty", () => {
	it("does not move, and the warning names the dirty files", async () => {
		const { root, remote } = makeSeat();
		pushRemote(remote, "new.txt");
		const before = git(root, "rev-parse", "HEAD");
		writeFileSync(join(root, "a.txt"), "changed\n");
		writeFileSync(join(root, "junk.txt"), "j\n");

		const { report, statuses, notes } = await fire(root);

		expect(report!.outcome).toBe("blocked");
		expect(report!.status).toBe("seat sync: BLOCKED — 2 dirty files");
		expect(report!.warning).toContain("M a.txt");
		expect(report!.warning).toContain("?? junk.txt");
		expect(report!.warning).toContain("2 dirty files");
		// The warning is a warning, not an info note.
		expect(notes.map((n) => n.level)).toEqual(["warning"]);
		expect(statuses).toEqual([["seat-sync", "seat sync: BLOCKED — 2 dirty files"]]);
		expect(git(root, "rev-parse", "HEAD")).toBe(before);
		expect(existsSync(join(root, "new.txt"))).toBe(false);
		// No fast-forward was attempted at all.
		expect(report!.commands.filter((command) => command.startsWith("git merge"))).toEqual([]);
	}, 60_000);

	it("names ten dirty files and counts the rest", async () => {
		const { root } = makeSeat();
		const before = git(root, "rev-parse", "HEAD");
		for (let i = 0; i < 12; i += 1) writeFileSync(join(root, `junk-${String(i).padStart(2, "0")}.txt`), "j\n");

		const { report } = await fire(root);

		expect(report!.status).toBe("seat sync: BLOCKED — 12 dirty files");
		expect(report!.warning).toContain("junk-09.txt");
		expect(report!.warning).not.toContain("junk-10.txt");
		expect(report!.warning).toContain("… and 2 more");
		expect(git(root, "rev-parse", "HEAD")).toBe(before);
	}, 60_000);
});

describe("R3 ahead", () => {
	it("does not move, and names the commit count and the first three subjects", async () => {
		const { root } = makeSeat();
		const subjects = ["local one", "local two", "local three", "local four"];
		for (const [i, subject] of subjects.entries()) {
			writeFileSync(join(root, `local-${i}.txt`), "l\n");
			commit(root, subject);
		}
		const local = git(root, "rev-parse", "HEAD");

		const { report } = await fire(root);

		expect(report!.outcome).toBe("blocked");
		expect(report!.status).toBe("seat sync: BLOCKED — 4 commits ahead of origin/main");
		expect(report!.warning).toContain("4 commits ahead of origin/main");
		// The cap is three, newest first: the oldest subject is not named.
		for (const subject of subjects.slice(1)) expect(report!.warning).toContain(subject);
		expect(report!.warning).not.toContain(subjects[0]);
		expect(git(root, "rev-parse", "HEAD")).toBe(local);
	}, 60_000);
});

describe("R4 diverged", () => {
	it("does not move, and the warning names both counts", async () => {
		const { root, remote } = makeSeat();
		pushRemote(remote, "theirs.txt");
		writeFileSync(join(root, "local.txt"), "l\n");
		const local = commit(root, "local work only here");

		const { report } = await fire(root);

		expect(report!.outcome).toBe("blocked");
		expect(report!.status).toBe("seat sync: BLOCKED — diverged from origin/main: 1 ahead, 1 behind");
		expect(report!.warning).toContain("1 commit it does not have, 1 commit it does");
		expect(git(root, "rev-parse", "HEAD")).toBe(local);
		expect(report!.commands.filter((command) => command.startsWith("git merge"))).toEqual([]);
	}, 60_000);
});

describe("R5 up to date", () => {
	it("is a no-op with no warning, and spends four git invocations", async () => {
		const { root } = makeSeat();
		const before = git(root, "rev-parse", "HEAD");

		const { report, statuses, notes } = await fire(root);

		expect(report!.outcome).toBe("up-to-date");
		expect(report!.status).toBeUndefined();
		expect(report!.warning).toBeUndefined();
		expect(notes).toEqual([]);
		// The note is cleared rather than set: nothing to say.
		expect(statuses).toEqual([["seat-sync", undefined]]);
		expect(git(root, "rev-parse", "HEAD")).toBe(before);
		// The cost, pinned: upstream probe, fetch, status, counts. No merge.
		expect(report!.commands).toEqual([
			"git rev-parse --abbrev-ref @{u}",
			"git fetch --quiet",
			"git status --porcelain -uall",
			"git rev-list --count --left-right @{u}...HEAD",
		]);
	}, 60_000);
});

describe("R6 a worktree is never a seat", () => {
	it("skips a tree whose .git is a file, spawning no git and saying nothing", async () => {
		const { root } = makeSeat();
		const tree = join(tmp("trees"), `${basename(root)}-wt`);
		git(root, "worktree", "add", "-q", tree, "-b", "elsewhere");
		expect(seatScope(tree)).toEqual({ isSeat: false, reason: "worktree", root: tree });

		// A shim that logs every git invocation: the gate must spawn none.
		const shim = gitShim({ fetch: "exit 0" });
		const { report, statuses, notes } = await withPathPrefix(shim.dir, () => fire(tree));

		expect(report).toBeUndefined();
		expect(statuses).toEqual([]);
		expect(notes).toEqual([]);
		expect(shim.calls()).toEqual([]);
		// The gate ran before anything spawned git: the tree is untouched.
		expect(git(tree, "rev-parse", "--abbrev-ref", "HEAD")).toBe("elsewhere");
	}, 60_000);

	it("skips any checkout beneath a wt/ directory, even a plain clone", async () => {
		const { root } = makeSeat();
		const holder = tmp("holder");
		mkdirSync(join(holder, "wt"), { recursive: true });
		const clone = join(holder, "wt", "hand-made");
		git(holder, "clone", "-q", root, clone);
		expect(seatScope(clone)).toEqual({ isSeat: false, reason: "wt-path", root: clone });

		const { report, statuses } = await fire(clone);

		expect(report).toBeUndefined();
		expect(statuses).toEqual([]);
	}, 60_000);

	it("skips a directory that is not a repository at all", () => {
		const dir = tmp("plain");
		expect(seatScope(dir)).toEqual({ isSeat: false, reason: "not-a-clone", root: dir });
	});
});

describe("R7 no upstream", () => {
	it("skips without a warning, and spends no fetch", async () => {
		const root = tmp("no-upstream");
		git(root, "init", "-q", "-b", "main");
		writeFileSync(join(root, "a.txt"), "a\n");
		commit(root, "base");

		const { report, statuses, notes } = await fire(root);

		expect(report!.outcome).toBe("skipped");
		expect(report!.status).toBeUndefined();
		expect(notes).toEqual([]);
		expect(statuses).toEqual([["seat-sync", undefined]]);
		// Nothing else ran: no fetch, no status read, no merge.
		expect(report!.commands).toEqual(["git rev-parse --abbrev-ref @{u}"]);
	}, 60_000);
});

describe("R8 fetch fails", () => {
	it("attempts no fast-forward, and the warning carries git's stderr", async () => {
		const { root, remote } = makeSeat();
		pushRemote(remote, "new.txt");
		const before = git(root, "rev-parse", "HEAD");
		const shim = gitShim({
			fetch: `echo "fatal: unable to access 'https://example.invalid/x.git': Could not resolve host" >&2\nexit 1`,
		});

		const { report, notes } = await withPathPrefix(shim.dir, () => fire(root));

		expect(report!.outcome).toBe("blocked");
		expect(report!.status).toBe("seat sync: BLOCKED — fetch failed");
		expect(report!.warning).toContain("Could not resolve host");
		expect(notes.map((n) => n.level)).toEqual(["warning"]);
		// The fetch ran through the shim, the fast-forward never did.
		expect(shim.calls()).toContain("fetch --quiet");
		expect(shim.calls().filter((call) => call.startsWith("merge"))).toEqual([]);
		expect(git(root, "rev-parse", "HEAD")).toBe(before);
	}, 60_000);

	it("degrades a fetch that outlives its bound to a warning naming the timeout", async () => {
		// The order's box: 10 s. Pinned because every row below overrides it.
		expect(FETCH_TIMEOUT_MS).toBe(10_000);
		const { root } = makeSeat();
		const shim = gitShim({ fetch: "exec sleep 600" });
		_testSetFetchTimeout(300);
		try {
			const { report } = await withPathPrefix(shim.dir, () => fire(root));
			expect(report!.outcome).toBe("blocked");
			expect(report!.warning).toContain("timed out after 300ms");
			expect(shim.calls().filter((call) => call.startsWith("merge"))).toEqual([]);
		} finally {
			_testSetFetchTimeout(undefined);
		}
	}, 60_000);
});

describe("R9 the first prompt is not delayed", () => {
	it("returns from session_start while the fetch is still running, then reports", async () => {
		const { root } = makeSeat();
		const shim = gitShim({ fetch: "exec sleep 600" });
		_testSetFetchTimeout(2_000);
		try {
			await withPathPrefix(shim.dir, async () => {
				const { ctx, statuses, notes } = fakeCtx(root);
				const handlers = loadExtension();
				const started = Date.now();
				const returned = handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
				const elapsed = Date.now() - started;

				// The handler is synchronous and hands the work to a task: pi awaits
				// the handler before the first prompt (agent-session.js:2680), and a
				// fetch that never returns must not be part of that await.
				expect(returned).toBeUndefined();
				expect(elapsed).toBeLessThan(250);
				expect(statuses).toEqual([]);

				// The fetch is still hanging here — nothing has been decided. (The shim
				// has to have been started first: spawn hands the child its environment
				// but the child writes its own log line a moment later.)
				await waitFor(() => shim.calls().includes("fetch --quiet"), 1_000);
				expect(shim.calls()).toContain("fetch --quiet");
				expect(statuses).toEqual([]);
				expect(shim.calls().filter((call) => call.startsWith("merge"))).toEqual([]);

				const settledAt = Date.now();
				await _testLastSync();
				// The report lands off the turn path, once the bound kills the fetch.
				expect(Date.now() - settledAt).toBeGreaterThanOrEqual(500);
				expect(statuses).toEqual([["seat-sync", "seat sync: BLOCKED — fetch failed"]]);
				expect(notes[0].message).toContain("timed out after 2000ms");
			});
		} finally {
			_testSetFetchTimeout(undefined);
		}
	}, 60_000);
});

describe("the debug line", () => {
	it("names the five commands only when PI_SEAT_SYNC_DEBUG=1", async () => {
		const saved = process.env.PI_SEAT_SYNC_DEBUG;
		try {
			const on = makeSeat();
			pushRemote(on.remote, "new.txt");
			process.env.PI_SEAT_SYNC_DEBUG = "1";
			const debugged = await fire(on.root);

			expect(debugged.report!.outcome).toBe("fast-forwarded");
			expect(debugged.blockingMs).toBeLessThan(100);
			expect(debugged.notes).toEqual([
				{
					message:
						"[seat-sync] fast-forwarded: fast-forwarded 1 commit; commands: " +
						"git rev-parse --abbrev-ref @{u} ; git fetch --quiet ; " +
						"git status --porcelain -uall ; git rev-list --count --left-right @{u}...HEAD ; " +
						"git merge --ff-only @{u}",
					level: "info",
				},
			]);

			// The same five commands, with the variable unset: nothing but the status note.
			delete process.env.PI_SEAT_SYNC_DEBUG;
			const off = makeSeat();
			pushRemote(off.remote, "new.txt");
			const silent = await fire(off.root);

			expect(silent.report!.commands).toEqual(debugged.report!.commands);
			expect(silent.notes).toEqual([]);
			expect(silent.statuses).toEqual([["seat-sync", "seat sync: fast-forwarded 1 commit"]]);
		} finally {
			if (saved === undefined) delete process.env.PI_SEAT_SYNC_DEBUG;
			else process.env.PI_SEAT_SYNC_DEBUG = saved;
		}
	}, 60_000);
});

describe("print/RPC mode (no UI)", () => {
	it("sends the warning to stderr and never touches the status line", async () => {
		const { root, remote } = makeSeat();
		pushRemote(remote, "new.txt");
		const before = git(root, "rev-parse", "HEAD");
		writeFileSync(join(root, "a.txt"), "changed\n");

		const { ctx, statuses, notes } = fakeCtx(root);
		ctx.hasUI = false;
		const started = Date.now();
		const { value, warns } = await withWarnCapture(async () => {
			loadExtension().session_start({ type: "session_start", reason: "startup" }, ctx);
			const blockingMs = Date.now() - started;
			await _testLastSync();
			return { report: _testLastReport(), blockingMs };
		});

		expect(value.blockingMs).toBeLessThan(100);
		expect(value.report!.outcome).toBe("blocked");
		// The one thing the report exists to say survives the missing UI.
		expect(warns).toHaveLength(1);
		expect(warns[0]).toContain("has 1 dirty file and was not fast-forwarded");
		expect(warns[0]).toContain("M a.txt");
		// Neither the status bar nor a notification exists, and neither is called.
		expect(statuses).toEqual([]);
		expect(notes).toEqual([]);
		expect(git(root, "rev-parse", "HEAD")).toBe(before);
	}, 60_000);
});

describe("one fetch in flight per checkout", () => {
	it("joins owner-asks' background fetch, spawns no second one, and says it has no stderr to quote", async () => {
		const { root, remote } = makeSeat();
		// A registry repo, so `ownerAsks` starts the checkout's fetch...
		mkdirSync(join(root, "scripts"), { recursive: true });
		writeFileSync(join(root, "scripts", "reviews_status.py"), 'import sys\nsys.stdout.write(open("asks.txt").read())\n');
		writeFileSync(join(root, "asks.txt"), "docs/reviews/a.md  A1  soon  first\n");
		git(root, "add", "-A");
		commit(root, "registry scripts");
		git(root, "push", "-q", "origin", "HEAD:main");
		// ...and something to fast-forward to, which this fetch's failure blocks.
		pushRemote(remote, "new.txt");
		const shim = gitShim({ fetch: "sleep 1\nexit 1" });
		const cache = join(tmp("cache"), "owner-asks");

		const { report } = await withPathPrefix(shim.dir, async () => {
			const state = await ownerAsks(root, cache);
			expect(state!.asks).toHaveLength(1);
			// owner-asks' fetch is detached and still sleeping: seat-sync arrives mid-fetch.
			await waitFor(() => shim.calls().includes("fetch --quiet"), 2_000);
			expect(shim.calls()).toContain("fetch --quiet");

			const surfaces = await fire(root);
			// Exactly one fetch: seat-sync joined the running one instead of spawning another.
			expect(shim.calls().filter((call) => call === "fetch --quiet")).toHaveLength(1);
			expect(surfaces.blockingMs).toBeLessThan(100);
			return surfaces;
		});

		expect(report!.outcome).toBe("blocked");
		expect(report!.status).toBe("seat sync: BLOCKED — fetch failed");
		// A background fetch captures no stderr, so the join says that rather than nothing.
		expect(report!.warning).toBe(
			`seat sync: BLOCKED — git fetch --quiet failed in ${root} (stderr not captured: joined a background fetch)`,
		);
		expect(report!.commands).not.toContain("git merge --ff-only @{u}");
	}, 60_000);
});

describe("a stale ctx", () => {
	it("resolves the task quietly when hasUI/ui throw after cwd was read", async () => {
		const { root, remote } = makeSeat();
		const pushed = pushRemote(remote, "new.txt");
		const stale = {
			cwd: root,
			get hasUI(): boolean {
				throw new Error("this session is no longer active");
			},
			get ui(): never {
				throw new Error("this session is no longer active");
			},
		};

		const { value, warns } = await withWarnCapture(async () => {
			loadExtension().session_start({ type: "session_start", reason: "startup" }, stale as never);
			await _testLastSync();
			return _testLastReport();
		});

		// The sync itself still did its work; only the drawing had nowhere to go.
		expect(value!.outcome).toBe("fast-forwarded");
		expect(git(root, "rev-parse", "HEAD")).toBe(pushed);
		expect(warns.filter((line) => line.includes("[seat-sync] report failed"))).toEqual([]);
	}, 60_000);
});

describe("git read and merge failures", () => {
	it("reads the tree: a failing status is a blocked report carrying its stderr", async () => {
		const { root, remote } = makeSeat();
		pushRemote(remote, "new.txt");
		const before = git(root, "rev-parse", "HEAD");
		const shim = gitShim({ status: `echo "fatal: index file smaller than expected" >&2\nexit 128` });

		const { report, notes } = await withPathPrefix(shim.dir, () => fire(root));

		expect(report!.outcome).toBe("blocked");
		expect(report!.status).toBe("seat sync: BLOCKED — cannot read the working tree");
		expect(report!.warning).toContain("index file smaller than expected");
		expect(notes.map((n) => n.level)).toEqual(["warning"]);
		expect(report!.commands.filter((command) => command.startsWith("git merge"))).toEqual([]);
		expect(git(root, "rev-parse", "HEAD")).toBe(before);
	}, 60_000);

	it("counts the divergence: a failing rev-list is a blocked report carrying its stderr", async () => {
		const { root, remote } = makeSeat();
		pushRemote(remote, "new.txt");
		const before = git(root, "rev-parse", "HEAD");
		const shim = gitShim({ "rev-list": `echo "fatal: bad revision '@{u}...HEAD'" >&2\nexit 128` });

		const { report } = await withPathPrefix(shim.dir, () => fire(root));

		expect(report!.outcome).toBe("blocked");
		expect(report!.status).toBe("seat sync: BLOCKED — cannot read the upstream divergence");
		expect(report!.warning).toContain("bad revision");
		expect(report!.commands.filter((command) => command.startsWith("git merge"))).toEqual([]);
		expect(git(root, "rev-parse", "HEAD")).toBe(before);
	}, 60_000);

	it("a failing merge is a blocked report, never a claimed fast-forward", async () => {
		const { root, remote } = makeSeat();
		pushRemote(remote, "new.txt");
		const before = git(root, "rev-parse", "HEAD");
		const shim = gitShim({ merge: `echo "fatal: Not possible to fast-forward, aborting." >&2\nexit 128` });

		const { report, statuses, notes } = await withPathPrefix(shim.dir, () => fire(root));

		expect(report!.outcome).toBe("blocked");
		expect(report!.reason).toBe("fast-forward failed");
		expect(report!.status).toBe("seat sync: BLOCKED — fast-forward failed");
		expect(report!.warning).toContain("Not possible to fast-forward");
		expect(statuses).toEqual([["seat-sync", "seat sync: BLOCKED — fast-forward failed"]]);
		expect(notes.map((n) => n.level)).toEqual(["warning"]);
		expect(report!.commands.at(-1)).toBe("git merge --ff-only @{u}");
		expect(git(root, "rev-parse", "HEAD")).toBe(before);
	}, 60_000);
});
