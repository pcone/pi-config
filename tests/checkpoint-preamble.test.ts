/**
 * The `checkpoint` / `checkpoint_fork` execute preamble, characterized before
 * WO-2026-076 folds its two copies into one helper.
 *
 * The two `execute` bodies share a sequence (validate → owner verdict →
 * continuation → git capture → in-flight → compose) and differ in three facts:
 * the refusal verb ("compacted" vs "staged"), the fork's target-directory check
 * between validation and the owner verdict, and the cwd the git binding is
 * captured from. Nothing pinned the shared half before this file
 * (`rg 'archived or compacted|archived or staged' tests/` → 0), so a row here
 * that goes red under the named mutation is what makes the extraction
 * reviewable: green before, green after, red under its own mutation.
 *
 * Every row drives the registered tools through `h.tools.get(...).execute(...)`,
 * never the helper: a helper-level row would pin nothing about what the tools
 * return. The inverse registry (a live caller sees the real `/tmp` registry) is
 * empty per row, so only the child a row fabricates is ever in flight.
 *
 * Run: bash tests/setup.sh && bun test tests/checkpoint-preamble.test.ts
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import checkpointFactory, { _testSetInflightScanDir } from "../extensions/checkpoint.ts";
import { takePendingGo } from "../extensions/go.ts";
import { CHECKPOINT_MARKER } from "../extensions/lib/checkpoint-marker.ts";
import { childEnv, scrubSubagentEnv } from "./helpers/subagent-env.ts";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

let restoreSubagentEnv: () => void = () => {};

beforeAll(() => {
	restoreSubagentEnv = scrubSubagentEnv();
});

afterAll(() => {
	restoreSubagentEnv();
});

interface Sent {
	text: string;
	options?: unknown;
}

/** The `summary` schema's fields — the shape both tools' parameters require. */
const SUMMARY = {
	goal: "preamble fixture",
	filesTouched: ["none"],
	decisions: ["none"],
	triedAndFailed: ["a first attempt — it failed, so the next window does not retry it"],
	constraints: "none",
};

/** The one invalid field C2–C4 use: a blank goal, which the validator names first. */
const BAD_SUMMARY = { ...SUMMARY, goal: "" };
const BAD_GOAL_PROBLEM = "- goal: must be a non-blank paragraph saying what this checkpoint is for";

function makeHarness() {
	const tools = new Map<string, any>();
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const sent: Sent[] = [];
	const compactCalls: any[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const pi: any = {
		events: { emit: () => {}, on: () => {} },
		on: (name: string, fn: (event: any, ctx: any) => unknown) => {
			const list = handlers.get(name) ?? [];
			list.push(fn);
			handlers.set(name, list);
		},
		registerTool: (def: any) => tools.set(def.name, def),
		registerCommand: () => {},
		sendUserMessage: (text: string, options?: unknown) => sent.push({ text, options }),
		appendEntry: () => {},
		ui: { notify: () => {} },
	};
	checkpointFactory(pi);

	const ctxFor = (cwd: string) => ({
		cwd,
		hasUI: true,
		model: { contextWindow: 200_000 },
		getContextUsage: () => ({ tokens: 1000, contextWindow: 200_000, percent: null }),
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level }),
			setStatus: () => {},
			setWidget: () => {},
			clearStatus: () => {},
		},
		sessionManager: {
			getEntries: () => [],
			getBranch: () => [],
			getSessionId: () => "preamble-session",
			getCwd: () => cwd,
		},
		compact: (options: any) => compactCalls.push(options),
	});

	const emit = async (event: string, ctx: any, payload: Record<string, unknown> = {}) => {
		const results: unknown[] = [];
		for (const handler of handlers.get(event) ?? []) {
			results.push(await handler({ type: event, ...payload }, ctx));
		}
		return results;
	};

	return { tools, ctxFor, emit, sent, compactCalls, notifications };
}

/** The result text of a tool call (both tools return one text block). */
function textOf(result: any): string {
	return String(result.content[0].text);
}

