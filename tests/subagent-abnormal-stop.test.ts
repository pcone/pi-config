/**
 * WO-2026-078 (Q-A1, owner 2026-11-05: "done, but labelled"): a child whose
 * final assistant turn ended abnormally is delivered, classified and visibly
 * marked — never silently as success, and never refused (gating completion was
 * rejected).
 *
 * Three sites must say the same thing, which is what the rows assert together,
 * against literals rather than against each other:
 *   1. the delivered message prefix (`deliverResult`),
 *   2. the live log footer word (the close handler's `terminalOutcome`),
 *   3. the state read back from disk (`readSubagentState` over that footer).
 *
 * Rows:
 *  N1  `length` with text      → overflowed, at all three sites
 *  N2  `error` with text       → errored; the child's own text still delivered
 *  N3  `aborted` with exit 0   → aborted (the exit code is not what keys it)
 *  N4  recovery, `Stopped (7 turns, exit 143)` → not finished; word + exit read
 *  N4b recovery, `Completed (5 turns, exit 0)` → still finished
 *  N5  `stop` with text only   → byte-identical delivery (characterisation)
 *  N6  `length` with no text   → boundary: classified, but never `isDone`
 *  E2E `length` through a stand-in child → the real close handler writes the
 *      footer the state reader classifies, and delivers the new prefix
 *
 * Plus the words the union ranges over that no N row names (`toolUse`,
 * `pending`, `deferred`, `killed`), the exit-code dimension (`exit ?`, a
 * reasonless message, a log with no footer) and the classifier's refusal of a
 * stop reason it does not know.
 *
 * Run: bun test tests/subagent-abnormal-stop.test.ts
 * One row: bun test tests/subagent-abnormal-stop.test.ts -t 'N1'
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import * as path from "node:path";
import subagentFactory, {
	_testRunning,
	_testSetLiveSessionCtx,
	deliverResult,
	metaPath,
	recoverOrphanedSubagents,
	resolveRunningSession,
	terminalOutcome,
	updateFooter,
	type OwnerProbe,
} from "../extensions/subagent-async/index.ts";
import {
	OUTCOME_WORD,
	hasTerminalFooter,
	outcomeFromFooterWord,
	parseTerminalFooter,
	readSubagentState,
	readTerminalFooter,
	type SubagentDiskFacts,
} from "../extensions/lib/subagent-state.ts";
import { scrubSubagentEnv } from "./helpers/subagent-env.ts";
import { STANDIN_EPILOGUE } from "./helpers/standin-epilogue.ts";

// ── Stubs ──────────────────────────────────────────────────────────────────

const SELF_PID = 999_002;
const SELF_SESSION = "session-abnormal-stop";

/** ExtensionAPI stub: captures delivered user messages. */
function piStub() {
	const sent: string[] = [];
	const pi: any = {
		events: { emit() {} },
		registerTool() {},
		registerCommand() {},
		on() {},
		sendUserMessage(message: string) { sent.push(message); },
		ui: { setStatus() {}, notify() {}, setWidget() {}, setEditorComponent() {} },
	};
	return { pi, sent };
}

function liveCtx() {
	return {
		cwd: "/tmp",
		sessionManager: { getSessionId: () => SELF_SESSION },
		ui: { setStatus() {}, notify() {}, setWidget() {}, setEditorComponent() {} },
	};
}

/** RunningSubagent-shaped stub. Every field `terminalOutcome` / `deliverResult`
 *  reads is real; the rest is inert. */
