/**
 * WO-2026-090 / decision 046: the per-dispatch turn cap and the advisory
 * no-progress tripwire.
 *
 * Three layers, because the mechanism is a pure decision plus one execution
 * site:
 *
 *  - U rows drive `decideTurnAction` / `resolveTurnCap` / `nextStallState`
 *    directly: every state the order names, plus the combinations it leaves to
 *    the implementer (a tripped cap during the grace, a commit landing on the
 *    turn the counter would have tripped, a pending stall under a cap).
 *  - W rows drive `turnCapStep`, the one place a turn's action is executed,
 *    against a stub child: the wind-down goes out once and carries no number,
 *    the grace path reaches `dispatchKillSignals` with the `turn-cap` reason,
 *    the stall steer repeats only after a new stall, and `subagent_status`
 *    renders the flag.
 *  - E rows are real child dispatches and the git mechanism they depend on.
 *
 * LIVE-NETWORK: the four E rows spawn real `pi` children and make billed LLM calls;
 * the deterministic U/W/E3a rows make none. A full-file run is non-deterministic by
 * default because of the E rows only.
 *
 * Run: bun test tests/turn-cap.test.ts            (everything, minutes)
 *      bun test tests/turn-cap.test.ts -t "U"     (deterministic rows only)
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MAX_TURNS_HARD,
	STALL_TURNS,
	TURN_CAP_DEFAULT,
	TURN_CAP_GRACE,
	decideTurnAction,
	nextStallState,
	resolveTurnCap,
	type CommitObservation,
	type TurnCapState,
} from "../extensions/lib/subagent-state.ts";
import subagentFactory, {
	_testRunning,
	_testSetLiveSessionCtx,
	deliverCloseResult,
	deliverResult,
	metaPath,
	observeCommit,
	readMetaJson,
	resolveRunningSession,
	turnCapStep,
	writeMetaJson,
} from "../extensions/subagent-async/index.ts";
import { scrubSubagentEnv } from "./helpers/subagent-env.ts";
import { waitUntilUntracked } from "./helpers/subagent-lifecycle.ts";

// The harness injects PI_SUBAGENT_* into every subagent; a row that spawns a
// real child must not inherit a parent's allowlist or depth.
const restoreEnv = scrubSubagentEnv();

// `getPiInvocation` re-invokes `process.argv[1]` — pi's entry when the extension
// runs inside pi, this test file under `bun test`. The E rows need a child that
// really runs turns, so argv[1] points at a stand-in that execs the pi binary
// with the same RPC args (`tests/work-record-ownership.test.ts` uses the same
// seam with a never-runs-a-turn stand-in). Signals are forwarded so the kill
// rows terminate the child, not the wrapper.
let shimDir: string | undefined;
let argv1Before: string | undefined;
/** The stand-in that never runs a turn, for rows that only need a live handle. */
let standIn: string | undefined;
/** The stand-in that execs the real pi binary, for rows that need real turns. */
let realPi: string | undefined;

beforeAll(() => {
	shimDir = mkdtempSync(join(tmpdir(), "wo090-pi-"));
	const shim = join(shimDir, "real-pi.mjs");
	writeFileSync(
		shim,
		[
			'import { spawn } from "node:child_process";',
			'const child = spawn(process.env.PI_BIN ?? "pi", process.argv.slice(2), { stdio: "inherit" });',
			'for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => { try { child.kill(sig); } catch {} });',
			'child.on("exit", (code) => process.exit(code ?? 1));',
		].join("\n"),
	);
	standIn = join(shimDir, "stand-in-pi.mjs");
	writeFileSync(standIn, 'process.stdin.resume();\nsetInterval(() => {}, 1 << 30);\n');
	realPi = shim;
	argv1Before = process.argv[1];
	process.argv[1] = shim;
});

afterAll(() => {
	if (argv1Before !== undefined) process.argv[1] = argv1Before;
	if (shimDir) rmSync(shimDir, { recursive: true, force: true });
	restoreEnv();
});

/** The wind-down the child receives, verbatim (decision 046). */
const WIND_DOWN =
	"[Turn limit] This run has reached its turn limit. Commit what is green, leave the rest as a " +
	"clearly-marked WIP commit, then report: status partial or blocked, naming what is done, what is not, " +
	"the evidence you have, and what you would do next. You will be stopped shortly if you have not exited. " +
	"Do not thin tests, skip mutations or skip checks to finish.";
