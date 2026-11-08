/**
 * WO-2026-070 — only the spawn that OWNS a work order writes its `dispatch`.
 *
 * A `subagent` spawn carrying `workOrderPath` wrote a `dispatch` entry for any
 * agent, reviewers included, so each reviewer spawn the implementer launched
 * with the order's path (as `agents/implement.md` step 4 used to read) wrote a
 * second row naming **its own** session as the implementer and the review
 * prompt as the brief. Ownership is a property of the spawned agent
 * (`reviewer_kind` in its frontmatter), not of the spawn call, so the record
 * gate is `agent.reviewerKind === undefined`.
 *
 * WO-2026-074: that gate covers every reviewer only if every reviewer declares a
 * kind, so `review-plan` declares `plan` and the census below selects reviewers by
 * what their name and description say, not by the declaration it is checking.
 *
 * Every row drives the registered `subagent` tool against a temp repo holding a
 * stub `scripts/wo_record.py` that logs each append, so the assertions read the
 * argv a real record would receive. The child binary is a stand-in that holds
 * the pipe open and never runs a turn: the dispatch write happens in the parent,
 * before the child speaks, and nothing here waits on a model.
 *
 * The implementer's own brief cannot issue the reviewer spawn in a test (the
 * stand-in runs no turn), so row 1 issues it from the implementer's session
 * context. Nesting is invisible to the record: the write is keyed by `cwd` and
 * names the spawning spawn's session id, which is exactly what the row pins.
 *
 * Run: bun test tests/work-record-ownership.test.ts
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import subagentFactory, { metaPath, readPersistedSpawns, resolveRunningSession } from "../extensions/subagent-async/index.ts";
import { _loadAgentsFromDir } from "../extensions/subagent-async/agents.ts";
import { childEnv, scrubSubagentEnv } from "./helpers/subagent-env.ts";
import { WO_RECORD_STUB } from "./helpers/wo-record-stub.ts";
import { waitUntilUntracked } from "./helpers/subagent-lifecycle.ts";
import { STANDIN_EPILOGUE } from "./helpers/standin-epilogue.ts";

const WO_FILE = "work-orders/WO-2026-001-demo.md";
const WO_ID = "WO-2026-001";
const AGENTS_DIR = path.resolve(import.meta.dir, "../agents");

const tmpDirs: string[] = [];
let fixtureDir = "";
let argv1Before: string | undefined;
let agentDirBefore: string | undefined;
let restoreSubagentEnv: () => void = () => {};
const children: { sid: string; ctx: any; tools: Map<string, any> }[] = [];

beforeAll(() => {
	restoreSubagentEnv = scrubSubagentEnv();
	// The spawns resolve agents through `getAgentDir()/agents`; point that at this
	// repo so the census (`AGENTS_DIR`) and the spawn rows describe one directory
	// instead of the machine's user agent dir, which may be another checkout.
	agentDirBefore = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.resolve(import.meta.dir, "..");
	// `getPiInvocation` re-invokes `process.argv[1]` (pi's entry when the
	// extension runs inside pi; this test file under `bun test`). Point it at a
	// stand-in that never runs a turn.
	fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "wo-ownership-"));
	const fakePi = path.join(fixtureDir, "stand-in-pi.mjs");
	fs.writeFileSync(fakePi, "process.stdin.resume();\nsetInterval(() => {}, 1 << 30);\n" + STANDIN_EPILOGUE);
	argv1Before = process.argv[1];
	process.argv[1] = fakePi;
});

afterAll(() => {
	if (argv1Before !== undefined) process.argv[1] = argv1Before;
	if (agentDirBefore === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = agentDirBefore;
	restoreSubagentEnv();
	fs.rmSync(fixtureDir, { recursive: true, force: true });
	for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

afterEach(async () => {
	for (const child of children.splice(0)) {
		try {
			await child.tools
				.get("subagent_kill")
				.execute("tk", { session_id: child.sid }, undefined, undefined, child.ctx);
		} catch { /* best-effort: the direct kill below still runs */ }
		const rs = resolveRunningSession(child.sid);
		if (rs) {
			if (rs.staleTimer) clearTimeout(rs.staleTimer);
			if (rs.silenceTimer) clearTimeout(rs.silenceTimer);
			try { rs.proc?.kill("SIGKILL"); } catch { /* already gone */ }
		}
		await waitUntilUntracked(child.sid);
		for (const f of [metaPath(child.sid), `/tmp/pi-subagent-${child.sid}.log`, `/tmp/pi-subagent-${child.sid}.sock`]) {
			try { fs.rmSync(f, { force: true }); } catch { /* best-effort */ }
		}
	}
});

