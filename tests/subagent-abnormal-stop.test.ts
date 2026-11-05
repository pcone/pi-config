/**
 * WO-2026-078 (Q-A1, owner 2026-11-05: "done, but labelled"): a child whose
 * final assistant turn ended abnormally is delivered, classified and visibly
 * marked — never silently as success, and never refused (gating completion was
 * rejected).
 *
 * Three sites must say the same thing, which is what these rows assert
 * together:
 *   1. the delivered message prefix (`deliverResult`),
 *   2. the live log footer word (the close handler's `terminalOutcome`),
 *   3. the state read back from disk (`readSubagentState` over that footer).
 *
 * Rows:
 *  N1  `length` with text      → overflowed, at all three sites
 *  N2  `error` with text       → errored; the child's own text still delivered
 *  N3  `aborted` with exit 0   → aborted (exit code is not what keys it)
 *  N4  recovery, `Stopped (7 turns, exit 143)` → not finished; word + exit read
 *  N4b recovery, `Completed (5 turns, exit 0)` → still finished
 *  N5  `stop` with text only   → byte-identical delivery (characterisation)
 *  N6  `length` with no text   → boundary: classified, but never `isDone`
 *
 * Plus the classifier's refusals: an unknown stop reason and a footer word no
 * footer writes both throw rather than falling back to "finished".
 *
 * Run: bun test tests/subagent-abnormal-stop.test.ts
 * One row: bun test tests/subagent-abnormal-stop.test.ts -t 'N1'
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	_testRunning,
	_testSetLiveSessionCtx,
	deliverResult,
	recoverOrphanedSubagents,
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
function assistantMessage(stopReason: string, text: string | null) {
	return {
		role: "assistant",
		stopReason,
		content: text === null ? [] : [{ type: "text", text }],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
	};
}

function turns(n: number) {
	return { turns: n, filesRead: new Set<string>(), filesModified: new Set<string>(), errors: [], currentActivity: "" };
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

		// Site 2: the footer word the close handler writes, and the reader
		// accepting it as terminal evidence.
		expect(hasTerminalFooter(`── ${t.footer} (4 turns, exit 0) ──`)).toBe(true);

		// Site 3: the state read back from that log.
		const reading = stateForFooter(t.footer);
		expect(reading.state).not.toBe("complete");
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

		expect(hasTerminalFooter(`── ${t.footer} (2 turns, exit 0) ──`)).toBe(true);
		const reading = stateForFooter(t.footer);
		expect(reading.state).not.toBe("complete");
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

		expect(hasTerminalFooter(`── ${t.footer} (3 turns, exit 0) ──`)).toBe(true);
		const reading = stateForFooter(t.footer);
		expect(reading.state).not.toBe("complete");
		expect(reading.evidence).toContain("Aborted");
	});

	it("N5: `stopReason: stop`, text only — the delivery is the one it always was", () => {
		// Characterisation: nothing here is new API, so this row passes on the
		// pre-078 code too. A normal finish must not acquire an error word.
		const rs = rsStub({
			isDone: true,
			progress: { ...turns(2), filesRead: new Set(["a.ts"]) },
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

		expect(hasTerminalFooter("── Completed (2 turns, exit 0) ──")).toBe(true);
		expect(readSubagentState({
			meta: { ownerPid: process.pid, ownerStartToken: null },
			attached: false,
			sockExists: false,
			logLastLine: "── Completed (2 turns, exit 0) ──",
			logMtimeMs: Date.now() - 3_600_000,
			sessionFileExists: true,
			hasRecordedOwner: true,
			ownerAlive: true,
			now: Date.now(),
		}).state).toBe("complete");
	});

	it("N6: `stopReason: length` with no text — the classifier marks it, but the run is never `isDone`", () => {
		// The completion detector (`!hasToolCalls && hasText`) never sets isDone
		// for a textless turn, so this shape is delivered by the kill path (or the
		// close path if the child exits first), not by the completion path. The
		// classification of the turn itself is still abnormal, and its footer word
		// is not a completion.
		const rs = rsStub({ isDone: false, progress: turns(1), messages: [assistantMessage("length", null)] });
		const t = terminalOutcome(rs, 1);
		expect(t.outcome).toBe("overflowed");
		expect(t.footer).toBe("Overflowed");
		expect(t.footer).not.toBe(OUTCOME_WORD.finished.footer);
	});
});

// ── N4 / N4b: the recovery path ────────────────────────────────────────────

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

/** Recover one orphan whose log ends with `log`, and return the delivery. */
function recoverWith(log: string): { firstLine: string; message: string } {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-abnormal-stop-"));
	tempDirs.push(dir);
	const sid = `subagent-recovered-${randomUUID()}`;
	writeFileSync(path.join(dir, `pi-subagent-${sid}.sock`), "");
	writeFileSync(path.join(dir, `pi-subagent-${sid}.log`), log);
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
});

// ── Vocabulary boundaries: fail loud, never "assume success" ───────────────

describe("the terminal vocabulary has no safe default", () => {
	it("refuses an unknown stop reason instead of calling it finished", () => {
		const rs = rsStub({ isDone: true, messages: [assistantMessage("timeout", "?"), ], progress: turns(1) });
		expect(() => terminalOutcome(rs, 0)).toThrow(/unknown stopReason "timeout"/);
	});

	it("refuses an assistant message that carries no stopReason at all", () => {
		const rs = rsStub({ isDone: true, messages: [{ role: "assistant", content: [{ type: "text", text: "x" }] }] });
		expect(() => terminalOutcome(rs, 0)).toThrow(/carries no stopReason/);
	});

	it("refuses a footer word no footer writes", () => {
		expect(() => outcomeFromFooterWord("Finished")).toThrow(/not a terminal footer word/);
	});

	it("parses every word the footer vocabulary writes, and the legacy `exit ?`", () => {
		const words = [...Object.values(OUTCOME_WORD).map((w) => w.footer), "Exited", "Stopped"];
		for (const word of words) {
			expect(parseTerminalFooter(`── ${word} (12 turns, exit 3) ──`)).toEqual({ word, turns: 12, exitCode: 3 });
			expect(hasTerminalFooter(`── ${word} (12 turns, exit 3) ──`)).toBe(true);
		}
		expect(parseTerminalFooter("── Stopped (0 turns, exit ?) ──")).toEqual({ word: "Stopped", turns: 0, exitCode: null });
		expect(parseTerminalFooter("── Turn 3 ──")).toBeNull();
	});
});