/** The advisory stall steer, verbatim (decision 046). */
const STALL_STEER =
	"[No-progress check] No new commit for a long stretch of turns. Stop and check whether your current " +
	"approach is working: if it is, carry on; if it is not, change approach or report what is blocking you.";

// ── Cleanup ────────────────────────────────────────────────────────────────

const logsToClean: string[] = [];
const sidsToClean: string[] = [];
const dirsToClean: string[] = [];

afterEach(() => {
	for (const f of logsToClean) {
		try {
			if (existsSync(f)) unlinkSync(f);
		} catch {
			// best-effort
		}
	}
	logsToClean.length = 0;
	for (const sid of sidsToClean) {
		_testRunning.delete(sid);
		try {
			if (existsSync(metaPath(sid))) unlinkSync(metaPath(sid));
		} catch {
			// best-effort
		}
	}
	sidsToClean.length = 0;
	for (const d of dirsToClean) rmSync(d, { recursive: true, force: true });
	dirsToClean.length = 0;
	// The delivery path only sends while a session is live (decision 026).
	_testSetLiveSessionCtx(null);
});

// bun wraps spyOn and calls through; the original is restored by hand, as
// tests/subagent-async-kill.test.ts does for the SIGKILL fallback timer.
const realSetTimeout = globalThis.setTimeout;
let setTimeoutSpy: ReturnType<typeof spyOn> | null = null;

afterEach(() => {
	if (setTimeoutSpy) {
		globalThis.setTimeout = realSetTimeout;
		setTimeoutSpy = null;
	}
});

// ── Stubs ──────────────────────────────────────────────────────────────────

function progressStub(turns: number): any {
	return {
		turns,
		filesRead: new Set<string>(),
		filesModified: new Set<string>(),
		errors: [] as string[],
		currentActivity: "testing",
	};
}

/** A child that can be written to: the steer payloads land in `written`. */
function stubChild(over: Record<string, any> = {}): any {
	const written: string[] = [];
	const logPath = `/tmp/pi-subagent-test-${randomUUID()}.log`;
	logsToClean.push(logPath);
	const proc: any = {
		killed: false,
		exitCode: null,
		signals: [] as string[],
		kill(sig: string) {
			proc.signals.push(sig);
			proc.killed = true;
		},
	};
	return {
		sessionId: `subagent-${randomUUID()}`,
		agentName: "implement",
		proc,
		stdin: {
			destroyed: false,
			write(chunk: string) {
				written.push(chunk);
				return true;
			},
		},
		isDone: false,
		procExited: false,
		progress: progressStub(0),
		turnCap: TURN_CAP_DEFAULT,
		turnsBefore: 0,
		turnCapReached: false,
		stallTurns: 0,
		stallSteered: false,
		stallLastTip: null,
		killedExplicitly: false,
		killedVia: null,
		staleTimer: null,
		silenceTimer: null,
		logPath,
		logLines: [] as string[],
		sockClients: new Set<any>(),
		watchHandle: null,
		written,
		...over,
	};
}

/** The steer messages a stub child received. */
function steeredTexts(rs: any): string[] {
	return (rs.written as string[]).map((chunk) => String(JSON.parse(chunk).message));
}

// ── U: the pure decision ───────────────────────────────────────────────────

/** The three commit observations a turn can carry. */
const UNCHANGED: CommitObservation = { observed: true, changed: false };
const CHANGED: CommitObservation = { observed: true, changed: true };
const NO_BRANCH: CommitObservation = { observed: false, changed: false };

/** A cap/stall state; each row overrides only the axes it is about. */
function state(over: Partial<TurnCapState> = {}): TurnCapState {
	return {
		turns: 0,
		cap: TURN_CAP_DEFAULT,
		capTripped: false,
		stallTurns: 0,
		stallSteered: false,
		stallObserved: true,
		commitChanged: false,
		...over,
	};
}