/** Run the action `/go` would run, capturing what the new session is sent. */
async function runGo(sourceCwd: string): Promise<{ sent: string[]; file: string }> {
	const action = takePendingGo();
	if (!action) throw new Error("/go has no pending action");
	const sentToNewSession: string[] = [];
	let file = "";
	const cmdCtx = {
		cwd: sourceCwd,
		ui: { notify: () => {} },
		sessionManager: {
			getEntries: () => [],
			getSessionId: () => "preamble-session",
			getCwd: () => sourceCwd,
		},
		switchSession: async (path: string, opts?: { withSession?: (n: any) => Promise<void> }) => {
			file = path;
			await opts?.withSession?.({
				sendUserMessage: async (text: string) => {
					sentToNewSession.push(text);
				},
			});
		},
	};
	await action.run(cmdCtx as any);
	return { sent: sentToNewSession, file };
}

// ---------------------------------------------------------------------------
// Archive fixtures
// ---------------------------------------------------------------------------

function checkpointsDir(cwd: string): string {
	return join(cwd, ".pi", "checkpoints");
}

/** Every `.jsonl` archive under `cwd`, sorted — the tool's own written output. */
function archiveFiles(cwd: string): string[] {
	const dir = checkpointsDir(cwd);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".jsonl"))
		.sort()
		.map((f) => join(dir, f));
}

/** The single archive the row's tool wrote; the path comes from disk, not from the result text. */
function onlyArchive(cwd: string): string {
	const files = archiveFiles(cwd);
	if (files.length !== 1) throw new Error(`expected one archive in ${cwd}, found ${files.length}`);
	return files[0];
}

function readMeta(archivePath: string): any {
	return JSON.parse(readFileSync(archivePath.replace(/\.jsonl$/, ".meta.json"), "utf8"));
}

// ---------------------------------------------------------------------------
// In-flight registry fixtures
// ---------------------------------------------------------------------------

const INFLIGHT_SID = "subagent-aaaaaaaa-1111-4111-8111-111111111111";
const INFLIGHT_BRANCH = "pi-subagent-111111111111";

/**
 * A child the registry reports as `orphaned`: same-process owner, a session file
 * on disk, no log. `orphaned`'s evidence is a fixed sentence — the `running`
 * evidence quotes a log age, which would make the section text time-dependent.
 */
function writeOrphaned(registry: string, dir: string): void {
	const sessionFile = join(dir, `${INFLIGHT_SID}.session.jsonl`);
	writeFileSync(sessionFile, "{}\n");
	writeFileSync(
		join(registry, `pi-subagent-${INFLIGHT_SID}.meta.json`),
		JSON.stringify({
			ownerPid: process.pid,
			agentName: "implement",
			task: "do the thing",
			isolationBranch: INFLIGHT_BRANCH,
			sessionFile,
		}),
	);
}

/** `formatInFlightSection`'s text for the one fabricated child — a literal. */
const INFLIGHT_SECTION = [
	"### In-flight subagents",
	"_Recorded by the checkpoint tool from the subagent meta registry._",
	`- \`${INFLIGHT_SID}\` (implement) — branch \`${INFLIGHT_BRANCH}\` — state: orphaned (no completion line, and a session file exists (resumable))`,
	`  - resumable: \`subagent_resume({ session_id: "${INFLIGHT_SID}", task: "do the thing" })\``,
].join("\n");

/** The in-flight section onwards — the composed summary's last section. */
function sectionFrom(summary: string): string {
	const at = summary.indexOf("### In-flight subagents");
	if (at < 0) throw new Error(`no in-flight section in:\n${summary}`);
	return summary.slice(at);
}

// ---------------------------------------------------------------------------
// The pendingCheckpoint representation
// ---------------------------------------------------------------------------

/**
 * `pendingCheckpoint`'s key set, read from the literal that builds it.
 *
 * The object is module-private and WO-2026-076 freezes this file's export count
 * ("no new exported symbol"), so no test hook can reach it at runtime. The
 * literal is parsed instead — the same shape-over-source check
 * `tests/subagent-boundary-hermeticity.test.ts` makes on spawn call sites. A
 * field added, renamed, dropped, or an `...` spread that hides the keys is what
 * this catches; every field's *value* is pinned by C1 and C5 behaviourally.
 */
