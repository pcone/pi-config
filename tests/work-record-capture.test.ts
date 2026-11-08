/**
 * Harness capture of work-order records (decisions/work-order-records/001).
 *
 * The spawner writes the dispatch at spawn, and the reviewer rounds and completion at the
 * implementer's close. These tests drive the exported helpers against a temp repo holding a
 * stub `scripts/wo_record.py` that logs each call, so they pin the harness's side of the
 * contract: argv, stdin, order, and what a failed write does. The real tool's behaviour is
 * pinned in tfd (tests/test_wo_record.py).
 *
 * Run: bun test tests/work-record-capture.test.ts
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import subagentFactory, {
	commitRecordEntries,
	completeWorkRecord,
	metaPath,
	openRecordContext,
	openWorkRecord,
	readSessionExchange,
	recoverOrphanedSubagents,
	resolveRunningSession,
	verifyWorkRecord,
	writeMetaJson,
	_testSetLiveSessionCtx,
} from "../extensions/subagent-async/index.ts";
import { childEnv, scrubSubagentEnv } from "./helpers/subagent-env.ts";
import { WO_RECORD_STUB } from "./helpers/wo-record-stub.ts";

const WO_FILE = "work-orders/WO-2026-001-demo.md";
const WO_ID = "WO-2026-001";
const tmpDirs: string[] = [];
const tmpFiles: string[] = [];

// The spawn rows run `implement` through the tool gate, whose allowlist and
// nesting-cap reads are env-driven — so this file controls that env instead of
// inheriting whatever its runner has (pi-config#9).
let restoreSubagentEnv: () => void = () => {};

beforeAll(() => {
	restoreSubagentEnv = scrubSubagentEnv();
});

afterAll(() => {
	restoreSubagentEnv();
});

afterEach(() => {
	for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
	for (const f of tmpFiles.splice(0)) fs.rmSync(f, { force: true });
});

function makeRepo({ script = true, record = true, ignoreRecords = false } = {}): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "wo-record-capture-"));
	tmpDirs.push(root);
	execFileSync("git", ["init", "-q"], { cwd: root, env: childEnv() });
	fs.mkdirSync(path.join(root, "work-orders"));
	fs.writeFileSync(path.join(root, WO_FILE), "# WO-2026-001 — demo\n\nbody\n");
	if (ignoreRecords) fs.writeFileSync(path.join(root, ".gitignore"), "work-orders/records/\n");
	if (script) {
		fs.mkdirSync(path.join(root, "scripts"));
		fs.writeFileSync(path.join(root, "scripts/wo_record.py"), WO_RECORD_STUB);
	}
	// The real tool opens a record only through a dispatch and refuses every other kind without
	// one, so a run that appends finds a record a dispatch already created. `record: false` is for
	// the rows that read a repo no run has written to.
	if (record) {
		fs.mkdirSync(path.join(root, "work-orders/records"), { recursive: true });
		fs.writeFileSync(recordFile(root), [
			"---", 'title: "WO-2026-001 — demo"', "type: wo-record", `work_order: ${WO_FILE}`, "status: open", "---", "",
			`## dispatch — ${ISO}`, "implementer: subagent-seed", "",
		].join("\n"));
	}
	return root;
}

function commitAll(root: string, message = "record"): void {
	execFileSync("git", ["add", "-A"], { cwd: root, env: childEnv() });
	execFileSync("git", ["commit", "-q", "-m", message], { cwd: root, env: childEnv() });
}

function gitOut(root: string, args: string[]): string {
	return execFileSync("git", args, { cwd: root, env: childEnv(), encoding: "utf-8" }).trim();
}

function calls(root: string): { argv: string[]; body: string }[] {
	const file = path.join(root, "calls.jsonl");
	if (!fs.existsSync(file)) return [];
	return fs.readFileSync(file, "utf-8").trim().split("\n").map((l) => {
		const { argv, body } = JSON.parse(l);
		return { argv, body };
	});
}

function blobOf(root: string, rel: string): string {
	return execFileSync("git", ["hash-object", "--", rel], { cwd: root, env: childEnv(), encoding: "utf-8" }).trim();
}

function recordFile(root: string): string {
	return path.join(root, "work-orders", "records", `${WO_ID}.md`);
}

const ISO = "2026-10-17T10:00:00.000Z";

function sessionFile(root: string, lines: object[]): string {
	const file = path.join(root, "session.jsonl");
	fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
	return file;
}

function message(id: string, message: object) {
	return { type: "message", id, parentId: null, timestamp: ISO, message };
}

/** Register a reviewer under `implementerKey`, as the reviewers registry and meta files do. */
function registerReviewer(implementerKey: string, childId: string, agent: string, sessionFileName?: string) {
	const regFile = `/tmp/pi-subagent-${implementerKey}.reviewers.json`;
	const prior = fs.existsSync(regFile) ? JSON.parse(fs.readFileSync(regFile, "utf-8")).spawns : [];
	const spawns = [...prior, { reviewerKind: "implementation", childSessionId: childId, childAgentName: agent, spawnedAt: 1 }];
	fs.writeFileSync(regFile, JSON.stringify({ spawns, reviewRounds: spawns.length, reviewCapReached: false }));
	tmpFiles.push(regFile);
	const metaFile = `/tmp/pi-subagent-${childId}.meta.json`;
	fs.writeFileSync(metaFile, JSON.stringify(sessionFileName ? { sessionFile: sessionFileName } : {}));
	tmpFiles.push(metaFile);
}