describe("decideTurnAction: the cap arm", () => {
	it("U1: below the cap with no stall pending, nothing happens", () => {
		expect(decideTurnAction(state({ turns: TURN_CAP_DEFAULT - 1 }))).toEqual({ kind: "none" });
		expect(decideTurnAction(state({ turns: 1, cap: 5 }))).toEqual({ kind: "none" });
	});

	it("U2: at the cap, the wind-down is the action", () => {
		expect(decideTurnAction(state({ turns: TURN_CAP_DEFAULT }))).toEqual({ kind: "wind-down" });
		expect(decideTurnAction(state({ turns: 5, cap: 5 }))).toEqual({ kind: "wind-down" });
	});

	it("U3: inside the grace and already tripped, the wind-down is not repeated", () => {
		expect(decideTurnAction(state({ turns: TURN_CAP_DEFAULT + 1, capTripped: true }))).toEqual({ kind: "none" });
		// The last turn of the grace is still a grace turn.
		expect(decideTurnAction(state({ turns: TURN_CAP_DEFAULT + TURN_CAP_GRACE - 1, capTripped: true }))).toEqual({
			kind: "none",
		});
	});

	it("U4: the grace exhausted, the run is killed", () => {
		expect(decideTurnAction(state({ turns: TURN_CAP_DEFAULT + TURN_CAP_GRACE, capTripped: true }))).toEqual({
			kind: "kill",
		});
		expect(decideTurnAction(state({ turns: 15, cap: 5, capTripped: true }))).toEqual({ kind: "kill" });
	});

	it("U5: resolveTurnCap defaults, disables, and refuses a cap above the hard limit by naming both numbers", () => {
		expect(resolveTurnCap(undefined)).toBe(TURN_CAP_DEFAULT);
		expect(resolveTurnCap(0)).toBe(Infinity);
		expect(resolveTurnCap(-5)).toBe(Infinity);
		// A disabled cap never trips: no turn count reaches Infinity.
		expect(decideTurnAction(state({ turns: TURN_CAP_DEFAULT, cap: resolveTurnCap(0) }))).toEqual({ kind: "none" });
		expect(decideTurnAction(state({ turns: 10_000, cap: resolveTurnCap(0) }))).toEqual({ kind: "none" });
		expect(() => resolveTurnCap(600)).toThrow(/600/);
		expect(() => resolveTurnCap(600)).toThrow(/500/);
		expect(() => resolveTurnCap(MAX_TURNS_HARD)).not.toThrow();
		// NaN is not "disabled": it is not a turn count.
		expect(() => resolveTurnCap(NaN)).toThrow(/turn_cap/);
	});
});

describe("decideTurnAction: the stall arm", () => {
	it("U5b: the ruled numbers are pinned, not just symbolically referenced", () => {
		expect(TURN_CAP_DEFAULT).toBe(150);
		expect(TURN_CAP_GRACE).toBe(10);
		expect(STALL_TURNS).toBe(30);
	});

	it("U6: a full stall with an unchanged commit steers", () => {
		expect(decideTurnAction(state({ stallTurns: STALL_TURNS }))).toEqual({ kind: "stall-steer" });
	});

	it("U7: one turn short is nothing; a new commit cannot steer, and the fold resets the counter", () => {
		expect(decideTurnAction(state({ stallTurns: STALL_TURNS - 1 }))).toEqual({ kind: "none" });
		expect(decideTurnAction(state({ stallTurns: 40, commitChanged: true }))).toEqual({ kind: "none" });
		expect(nextStallState({ stallTurns: 40, stallSteered: true, stallObserved: true }, CHANGED)).toEqual({
			stallTurns: 0,
			stallSteered: false,
			stallObserved: true,
		});
		// An unchanged commit advances the counter and keeps the steer flag.
		expect(nextStallState({ stallTurns: 40, stallSteered: true, stallObserved: true }, UNCHANGED)).toEqual({
			stallTurns: 41,
			stallSteered: true,
			stallObserved: true,
		});
		// The steer already delivered for this stall is not repeated.
		expect(decideTurnAction(state({ stallTurns: 40, stallSteered: true }))).toEqual({ kind: "none" });
		// A run with nothing to watch has no stall to report, however long it runs.
		expect(decideTurnAction(state({ stallTurns: 40, stallObserved: false }))).toEqual({ kind: "none" });
		expect(nextStallState({ stallTurns: 40, stallSteered: true, stallObserved: true }, NO_BRANCH)).toEqual({
			stallTurns: 0,
			stallSteered: false,
			stallObserved: false,
		});
	});

	it("U8: a run at its cap gets the cap's one message, not the stall's", () => {
		// Untripped at the cap: the wind-down outranks a pending stall.
		expect(decideTurnAction(state({ turns: TURN_CAP_DEFAULT, stallTurns: 40 }))).toEqual({ kind: "wind-down" });
		// Tripped inside the grace with a stall pending: silence, not a second steer.
		expect(decideTurnAction(state({ turns: TURN_CAP_DEFAULT + 1, capTripped: true, stallTurns: 40 }))).toEqual({
			kind: "none",
		});
	});

	it("U9: a cap whose grace would overrun the hard limit — the hard arm fires first and keeps its reason", () => {
		// The conflict only exists at 500 turns, which no test can dispatch, so the
		// row pins the structure that decides it: the hard ceiling's block precedes
		// the turn-cap step and dispatches "turn-limit", and a cap above the hard
		// limit is refused rather than clamped. At 500 the run is killed as
		// turn-limit, never as turn-cap. This holds for a fresh spawn: the ceiling
		// counts this run's turns, the cap counts the dispatch's (decision 046).
		const src = readFileSync("extensions/subagent-async/index.ts", "utf-8");
		const hardAt = src.indexOf("if (rs.progress.turns >= MAX_TURNS_HARD) {");
		const capStepAt = src.indexOf("turnCapStep(rs, observeCommit(rs))");
		expect(hardAt).toBeGreaterThan(0);
		expect(capStepAt).toBeGreaterThan(hardAt);
		expect(src.slice(hardAt, capStepAt)).toContain('dispatchKillSignals(rs, "turn-limit")');
		// cap + grace CAN cross the hard limit (only the cap itself is refused), so
		// at 500 the pure decider is still inside the grace — the hard arm is what
		// fires there, and its reason is turn-limit.
		expect(decideTurnAction(state({ turns: MAX_TURNS_HARD, cap: 495, capTripped: true }))).toEqual({ kind: "none" });
		expect(decideTurnAction(state({ turns: 505, cap: 495, capTripped: true }))).toEqual({ kind: "kill" });
		expect(() => resolveTurnCap(MAX_TURNS_HARD)).not.toThrow();
		expect(() => resolveTurnCap(MAX_TURNS_HARD + 1)).toThrow();
	});
});

