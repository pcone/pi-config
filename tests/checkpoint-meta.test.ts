/**
 * `captureGitBinding`, the git half of extensions/lib/checkpoint-meta.ts.
 *
 * `runGit`'s only hang protection is the `timeout` option on its `execFile`
 * call (GIT_TIMEOUT_MS): a git that never returns must not hold a checkpoint.
 * That promise had no row, so the constant alone survived deleting the option
 * (structure-trend register, WO-2026-057 follow-up) — the hang row below is
 * written to go red when the option goes, and the mutation was checked both
 * ways when it landed (option dropped → this row reds on its witness; restored
 * → green). A version of this row that passes either way is a no-op control.
 *
 * Fixture: a `git` shim first on PATH that logs its argv and then `exec sleep`s.
 * Async `execFile` — what `runGit` uses — sees live `process.env` mutations;
 * only *sync* spawns (`execFileSync`/`spawnSync`) get Bun's startup env
 * snapshot (the note at tests/owner-asks.test.ts's spawnSync row). Probe on
 * bun 1.3.11: the PATH prepend reaches the child. `exec` matters — a shell that
 * forks `sleep` leaves a grandchild holding the stdio pipes.
 *
 * Rows drive the export, not the module-private `runGit`: the "any failure —
 * not a repo, no git binary, timeout — yields null" contract is on the export.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureGitBinding } from "../extensions/lib/checkpoint-meta";

/** Mirror of the module-private GIT_TIMEOUT_MS in extensions/lib/checkpoint-meta.ts; the row bounds its witness around it, it does not import it. */
const GIT_TIMEOUT_MS = 2000;
/** Fails the row below its own timeout, so a hang reports the witness's message, not a budget kill (pi-config#3). */
const HANG_WITNESS_MS = 6000;
/** Comfortably past the witness, so the mutant run's shims die rather than linger. */
const SHIM_SLEEP_SECONDS = 10;
const ROW_TIMEOUT_MS = 30_000;

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@t",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@t",
};

const git = (cwd: string, ...args: string[]): string =>
	execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

const tmpRoots: string[] = [];
/** Copy a template tree onto `dest` (which must not exist), so a row gets its own tree and the
 *  copy keeps the template's `.git` — no `git init`, no `remote set-url`. */
function copyTree(from: string, dest: string): string {
	cpSync(from, dest, { recursive: true });
	return dest;
}
function tmp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `checkpoint-meta-${prefix}-`));
	tmpRoots.push(dir);
	return dir;
}