function uniqueKey(tag: string): string {
	return `subagent-${tag}-${Math.random().toString(16).slice(2, 10)}`;
}

describe("openWorkRecord — dispatch at spawn", () => {
	it("writes the dispatch with the WO file's blob sha and the task on stdin", () => {
		const root = makeRepo();
		const task = "Implement the thing.\n```\nfenced\n```";
		const { record, failures } = openWorkRecord(root, WO_FILE, "subagent-impl-1", task);
		expect(failures).toEqual([]);
		expect(record).toEqual({
			cwd: root, woId: "WO-2026-001", paths: [recordFile(root)],
			entries: [{ kind: "dispatch", keys: { implementer: "subagent-impl-1" } }], expected: [],
		});
		expect(calls(root)).toEqual([{
			argv: ["append", "WO-2026-001", "dispatch", "--wo_blob", blobOf(root, WO_FILE),
				"--implementer", "subagent-impl-1", "--work_order", WO_FILE],
			body: task,
		}]);
	}, 30_000);

	it("writes nothing and says nothing in a repo without wo_record.py", () => {
		const root = makeRepo({ script: false });
		expect(openWorkRecord(root, WO_FILE, "subagent-impl-1", "task")).toEqual({ failures: [] });
		expect(fs.existsSync(path.join(root, "calls.jsonl"))).toBe(false);
	}, 30_000);

	it("reports a refused write and returns no record to complete", () => {
		const root = makeRepo();
		fs.writeFileSync(path.join(root, "fail-on"), "dispatch");
		const out = openWorkRecord(root, WO_FILE, "subagent-impl-1", "task");
		expect(out.record).toBeUndefined();
		expect(out.failures).toEqual(["work-order record not written: stub refused dispatch"]);
	}, 30_000);

	it("reports a file name with no WO-YYYY-NNN prefix without calling the tool", () => {
		const root = makeRepo();
		fs.writeFileSync(path.join(root, "work-orders/demo.md"), "x");
		const out = openWorkRecord(root, "work-orders/demo.md", "subagent-impl-1", "task");
		expect(out.record).toBeUndefined();
		expect(out.failures[0]).toContain("has no WO-YYYY-NNN prefix");
		expect(calls(root)).toEqual([]);
	}, 30_000);

	it("names the whole record file in a checkout whose path holds a space and a parenthesis", () => {
		// The tool answers `appended <kind> to <path>`; a path parsed only up to the first space
		// reads as a file outside the record's tree, and one holding a parenthesis parses as nothing.
		const parent = fs.mkdtempSync(path.join(os.tmpdir(), "wo record (x) "));
		tmpDirs.push(parent);
		const root = path.join(parent, "repo");
		fs.mkdirSync(path.join(root, "work-orders"), { recursive: true });
		fs.mkdirSync(path.join(root, "scripts"));
		fs.writeFileSync(path.join(root, WO_FILE), "# WO-2026-001 — demo\n");
		fs.writeFileSync(path.join(root, "scripts/wo_record.py"), WO_RECORD_STUB);
		execFileSync("git", ["init", "-q"], { cwd: root, env: childEnv() });
		const { record, failures } = openWorkRecord(root, WO_FILE, "subagent-impl-1", "task");
		expect(failures).toEqual([]);
		expect(record?.paths).toEqual([recordFile(root)]);
		expect(verifyWorkRecord(record!, false)).toEqual([]);
	}, 30_000);
});