// ── W: the one execution site ──────────────────────────────────────────────

describe("turnCapStep: the executed action", () => {
	it("W1: crossing the cap wind-downs once, with the exact text and no number in it", () => {
		const rs = stubChild({ progress: progressStub(TURN_CAP_DEFAULT) });

		expect(turnCapStep(rs, UNCHANGED)).toEqual({ kind: "wind-down" });
		expect(rs.turnCapReached).toBe(true);
		expect(steeredTexts(rs)).toEqual([WIND_DOWN]);
		// Prohibition 2: no cap, no turn count, no digits at all.
		expect(WIND_DOWN).not.toMatch(/[0-9]/);

		// The next turn inside the grace neither re-steers nor kills.
		rs.progress.turns = TURN_CAP_DEFAULT + 1;
		expect(turnCapStep(rs, UNCHANGED)).toEqual({ kind: "none" });
		expect(steeredTexts(rs)).toHaveLength(1);
		expect(rs.proc.signals).toEqual([]);
	});

	it("W2: at cap + grace the run is killed through dispatchKillSignals with the turn-cap reason", () => {
		setTimeoutSpy = spyOn(globalThis, "setTimeout");
		const rs = stubChild({ progress: progressStub(TURN_CAP_DEFAULT + TURN_CAP_GRACE), turnCapReached: true });

		expect(turnCapStep(rs, UNCHANGED)).toEqual({ kind: "kill" });
		expect(rs.killedVia).toBe("turn-cap");
		expect(rs.killedExplicitly).toBe(true);
		expect(rs.proc.signals).toEqual(["SIGTERM"]);
		expect(rs.logLines.join("\n")).toContain("Killed via turn-cap");
		expect(rs.progress.errors.join("\n")).toContain("Turn cap reached");
		for (const r of setTimeoutSpy!.mock.results as any[]) if (r.value) clearTimeout(r.value);
	});

	it("W3: the stall steer lands once, never kills, and repeats only after a new stall", () => {
		const rs = stubChild({ stallTurns: STALL_TURNS - 1 });

		expect(turnCapStep(rs, UNCHANGED)).toEqual({ kind: "stall-steer" });
		expect(rs.stallSteered).toBe(true);
		expect(steeredTexts(rs)).toEqual([STALL_STEER]);
		expect(STALL_STEER).not.toMatch(/[0-9]/);
		// It never kills.
		expect(rs.killedExplicitly).toBe(false);
		expect(rs.proc.signals).toEqual([]);

		// Same stall, next turns: silence.
		expect(turnCapStep(rs, UNCHANGED)).toEqual({ kind: "none" });
		expect(turnCapStep(rs, UNCHANGED)).toEqual({ kind: "none" });
		expect(steeredTexts(rs)).toHaveLength(1);

		// A new commit resets the stall: the counter and the flag both clear.
		expect(turnCapStep(rs, CHANGED)).toEqual({ kind: "none" });
		expect(rs.stallTurns).toBe(0);
		expect(rs.stallSteered).toBe(false);
	});

	it("W4: an undelivered stall steer is retried rather than marked delivered", () => {
		const rs = stubChild({
			stallTurns: STALL_TURNS - 1,
			stdin: { destroyed: true, write: () => true },
		});

		expect(turnCapStep(rs, UNCHANGED)).toEqual({ kind: "stall-steer" });
		expect(rs.stallSteered).toBe(false);
		expect(turnCapStep(rs, UNCHANGED)).toEqual({ kind: "stall-steer" });
	});

	it("W5: a tripped cap suppresses a pending stall steer", () => {
		const rs = stubChild({
			progress: progressStub(TURN_CAP_DEFAULT + 1),
			turnCapReached: true,
			stallTurns: 40,
		});

		expect(turnCapStep(rs, UNCHANGED)).toEqual({ kind: "none" });
		expect(steeredTexts(rs)).toHaveLength(0);
	});

	it("W5b: the step counts a resumed dispatch's earlier turns, and a no-branch run never stalls", () => {
		// The cap compares cumulative turns: 137 from the earlier run + 13 here.
		const resumed = stubChild({ progress: progressStub(13), turnsBefore: 137 });
		expect(turnCapStep(resumed, UNCHANGED)).toEqual({ kind: "wind-down" });
		// …and the grace is measured on the same number.
		const grace = stubChild({ progress: progressStub(23), turnsBefore: 137, turnCapReached: true });
		expect(turnCapStep(grace, UNCHANGED)).toEqual({ kind: "kill" });

		// A run with no branch to watch skips the stall arm, however long it runs:
		// every reviewer defaults to non-isolated, and every resume has no branch.
		const noBranch = stubChild({ progress: progressStub(25), stallTurns: 40 });
		expect(turnCapStep(noBranch, NO_BRANCH)).toEqual({ kind: "none" });
		expect(steeredTexts(noBranch)).toHaveLength(0);
		expect(noBranch.stallTurns).toBe(0);
		expect(noBranch.stallObserved).toBe(false);
	});

	it("W6: a run killed at its cap carries the turn-cap marker in the delivered result", () => {
		const rs = stubChild({ killedExplicitly: true, killedVia: "turn-cap", messages: [] });
		let delivered = "";
		rs.resolveOnStop = (text: string) => {
			delivered = text;
		};

		expect(deliverCloseResult({} as any, rs, 0)).toBe("stop");
		expect(delivered).toStartWith("[Killed via turn-cap — process terminated");
	});
});