function rsStub(overrides: Record<string, any> = {}): any {
	const sid = overrides.sessionId ?? `subagent-${randomUUID()}`;
	return {
		proc: null,
		sessionId: sid,
		agentName: "test-agent",
		task: "do the thing",
		cwd: "/tmp",
		startedAt: Date.now(),
		progress: { turns: 0, filesRead: new Set(), filesModified: new Set(), errors: [], currentActivity: "testing" },
		messages: [],
		stdin: null,
		resolveOnStop: null,
		isDone: false,
		procExited: true,
		recoveredFooterWord: null,
		killedExplicitly: false,
		stoppedExplicitly: false,
		turnNudged: false,
		toolInFlight: 0,
		logPath: `/tmp/pi-subagent-${sid}.log`,
		logLines: [],
		stderrLines: [],
		watchHandle: null,
		sockPath: "",
		sockServer: null,
		sockClients: new Set(),
		worktreePath: null,
		isolationBranch: null,
		parentHeadCommit: null,
		parentCwd: "/tmp",
		carried: null,
		parentTrackerKey: "test",
		usageStats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, latestCacheHitRate: undefined },
		staleTimer: null,
		lastActivityMs: Date.now(),
		silenceTimer: null,
		silenceTimeoutMs: 0,
		killedVia: null,
		...overrides,
	};
}

/** An assistant `message_end` payload; `text: null` is a turn with no text
 *  part at all (the shape the completion detector ignores). */
function assistantMessage(stopReason: string | null, text: string | null) {
	return {
		role: "assistant",
		stopReason,
		content: text === null ? [] : [{ type: "text", text }],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
	};
}

function turns(n: number, filesRead: string[] = []) {
	return { turns: n, filesRead: new Set(filesRead), filesModified: new Set<string>(), errors: [], currentActivity: "" };
}

/** The state a reader gets from a log ending in `<word> (3 turns, exit 0)`. */
function stateForFooter(word: string, exitCode = 0) {
	const facts: SubagentDiskFacts = {
		meta: { ownerPid: process.pid, ownerStartToken: null },
		attached: false,
		sockExists: false,
		logLastLine: `── ${word} (3 turns, exit ${exitCode}) ──`,
		logMtimeMs: Date.now() - 3_600_000,
		sessionFileExists: true,
		hasRecordedOwner: true,
		ownerAlive: true,
		now: Date.now(),
	};
	return readSubagentState(facts);
}

/** A terminal footer line as the close handler writes it. */
function footerLine(word: string, turnCount: number, exitCode: number | "?"): string {
	return `── ${word} (${turnCount} turns, exit ${exitCode}) ──`;
}

const tempDirs: string[] = [];

afterEach(() => {
	_testSetLiveSessionCtx(null);
	_testRunning.clear();
	// Tears down any sleep guard a scan's updateFooter started.
	updateFooter();
	for (const dir of tempDirs.splice(0)) {
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
	}
});

// ── N1–N3, N5, N6: the live classification ─────────────────────────────────