describe("completeWorkRecord — reviewer rounds, then completion", () => {	it("writes each reviewer round in spawn order, then the completion", () => {
		const root = makeRepo();
		const key = uniqueKey("impl");
		const code = sessionFile(root, [
			message("u1", { role: "user", content: "Review the code." }),
			message("a1", { role: "assistant", content: [{ type: "toolCall", id: "t", name: "read", arguments: {} }] }),
			message("a2", { role: "assistant", content: [{ type: "text", text: "APPROVED" }] }),
		]);
		const tests = path.join(root, "tests-session.jsonl");
		fs.writeFileSync(tests, JSON.stringify(message("u2", { role: "user", content: [{ type: "text", text: "Review tests." }] })) + "\n"
			+ JSON.stringify(message("a3", { role: "assistant", content: [{ type: "text", text: "REJECT" }] })) + "\n");
		registerReviewer(key, "subagent-code-1", "review-code", code);
		registerReviewer(key, "subagent-tests-1", "review-tests", tests);

		const { notes, failures } = completeWorkRecord(openRecordContext({ cwd: root, woId: WO_ID }), key,
			() => "Done.\n**deviations_from_spec:** none");
		expect({ notes, failures }).toEqual({ notes: [], failures: [] });
		const [r1, r2, done] = calls(root);
		expect(r1.argv).toEqual(["append", "WO-2026-001", "review", "--seat", "review-code", "--round", "1",
			"--session", "subagent-code-1"]);
		expect(JSON.parse(r1.body)).toEqual({ brief: "Review the code.", output: "APPROVED" });
		expect(r2.argv.slice(2, 8)).toEqual(["review", "--seat", "review-tests", "--round", "2", "--session"]);
		expect(JSON.parse(r2.body)).toEqual({ brief: "Review tests.", output: "REJECT" });
		expect(done).toEqual({ argv: ["append", "WO-2026-001", "completion", "--implementer", key],
			body: "Done.\n**deviations_from_spec:** none" });
	}, 30_000);

	it("keeps writing after a refused review and reports it", () => {
		const root = makeRepo();
		const key = uniqueKey("impl");
		fs.writeFileSync(path.join(root, "fail-on"), "review");
		const code = sessionFile(root, [message("u1", { role: "user", content: "Review." }),
			message("a1", { role: "assistant", content: [{ type: "text", text: "OK" }] })]);
		registerReviewer(key, "subagent-code-2", "review-code", code);
		const { failures } = completeWorkRecord(openRecordContext({ cwd: root, woId: WO_ID }), key, () => "Done.");
		expect(failures).toEqual(["work-order record: review subagent-code-2 not written: stub refused review"]);
		expect(calls(root).map((c) => c.argv[2])).toEqual(["review", "completion"]);
	}, 30_000);

	it("reports a reviewer with no session file and still writes the rest", () => {
		const root = makeRepo();
		const key = uniqueKey("impl");
		registerReviewer(key, "subagent-code-3", "review-code");
		const { notes } = completeWorkRecord(openRecordContext({ cwd: root, woId: WO_ID }), key, () => "Done.");
		expect(notes).toEqual(["work-order record: review subagent-code-3 not written: no session file with a task"]);
		expect(calls(root).map((c) => c.argv[2])).toEqual(["completion"]);
	}, 30_000);

	it("reports a missing final report and writes no completion", () => {
		const root = makeRepo();
		const { notes } = completeWorkRecord(openRecordContext({ cwd: root, woId: WO_ID }), uniqueKey("impl"), () => "  \n");
		expect(notes).toEqual(["work-order record: completion not written: implementer has no final report"]);
		expect(calls(root)).toEqual([]);
	}, 30_000);

	it("writes nothing when the record does not hold an entry list", () => {
		// A record it cannot read is not an empty record: appending the reviews it already holds
		// twice is exactly what reading a broken record as `[]` would do.
		const root = makeRepo();
		fs.writeFileSync(path.join(root, "summary-shape"), "entries-not-array");
		const { failures } = completeWorkRecord(openRecordContext({ cwd: root, woId: WO_ID }), uniqueKey("impl"), () => "Done.");
		expect(failures).toEqual([
			'work-order record: WO-2026-001 not read, nothing written: summary carries no entries array: ' +
			'{"status": "open", "entries": {"dispatch": 1}}',
		]);
		expect(calls(root)).toEqual([]);
	}, 30_000);

	it("writes nothing when the record does not exist", () => {
		// The real tool exits 1 on a missing record rather than answering an empty entry list.
		const root = makeRepo({ record: false });
		const { failures } = completeWorkRecord(openRecordContext({ cwd: root, woId: WO_ID }), uniqueKey("impl"), () => "Done.");
		expect(failures).toHaveLength(1);
		expect(failures[0]).toContain("not read, nothing written: wo_record: no record at");
		expect(calls(root)).toEqual([]);
	}, 30_000);
});