describe("the delivered result carries the flag", () => {
	it("W6b: deliverResult names turn_cap_reached and the dispatch's turn count", () => {
		const sent: string[] = [];
		const pi: any = { sendUserMessage: (m: string) => { sent.push(m); } };
		_testSetLiveSessionCtx({ ui: { setStatus: () => {}, notify: () => {} } });
		const rs = stubChild({
			task: "test task",
			progress: progressStub(4),
			turnsBefore: 148,
			turnCapReached: true,
			messages: [{ role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "stop" }],
		});

		deliverResult(pi, rs, 0);

		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("turn_cap_reached: true | turns_used: 152");
	});
});

describe("the flag reaches the parent's status surface", () => {
	it("W7: subagent_status renders the cap, the turns used, and the reached flag", async () => {
		const tools: Record<string, any> = {};
		subagentFactory({
			on: () => {},
			registerTool: (t: any) => {
				tools[t.name] = t;
			},
			registerCommand: () => {},
		} as any);
		const rs = stubChild({ progress: progressStub(4), turnsBefore: 148, turnCapReached: true });
		_testRunning.set(rs.sessionId, rs);
		sidsToClean.push(rs.sessionId);

		const res = await tools.subagent_status.execute("c1", { session_id: rs.sessionId });
		const text = String(res.content[0].text);
		expect(text).toContain("Turns: 152");
		expect(text).toContain(`Turn cap: ${TURN_CAP_DEFAULT}`);
		expect(text).toContain("Turn cap reached: true");
		expect(resolveRunningSession(rs.sessionId)).toBe(rs);
	});

	it("W8: a disabled cap renders as disabled, not as a number", async () => {
		const tools: Record<string, any> = {};
		subagentFactory({
			on: () => {},
			registerTool: (t: any) => {
				tools[t.name] = t;
			},
			registerCommand: () => {},
		} as any);
		const rs = stubChild({ turnCap: resolveTurnCap(0) });
		_testRunning.set(rs.sessionId, rs);
		sidsToClean.push(rs.sessionId);

		const res = await tools.subagent_status.execute("c1", { session_id: rs.sessionId });
		expect(String(res.content[0].text)).toContain("Turn cap: none (disabled)");
	});
});