describe("a child's abnormal terminal turn is labelled, not delivered as success", () => {
	it("N1: `stopReason: length` — the prefix, the footer word and the state agree on `overflowed`", () => {
		const rs = rsStub({
			isDone: true,
			progress: turns(4),
			messages: [assistantMessage("length", "partial review — stopped at 3 of 6 files")],
		});
		const t = terminalOutcome(rs, 0);
		expect(t).toEqual({ outcome: "overflowed", footer: "Overflowed", prefix: "overflowed" });

		// Site 1: the delivered prefix.
		_testSetLiveSessionCtx(liveCtx());
		const { pi, sent } = piStub();
		deliverResult(pi, rs, 0);
		expect(sent[0].split("\n")[0]).toBe(`[Subagent test-agent overflowed] — session: ${rs.sessionId}`);
		expect(sent[0]).toContain("partial review — stopped at 3 of 6 files");

		// Site 2: the footer line, asserted against its literal spelling.
		const line = footerLine("Overflowed", 4, 0);
		expect(t.footer).toBe("Overflowed");
		expect(parseTerminalFooter(line)).toEqual({ word: "Overflowed", turns: 4, exitCode: 0 });
		expect(hasTerminalFooter(line)).toBe(true);

		// Site 3: the state read back from that log.
		const reading = stateForFooter("Overflowed");
		expect(reading.state).toBe("orphaned");
		expect(reading.evidence).toContain("Overflowed");
	});

	it("N2: `stopReason: error` — `errored`, and the child's own text still reaches the parent", () => {
		const rs = rsStub({
			isDone: true,
			progress: turns(2),
			messages: [assistantMessage("error", "I could not reach the provider; here is what I found so far")],
		});
		const t = terminalOutcome(rs, 0);
		expect(t).toEqual({ outcome: "errored", footer: "Errored", prefix: "errored" });

		_testSetLiveSessionCtx(liveCtx());
		const { pi, sent } = piStub();
		deliverResult(pi, rs, 0);
		expect(sent[0].split("\n")[0]).toBe(`[Subagent test-agent errored] — session: ${rs.sessionId}`);
		expect(sent[0]).toContain("I could not reach the provider; here is what I found so far");

		expect(parseTerminalFooter(footerLine("Errored", 2, 0))).toEqual({ word: "Errored", turns: 2, exitCode: 0 });
		const reading = stateForFooter("Errored");
		expect(reading.state).toBe("orphaned");
		expect(reading.evidence).toContain("Errored");
	});

	it("N3: `stopReason: aborted` with the process exiting 0 — still `aborted`", () => {
		const rs = rsStub({
			isDone: true,
			progress: turns(3),
			messages: [assistantMessage("aborted", "interrupted mid-sentence")],
		});
		const t = terminalOutcome(rs, 0);
		expect(t).toEqual({ outcome: "aborted", footer: "Aborted", prefix: "aborted" });

		_testSetLiveSessionCtx(liveCtx());
		const { pi, sent } = piStub();
		deliverResult(pi, rs, 0);
		expect(sent[0].split("\n")[0]).toBe(`[Subagent test-agent aborted] — session: ${rs.sessionId}`);

		expect(parseTerminalFooter(footerLine("Aborted", 3, 0))).toEqual({ word: "Aborted", turns: 3, exitCode: 0 });
		const reading = stateForFooter("Aborted");
		expect(reading.state).toBe("orphaned");
		expect(reading.evidence).toContain("Aborted");
	});

	it("N5: `stopReason: stop`, text only — the delivery is the one it always was", () => {
		// Characterisation: this row uses only pre-078 API, so it passes on the
		// base commit too (verified). A normal finish must not acquire an error word.
		const rs = rsStub({
			isDone: true,
			progress: turns(2, ["a.ts"]),
			messages: [assistantMessage("stop", "the report")],
		});

		_testSetLiveSessionCtx(liveCtx());
		const { pi, sent } = piStub();
		deliverResult(pi, rs, 0);
		expect(sent[0]).toBe(
			[
				`[Subagent test-agent finished] — session: ${rs.sessionId}`,
				"Task: do the thing",
				"Turns: 2 | Files read: 1 | Files modified: 0",
				"---",
				"the report",
			].join("\n"),
		);

		expect(hasTerminalFooter(footerLine("Completed", 2, 0))).toBe(true);
		expect(stateForFooter("Completed").state).toBe("complete");
	});

	it("N6: `stopReason: length` with no text — the classifier marks it, but the run is never `isDone`", () => {
		// The completion detector (`!hasToolCalls && hasText`) never sets isDone for
		// a textless turn, so this shape is delivered by the kill path (or the close
		// path if the child exits first), not by the completion path. The
		// classification of the turn itself is still abnormal, and the footer word it
		// would leave is not a completion.
		const rs = rsStub({ isDone: false, progress: turns(1), messages: [assistantMessage("length", null)] });
		const t = terminalOutcome(rs, 1);
		expect(t.outcome).toBe("overflowed");
		expect(t.footer).toBe("Overflowed");
		expect(t.footer).not.toBe(OUTCOME_WORD.finished.footer);
	});
});

// ── The rest of the union, and the exit-code dimension ─────────────────────