describe("verifyWorkRecord — the close-time gate", () => {
	/** A record this run wrote, through the tool, as a spawn writes its dispatch. */
	function written(root: string) {
		const { record, failures } = openWorkRecord(root, WO_FILE, "subagent-impl-1", "task");
		expect(failures).toEqual([]);
		return record!;
	}

	it("passes a record file committed in its own tree", () => {
		const root = makeRepo({ record: false });
		const record = written(root);
		commitAll(root);
		expect(verifyWorkRecord(record, true)).toEqual([]);
	}, 30_000);

	it("R3 — fails a record left untracked in the tree that commits, naming the file", () => {
		// The observed bug's class: the append lands where the commit never reaches, and the
		// worktree removal then destroys it. `git diff --quiet HEAD` answers 0 for this path, which
		// is how it read as committed.
		const root = makeRepo({ record: false });
		commitAll(root, "base");
		const record = written(root);
		expect(verifyWorkRecord(record, true)).toEqual([
			`record file ${recordFile(root)} is not committed in ${root}: ?? work-orders/records/${WO_ID}.md`,
		]);
	}, 30_000);

	it("fails a record staged but never committed", () => {
		const root = makeRepo({ record: false });
		commitAll(root, "base");
		const record = written(root);
		execFileSync("git", ["add", "-A"], { cwd: root, env: childEnv() });
		expect(verifyWorkRecord(record, true)[0]).toContain("is not committed in");
	}, 30_000);

	it("fails a record the repo ignores, which no commit carries either", () => {
		const root = makeRepo({ record: false });
		fs.writeFileSync(path.join(root, ".gitignore"), "work-orders/records/\n");
		commitAll(root, "base");
		const record = written(root);
		// Porcelain collapses an untracked-or-ignored directory to the directory itself.
		expect(verifyWorkRecord(record, true)).toEqual([
			`record file ${recordFile(root)} is not committed in ${root}: !! work-orders/records/`,
		]);
	}, 30_000);

	it("fails a record changed after its commit", () => {
		const root = makeRepo({ record: false });
		const record = written(root);
		commitAll(root, "base");
		fs.appendFileSync(recordFile(root), "\ntrailing\n");
		expect(verifyWorkRecord(record, true)[0]).toContain("is not committed in");
	}, 30_000);

	it("passes an uncommitted working file when the spawner's own commit carries it", () => {
		const root = makeRepo({ record: false });
		const record = written(root);
		expect(verifyWorkRecord(record, false)).toEqual([]);
	}, 30_000);

	it("names a record file outside the record's tree", () => {
		const root = makeRepo();
		const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "wo-elsewhere-"));
		tmpDirs.push(elsewhere);
		const stray = path.join(elsewhere, `${WO_ID}.md`);
		fs.writeFileSync(stray, fs.readFileSync(recordFile(root)));
		const record = {
			...openRecordContext({ cwd: root, woId: WO_ID }),
			paths: [stray],
			entries: [{ kind: "dispatch", keys: { implementer: "subagent-seed" } }],
		};
		expect(verifyWorkRecord(record, true)).toEqual([`record file ${stray} is outside the committed tree ${root}`]);
	}, 30_000);

	it("reports a record the tool does not hold instead of reading it as empty", () => {
		// The unreadable branch: the real tool exits 1 on a missing record, so a run whose tree
		// never held it fails here rather than completing as if it had read an empty record.
		const root = makeRepo({ record: false });
		const record = openRecordContext({ cwd: root, woId: WO_ID },
			[{ kind: "dispatch", keys: { implementer: "subagent-impl-1" } }]);
		expect(verifyWorkRecord(record, false)).toEqual([
			`record ${root} not readable in ${root}: wo_record: no record at ${recordFile(root)}`,
		]);
	}, 30_000);

	it("reports a summary that is not an entry list rather than throwing", () => {
		// It runs after the work is committed, in an async close handler: a throw there is an
		// unhandled rejection and no delivery at all.
		const root = makeRepo();
		const record = { ...openRecordContext({ cwd: root, woId: WO_ID }),
			entries: [{ kind: "dispatch", keys: { implementer: "subagent-seed" } }] };
		fs.writeFileSync(path.join(root, "summary-shape"), "entries-not-array");
		expect(verifyWorkRecord(record, false)).toEqual([
			`record ${root} not readable in ${root}: summary carries no entries array: ` +
			'{"status": "open", "entries": {"dispatch": 1}}',
		]);
		fs.writeFileSync(path.join(root, "summary-shape"), "not-json");
		expect(verifyWorkRecord(record, false)[0]).toContain("summary is not JSON");
	}, 30_000);
});