function pendingCheckpointKeys(): string[] {
	const source = readFileSync(join(import.meta.dir, "..", "extensions", "checkpoint.ts"), "utf8");
	const sites = source.match(/\n[ \t]*pendingCheckpoint = \{/g) ?? [];
	if (sites.length !== 1) {
		throw new Error(`expected one \`pendingCheckpoint = {\` construction site, found ${sites.length}`);
	}
	const match = /\n([ \t]+)pendingCheckpoint = \{/.exec(source);
	if (!match) throw new Error("no `pendingCheckpoint = {` assignment in extensions/checkpoint.ts");
	const indent = match[1];
	const open = source.indexOf("{", match.index);
	const close = source.indexOf(`\n${indent}};`, open);
	if (close < 0) throw new Error("`pendingCheckpoint` literal is not closed at its own indentation");
	const body = source.slice(open + 1, close);
	if (/^[ \t]+\.\.\./m.test(body)) {
		throw new Error("`pendingCheckpoint` spreads keys it does not name; the literal must name every field");
	}
	const keys: string[] = [];
	for (const m of body.matchAll(/^[ \t]+([A-Za-z_$][\w$]*)\s*[:,]/gm)) keys.push(m[1]);
	return keys.sort();
}

// ---------------------------------------------------------------------------
// Row fixtures
// ---------------------------------------------------------------------------

let dir: string;
let registry: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-checkpoint-preamble-"));
	registry = join(dir, "registry");
	mkdirSync(registry, { recursive: true });
	_testSetInflightScanDir(registry);
});

afterEach(() => {
	_testSetInflightScanDir(undefined);
	takePendingGo();
	rmSync(dir, { recursive: true, force: true });
});

/** A tmp session directory the fork can target. */
function target(): string {
	const path = join(dir, "target");
	mkdirSync(path, { recursive: true });
	return path;
}

/** pi's default session dir for a cwd (`getDefaultSessionDir` isn't exported). */
function defaultSessionDir(cwd: string): string {
	const safePath = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(getAgentDir(), "sessions", safePath);
}

/**
 * A git repo whose registry script fails: the R6 existence check degrades to a
 * non-blocking warning (`decisions/subagents/043`) — the state C6 needs, the
 * only one where the owner verdict warns and the tool still succeeds.
 */
function registryThatFails(): string {
	const repo = join(dir, "warning-repo");
	mkdirSync(join(repo, "scripts"), { recursive: true });
	writeFileSync(
		join(repo, "scripts", "reviews_status.py"),
		'import sys\nsys.stderr.write("registry broke\\n")\nsys.exit(3)\n',
	);
	const git = Bun.spawnSync(["git", "init", "-q", repo], { env: childEnv() });
	if (git.exitCode !== 0) throw new Error(`git init failed: ${git.stderr.toString()}`);
	return repo;
}

const OWNER_CLAIM = "The owner approved the schema row (known.md#K1).";

/**
 * The interface's members, and the ones assigned after construction.
 *
 * The literal alone is not the whole shape: `injection` is filled by
 * `session_before_compact` (`pending.injection = injection`), so a row that
 * compared the literal's keys to its own expectation would keep passing while
 * the interface grew a second post-construction field. This pairs the two halves
 * against the interface, so a new member has to be accounted for somewhere.
 */