describe("the vocabulary holds for every outcome and every ending", () => {
	it("`toolUse` is a normal end: exit 0 is `finished`, a non-zero exit is `aborted`", () => {
		const clean = rsStub({ isDone: false, progress: turns(2), messages: [assistantMessage("toolUse", null)] });
		expect(terminalOutcome(clean, 0)).toEqual({ outcome: "finished", footer: "Exited", prefix: "finished" });
		const failed = rsStub({ isDone: false, progress: turns(2), messages: [assistantMessage("toolUse", null)] });
		expect(terminalOutcome(failed, 1)).toEqual({ outcome: "aborted", footer: "Stopped", prefix: "aborted" });
	});

	it("`pending` and `deferred` are turns that never settled: `aborted` at all three sites", () => {
		for (const reason of ["pending", "deferred"]) {
			const rs = rsStub({ isDone: true, progress: turns(1), messages: [assistantMessage(reason, "half an answer")] });
			const t = terminalOutcome(rs, 0);
			expect(t).toEqual({ outcome: "aborted", footer: "Aborted", prefix: "aborted" });
			expect(stateForFooter(t.footer).state).toBe("orphaned");
		}
	});

	it("a kill is `killed` at all three sites — the marker supersedes the prefix word", () => {
		// decisions/subagents/015 + 043 keep the marker strings verbatim, so the
		// delivered prefix is the marker rather than `[Subagent X killed]`; the
		// footer word and the state reading still have to agree with the outcome.
		for (const exitCode of [null, 0, 143]) {
			const rs = rsStub({
				isDone: false,
				killedExplicitly: true,
				killedVia: "progress-timeout",
				progress: turns(6),
				messages: [assistantMessage("toolUse", null)],
			});
			const t = terminalOutcome(rs, exitCode);
			expect(t).toEqual({ outcome: "killed", footer: "Killed", prefix: "killed" });

			_testSetLiveSessionCtx(liveCtx());
			const { pi, sent } = piStub();
			deliverResult(pi, rs, exitCode);
			expect(sent[0].split("\n")[0]).toBe(
				`[Killed via progress-timeout — process terminated, work in this subagent is lost] — session: ${rs.sessionId}`,
			);

			expect(parseTerminalFooter(footerLine("Killed", 6, "?"))).toEqual({ word: "Killed", turns: 6, exitCode: null });
			const reading = stateForFooter("Killed");
			expect(reading.state).toBe("orphaned");
			expect(reading.evidence).toContain("Killed");
		}
	});

	it("a process that left no exit code was terminated, not finished", () => {
		const rs = rsStub({ isDone: false, progress: turns(3), messages: [assistantMessage("stop", "text")] });
		// `stop` with text and no exit code: the turn is normal, the ending is not.
		expect(terminalOutcome(rs, null).outcome).toBe("aborted");
	});

	it("a reasonless assistant message is an abnormal turn, not a normal end", () => {
		const rs = rsStub({ isDone: true, progress: turns(1), messages: [assistantMessage(null, "some text")] });
		const t = terminalOutcome(rs, 0);
		expect(t).toEqual({ outcome: "aborted", footer: "Aborted", prefix: "aborted" });
	});
});

// ── N4 / N4b and the recovery path's other endings ─────────────────────────

interface FakeSocket {
	unrefCalls: number;
	unref(): void;
	on(event: string, cb: (...args: any[]) => void): FakeSocket;
	destroy(): void;
	write(): void;
	fire(event: string): void;
}

function makeFakeSocket(): FakeSocket {
	const handlers = new Map<string, Array<(...args: any[]) => void>>();
	const socket: FakeSocket = {
		unrefCalls: 0,
		unref() { socket.unrefCalls++; },
		on(event, cb) {
			const list = handlers.get(event) ?? [];
			list.push(cb);
			handlers.set(event, list);
			return socket;
		},
		destroy() {},
		write() {},
		fire(event) { for (const cb of handlers.get(event) ?? []) cb(); },
	};
	return socket;
}

function probeFrom(map: Map<number, string | null>): OwnerProbe {
	return {
		exists: (pid: number) => map.has(pid),
		startToken: (pid: number) => map.get(pid) ?? null,
	};
}