function makeRepo(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "wo-ownership-repo-"));
	tmpDirs.push(root);
	execFileSync("git", ["init", "-q"], { cwd: root, env: childEnv() });
	fs.mkdirSync(path.join(root, "work-orders"));
	fs.mkdirSync(path.join(root, "scripts"));
	fs.writeFileSync(path.join(root, WO_FILE), `# ${WO_ID} — demo\n\nbody\n`);
	fs.writeFileSync(path.join(root, "scripts/wo_record.py"), WO_RECORD_STUB);
	return root;
}

function recordCalls(root: string): { argv: string[]; body: string }[] {
	const file = path.join(root, "calls.jsonl");
	if (!fs.existsSync(file)) return [];
	return fs.readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
}

function dispatches(root: string) {
	return recordCalls(root).filter((c) => c.argv[2] === "dispatch");
}

function blobOf(root: string, rel: string): string {
	return execFileSync("git", ["hash-object", "--", rel], { cwd: root, env: childEnv(), encoding: "utf-8" }).trim();
}

function stubPi() {
	const tools = new Map<string, any>();
	const pi: any = {
		events: { emit: () => {} },
		registerTool: (def: any) => tools.set(def.name, def),
		registerCommand: () => {},
		on: () => {},
		sendUserMessage: () => {},
		ui: { setStatus: () => {}, notify: () => {}, setWidget: () => {} },
	};
	return { pi, tools };
}

const stubCtx = (cwd: string, sessionId: string) => ({
	cwd,
	ui: { setStatus: () => {}, notify: () => {}, setWidget: () => {}, clearStatus: () => {} },
	getModel: () => undefined,
	sessionManager: { getBranch: () => [], getEntries: () => [], getSessionId: () => sessionId },
});

interface Spawned { sid: string; text: string; isError: boolean | undefined; tools: Map<string, any>; ctx: any }

async function spawnAgent(
	root: string,
	agent: string,
	task: string,
	params: Record<string, unknown>,
	ctx = stubCtx(root, "session-orchestrator"),
): Promise<Spawned> {
	const { pi, tools } = stubPi();
	subagentFactory(pi);
	const res = await tools.get("subagent").execute("tc", {
		agent, task, cwd: root, isolate: false, ...params,
	}, undefined, undefined, ctx);
	const text = res.content[0].text as string;
	const match = /session: (subagent-[0-9a-f-]+)/.exec(text);
	if (!match) throw new Error(`spawn of ${agent} returned no session id (isError=${res.isError}):\n${text}`);
	const sid = match[1];
	children.push({ sid, ctx, tools });
	return { sid, text, isError: res.isError, tools, ctx };
}