describe("readSessionExchange", () => {
	it("takes the first user task and the last assistant text, skipping tool calls", () => {
		const root = makeRepo();
		const file = sessionFile(root, [
			{ type: "session", version: 3, id: "s", timestamp: ISO, cwd: root },
			message("u", { role: "user", content: [{ type: "text", text: "Brief." }, { type: "text", text: "More." }] }),
			message("a", { role: "assistant", content: [{ type: "toolCall", id: "t", name: "bash", arguments: {} }] }),
			message("b", { role: "assistant", content: [{ type: "text", text: "Final." }] }),
		]);
		expect(readSessionExchange(file)).toEqual({ task: "Brief.\nMore.", output: "Final." });
	}, 30_000);

	it("returns null without a user message", () => {
		const root = makeRepo();
		expect(readSessionExchange(sessionFile(root, [message("a", { role: "assistant", content: [] })]))).toBeNull();
	}, 30_000);

	it("throws on a malformed line rather than dropping part of the session", () => {
		const root = makeRepo();
		const file = path.join(root, "bad.jsonl");
		fs.writeFileSync(file, JSON.stringify(message("u", { role: "user", content: "x" })) + "\n{\"type\":");
		expect(() => readSessionExchange(file)).toThrow();
	}, 30_000);
});

// ── Resume, recovery and the execute branch ─────────────────────────────────

function stubPi(delivered: string[] = []) {
	const tools = new Map<string, any>();
	const pi: any = {
		events: { emit: () => {} },
		registerTool: (def: any) => tools.set(def.name, def),
		registerCommand: () => {},
		on: () => {},
		sendUserMessage: (text: string) => delivered.push(text),
		ui: { setStatus: () => {}, notify: () => {}, setWidget: () => {} },
	};
	return { pi, tools };
}

const stubCtx = (cwd: string) => ({
	cwd,
	ui: { setStatus: () => {}, notify: () => {}, setWidget: () => {}, clearStatus: () => {} },
	getModel: () => undefined,
	sessionManager: {
		getBranch: () => [],
		getEntries: () => [],
		getSessionId: () => "session-spawner",
	},
});

/** A reviewer session file (JSONL) with one task and one final text. */
function reviewSession(file: string, task: string, output: string): string {
	fs.writeFileSync(file, [
		JSON.stringify(message("u", { role: "user", content: task })),
		JSON.stringify(message("a", { role: "assistant", content: [{ type: "text", text: output }] })),
	].join("\n") + "\n");
	return file;
}