/** Recover one orphan whose log is `log`, and return the delivery. */
function recoverWith(log: string | null): { firstLine: string; message: string } {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-abnormal-stop-"));
	tempDirs.push(dir);
	const sid = `subagent-recovered-${randomUUID()}`;
	writeFileSync(path.join(dir, `pi-subagent-${sid}.sock`), "");
	if (log !== null) writeFileSync(path.join(dir, `pi-subagent-${sid}.log`), log);
	writeFileSync(
		path.join(dir, `pi-subagent-${sid}.meta.json`),
		JSON.stringify({
			agentName: "scout-code",
			task: "t",
			cwd: dir,
			ownerPid: 4242,
			ownerStartToken: "gone",
			parentSessionId: SELF_SESSION,
		}),
	);

	const { pi, sent } = piStub();
	_testSetLiveSessionCtx(liveCtx());
	const sockets: FakeSocket[] = [];
	recoverOrphanedSubagents(pi as any, liveCtx(), {
		dir,
		selfPid: SELF_PID,
		selfSessionId: SELF_SESSION,
		probe: probeFrom(new Map()), // owner process gone → adopt
		connect: () => {
			const s = makeFakeSocket();
			sockets.push(s);
			return s as any;
		},
	});
	expect(sockets.length).toBe(1);
	sockets[0].fire("connect");
	sockets[0].fire("close");
	expect(sent.length).toBe(1);
	return { firstLine: sent[0].split("\n")[0], message: sent[0] };
}

describe("a recovered child is classified from the footer it left behind", () => {
	it("N4: `Stopped (7 turns, exit 143)` — not `finished`, and the footer's word and exit code are read", () => {
		const log = "── Turn 1 ──\nwork in progress\n── Stopped (7 turns, exit 143) ──\n";
		// The footer is the recovered child's only terminal evidence.
		expect(readTerminalFooter(log)).toEqual({ word: "Stopped", turns: 7, exitCode: 143 });

		const { firstLine, message } = recoverWith(log);
		expect(firstLine.startsWith("[Subagent scout-code aborted] — session: ")).toBe(true);
		expect(message).toContain("Turns: 7");
		expect(readSubagentState({
			meta: { ownerPid: 4242, ownerStartToken: "gone" },
			attached: false,
			sockExists: false,
			logLastLine: "── Stopped (7 turns, exit 143) ──",
			logMtimeMs: Date.now() - 3_600_000,
			sessionFileExists: true,
			hasRecordedOwner: true,
			ownerAlive: false,
			now: Date.now(),
		}).state).not.toBe("complete");
	});

	it("N4b: `Completed (5 turns, exit 0)` — still `finished`", () => {
		const log = "── Turn 1 ──\nthe report\n── Completed (5 turns, exit 0) ──\n";
		expect(readTerminalFooter(log)).toEqual({ word: "Completed", turns: 5, exitCode: 0 });

		const { firstLine, message } = recoverWith(log);
		expect(firstLine.startsWith("[Subagent scout-code finished] — session: ")).toBe(true);
		expect(message).toContain("Turns: 5");
	});

	it("`Stopped (3 turns, exit ?)` — a signalled child is not delivered as `finished`", () => {
		// The footer writes `exit ?` when the process left no exit code, which is
		// what a signal kill looks like. It must not read as success.
		const log = "── Turn 1 ──\nwork\n── Stopped (3 turns, exit ?) ──\n";
		expect(readTerminalFooter(log)).toEqual({ word: "Stopped", turns: 3, exitCode: null });

		const { firstLine } = recoverWith(log);
		expect(firstLine.startsWith("[Subagent scout-code aborted] — session: ")).toBe(true);
	});

	it("a log with no footer leaves no evidence of a finished run", () => {
		const { firstLine } = recoverWith("── Turn 1 ──\nthe previous session died here\n");
		expect(firstLine.startsWith("[Subagent scout-code aborted] — session: ")).toBe(true);
	});
});