// ── Row 1 — the false dispatch the order is about ──────────────────────────
describe("a reviewer spawn carrying workOrderPath", () => {
	it(
		"writes no dispatch: the record holds one, owned by the implementer",
		async () => {
			const root = makeRepo();
			const impl = await spawnAgent(root, "implement",
				`Execute work order ${WO_FILE}. Spawn one reviewer and give it the order's path.`,
				{ workOrderPath: WO_FILE, review_policy: "skip" });
			// The reviewer spawn the brief asks for: same repo, same workOrderPath,
			// issued from the implementer's session.
			const reviewer = await spawnAgent(root, "review-code",
				`Review the implementation. The work order is ${WO_FILE}.`,
				{ workOrderPath: WO_FILE }, stubCtx(root, impl.sid));

			const rows = dispatches(root);
			expect(rows).toHaveLength(1);
			expect(rows[0].argv).toEqual(["append", WO_ID, "dispatch", "--wo_blob", blobOf(root, WO_FILE),
				"--implementer", impl.sid, "--work_order", WO_FILE]);
			expect(recordCalls(root).flatMap((c) => c.argv)).not.toContain(reviewer.sid);
			// The reviewer's own close must not complete a record it never opened, and the
			// skip is a debug log, never a note the implementer sees.
			const rs = resolveRunningSession(reviewer.sid);
			expect(rs).toBeDefined();
			expect(rs?.workRecord).toBeUndefined();
			expect(rs?.recordFailures).toEqual([]);
			expect(reviewer.text).not.toContain("work-order record");
		},
		60_000,
	);
});

// ── Row 2 — every reviewer in agents/, declared kind or not ────────────────
describe("every reviewer agent in agents/", () => {
	/** Agents the directory says are reviewers, recognised by name or description. The
	 *  filter deliberately does not read `reviewerKind`: that is the value under test, and
	 *  filtering by it is how a reviewer that declares nothing escapes the census. The
	 *  production record gate never enumerates — it reads `reviewerKind !== undefined`
	 *  (`index.ts:3963`) — so this recogniser is a test-side census guard only. */
	function reviewerAgents() {
		return _loadAgentsFromDir(AGENTS_DIR, "project").filter(
			(a) => a.name.startsWith("review-") || /\breviewers?\b/i.test(a.description));
	}

	it("every such agent declares a reviewer_kind", () => {
		const undeclared = reviewerAgents().filter((a) => a.reviewerKind === undefined).map((a) => a.name);
		expect(undeclared).toEqual([]);
	});

	it("the iteration is not vacuous: all three reviewer kinds are declared in agents/", () => {
		// The census is relative to the type, not to a count, and it names no agent: a
		// deleted `reviewer_kind:` field leaves a kind unrepresented and reddens this row.
		const kinds = reviewerAgents().map((a) => a.reviewerKind).sort();
		expect(kinds).toEqual(["implementation", "plan", "tests"]);
	});

	it(
		"writes no dispatch, whichever reviewer it is",
		async () => {
			const reviewers = reviewerAgents();
			expect(reviewers.length).toBeGreaterThanOrEqual(3);
			for (const agent of reviewers) {
				const root = makeRepo();
				const spawned = await spawnAgent(root, agent.name,
					`Review the work. The work order is ${WO_FILE}.`, { workOrderPath: WO_FILE });
				expect(spawned.isError).toBeFalsy();
				expect({ reviewer: agent.name, dispatches: dispatches(root) })
					.toEqual({ reviewer: agent.name, dispatches: [] });
			}
		},
		120_000,
	);
});

// ── Row 2b — the reviewer that declared nothing before WO-2026-074 ─────────
describe("a review-plan spawn carrying workOrderPath", () => {
	it(
		"writes no dispatch: a plan review never owns the order it reads",
		async () => {
			const root = makeRepo();
			const plan = await spawnAgent(root, "review-plan",
				`Review the plan for ${WO_FILE}.`, { workOrderPath: WO_FILE });
			expect(plan.isError).toBeFalsy();
			expect(dispatches(root)).toEqual([]);
			expect(resolveRunningSession(plan.sid)?.workRecord).toBeUndefined();
			expect(plan.text).not.toContain("work-order record");
		},
		60_000,
	);
});