describe("a resume carries the cap and the turn count over", () => {
	/** A meta the resume path accepts: a session file that exists, plus the
	 *  decision-046 fields the previous run recorded. */
	function writeResumeMeta(sid: string, fields: Record<string, any>): void {
		const dir = mkdtempSync(join(tmpdir(), "wo090-resume-"));
		dirsToClean.push(dir);
		const sessionFile = join(dir, "session.jsonl");
		writeFileSync(sessionFile, '{"type":"session","version":3,"id":"abc","cwd":"/tmp"}\n{"type":"model_change"}\n');
		writeMetaJson(sid, { sessionFile, agentName: "implement", parentCwd: process.cwd(), ...fields });
	}

	async function resumeRow(fields: Record<string, any>): Promise<{ text: string; rs: any }> {
		const tools: Record<string, any> = {};
		subagentFactory({
			on: () => {},
			registerTool: (t: any) => {
				tools[t.name] = t;
			},
			registerCommand: () => {},
		} as any);
		const sid = `subagent-${randomUUID()}`;
		sidsToClean.push(sid);
		logsToClean.push(`/tmp/pi-subagent-${sid}.log`, `/tmp/pi-subagent-${sid}.sock`);
		writeResumeMeta(sid, fields);

		// A child that never runs a turn: this row is about the meta hand-off.
		process.argv[1] = standIn!;
		try {
			const res = await tools.subagent_resume.execute(
				"w9",
				{ session_id: sid, task: "continue" },
				undefined,
				undefined,
				{ cwd: process.cwd(), sessionManager: { getSessionId: () => `w9-${randomUUID()}` }, ui: {} } as any,
			);
			return { text: String(res.content[0].text), rs: _testRunning.get(sid) };
		} finally {
			try {
				await tools.subagent_kill.execute("w9k", { session_id: sid }, undefined, undefined, {} as any);
			} finally {
				process.argv[1] = realPi!;
			}
		}
	}

	it("W9: the recorded cap and count reach the resumed run, and a legacy meta resolves to the default", async () => {
		const carried = await resumeRow({ turnCap: 40, turnsUsed: 137 });
		expect(carried.text).toContain("turn_cap: 40 | turns_used: 137");
		expect(carried.text).toContain("stall_watch: none");
		expect(carried.rs?.turnCap).toBe(40);
		expect(carried.rs?.turnsBefore).toBe(137);

		// A meta written before decision 046 carries neither field: default cap,
		// count from zero — not "uncapped".
		const legacy = await resumeRow({});
		expect(legacy.text).toContain(`turn_cap: ${TURN_CAP_DEFAULT} | turns_used: 0`);
		// A disabled cap is recorded as 0 and resolves back to disabled.
		const disabled = await resumeRow({ turnCap: 0, turnsUsed: 3 });
		expect(disabled.text).toContain("turn_cap: none (disabled) | turns_used: 3");

		// A cap above the hard limit cannot come back through a resume either.
		await expect(resumeRow({ turnCap: 600 })).rejects.toThrow(/600/);
	}, 120_000);
});

// ── E: the mechanism and real dispatches ───────────────────────────────────

/** Spawn a real child through the extension's own tool surface. */
function harness(root: string) {
	const tools: Record<string, any> = {};
	const sent: string[] = [];
	const ui = { setStatus: () => {}, notify: () => {}, setWidget: () => {}, setEditorComponent: () => {} };
	const pi: any = {
		events: { emit: () => {} },
		registerTool: (t: any) => {
			tools[t.name] = t;
		},
		registerCommand: () => {},
		on: () => {},
		sendUserMessage: (message: string) => {
			sent.push(message);
		},
		ui,
	};
	subagentFactory(pi);
	const ctx: any = {
		cwd: root,
		sessionManager: { getSessionId: () => `turn-cap-test-${randomUUID()}` },
		getModel: () => undefined,
		ui,
	};
	_testSetLiveSessionCtx(ctx);
	return { tools, sent, ctx };
}