// ── End to end: the close handler writes and delivers the new word ─────────

/** A stand-in child that answers `get_state` and emits one text-only assistant
 *  turn. `standin-mode.txt` in its cwd decides the case: `length` (default)
 *  truncates the turn, `signalled` completes it and then dies by SIGKILL (so the
 *  parent's close handler sees `code === null`), `unknown` completes it with a
 *  `stopReason` no vocabulary names. */
const STANDIN_SOURCE = `
import { appendFileSync, readFileSync } from "node:fs";

const PI_SESSION_ID = "standin-abnormal-stop";
let mode = "length";
try { mode = readFileSync("standin-mode.txt", "utf8").trim() || mode; } catch { /* default */ }
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
	try { appendFileSync("stdin-echo.txt", d); } catch { /* */ }
	for (const line of String(d).split("\\n")) {
		if (!line.trim()) continue;
		let msg;
		try { msg = JSON.parse(line); } catch { continue; }
		if (msg && msg.type === "get_state") {
			process.stdout.write(JSON.stringify({
				type: "response", id: msg.id, success: true,
				data: { sessionId: PI_SESSION_ID, sessionFile: "/tmp/" + PI_SESSION_ID + ".jsonl" },
			}) + "\\n");
		}
	}
});
process.stdin.on("end", () => {
	if (mode === "signalled") process.kill(process.pid, "SIGKILL");
	process.exit(0);
});
setTimeout(() => {
	const stopReason = mode === "length" ? "length" : mode === "unknown" ? "timeout" : "stop";
	process.stdout.write(JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			stopReason,
			content: [{ type: "text", text: "I got as far as the third file" }],
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
		},
	}) + "\\n");
}, 300);
setInterval(() => {}, 1 << 30);
`;

let fixtureRoot: string;
let argv1Before: string | undefined;
let agentDirBefore: string | undefined;
let restoreSubagentEnv: () => void = () => {};
const spawnedSessions: string[] = [];

// The harness injects PI_SUBAGENT_* into every subagent and reads them in the
// spawn path, so the suite scrubs them to be green from inside a subagent
// (tests/helpers/subagent-env.ts), like the other stand-in-child suites do.
beforeAll(() => {
	restoreSubagentEnv = scrubSubagentEnv();
	fixtureRoot = mkdtempSync(path.join(tmpdir(), "pi-abnormal-stop-"));
	const fakePi = path.join(fixtureRoot, "stand-in-pi.mjs");
	writeFileSync(fakePi, STANDIN_SOURCE + STANDIN_EPILOGUE);
	argv1Before = process.argv[1];
	process.argv[1] = fakePi;

	const agentsDir = path.join(fixtureRoot, "agent", "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(
		path.join(agentsDir, "standin-worker.md"),
		"---\nname: standin-worker\ndescription: abnormal-stop fixture\n---\n\nDo the work.\n",
	);
	agentDirBefore = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(fixtureRoot, "agent");
});