// ── Row 2c — the plan spawn reaches the tracker the review gate reads ──────
describe("a review-plan spawn in the reviewer tracker", () => {
	// This row owns the key: the tracker is module-level in-memory state as well as a
	// file, so a second user of the same key would see this row's rounds.
	const PARENT = `session-parent-plan-${process.pid}`;
	const trackerPath = `/tmp/pi-subagent-${PARENT}.reviewers.json`;
	afterEach(() => {
		fs.rmSync(trackerPath, { force: true });
	});

	it(
		"records the spawn under the parent, and it consumes no review round",
		async () => {
			// A file left by an earlier run would be a second entry.
			fs.rmSync(trackerPath, { force: true });
			const root = makeRepo();
			const plan = await spawnAgent(root, "review-plan", "Review the plan.",
				{}, stubCtx(root, PARENT));

			let state = readPersistedSpawns(PARENT);
			expect(state.spawns.map((s) => ({ kind: s.reviewerKind, agent: s.childAgentName, sid: s.childSessionId })))
				.toEqual([{ kind: "plan", agent: "review-plan", sid: plan.sid }]);
			// The round counter feeds `reviewCapReached`, which suppresses the
			// missing-reviewer nudge; a plan review must not spend one of the three
			// rounds an implementer has (WO-2026-074 Q-074-a).
			expect({ rounds: state.reviewRounds, capped: state.reviewCapReached })
				.toEqual({ rounds: 0, capped: false });

			// The contrast the counter exists for: a post-implementation review does
			// spend a round.
			await spawnAgent(root, "review-code", "Review the code.", {}, stubCtx(root, PARENT));
			state = readPersistedSpawns(PARENT);
			expect(state.spawns.map((s) => s.reviewerKind)).toEqual(["plan", "implementation"]);
			expect(state.reviewRounds).toBe(1);
		},
		60_000,
	);
});

// ── Row 3 — control: an implementer still owns its dispatch ────────────────
describe("an implementer spawn carrying workOrderPath", () => {
	it(
		"writes exactly one dispatch, with its own session id and the order's blob",
		async () => {
			const root = makeRepo();
			const impl = await spawnAgent(root, "implement", "Do the work.", { workOrderPath: WO_FILE, review_policy: "skip" });
			expect(recordCalls(root)).toEqual([{
				argv: ["append", WO_ID, "dispatch", "--wo_blob", blobOf(root, WO_FILE),
					"--implementer", impl.sid, "--work_order", WO_FILE],
				body: "Do the work.",
			}]);
			// The record is the spawner's own repo here (no isolation), and this run wrote one entry.
			const record = resolveRunningSession(impl.sid)?.workRecord;
			expect({ cwd: record?.cwd, woId: record?.woId }).toEqual({ cwd: root, woId: WO_ID });
			expect(record?.entries).toEqual([{ kind: "dispatch", keys: { implementer: impl.sid } }]);
		},
		60_000,
	);
});

// ── Row 4 — a reviewer spawn without the path is untouched ─────────────────
describe("a reviewer spawn without workOrderPath", () => {
	it(
		"writes no record, reports no note and no error",
		async () => {
			const root = makeRepo();
			const reviewer = await spawnAgent(root, "review-code", "Review the implementation.", {});
			expect(reviewer.isError).toBeFalsy();
			expect(recordCalls(root)).toEqual([]);
			expect(reviewer.text).not.toContain("work-order record");
			const rs = resolveRunningSession(reviewer.sid);
			expect(rs?.workRecord).toBeUndefined();
			expect(rs?.recordFailures).toEqual([]);
		},
		60_000,
	);
});

// ── Row 5 — the rule is stated where the mistake is made ──────────────────
describe("agents/implement.md step 4", () => {
	it("sends the order's path in the reviewer's task text, never as workOrderPath", () => {
		const prompt = fs.readFileSync(path.join(AGENTS_DIR, "implement.md"), "utf-8").replace(/\s+/g, " ");
		expect(prompt).toContain("Give the work order's path in the reviewer's task text, never as `workOrderPath`");
		expect(prompt).toContain("a reviewer never owns an order");
	});
});