describe("a second completion appends only the reviews the record does not hold", () => {
	it("writes the new reviewer with the next round, then the completion", () => {
		const root = makeRepo();
		const key = uniqueKey("impl");
		const record = openRecordContext({ cwd: root, woId: WO_ID });
		registerReviewer(key, "subagent-rev-a", "review-code", reviewSession(path.join(root, "a.jsonl"), "Review A.", "APPROVED"));
		expect(completeWorkRecord(record, key, () => "First report.")).toEqual({ notes: [], failures: [] });
		const before = calls(root).length;

		registerReviewer(key, "subagent-rev-b", "review-tests", reviewSession(path.join(root, "b.jsonl"), "Review B.", "REJECT"));
		expect(completeWorkRecord(record, key, () => "Second report.")).toEqual({ notes: [], failures: [] });

		const later = calls(root).slice(before);
		expect(later.map((c) => c.argv[2])).toEqual(["review", "completion"]);
		expect(later[0].argv).toEqual(["append", WO_ID, "review", "--seat", "review-tests", "--round", "2",
			"--session", "subagent-rev-b"]);
		expect(later[1].body).toBe("Second report.");
	}, 30_000);
});

class FakeSock extends EventEmitter {
	unref(): void {}
}

describe("recovery completes the record from the recovered session file", () => {
	/** Drive the orphan-recovery close for a run whose record lives in `root`. A live session ctx is
	 *  set first — the hook mirrors the `session_start` lifecycle — so the delivered result is
	 *  captured rather than dropped. `exposeMetaInTmp` links the run's meta at the path the status
	 *  tools read (`/tmp`, the deployment's real sock dir) while the scan itself stays isolated in a
	 *  temp dir, so it cannot adopt another run's socket. Returns the delivered text, the record
	 *  writes it made, and the registered tools. */
	function recoverRun(
		root: string,
		piId: string,
		before: number,
		{ exposeMetaInTmp = false } = {},
	) {
		const sid = `subagent-${randomUUID()}`;
		const runFile = reviewSession(path.join(root, "run2.jsonl"), "Rework.",
			"Reworked.\n\n**deviations_from_spec:**\n- Changed the approach.");
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wo-recover-"));
		tmpDirs.push(dir);
		fs.writeFileSync(path.join(dir, `pi-subagent-${sid}.sock`), "");
		fs.writeFileSync(path.join(dir, `pi-subagent-${sid}.log`), "");
		fs.writeFileSync(path.join(dir, `pi-subagent-${sid}.meta.json`), JSON.stringify({
			agentName: "implement", task: "Rework.", cwd: root, startedAt: Date.now(), piSessionId: piId,
			sessionFile: runFile, ownerPid: process.pid, workRecord: { cwd: root, woId: WO_ID },
		}));
		if (exposeMetaInTmp) {
			// A link, not a copy: the file the recovery writes is the one the status surface reads.
			fs.symlinkSync(path.join(dir, `pi-subagent-${sid}.meta.json`), metaPath(sid));
			tmpFiles.push(metaPath(sid));
		}

		const delivered: string[] = [];
		const { pi, tools } = stubPi(delivered);
		subagentFactory(pi); // the tools a user's status query reaches for
		const sock = new FakeSock();
		_testSetLiveSessionCtx(stubCtx(root));
		recoverOrphanedSubagents(
			pi,
			{ cwd: root, sessionManager: { getSessionId: () => "session-under-test" } } as any,
			{ dir, connect: () => sock as any, selfPid: process.pid },
		);
		sock.emit("connect");
		sock.emit("close");
		return { sid, delivered: delivered.join("\n"), after: calls(root).slice(before), tools };
	}

	/** A record its first run already wrote a completion into, and a reviewer its second run added. */
	function runTwice(root: string) {
		const piId = uniqueKey("impl");
		const record = openRecordContext({ cwd: root, woId: WO_ID });
		registerReviewer(piId, "subagent-rec-a", "review-code", reviewSession(path.join(root, "a.jsonl"), "Review A.", "APPROVED"));
		completeWorkRecord(record, piId, () => "First report.");
		const before = calls(root).length;
		registerReviewer(piId, "subagent-rec-b", "review-tests", reviewSession(path.join(root, "b.jsonl"), "Review B.", "REJECT"));
		return { piId, before };
	}

	it("appends the reviews not yet recorded, then the completion", () => {
		const root = makeRepo();
		const { piId, before } = runTwice(root);
		const { sid, after } = recoverRun(root, piId, before);

		expect(after.map((c) => c.argv[2])).toEqual(["review", "completion"]);
		expect(after[0].argv.slice(3, 9)).toEqual(["--seat", "review-tests", "--round", "2", "--session", "subagent-rec-b"]);
		expect(after[1].body).toBe("Reworked.\n\n**deviations_from_spec:**\n- Changed the approach.");
		expect(resolveRunningSession(sid)).toBeNull();
	}, 30_000);

	it("commits what it appended, in the tree it wrote to, and verifies that commit", () => {
		// Owner ruling Q-094-a (2026-11-08): a recovery commits its record and verifies it, exactly
		// as a normal close does. A recovered run never runs the spawn's pre-commit steps, so
		// without this the entries sit uncommitted in a tree the reap or a checkout discards.
		const root = makeRepo();
		const { piId, before } = runTwice(root);
		const { delivered } = recoverRun(root, piId, before);

		expect(gitOut(root, ["status", "--porcelain", "--ignored", "--", `work-orders/records/${WO_ID}.md`])).toBe("");
		expect(gitOut(root, ["ls-tree", "-r", "--name-only", "HEAD"])).toBe(`work-orders/records/${WO_ID}.md`);
		// The commit carries the record file and nothing else in that tree.
		expect(gitOut(root, ["show", "--name-only", "--format=%s", "HEAD"]).replace(/\n+/g, "\n"))
			.toBe(`work-order record: recovery append (${WO_ID})\nwork-orders/records/${WO_ID}.md`);
		expect(delivered).not.toContain("RECORD FAILURE");
	}, 30_000);

	it("reports RECORD FAILURE when that tree's commit cannot carry the entries", () => {
		const root = makeRepo({ ignoreRecords: true });
		const { piId, before } = runTwice(root);
		const { delivered } = recoverRun(root, piId, before);

		expect(delivered).toContain("RECORD FAILURE");
		expect(delivered).toContain(`${recordFile(root)} is not committed in ${root}: !! work-orders/records/`);
		// The append itself happened: the failure names what the commit could not carry.
		expect(fs.readFileSync(recordFile(root), "utf-8")).toContain("## completion");
	}, 30_000);

	it("leaves that failure on the status surface the recovered session left behind", async () => {
		// The recovered run is out of the running map before its commit runs, so a user's later
		// `subagent_status` reads the meta and nothing else: the delivered result is one shot, and
		// the meta write is the only thing that carries the outcome past it.
		const root = makeRepo({ ignoreRecords: true });
		const { piId, before } = runTwice(root);
		const { sid, tools } = recoverRun(root, piId, before, { exposeMetaInTmp: true });

		const status = await tools.get("subagent_status").execute("ts", { session_id: sid }, undefined, undefined, stubCtx(root));
		expect(String(status.content[0].text))
			.toContain(`RECORD FAILURE: record file ${recordFile(root)} is not committed in ${root}`);
	}, 30_000);
});