afterAll(() => {
	restoreSubagentEnv();
	if (argv1Before !== undefined) process.argv[1] = argv1Before;
	if (agentDirBefore === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = agentDirBefore;
	rmSync(fixtureRoot, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, ms = 15_000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (check()) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return check();
}

afterEach(async () => {
	for (const sid of spawnedSessions.splice(0)) {
		const rs = resolveRunningSession(sid);
		if (rs) {
			if (rs.staleTimer) clearTimeout(rs.staleTimer);
			if (rs.silenceTimer) clearTimeout(rs.silenceTimer);
			try { rs.proc?.kill("SIGKILL"); } catch { /* already gone */ }
			await waitFor(() => !resolveRunningSession(sid), 5_000);
		}
		for (const f of [metaPath(sid), `/tmp/pi-subagent-${sid}.log`, `/tmp/pi-subagent-${sid}.sock`]) {
			try { if (existsSync(f)) unlinkSync(f); } catch { /* best-effort */ }
		}
	}
});

/** Spawn the stand-in child through the real `subagent` tool and return the
 *  session id plus the captured deliveries. */
async function spawnStandin(mode: "length" | "signalled" | "unknown") {
	const cwd = mkdtempSync(path.join(tmpdir(), "pi-abnormal-stop-case-"));
	tempDirs.push(cwd);
	writeFileSync(path.join(cwd, "standin-mode.txt"), mode);
	const { pi, sent } = piStub();
	const tools = new Map<string, any>();
	pi.registerTool = (def: any) => tools.set(def.name, def);
	subagentFactory(pi);
	const ctx: any = {
		cwd,
		ui: { setStatus() {}, notify() {}, setWidget() {}, clearStatus() {} },
		getModel: () => ({ provider: "openrouter", id: "xiaomi/mimo-v2.6-flash" }),
		sessionManager: { getBranch: () => [], getEntries: () => [], getSessionId: () => SELF_SESSION },
	};
	_testSetLiveSessionCtx(ctx);

	const res = await tools
		.get("subagent")
		.execute("tc", { agent: "standin-worker", task: "Reply with: ok", cwd, isolate: false, review_policy: "skip" }, undefined, undefined, ctx);
	const match = /session: (subagent-[0-9a-f-]+)/.exec(res.content[0].text as string);
	if (!match) throw new Error(`spawn did not return a session id:\n${res.content[0].text}`);
	spawnedSessions.push(match[1]);
	return { sid: match[1], sent };
}

describe("the close handler writes the word it classified", () => {
	it("a child whose last turn was truncated is delivered `overflowed` and logged `Overflowed`", async () => {
		const { sid, sent } = await spawnStandin("length");

		expect(await waitFor(() => sent.length > 0)).toBe(true);
		expect(sent.length).toBe(1);
		// Site 1: the delivered prefix.
		expect(sent[0].split("\n")[0]).toBe(`[Subagent standin-worker overflowed] — session: ${sid}`);

		// Site 2: the footer the close handler actually wrote to the log.
		const log = readFileSync(`/tmp/pi-subagent-${sid}.log`, "utf8").split("\n").filter((l) => l.trim()).pop()!;
		const footer = parseTerminalFooter(log);
		expect(footer).toEqual({ word: "Overflowed", turns: 1, exitCode: 0 });

		// Site 3: the state read back from that written line.
		const reading = readSubagentState({
			meta: { ownerPid: process.pid, ownerStartToken: null },
			attached: false,
			sockExists: false,
			logLastLine: log,
			logMtimeMs: Date.now() - 3_600_000,
			sessionFileExists: true,
			hasRecordedOwner: true,
			ownerAlive: true,
			now: Date.now(),
		});
		expect(reading.state).toBe("orphaned");
		expect(reading.evidence).toContain("Overflowed");
	}, 30_000);

	it("a child that completed its turn and then died by signal is not delivered as `finished`", async () => {
		// The parent's close handler gets `code === null` here. Coercing that to 0
		// is what delivered a signalled child as a finished run.
		const { sid, sent } = await spawnStandin("signalled");

		expect(await waitFor(() => sent.length > 0)).toBe(true);
		expect(sent.length).toBe(1);
		expect(sent[0].split("\n")[0]).toBe(`[Subagent standin-worker aborted] — session: ${sid}`);

		// Sites 2 and 3 from the log the handler wrote: the abort the delivery
		// reports is the abort the durable record and the state reader report.
		const log = readFileSync(`/tmp/pi-subagent-${sid}.log`, "utf8").split("\n").filter((l) => l.trim()).pop()!;
		expect(parseTerminalFooter(log)).toEqual({ word: "Stopped", turns: 1, exitCode: null });
		const reading = readSubagentState({
			meta: { ownerPid: process.pid, ownerStartToken: null },
			attached: false,
			sockExists: false,
			logLastLine: log,
			logMtimeMs: Date.now() - 3_600_000,
			sessionFileExists: true,
			hasRecordedOwner: true,
			ownerAlive: true,
			now: Date.now(),
		});
		expect(reading.state).toBe("orphaned");
	}, 30_000);

	it("an unknown stop reason is delivered labelled and named, not thrown over", async () => {
		// A child pi newer than this vocabulary reports a reason the table does not
		// name (decisions/subagents/001 plans `timeout`). It must still be delivered
		// — labelled non-success — with the reason named where the parent reads it.
		const { sid, sent } = await spawnStandin("unknown");

		expect(await waitFor(() => sent.length > 0)).toBe(true);
		expect(sent.length).toBe(1);
		expect(sent[0].split("\n")[0]).toBe(`[Subagent standin-worker aborted] — session: ${sid}`);
		// Named once, and still named when the child has already logged errors:
		// the delivered `Errors:` line renders three entries, so the note is
		// prepended to that list rather than appended.
		expect(sent[0].split('unknown stopReason "timeout"').length - 1).toBe(1);
		expect(sent[0]).toContain('Errors: unknown stopReason "timeout" — classified aborted');
		const log = readFileSync(`/tmp/pi-subagent-${sid}.log`, "utf8").split("\n").filter((l) => l.trim()).pop()!;
		expect(parseTerminalFooter(log)).toEqual({ word: "Aborted", turns: 1, exitCode: 0 });
	}, 30_000);
});

// ── Vocabulary boundaries: fail loud, never "assume success" ───────────────

describe("the terminal vocabulary has no safe default", () => {
	it("classifies a stop reason the vocabulary does not name as an abort, and names it", () => {
		const rs = rsStub({ isDone: true, progress: turns(1), messages: [assistantMessage("timeout", "?")] });
		const t = terminalOutcome(rs, 0);
		expect(t).toEqual({ outcome: "aborted", footer: "Aborted", prefix: "aborted" });
		expect(rs.progress.errors).toContain('unknown stopReason "timeout" — classified aborted');
	});

	it("names an unknown stop reason where the result renders it, and only once", () => {
		// The delivered `Errors:` line shows the first three entries, so the note
		// must lead the list: a child that already logged three errors is exactly
		// the run whose classification the parent most needs to see.
		const note = 'unknown stopReason "timeout" — classified aborted';
		const rs = rsStub({
			isDone: true,
			progress: { ...turns(1), errors: ["e1", "e2", "e3"] },
			messages: [assistantMessage("timeout", "?")],
		});
		_testSetLiveSessionCtx(liveCtx());
		const { pi, sent } = piStub();
		deliverResult(pi, rs, 0);
		expect(sent[0]).toContain(`Errors: ${note}; e1; e2`);
		// Called from two sites (the footer computation and the delivery), and the
		// note is still there once.
		terminalOutcome(rs, 0);
		expect(rs.progress.errors.filter((e) => e === note).length).toBe(1);
		expect(rs.progress.errors[0]).toBe(note);
	});

	it("refuses a footer word no footer writes", () => {
		expect(() => outcomeFromFooterWord("Finished")).toThrow(/not a terminal footer word/);
	});

	it("parses every word the footer vocabulary writes, and the legacy `exit ?`", () => {
		const words = [...Object.values(OUTCOME_WORD).map((w) => w.footer), "Exited", "Stopped"];
		for (const word of words) {
			const line = footerLine(word, 12, 3);
			expect(parseTerminalFooter(line)).toEqual({ word, turns: 12, exitCode: 3 });
			expect(hasTerminalFooter(line)).toBe(true);
		}
		expect(parseTerminalFooter(footerLine("Stopped", 0, "?"))).toEqual({ word: "Stopped", turns: 0, exitCode: null });
		expect(parseTerminalFooter("── Turn 3 ──")).toBeNull();
	});

	it("reads `Exited` and `Stopped` as the exit code it recorded", () => {
		expect(outcomeFromFooterWord("Exited")).toBeNull();
		expect(outcomeFromFooterWord("Stopped")).toBeNull();
		expect(outcomeFromFooterWord("Overflowed")).toBe("overflowed");
	});
});