function readLog(sid: string): string {
	try {
		return readFileSync(`/tmp/pi-subagent-${sid}.log`, "utf8");
	} catch {
		return "";
	}
}

async function waitFor(predicate: () => boolean, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((r) => setTimeout(r, 100));
	}
	return predicate();
}

function track(sid: string, text: string): typeof text {
	sidsToClean.push(sid);
	logsToClean.push(`/tmp/pi-subagent-${sid}.log`, `/tmp/pi-subagent-${sid}.sock`);
	return text;
}

function sidOf(res: any): string {
	return /session: (subagent-[0-9a-f-]+)/.exec(String(res.content[0].text))![1];
}

describe("E3a: the commit observation", () => {
	it("git rev-parse from the parent sees a commit made in a linked worktree, and no ref file under it does", () => {
		const dir = mkdtempSync(join(tmpdir(), "wo090-git-"));
		dirsToClean.push(dir);
		const repo = join(dir, "repo");
		const tree = join(dir, "wt");
		const branch = "pi-subagent-testcase";
		const git = (cwd: string, args: string[]) =>
			execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		const sh = (cwd: string, args: string[]) =>
			execFileSync("git", args, {
				cwd,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "ignore"],
				env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
			});

		execFileSync("mkdir", ["-p", repo]);
		git(repo, ["init", "-q", "-b", "main"]);
		sh(repo, ["commit", "-q", "--allow-empty", "-m", "base"]);
		git(repo, ["worktree", "add", "-q", tree, "-b", branch]);
		const baseline = git(repo, ["rev-parse", branch]);

		sh(tree, ["commit", "-q", "--allow-empty", "-m", "wip"]);
		const tip = git(tree, ["rev-parse", "HEAD"]);
		expect(tip).not.toBe(baseline);
		// The order's observation, from the parent's cwd: it sees the child's commit.
		expect(git(repo, ["rev-parse", branch])).toBe(tip);
		// Why a file read cannot: a linked worktree's `.git` is a file, and the
		// branch lives in the common dir's refs, not under the worktree.
		expect(existsSync(join(tree, ".git", "refs", "heads", branch))).toBe(false);
	});
});