describe("resume re-opens the record and checks the dispatch it must already hold", () => {
	it("carries the meta's record, expecting the dispatch, and reports a tree that lacks it", async () => {
		const root = makeRepo();
		const sid = `subagent-${randomUUID()}`;
		const sessionFile = path.join(root, "resume.jsonl");
		fs.writeFileSync(sessionFile, `{"type":"session","version":3,"id":"abc","cwd":${JSON.stringify(root)}}\n{"type":"model_change"}\n`);
		writeMetaJson(sid, { sessionFile, agentName: "implement", workRecord: { cwd: root, woId: WO_ID } });
		const { pi, tools } = stubPi();
		subagentFactory(pi);
		try {
			const res = await tools.get("subagent_resume").execute("tc", { session_id: sid, task: "continue" },
				undefined, undefined, stubCtx(root));
			expect(res.isError).toBeFalsy();
			const record = resolveRunningSession(sid)?.workRecord!;
			// The dispatch was written by the spawn that owns the order, under this same session id.
			expect(record).toEqual(openRecordContext({ cwd: root, woId: WO_ID },
				[{ kind: "dispatch", keys: { implementer: sid } }]));
			// The seeded record carries another implementer's dispatch: this run's is missing.
			expect(verifyWorkRecord(record, false)).toEqual([
				`record ${root} is missing dispatch(implementer=${sid})`,
			]);
			// And a tree with no record at all is a failure, not an empty record.
			fs.rmSync(recordFile(root));
			expect(verifyWorkRecord(record, false)[0]).toContain("not readable in");
		} finally {
			await tools.get("subagent_kill").execute("tk", { session_id: sid }, undefined, undefined, stubCtx(root));
			removeArtifacts(sid);
		}
	}, 30_000);
});

