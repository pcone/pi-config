/**
 * Owner asks (extensions/owner-asks): the counting logic in lib.ts and the
 * Claude Code statusline CLI. Fixtures are real git repos with a fake
 * scripts/reviews_status.py that prints asks.txt (read from the --ref commit when
 * one is given), so assertions are about the contract, not tfd's registry.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import loadExtension from "../extensions/owner-asks/index.ts";
import { ack, attention, countText, fableAge, list, ownerAsks } from "../extensions/owner-asks/lib.ts";
import { childEnv, scrubSubagentEnv } from "./helpers/subagent-env.ts";

const CLI = join(import.meta.dir, "..", "extensions", "owner-asks", "external.ts");

const FAKE_SCRIPT = `
import subprocess, sys
args = sys.argv[1:]
ref = args[args.index("--ref") + 1] if "--ref" in args else None
with open("runs.log", "a") as f:
    f.write(f"{ref}\\n")
if ref:
    text = subprocess.run(["git", "show", f"{ref}:asks.txt"], capture_output=True, text=True, check=True).stdout
else:
    text = open("asks.txt").read()
sys.stdout.write(text)
`;

// Logs each call to record-runs.log (the subcommand and --ref), then prints unruled.txt (read at --ref when given).
const FAKE_RECORD_SCRIPT = `
import subprocess, sys
args = sys.argv[1:]
ref = args[args.index("--ref") + 1] if "--ref" in args else None
with open("record-runs.log", "a") as f:
    f.write(f"{args[0]} {ref}\\n")
if ref:
    text = subprocess.run(["git", "show", f"{ref}:unruled.txt"], capture_output=True, text=True, check=True).stdout
else:
    text = open("unruled.txt").read()
sys.stdout.write(text)
`;

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@t",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@t",
};

const DAY_MS = 86_400_000;
/** `git` with an extra environment — the committer date is what the sweep age reads. */
const gitAt = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string =>
	execFileSync("git", args, { cwd, env: { ...GIT_ENV, ...env }, encoding: "utf8" }).trim();
const git = (cwd: string, ...args: string[]): string =>
	execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

const tmpRoots: string[] = [];
function tmp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `owner-asks-${prefix}-`));
	tmpRoots.push(dir);
	return dir;
}

/**
 * A git repo on `main` with the given asks, optionally a registry script, optionally a pushed upstream,
 * and, when `unruled` is given, a fake scripts/wo_record.py printing those lines.
 */