describe("real dispatch: the cap arm", () => {
	it("E1: a capped child crosses the cap — one wind-down, and the result carries turn_cap_reached and turns_used", async () => {
		const root = process.cwd();
		const { tools, sent, ctx } = harness(root);

		const res = await tools.subagent.execute(
			"e1",
			{
				agent: "implement",
				task: "Reply with the single word: ok",
				cwd: root,
				isolate: false,
				review_policy: "skip",
				turn_cap: 1,
			},
			undefined,
			undefined,
			ctx,
		);
		const sid = sidOf(res);
		track(sid, sid);
		expect(String(res.content[0].text)).toContain("turn_cap: 1 | turns_used: 0");

		expect(await waitFor(() => readLog(sid).includes("[turn-cap] wind-down injected"), 90_000)).toBe(true);
		expect(await waitUntilUntracked(sid, 300_000)).toBe(true);

		const log = readLog(sid);
		expect(log.split("\n").filter((l) => l.includes("[turn-cap] wind-down injected"))).toHaveLength(1);
		expect(log).not.toContain("Killed via turn-cap");

		const delivered = sent.find((m) => m.includes("turn_cap_reached")) ?? "";
		expect(delivered).toContain("turn_cap_reached: true");
		expect(delivered).toMatch(/turns_used: \d+/);
	}, 480_000);

	it("E2: a child that ignores the wind-down is killed at cap + grace, through the shared kill path", async () => {
		const root = process.cwd();
		const { tools, sent, ctx } = harness(root);

		const res = await tools.subagent.execute(
			"e2",
			{
				agent: "implement",
				task:
					"Run the bash tool once per turn: `echo step` — one single bash call per message, then send another, " +
					"and keep going until you have run it at least fifteen times. Only then reply with the word done.",
				cwd: root,
				isolate: false,
				review_policy: "skip",
				turn_cap: 2,
			},
			undefined,
			undefined,
			ctx,
		);
		const sid = sidOf(res);
		track(sid, sid);

		expect(await waitFor(() => readLog(sid).includes("Killed via turn-cap"), 420_000)).toBe(true);
		expect(await waitUntilUntracked(sid, 120_000)).toBe(true);

		const delivered = sent.find((m) => m.startsWith("[Killed via turn-cap")) ?? "";
		expect(delivered).toStartWith("[Killed via turn-cap — process terminated");
		// Killed at cap + grace, and its session file survives, so it stays resumable.
		const killed = readLog(sid).split("\n").find((l) => l.includes("Killed via turn-cap")) ?? "";
		expect(killed).toContain("── Killed");
		expect(existsSync(String(readMetaJson(sid)?.sessionFile))).toBe(true);
	}, 600_000);

	it("E3: the observation sees a linked worktree's commit and resets the stall counter", () => {
		// The production observation, driven directly: a real repo, a real linked
		// worktree branch, and a stub child whose parentCwd is that repo. This is
		// the seat's real-case row — the branch tip moves, so the counter resets —
		// without needing a live sampling window inside a dispatched child.
		const dir = mkdtempSync(join(tmpdir(), "wo090-observe-"));
		dirsToClean.push(dir);
		const repo = join(dir, "repo");
		const tree = join(dir, "wt");
		const branch = "pi-subagent-observe";
		const git = (cwd: string, args: string[]) =>
			execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
		const commit = (cwd: string, msg: string) =>
			execFileSync("git", ["commit", "-q", "--allow-empty", "-m", msg], {
				cwd,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "ignore"],
				env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
			});

		execFileSync("mkdir", ["-p", repo]);
		git(repo, ["init", "-q", "-b", "main"]);
		commit(repo, "base");
		git(repo, ["worktree", "add", "-q", tree, "-b", branch]);
		const baseline = git(repo, ["rev-parse", branch]).trim();

		const rs = stubChild({ isolationBranch: branch, parentCwd: repo, stallLastTip: baseline, stallTurns: 12 });
		expect(observeCommit(rs)).toEqual({ observed: true, changed: false });
		expect(rs.stallTurns).toBe(12);

		commit(tree, "wip");
		const change = observeCommit(rs);
		expect(change).toEqual({ observed: true, changed: true });
		expect(rs.stallLastTip).toBe(git(repo, ["rev-parse", branch]).trim());
		expect(rs.stallLastTip).not.toBe(baseline);
		// The turn that observed the commit resets the stall counter.
		expect(turnCapStep(rs, change)).toEqual({ kind: "none" });
		expect(rs.stallTurns).toBe(0);

		// A run with no branch is unobserved, not "no commit".
		expect(observeCommit(stubChild({ isolationBranch: null }))).toEqual({ observed: false, changed: false });
	});

	it("E4: a resume continues the recorded turn count, carries the cap over, and re-trips it", async () => {
		const root = process.cwd();
		const { tools, sent, ctx } = harness(root);

		const first = await tools.subagent.execute(
			"e4a",
			{
				agent: "implement",
				task: "Reply with the single word: ok",
				cwd: root,
				isolate: false,
				review_policy: "skip",
				turn_cap: 1,
			},
			undefined,
			undefined,
			ctx,
		);
		const sid = sidOf(first);
		track(sid, sid);
		expect(await waitFor(() => readLog(sid).includes("[turn-cap] wind-down injected"), 180_000)).toBe(true);
		expect(await waitUntilUntracked(sid, 300_000)).toBe(true);
		const recorded = readMetaJson(sid)?.turnsUsed;
		expect(typeof recorded).toBe("number");

		const resumed = await tools.subagent_resume.execute(
			"e4b",
			{ session_id: sid, task: "Reply with the single word: ok again" },
			undefined,
			undefined,
			ctx,
		);
		expect(String(resumed.content[0].text)).toContain(`turn_cap: 1 | turns_used: ${recorded}`);
		expect(String(resumed.content[0].text)).toContain("stall_watch: none");

		// The cap carried over, so the resumed run trips it again.
		expect(
			await waitFor(() => readLog(sid).split("[turn-cap] wind-down injected").length > 2, 240_000),
		).toBe(true);
		expect(await waitUntilUntracked(sid, 180_000)).toBe(true);
		expect(sent.filter((m) => m.includes("turn_cap_reached: true")).length).toBeGreaterThanOrEqual(2);
	}, 1_200_000);
});