describe("commitRecordEntries — the recovery commits the record it appended, and nothing else", () => {
	/** A record this run wrote through the tool, as a recovery's appends leave it. */
	function written(root: string) {
		const { record, failures } = openWorkRecord(root, WO_FILE, "subagent-impl-1", "task");
		expect(failures).toEqual([]);
		return record!;
	}

	it("commits nothing and reports nothing when the record is already committed", () => {
		// The stated state behind the branch: a second close over the same record. Nothing staged
		// means no commit — and a commit attempted with nothing staged would fail, so this row
		// reds if the branch is inverted rather than passing quietly.
		const root = makeRepo({ record: false });
		const record = written(root);
		commitAll(root, "record");
		const head = gitOut(root, ["rev-parse", "HEAD"]);

		expect(commitRecordEntries(record)).toEqual([]);
		expect(gitOut(root, ["rev-parse", "HEAD"])).toBe(head);
		expect(gitOut(root, ["status", "--porcelain", "-uall"])).toBe("");
	}, 30_000);
});

/** Remove what a real spawn leaves for a handle: meta, log, socket, and its pi transcript. */
function removeArtifacts(sid: string): void {
	const files = [metaPath(sid), `/tmp/pi-subagent-${sid}.log`, `/tmp/pi-subagent-${sid}.sock`];
	const sessionsRoot = path.join(os.homedir(), ".pi", "agent", "sessions");
	try {
		for (const dir of fs.readdirSync(sessionsRoot)) {
			for (const entry of fs.readdirSync(path.join(sessionsRoot, dir))) {
				if (entry.endsWith(`_${sid}.jsonl`)) files.push(path.join(sessionsRoot, dir, entry));
			}
		}
	} catch {
		// no transcripts directory
	}
	for (const f of files) fs.rmSync(f, { force: true });
}

describe("subagent execute opens the record only for a workOrderPath spawn", () => {
	it("writes the dispatch and persists the record context; a plain spawn writes nothing", async () => {
		const root = makeRepo();
		const { pi, tools } = stubPi();
		subagentFactory(pi);
		const ctx = stubCtx(root);
		const task = "Reply with the single word: ok";
		const sids: string[] = [];
		try {
			const withOrder = await tools.get("subagent").execute("tc", {
				agent: "implement", task, cwd: root, isolate: false, review_policy: "skip", workOrderPath: WO_FILE,
			}, undefined, undefined, ctx);
			const sid = /session: (subagent-[0-9a-f-]+)/.exec(withOrder.content[0].text)![1];
			sids.push(sid);
			expect(calls(root)).toEqual([{
				argv: ["append", WO_ID, "dispatch", "--wo_blob", blobOf(root, WO_FILE), "--implementer", sid,
					"--work_order", WO_FILE],
				body: task,
			}]);
			expect(JSON.parse(fs.readFileSync(metaPath(sid), "utf-8")).workRecord).toEqual({ cwd: root, woId: WO_ID });

			const plain = await tools.get("subagent").execute("tc", {
				agent: "implement", task, cwd: root, isolate: false, review_policy: "skip",
			}, undefined, undefined, ctx);
			const plainSid = /session: (subagent-[0-9a-f-]+)/.exec(plain.content[0].text)![1];
			sids.push(plainSid);
			expect(calls(root)).toHaveLength(1);
			expect(JSON.parse(fs.readFileSync(metaPath(plainSid), "utf-8")).workRecord).toBeUndefined();
		} finally {
			for (const sid of sids) {
				await tools.get("subagent_kill").execute("tk", { session_id: sid }, undefined, undefined, ctx);
				removeArtifacts(sid);
			}
		}
	}, 30_000);
});