function makeRepo(
	asks: string,
	{
		registry = true,
		upstream = false,
		unruled = null,
	}: { registry?: boolean; upstream?: boolean; unruled?: string | null } = {},
): { root: string; cache: string } {
	const root = realpathSync(tmp("repo"));
	git(root, "init", "-q", "-b", "main");
	if (registry) {
		mkdirSync(join(root, "scripts"));
		writeFileSync(join(root, "scripts", "reviews_status.py"), FAKE_SCRIPT);
	}
	if (unruled !== null) {
		mkdirSync(join(root, "scripts"), { recursive: true });
		writeFileSync(join(root, "scripts", "wo_record.py"), FAKE_RECORD_SCRIPT);
		writeFileSync(join(root, "unruled.txt"), unruled);
	}
	writeFileSync(join(root, "asks.txt"), asks);
	git(root, "add", "-A");
	git(root, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
	if (upstream) {
		const bare = tmp("remote");
		git(bare, "init", "-q", "--bare");
		git(root, "remote", "add", "origin", bare);
		git(root, "push", "-q", "-u", "origin", "main");
	}
	return { root, cache: join(tmp("cache"), "owner-asks") };
}

const ASKS_AB = "docs/reviews/a.md  A1  soon  first\ndocs/reviews/a.md  A2  soon  second\n";

// The extension skips registration under a subagent (index.ts's PI_SUBAGENT_DEPTH
// guard), and one test spawns a `bun -e` subprocess that inherits the var — so the
// suite must sanitize it to be green from inside a subagent, where the reviewers
// run. Snapshot/unset in beforeAll, restore in afterAll (tests/helpers/subagent-env.ts).
let restoreSubagentEnv: () => void = () => {};

beforeAll(() => {
	restoreSubagentEnv = scrubSubagentEnv();
});

afterAll(() => {
	restoreSubagentEnv();
	for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

describe("owner asks: new = open - seen", () => {
	it("flags only asks added since the last ack, and ack clears them", async () => {
		const { root, cache } = makeRepo(ASKS_AB);
		const first = await ownerAsks(root, cache);
		expect(first!.asks.map((a) => [a.key, a.isNew])).toEqual([
			["docs/reviews/a.md#A1", false],
			["docs/reviews/a.md#A2", false],
		]);

		writeFileSync(join(root, "asks.txt"), ASKS_AB + "docs/reviews/b.md  B1  later  third\n");
		const second = await ownerAsks(root, cache);
		expect(second!.asks.map((a) => [a.key, a.isNew])).toEqual([
			["docs/reviews/a.md#A1", false],
			["docs/reviews/a.md#A2", false],
			["docs/reviews/b.md#B1", true],
		]);
		expect(countText(second!.asks)).toBe("owner asks: 3 open · 1 new");

		expect(await list(root, cache)).toEqual([
			"docs/reviews/b.md  B1  later  third",
			"docs/reviews/a.md  A1  soon  first",
			"docs/reviews/a.md  A2  soon  second",
		]);

		await ack(root, cache);
		const acked = await ownerAsks(root, cache);
		expect(acked!.asks.some((a) => a.isNew)).toBe(false);
		expect(countText(acked!.asks)).toBe("owner asks: 3 open");
	}, 30_000);
});

describe("owner asks: first run", () => {
	it("seeds the seen set with the current open asks, so nothing is new", async () => {
		const { root, cache } = makeRepo(ASKS_AB);
		const state = await ownerAsks(root, cache);
		expect(state!.asks.every((a) => !a.isNew)).toBe(true);
		const [seenFile] = readdirSync(cache).filter((f) => f.endsWith(".seen"));
		expect(JSON.parse(fs.readFileSync(join(cache, seenFile), "utf8"))).toEqual([
			"docs/reviews/a.md#A1",
			"docs/reviews/a.md#A2",
		]);
	}, 30_000);
});

describe("owner asks: cache by upstream sha", () => {
	it("runs the script once per upstream sha and reads the ref it names", async () => {
		const { root, cache } = makeRepo(ASKS_AB, { upstream: true });
		const firstSha = git(root, "rev-parse", "@{u}");
		await ownerAsks(root, cache);
		await ownerAsks(root, cache);
		const runs = () => fs.readFileSync(join(root, "runs.log"), "utf8").trim().split("\n");
		expect(runs()).toEqual([firstSha]);

		writeFileSync(join(root, "asks.txt"), ASKS_AB + "docs/reviews/b.md  B1  later  third\n");
		git(root, "-c", "commit.gpgsign=false", "commit", "-q", "-am", "add B1");
		git(root, "push", "-q", "origin", "main");
		const sha = git(root, "rev-parse", "HEAD");

		const state = await ownerAsks(root, cache);
		expect(runs()).toEqual([firstSha, sha]);
		const b1 = state!.asks.find((a) => a.key === "docs/reviews/b.md#B1");
		expect(b1?.isNew).toBe(true);
	}, 30_000);
});

describe("owner asks: non-registry repos", () => {
	it("returns null for a repo without scripts/reviews_status.py, and for a non-git dir", async () => {
		const { root, cache } = makeRepo(ASKS_AB, { registry: false });
		expect(await ownerAsks(root, cache)).toBeNull();
		expect(await list(root, cache)).toBeNull();
		expect(await ack(root, cache)).toBeNull();

		const bare = realpathSync(tmp("plain"));
		expect(await ownerAsks(bare, cache)).toBeNull();
	}, 30_000);
});

describe("owner asks: statusline CLI", () => {
	const statusline = (input: object, home: string) =>
		spawnSync(process.execPath, [CLI, "statusline"], {
			input: JSON.stringify(input),
			env: childEnv({ HOME: home }),
			encoding: "utf8",
		});

	it("prints dir · branch · asks for a registry repo", () => {
		const { root } = makeRepo(ASKS_AB);
		const home = tmp("home");
		const out = statusline({ workspace: { current_dir: root } }, home);
		expect(out.status).toBe(0);
		expect(out.stdout).toBe(`${basename(root)} · main · owner asks: 2 open\n`);
	}, 30_000);

	it("prints only dir · branch outside a registry repo", () => {
		const { root } = makeRepo(ASKS_AB, { registry: false });
		const out = statusline({ cwd: root }, tmp("home"));
		expect(out.stdout).toBe(`${basename(root)} · main\n`);
	}, 30_000);
});

/** session_start fires its refresh without awaiting it; a registry repo's status lands after its git and script calls. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
/** Bounded poll — the draw path spawns git/python3, which takes seconds on a
 * loaded machine; a fixed sleep races it. Still fails when nothing arrives. */
const waitFor = async (ready: () => boolean, ms = 20_000): Promise<void> => {
	const deadline = Date.now() + ms;
	while (!ready()) {
		if (Date.now() > deadline) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
};

describe("owner asks: pi extension wiring", () => {
	it("does not register handlers in a subagent session (the depth guard)", () => {
		const restore = scrubSubagentEnv();
		process.env.PI_SUBAGENT_DEPTH = "1";
		try {
			const handlers: Record<string, unknown> = {};
			loadExtension({ on: (event: string, handler: unknown) => { handlers[event] = handler; } } as never);
			expect(Object.keys(handlers)).toHaveLength(0);
		} finally {
			restore();
		}
	});

	it("clears the status outside a registry repo, and /asks reports that instead of acking", async () => {
		const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
		const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> = {};
		const pi = {
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				handlers[event] = handler;
			},
			registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
				commands[name] = opts;
			},
		};
		const statuses: (string | undefined)[] = [];
		const notes: string[] = [];
		const { root } = makeRepo(ASKS_AB, { registry: false });
		const ctx = {
			cwd: root,
			hasUI: true,
			ui: {
				setStatus: (_key: string, text: string | undefined) => statuses.push(text),
				theme: { fg: (_color: string, text: string) => text },
				notify: (text: string) => notes.push(text),
			},
		};
		loadExtension(pi as never);
		handlers.session_start({}, ctx);
		await settle();
		expect(statuses).toHaveLength(1);
		expect(statuses[0]).toBeUndefined();

		await commands.asks.handler("", ctx);
		expect(notes).toEqual(["not a registry repo (no scripts/reviews_status.py)"]);

		// session_shutdown clears the 60 s timer; without it the test process would not exit.
		await handlers.session_shutdown({}, ctx);
	}, 30_000);

	it("stays silent without a UI (print mode), so no timer keeps the process alive", async () => {
		const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
		const pi = {
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				handlers[event] = handler;
			},
			registerCommand: () => {},
		};
		const statuses: unknown[] = [];
		const { root } = makeRepo(ASKS_AB);
		loadExtension(pi as never);
		handlers.session_start({}, {
			cwd: root,
			hasUI: false,
			ui: { setStatus: (_key: string, text: unknown) => statuses.push(text) },
		});
		await settle();
		await handlers.session_shutdown({}, {});
		expect(statuses).toHaveLength(0);
	}, 30_000);
	it("does not hold a print-mode process open (the 60 s interval is never started)", () => {
		const { root } = makeRepo(ASKS_AB);
		const code = `
			const handlers = {};
			const pi = { on: (e, h) => { handlers[e] = h; }, registerCommand: () => {} };
			const { default: ext } = await import(${JSON.stringify(join(import.meta.dir, "..", "extensions", "owner-asks", "index.ts"))});
			ext(pi);
			await handlers.session_start({}, { cwd: ${JSON.stringify(root)}, hasUI: false, ui: {} });
		`;
		// Bun's spawnSync without an explicit env option gives the child the
		// STARTUP env snapshot — the scrub's deletions never reach it, so hand the
		// child the live env (`childEnv`), or its own depth guard fires and the
		// extension registers no handlers.
		const run = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", timeout: 10_000, env: childEnv() });
		expect(run.error).toBeUndefined();
		expect(run.status).toBe(0);
	}, 30_000);
});

describe("owner asks: fable sweep count", () => {
	const MARKER = "docs/fable-sweeps.md";

	/** `n` first-parent landings on top of `from`: a merge each, the shape one work order lands in.
	 *  `dates[i]` sets the i-th landing's committer date, and `paths[i]` the files it changes (one
	 *  default code file), so both the age and the non-code filter have something to read. */
	function land(root: string, from: string, n: number, dates: number[] = [], paths: string[][] = []): string {
		let tip = from;
		for (let i = 1; i <= n; i++) {
			const env = i <= dates.length ? { GIT_COMMITTER_DATE: new Date(dates[i - 1]).toISOString() } : {};
			for (const rel of paths[i - 1] ?? [`src/landing-${i}.ts`]) {
				mkdirSync(join(root, dirname(rel)), { recursive: true });
				writeFileSync(join(root, rel), `// ${rel} ${i}\n`);
			}
			git(root, "add", "-A");
			const tree = git(root, "write-tree");
			const topic = gitAt(root, env, "commit-tree", tree, "-p", tip, "-m", `work ${i}`);
			tip = gitAt(root, env, "commit-tree", tree, "-p", tip, "-p", topic, "-m", `land ${i}`);
			git(root, "update-ref", "HEAD", tip);
		}
		return tip;
	}

	function writeMarker(root: string, sha: string, extra = ""): void {
		mkdirSync(join(root, "docs"), { recursive: true });
		writeFileSync(join(root, MARKER), `---\nreviewed_through: ${sha}\nreviewed_by: fable\n${extra}---\n\nsweeps\n`);
	}

	/** Commit the marker file and push it. The commit itself changes only `.md`. */
	function commitMarker(root: string, extra = ""): void {
		git(root, "add", "-A");
		git(root, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "marker");
		git(root, "push", "-q", "origin", "main");
	}

	it("counts the first-parent landings between the marker and the upstream tip", async () => {
		const { root, cache } = makeRepo(ASKS_AB, { upstream: true });
		const base = git(root, "rev-parse", "HEAD");
		writeMarker(root, base);
		const nowMs = Date.now();
		git(root, "add", "-A");
		// The commit that carries the marker is the oldest unreviewed landing, six days old: the
		// age has to come from the first first-parent commit after the marker, which is that one.
		gitAt(root, { GIT_COMMITTER_DATE: new Date(nowMs - 6 * DAY_MS).toISOString() },
			"-c", "commit.gpgsign=false", "commit", "-q", "-m", "marker");
		git(root, "push", "-q", "origin", "main");
		const marked = git(root, "rev-parse", "HEAD");
		const tip = land(root, marked, 3, [nowMs - 3_600_000, nowMs - 3_600_000, nowMs - 3_600_000]);
		git(root, "push", "-q", "origin", "main");

		const state = await ownerAsks(root, cache);
		// Four, not three: the commit that carries the marker is itself a landing after it.
		expect(state!.fable).toMatchObject({ kind: "count", unreviewed: 4 });
		// One merge is one landing: a count that also walked the merged-in commits would read 7.
		expect(git(root, "rev-list", "--count", `${base}..${tip}`)).toBe("7");
		expect(countText(state!.asks, state!.unruled.length, state!.fable)).toBe(
			"owner asks: 2 open · fable: 4 unreviewed · 6d",
		);
	}, 30_000);

	it("says the sweep is complete when nothing is unreviewed", () => {
		// Zero is reachable after a force-push that lands the marker on a commit no longer in the
		// first-parent range, so the state is real; pinning it here keeps the text off a repo
		// shape that cannot be built (a marker cannot name its own commit).
		expect(countText([], 0, { kind: "reviewed" })).toBe("owner asks: 0 open · fable: reviewed");
	});

	it("formats the age in minutes under an hour, hours under two days, days beyond", () => {
		expect(fableAge(0)).toBe("0m");
		expect(fableAge(59_000)).toBe("0m");
		expect(fableAge(42 * 60_000)).toBe("42m");
		expect(fableAge(3_600_000)).toBe("1h");
		expect(fableAge(47 * 3_600_000)).toBe("47h");
		expect(fableAge(2 * DAY_MS)).toBe("2d");
		expect(fableAge(6 * DAY_MS + 5 * 3_600_000)).toBe("6d");
		// A commit dated in the future is not a negative age.
		expect(fableAge(-5_000)).toBe("0m");
	});

	it("does not count a landing that changes only non-code paths, and reads the list from the file", async () => {
		const { root, cache } = makeRepo(ASKS_AB, { upstream: true });
		const NON_CODE = 'non_code: ["*.md", "*.cases", "scripts/*_baseline.json"]\n';
		writeMarker(root, git(root, "rev-parse", "HEAD"), NON_CODE);
		commitMarker(root);
		const marked = git(root, "rev-parse", "HEAD");
		const nowMs = Date.now();
		const tip = land(
			root,
			marked,
			4,
			[nowMs - 5 * DAY_MS, nowMs - 2 * DAY_MS, nowMs - 3_600_000, nowMs - 3_600_000],
			makePaths(),
		);
		git(root, "push", "-q", "origin", "main");
		function makePaths(): string[][] {
			return [
				["docs/notes.md"], // .md: non-code, the only thing it touches
				["src/parser.ts"], // code
				["scripts/dup_baseline.json", "tests/fixtures/x.cases"], // both non-code, listed
				["src/codegen.ts", "docs/notes.md"], // one code path is enough to count
			];
		}

		const state = await ownerAsks(root, cache);
		// Four landings, two counted: the docs-only one and the all-listed one are skipped, and the
		// mixed landing counts because one path is code. The marker commit is `.md` only → skipped.
		expect(state!.fable).toMatchObject({ kind: "count", unreviewed: 2 });
		// The age is the oldest *counted* landing: the five-day one is the docs landing the filter
		// skips, so the two-day code landing is the oldest that still counts.
		expect(countText(state!.asks, 0, state!.fable)).toBe("owner asks: 2 open · fable: 2 unreviewed · 2d");
		// A `.json` outside the listed shape counts: the list is read from the file, not inferred.
		expect(git(root, "log", "--first-parent", "--format=%s", `${marked}..${tip}`)).toContain("land 1");
	}, 30_000);

	it("reads a merge's first-parent diff, not the diff against its other parent", async () => {
		const { root, cache } = makeRepo(ASKS_AB, { upstream: true });
		writeMarker(root, git(root, "rev-parse", "HEAD"), 'non_code: ["*.md"]\n');
		commitMarker(root);
		const marked = git(root, "rev-parse", "HEAD");

		// The mainline commits a code file; the topic documents something. The merge therefore
		// changes only `docs/` against its first parent, and only `src/` against its second — the
		// shape that tells the two diff readings apart.
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
		git(root, "add", "-A");
		git(root, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "code on the mainline");
		const mainline = git(root, "rev-parse", "HEAD");

		const topicTree = git(root, "write-tree");
		mkdirSync(join(root, "docs"), { recursive: true });
		writeFileSync(join(root, "docs/only.md"), "docs\n");
		git(root, "add", "-A");
		const docsTree = git(root, "write-tree");
		const topic = git(root, "commit-tree", docsTree, "-p", marked, "-m", "docs work");
		const merged = git(root, "commit-tree", docsTree, "-p", mainline, "-p", topic, "-m", "land docs");
		git(root, "update-ref", "HEAD", merged);
		git(root, "push", "-q", "origin", "main");

		const state = await ownerAsks(root, cache);
		// The docs merge is skipped; the mainline code commit counts; the marker commit is `.md`.
		expect(state!.fable).toMatchObject({ kind: "count", unreviewed: 1 });
	}, 30_000);

	it("reaches reviewed when the marker's own docs landing is the only unswept one", async () => {
		const { root, cache } = makeRepo(ASKS_AB, { upstream: true });
		writeMarker(root, git(root, "rev-parse", "HEAD"), 'non_code: ["*.md"]\n');
		commitMarker(root);

		// The sweep's marker commit touches only `docs/fable-sweeps.md`, so R98's filter skips it and
		// nothing is left to review — the case a marker alone could not reach before.
		const state = await ownerAsks(root, cache);
		expect(state!.fable).toEqual({ kind: "reviewed" });
		expect(countText(state!.asks, 0, state!.fable)).toBe("owner asks: 2 open · fable: reviewed");
	}, 30_000);

	it("warns on a non_code key that names no list", async () => {
		const { root, cache } = makeRepo(ASKS_AB, { upstream: true });
		writeMarker(root, git(root, "rev-parse", "HEAD"), "non_code: {}\n");
		commitMarker(root);
		const state = await ownerAsks(root, cache);
		expect(state!.fable).toEqual({ kind: "invalid" });
		expect(attention(state!)).toBe(true);
	}, 30_000);

	it("counts every landing when the file has no non_code key", async () => {
		const { root, cache } = makeRepo(ASKS_AB, { upstream: true });
		writeMarker(root, git(root, "rev-parse", "HEAD"));
		commitMarker(root);
		land(root, git(root, "rev-parse", "HEAD"), 2, [], [["docs/only.md"], ["docs/also.md"]]);
		git(root, "push", "-q", "origin", "main");
		// No list to read: the marker commit and both docs landings count, as they did before R98.
		expect((await ownerAsks(root, cache))!.fable).toMatchObject({ kind: "count", unreviewed: 3 });
	}, 30_000);

	it("shows nothing when the upstream carries no marker file", async () => {
		const { root, cache } = makeRepo(ASKS_AB, { upstream: true });
		const state = await ownerAsks(root, cache);
		expect(state!.fable).toBeNull();
		expect(countText(state!.asks, 0, state!.fable)).toBe("owner asks: 2 open");
	}, 30_000);

	it("shows nothing when the file has no reviewed_through key", async () => {
		const { root, cache } = makeRepo(ASKS_AB, { upstream: true });
		mkdirSync(join(root, "docs"), { recursive: true });
		writeFileSync(join(root, MARKER), "---\nreviewed_by: fable\n---\n");
		git(root, "add", "-A");
		git(root, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "marker");
		git(root, "push", "-q", "origin", "main");
		expect((await ownerAsks(root, cache))!.fable).toBeNull();
	}, 30_000);

	it("warns on a marker that is not a sha, and on one that is not an ancestor of the upstream", async () => {
		const { root, cache } = makeRepo(ASKS_AB, { upstream: true });
		const base = git(root, "rev-parse", "HEAD");
		// A sibling line: a commit the upstream does not contain.
		const side = git(root, "commit-tree", `${base}^{tree}`, "-p", base, "-m", "side");
		for (const marker of ["not-a-sha", side]) {
			writeMarker(root, marker);
			git(root, "add", "-A");
			git(root, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "marker");
			git(root, "push", "-q", "origin", "main");
			const state = await ownerAsks(root, cache);
			expect(state!.fable).toEqual({ kind: "invalid" });
			expect(countText(state!.asks, 0, state!.fable)).toBe("owner asks: 2 open · fable: marker invalid");
			// The count alone is informational; an unusable marker is the warning.
			expect(attention(state!)).toBe(true);
		}
	}, 30_000);

	it("reads the marker at the upstream, not the working tree", async () => {
		const { root, cache } = makeRepo(ASKS_AB, { upstream: true });
		const base = git(root, "rev-parse", "HEAD");
		writeMarker(root, base);
		git(root, "add", "-A");
		git(root, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "marker");
		git(root, "push", "-q", "origin", "main");
		land(root, git(root, "rev-parse", "HEAD"), 2);
		git(root, "push", "-q", "origin", "main");

		// An uncommitted local edit that would read as fully swept, and a local commit nothing pushed.
		writeMarker(root, git(root, "rev-parse", "@{u}"));
		expect((await ownerAsks(root, cache))!.fable).toMatchObject({ kind: "count", unreviewed: 3 });
	}, 30_000);
});

describe("owner asks: work-order departures", () => {
	const UNRULED = "WO-2026-001 D1 Changed the mechanism.\nWO-2026-002 D2 Skipped Y.\n";

	it("counts them in the status text, pluralised", () => {
		expect(countText([], 1)).toBe("owner asks: 0 open · 1 unruled departure");
		expect(countText([], 2)).toBe("owner asks: 0 open · 2 unruled departures");
		expect(countText([])).toBe("owner asks: 0 open");
	});

	it("reads them at the upstream sha, caches them with the asks, and lists them after the asks", async () => {
		const { root, cache } = makeRepo(ASKS_AB, { upstream: true, unruled: UNRULED });
		const sha = git(root, "rev-parse", "@{u}");
		const state = await ownerAsks(root, cache);
		expect(state!.unruled).toEqual(["WO-2026-001 D1 Changed the mechanism.", "WO-2026-002 D2 Skipped Y."]);
		await ownerAsks(root, cache);
		const runs = () => fs.readFileSync(join(root, "record-runs.log"), "utf8").trim().split("\n");
		expect(runs()).toEqual([`unruled ${sha}`]);
		expect(await list(root, cache)).toEqual([
			"docs/reviews/a.md  A1  soon  first",
			"docs/reviews/a.md  A2  soon  second",
			"WO-2026-001 D1 Changed the mechanism.",
			"WO-2026-002 D2 Skipped Y.",
		]);

		writeFileSync(join(root, "unruled.txt"), "");
		git(root, "-c", "commit.gpgsign=false", "commit", "-q", "-am", "ruled");
		git(root, "push", "-q", "origin", "main");
		const next = git(root, "rev-parse", "HEAD");
		expect((await ownerAsks(root, cache))!.unruled).toEqual([]);
		expect(runs()).toEqual([`unruled ${sha}`, `unruled ${next}`]);
	}, 30_000);

	it("reads a cache written before departures existed again", async () => {
		const { root, cache } = makeRepo(ASKS_AB, { upstream: true, unruled: UNRULED });
		await ownerAsks(root, cache);
		const [cacheFile] = readdirSync(cache).filter((f) => f.endsWith(".parsed.json"));
		const old = JSON.parse(fs.readFileSync(join(cache, cacheFile), "utf8"));
		fs.writeFileSync(join(cache, cacheFile), JSON.stringify({ sha: old.sha, lines: old.lines }));
		expect((await ownerAsks(root, cache))!.unruled).toHaveLength(2);
	}, 30_000);

	it("reads nothing from a repo without wo_record.py", async () => {
		const { root, cache } = makeRepo(ASKS_AB);
		expect((await ownerAsks(root, cache))!.unruled).toEqual([]);
		expect(fs.existsSync(join(root, "record-runs.log"))).toBe(false);
	}, 30_000);

	it("counts as attention, and the statusline draws it in warning colour", () => {
		const { root } = makeRepo(ASKS_AB, { unruled: "WO-2026-001 D1 x\n" });
		const out = spawnSync(process.execPath, [CLI, "statusline"], {
			input: JSON.stringify({ cwd: root }),
			env: childEnv({ HOME: tmp("home") }),
			encoding: "utf8",
		});
		expect(out.stdout).toBe(`${basename(root)} · main · \x1b[33mowner asks: 2 open · 1 unruled departure\x1b[0m\n`);
	}, 30_000);

	it("shows in the pi status bar with nothing new, in the warning colour", async () => {
		const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
		const pi = {
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				handlers[event] = handler;
			},
			registerCommand: () => {},
		};
		const statuses: (string | undefined)[] = [];
		const { root } = makeRepo("", { unruled: "WO-2026-001 D1 x\n" });
		const ctx = {
			cwd: root,
			hasUI: true,
			ui: {
				setStatus: (_key: string, text: string | undefined) => statuses.push(text),
				theme: { fg: (color: string, text: string) => `[${color}]${text}` },
				notify: () => {},
			},
		};
		loadExtension(pi as never);
		handlers.session_start({}, ctx);
		await waitFor(() => statuses.at(-1) !== undefined);
		expect(statuses.at(-1)).toBe("[warning]owner asks: 0 open · 1 unruled departure");
		await handlers.session_shutdown({}, ctx);
	}, 30_000);

	it("attention is false when neither new asks nor departures exist", async () => {
		const { root, cache } = makeRepo(ASKS_AB, { unruled: "" });
		expect(attention((await ownerAsks(root, cache))!)).toBe(false);
	}, 30_000);
});