function pendingCheckpointShape(): {
	literal: string[];
	assigned: string[];
	declared: string[];
} {
	const source = readFileSync(join(import.meta.dir, "..", "extensions", "checkpoint.ts"), "utf8");

	const iface = /interface PendingCheckpoint \{([\s\S]*?)\n\}/.exec(source);
	if (!iface) throw new Error("no `interface PendingCheckpoint` declaration");
	const declared: string[] = [];
	for (const m of iface[1].matchAll(/^[ \t]+([A-Za-z_$][\w$]*)\??\s*:/gm)) declared.push(m[1]);

	// Assignments to the stashed object after the literal built it.
	const assigned = new Set<string>();
	for (const m of source.matchAll(/\bpending\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) assigned.add(m[1]);

	// A post-construction assignment the literal never names is only legitimate
	// for an optional member; a required one must arrive complete.
	return {
		literal: pendingCheckpointKeys(),
		assigned: [...assigned].sort(),
		declared: declared.sort(),
	};
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

describe("checkpoint preamble: characterized before the extraction", () => {
	it("C1: checkpoint success — exact result text, the archive it names, pendingCheckpoint's key set", async () => {
		const h = makeHarness();
		const sourceCwd = join(dir, "source");
		mkdirSync(sourceCwd);
		writeOrphaned(registry, dir);
		const ctx = h.ctxFor(sourceCwd);
		await h.emit("session_start", ctx);

		const result = await h.tools
			.get("checkpoint")
			.execute("call-1", { summary: SUMMARY, nextSteps: "NEXT-STEP" }, undefined, undefined, ctx);

		expect(result.isError).toBeFalsy();
		const archivePath = onlyArchive(sourceCwd);
		// Mutation: swap the refusal verb into the success path (or reword any
		// line here) — the equality reds.
		expect(textOf(result)).toBe(
			[
				"Checkpoint queued.",
				`In-flight subagents recorded in the summary: 1 (${INFLIGHT_SID.slice(-8)} orphaned).`,
				`Full session archived to:\n\`${archivePath}\``,
				`Grep there with: \`rg PATTERN ${archivePath}\``,
				"Next: NEXT-STEP",
				"No wait pending → continuing",
			].join("\n\n"),
		);
		expect(h.notifications).toEqual([]);

		// The compaction hook is handed `pending.summary` verbatim, behind the marker.
		await h.emit("agent_settled", ctx);
		expect(h.compactCalls).toHaveLength(1);
		const instructions = String(h.compactCalls[0].customInstructions);
		expect(instructions.startsWith(`${CHECKPOINT_MARKER}\n`)).toBe(true);
		expect(instructions.slice(CHECKPOINT_MARKER.length + 1)).toBe(readMeta(archivePath).summary);

		const shape = pendingCheckpointShape();
		expect(shape.literal).toEqual([
			"archivePath",
			"contextWindow",
			"continuation",
			"cwd",
			"git",
			"next",
			"relevantPaths",
			"summary",
			"tokens",
			"waits",
		]);
		// Every declared member is either built by the literal or filled later.
		// A member that is neither would be a field nothing ever sets.
		const accounted = new Set([...shape.literal, ...shape.assigned]);
		expect(shape.declared.filter((field) => !accounted.has(field))).toEqual([]);
		// And the later fill is exactly the one the compaction hook performs.
		expect(shape.assigned).toEqual(["injection"]);
	}, 30_000);

	it("C2: checkpoint invalid summary — the `compacted` refusal, and nothing written", async () => {
		const h = makeHarness();
		const sourceCwd = join(dir, "source");
		mkdirSync(sourceCwd);
		const ctx = h.ctxFor(sourceCwd);
		await h.emit("session_start", ctx);

		const result = await h.tools
			.get("checkpoint")
			.execute("call-1", { summary: BAD_SUMMARY, nextSteps: "NEXT-STEP" }, undefined, undefined, ctx);

		expect(result.isError).toBe(true);
		// Mutation: change the verb to "staged" — this equality reds.
		expect(textOf(result)).toBe(
			["Error: summary rejected — nothing was archived or compacted. Fix every field below:", BAD_GOAL_PROBLEM].join(
				"\n",
			),
		);
		expect(existsSync(checkpointsDir(sourceCwd))).toBe(false);
		expect(h.notifications).toEqual([]);

		// A rejection stashes no request, so the settle compacts nothing.
		await h.emit("agent_settled", ctx);
		expect(h.compactCalls).toEqual([]);
	}, 30_000);

	it("C3: checkpoint_fork invalid summary — the `staged` refusal, and nothing staged", async () => {
		const h = makeHarness();
		const sourceCwd = join(dir, "source");
		mkdirSync(sourceCwd);
		const ctx = h.ctxFor(sourceCwd);
		await h.emit("session_start", ctx);

		const result = await h.tools
			.get("checkpoint_fork")
			.execute(
				"call-f",
				{ newCwd: target(), summary: BAD_SUMMARY, nextSteps: "NEXT-STEP" },
				undefined,
				undefined,
				ctx,
			);

		expect(result.isError).toBe(true);
		// Mutation: change the verb to "compacted" — this equality reds.
		expect(textOf(result)).toBe(
			["Error: summary rejected — nothing was archived or staged. Fix every field below:", BAD_GOAL_PROBLEM].join("\n"),
		);
		expect(takePendingGo()).toBeNull();
		expect(existsSync(checkpointsDir(sourceCwd))).toBe(false);
		expect(h.notifications).toEqual([]);
	}, 30_000);

	it("C4: checkpoint_fork target missing AND summary invalid — the summary refusal wins, newCwd is not stat'ed", async () => {
		const h = makeHarness();
		const sourceCwd = join(dir, "source");
		mkdirSync(sourceCwd);
		const ctx = h.ctxFor(sourceCwd);
		await h.emit("session_start", ctx);

		const result = await h.tools
			.get("checkpoint_fork")
			.execute(
				"call-f",
				{ newCwd: join(dir, "no-such-target"), summary: BAD_SUMMARY, nextSteps: "NEXT-STEP" },
				undefined,
				undefined,
				ctx,
			);

		expect(result.isError).toBe(true);
		// Mutation: move the target check above validation — the refusal becomes
		// "target directory does not exist" and both assertions red.
		expect(textOf(result)).toBe(
			["Error: summary rejected — nothing was archived or staged. Fix every field below:", BAD_GOAL_PROBLEM].join("\n"),
		);
		expect(textOf(result)).not.toContain("target directory does not exist");
		expect(takePendingGo()).toBeNull();
	}, 30_000);

	it("C5: one in-flight child lands in checkpoint's pending summary and the fork's archived summary, identically", async () => {
		// -- checkpoint: the section rides `pending.summary` into the hook -----
		const h = makeHarness();
		const sourceCwd = join(dir, "source");
		mkdirSync(sourceCwd);
		writeOrphaned(registry, dir);
		const ctx = h.ctxFor(sourceCwd);
		await h.emit("session_start", ctx);
		await h.tools
			.get("checkpoint")
			.execute("call-1", { summary: SUMMARY, nextSteps: "NEXT-STEP" }, undefined, undefined, ctx);
		await h.emit("agent_settled", ctx);
		const instructions = String(h.compactCalls[0].customInstructions);
		const pendingSummary = instructions.slice(CHECKPOINT_MARKER.length + 1);

		expect(sectionFrom(pendingSummary)).toBe(INFLIGHT_SECTION);

		// -- checkpoint_fork: the same section rides the archived summary -----
		const forkCwd = join(dir, "fork-source");
		mkdirSync(forkCwd);
		const f = makeHarness();
		const forkCtx = f.ctxFor(forkCwd);
		await f.emit("session_start", forkCtx);
		const forkTarget = target();
		await f.tools
			.get("checkpoint_fork")
			.execute(
				"call-f",
				{ newCwd: forkTarget, summary: SUMMARY, nextSteps: "NEXT-STEP" },
				undefined,
				undefined,
				forkCtx,
			);
		const { file } = await runGo(forkCwd);
		expect(file.length).toBeGreaterThan(0);
		const forkSummary = readMeta(onlyArchive(forkCwd)).summary as string;

		expect(sectionFrom(forkSummary)).toBe(INFLIGHT_SECTION);
		// Mutation: drop `formatInFlightSection` from either path — one side loses
		// the section and this equality reds (as does the row above).
		expect(forkSummary).toBe(pendingSummary);

		rmSync(defaultSessionDir(forkTarget), { recursive: true, force: true });
	}, 60_000);

	it("C6: owner-verdict warning fires on both tools, and neither short-circuits", async () => {
		const repo = registryThatFails();
		const h = makeHarness();
		const ctx = h.ctxFor(repo);
		await h.emit("session_start", ctx);

		const result = await h.tools
			.get("checkpoint")
			.execute("call-1", { summary: SUMMARY, nextSteps: OWNER_CLAIM }, undefined, undefined, ctx);

		// Mutation: `return` on `ownerState.warning` — isError becomes true (or the
		// success text disappears) and every assertion below reds.
		expect(result.isError).toBeFalsy();
		const lines = textOf(result).split("\n\n");
		expect(lines[0]).toBe("Checkpoint queued.");
		expect(lines[1]).toContain("R6 warning");
		expect(lines[1]).toContain("exited 3");
		expect(lines[1]).toContain("known.md#K1");
		// The warning did not stop the work: the archive exists.
		expect(archiveFiles(repo)).toHaveLength(1);
		expect(h.notifications.some((n) => n.level === "warning" && n.message.includes("R6 warning"))).toBe(true);

		// -- checkpoint_fork: same verdict, same non-blocking outcome ---------
		const f = makeHarness();
		const forkCtx = f.ctxFor(repo);
		await f.emit("session_start", forkCtx);
		const forkResult = await f.tools
			.get("checkpoint_fork")
			.execute(
				"call-f",
				{ newCwd: target(), summary: SUMMARY, nextSteps: OWNER_CLAIM },
				undefined,
				undefined,
				forkCtx,
			);

		expect(forkResult.isError).toBeFalsy();
		const forkLines = textOf(forkResult).split("\n\n");
		expect(forkLines[0]).toContain("Fork prepared");
		expect(forkLines[1]).toContain("R6 warning");
		expect(forkLines[1]).toContain("exited 3");
		// Staged, not refused: the warning did not short-circuit the fork either.
		expect(takePendingGo()).not.toBeNull();
		expect(f.notifications.some((n) => n.level === "warning" && n.message.includes("R6 warning"))).toBe(true);
	}, 60_000);
	it("C7: checkpoint_fork target check — a valid summary plus a bad target refuses, and stages nothing", async () => {
		const h = makeHarness();
		const sourceCwd = join(dir, "source");
		mkdirSync(sourceCwd);
		const ctx = h.ctxFor(sourceCwd);
		await h.emit("session_start", ctx);

		const missing = join(dir, "no-such-target");
		// Mutation: replace the fork's `checkTarget` body with `async () => undefined`
		// (a no-op) — the fork then reports success for a target it never checked,
		// and every assertion here reds. C4 cannot see that: it asserts the *summary*
		// refusal winning, which is exactly what a no-op check also produces.
		const refused = await h.tools
			.get("checkpoint_fork")
			.execute("call-f", { newCwd: missing, summary: SUMMARY, nextSteps: "NEXT-STEP" }, undefined, undefined, ctx);
		expect(refused.isError).toBe(true);
		expect(textOf(refused)).toBe(`Error: target directory does not exist: ${missing}`);
		expect(takePendingGo()).toBeNull();
		expect(existsSync(checkpointsDir(sourceCwd))).toBe(false);

		// A path that exists but is not a directory is the check's other arm.
		const notADir = join(sourceCwd, "a-file");
		writeFileSync(notADir, "not a directory\n");
		const refusedFile = await h.tools
			.get("checkpoint_fork")
			.execute("call-f", { newCwd: notADir, summary: SUMMARY, nextSteps: "NEXT-STEP" }, undefined, undefined, ctx);
		expect(refusedFile.isError).toBe(true);
		expect(textOf(refusedFile)).toBe(`Error: not a directory: ${notADir}`);
		expect(takePendingGo()).toBeNull();
		expect(h.notifications).toEqual([]);
	}, 30_000);
});