/** A `git` that records its argv and then hangs: only `runGit`'s timeout can end the call. */
function hangShim(): { dir: string; calls: string } {
	const dir = tmp("shim");
	const calls = join(dir, "calls.log");
	writeFileSync(join(dir, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexec sleep ${SHIM_SLEEP_SECONDS}\n`);
	chmodSync(join(dir, "git"), 0o755);
	return { dir, calls };
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

/** Resolve `p`, or fail with `message()` while it is still pending after `ms` (the thunk so the failure text is built when it fires, not when the row starts). */
function witnessed<T>(p: Promise<T>, ms: number, message: () => string): Promise<T> {
	// A late settlement after the witness fired must not surface as an unhandled rejection.
	p.catch(() => {});
	let timer: ReturnType<typeof setTimeout>;
	const witness = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(message())), ms);
	});
	return Promise.race([p, witness]).finally(() => clearTimeout(timer));
}

const readCalls = (calls: string): string[] =>
	existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").sort() : [];

let repo: string;
/** A bare remote and its clone, each with the base pushed and one commit ahead: the shape the
 *  upstream row needs, built once and copied per row so the row pays no git process. */
let upstreamTemplate: { clone: string; remote: string };

beforeAll(() => {
	repo = tmp("repo");
	git(repo, "init", "-q", "-b", "main");
	writeFileSync(join(repo, "a.txt"), "a\n");
	git(repo, "add", "-A");
	git(repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");

	// The clone's `origin` is `../remote`, a relative path, so a copied pair still points at its
	// own remote and the row needs no `remote set-url` (which would be the git process this
	// template exists to remove). Built at 2026-11-21 in WO-2026-106: 6 git calls a row become 0.
	const holder = tmp("upstream-template");
	const remote = join(holder, "remote");
	const clone = join(holder, "clone");
	mkdirSync(remote);
	mkdirSync(clone);
	git(remote, "init", "-q", "--bare", "-b", "main");
	git(clone, "init", "-q", "-b", "main");
	writeFileSync(join(clone, "a.txt"), "a\n");
	git(clone, "add", "-A");
	git(clone, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base");
	git(clone, "remote", "add", "origin", "../remote");
	git(clone, "push", "-q", "-u", "origin", "main");
	writeFileSync(join(clone, "b.txt"), "b\n");
	git(clone, "add", "-A");
	git(clone, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "ahead");
	upstreamTemplate = { clone, remote };
});

afterAll(() => {
	for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

describe("captureGitBinding: real git", () => {
	it("binds the working tree it is handed", async () => {
		const binding = await captureGitBinding(repo);
		expect(binding).not.toBeNull();
		expect(binding!.head).toBe(git(repo, "rev-parse", "HEAD"));
		expect(binding!.branch).toBe("main");
		expect(binding!.dirty).toBe(false);
		// A scratch repo has no upstream: a stated fact, not a capture failure.
		expect(binding!.aheadBehind).toBeNull();
	}, ROW_TIMEOUT_MS);

	it("counts commits ahead of the upstream, not behind it", async () => {
		// `rev-list --left-right @{upstream}...HEAD` prints "<behind>\t<ahead>";
		// one local commit against a pushed base pins that order (a swap reads
		// behind: 1) without needing a second clone for the behind case.
		const holder = tmp("upstream");
		copyTree(upstreamTemplate.remote, join(holder, "remote"));
		const withUpstream = copyTree(upstreamTemplate.clone, join(holder, "clone"));

		const binding = await captureGitBinding(withUpstream);
		expect(binding!.aheadBehind).toEqual({ ahead: 1, behind: 0 });
	}, ROW_TIMEOUT_MS);
});

describe("captureGitBinding: hung git", () => {
	it("resolves null, because runGit's execFile timeout bounds it", async () => {
		// The shim has to outlive the witness, or a future "faster shim" edit would
		// let the row pass on the shim's own exit without the timeout ever firing.
		expect(SHIM_SLEEP_SECONDS * 1000).toBeGreaterThan(HANG_WITNESS_MS);

		const shim = hangShim();
		const started = Date.now();
		const binding = await withPathPrefix(shim.dir, () =>
			witnessed(captureGitBinding(repo), HANG_WITNESS_MS, () =>
				`captureGitBinding was still pending after ${HANG_WITNESS_MS}ms against a hung git — ` +
				`runGit's execFile \`timeout\` option (GIT_TIMEOUT_MS) is the only thing that bounds it. ` +
				`Shim answers: ${JSON.stringify(readCalls(shim.calls))}`,
			),
		);
		const elapsed = Date.now() - started;

		expect(binding).toBeNull();
		// The shim answered all three calls: had the PATH prepend not reached
		// execFile, real git would have answered and this would be non-null.
		expect(readCalls(shim.calls)).toEqual([
			"rev-list --count --left-right @{upstream}...HEAD",
			"rev-parse --abbrev-ref HEAD",
			"rev-parse HEAD",
			"status --porcelain",
		]);
		// And it hung rather than failing fast: a shim that exits early would
		// resolve null without ever exercising the timeout.
		expect(elapsed).toBeGreaterThanOrEqual(GIT_TIMEOUT_MS * 0.75);
		expect(elapsed).toBeLessThan(HANG_WITNESS_MS);
	}, ROW_TIMEOUT_MS);
});

describe("fixture env hygiene", () => {
	it("leaves the environment as it found it, so later rows still read real git", async () => {
		// Order-independence witness for the hang row above: a PATH restore that
		// leaked (the failure path included) makes this null.
		expect(await captureGitBinding(repo)).not.toBeNull();
	}, ROW_TIMEOUT_MS);

	it("restores PATH when the row body throws, so the failure path leaks nothing", async () => {
		const dir = tmp("leak");
		const saved = process.env.PATH;
		await expect(
			withPathPrefix(dir, async () => {
				expect(process.env.PATH?.startsWith(`${dir}:`)).toBe(true);
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(process.env.PATH).toBe(saved);
	}, ROW_TIMEOUT_MS);
});
