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
 *  - S rows drive the sampled, asynchronous commit observation: no spawn off
 *    the sample grid, a slow observation off the turn path, and the one-sample
 *    lag between a stall of N and the steer.
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
	STALL_SAMPLE_TURNS,
	STALL_TURNS,
	TURN_CAP_DEFAULT,
	TURN_CAP_GRACE,
	decideTurnAction,
	nextStallState,
	resolveTurnCap,
	stallSampleDue,
	type CommitObservation,
	type TurnCapState,
} from "../extensions/lib/subagent-state.ts";
import subagentFactory, {
	_testRunning,
	_testSetLiveSessionCtx,
	deliverCloseResult,
	deliverResult,
	observeCommit,
	readMetaJson,
	resolveRunningSession,
	turnCapStep,
	turnCapTurn,
	writeMetaJson,
	type CommitRunner,
} from "../extensions/subagent-async/index.ts";
import { childEnv, scrubSubagentEnv } from "./helpers/subagent-env.ts";
import { removeSpawnArtifacts, waitUntilUntracked } from "./helpers/subagent-lifecycle.ts";

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
		removeSpawnArtifacts(sid);
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
		stall: stallOf(),
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

/** A stub child's stall tracker with only the axes a row is about overridden. */
function stallOf(over: Record<string, any> = {}): any {
	return {
		stallTurns: 0,
		stallSteered: false,
		stallObserved: false,
		lastTip: null,
		pending: null,
		foldedTurn: 0,
		inFlight: false,
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

describe("stallSampleDue: the observation grid", () => {
	it("U10: the grid is every tenth turn, and turn zero is not a turn", () => {
		expect(stallSampleDue(0)).toBe(false);
		expect(stallSampleDue(1)).toBe(false);
		expect(stallSampleDue(STALL_SAMPLE_TURNS - 1)).toBe(false);
		expect(stallSampleDue(STALL_SAMPLE_TURNS)).toBe(true);
		expect(stallSampleDue(STALL_SAMPLE_TURNS + 1)).toBe(false);
		expect(stallSampleDue(STALL_SAMPLE_TURNS * 2)).toBe(true);
		// Cumulative, so a resumed dispatch lands on the same grid.
		expect(stallSampleDue(137 + 3)).toBe(true);
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
		const capStepAt = src.indexOf("if (turnCapTurn(rs).kind === \"kill\") return;");
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
		const rs = stubChild({ stall: stallOf({ stallTurns: STALL_TURNS - 1 }) });

		expect(turnCapStep(rs, UNCHANGED)).toEqual({ kind: "stall-steer" });
		expect(rs.stall.stallSteered).toBe(true);
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
		expect(rs.stall.stallTurns).toBe(0);
		expect(rs.stall.stallSteered).toBe(false);
	});

	it("W4: an undelivered stall steer is retried rather than marked delivered", () => {
		const rs = stubChild({
			stall: stallOf({ stallTurns: STALL_TURNS - 1 }),
			stdin: { destroyed: true, write: () => true },
		});

		expect(turnCapStep(rs, UNCHANGED)).toEqual({ kind: "stall-steer" });
		expect(rs.stall.stallSteered).toBe(false);
		expect(turnCapStep(rs, UNCHANGED)).toEqual({ kind: "stall-steer" });
	});

	it("W5: a tripped cap suppresses a pending stall steer", () => {
		const rs = stubChild({
			progress: progressStub(TURN_CAP_DEFAULT + 1),
			turnCapReached: true,
			stall: stallOf({ stallTurns: 40, stallObserved: true }),
		});

		expect(turnCapStep(rs, UNCHANGED)).toEqual({ kind: "none" });
		expect(steeredTexts(rs)).toHaveLength(0);
	});

	it("W5b: the step counts a resumed dispatch's earlier turns, and a no-branch run never stalls", () => {
		// The cap compares cumulative turns: 137 from the earlier run + 13 here.
		const resumed = stubChild({ progress: progressStub(13), turnsBefore: 137 });
		expect(turnCapStep(resumed, UNCHANGED)).toEqual({ kind: "wind-down" });
		// …and the grace is measured on the same number.
		setTimeoutSpy = spyOn(globalThis, "setTimeout");
		const grace = stubChild({ progress: progressStub(23), turnsBefore: 137, turnCapReached: true });
		expect(turnCapStep(grace, UNCHANGED)).toEqual({ kind: "kill" });
		for (const r of setTimeoutSpy!.mock.results as any[]) if (r.value) clearTimeout(r.value);

		// A run with no branch to watch skips the stall arm, however long it runs:
		// every reviewer defaults to non-isolated, and every resume has no branch.
		const noBranch = stubChild({
			progress: progressStub(25),
			stall: stallOf({ stallTurns: 40, stallObserved: true }),
		});
		expect(turnCapStep(noBranch, NO_BRANCH)).toEqual({ kind: "none" });
		expect(steeredTexts(noBranch)).toHaveLength(0);
		expect(noBranch.stall.stallTurns).toBe(0);
		expect(noBranch.stall.stallObserved).toBe(false);
	});

	it("W5c: a run handle carrying decoy cap fields cannot steer the decision", () => {
		// The decider's input is exactly the fields TurnCapState names. A handle
		// spread into it would let an unrelated `turns`/`cap`/`capTripped` on the
		// run silently re-time the wind-down or the kill.
		const rs = stubChild({
			progress: progressStub(4),
			turns: 9_999,
			cap: 1,
			capTripped: true,
			commitChanged: true,
		});

		expect(turnCapStep(rs, null)).toEqual({ kind: "none" });
		expect(steeredTexts(rs)).toHaveLength(0);
		expect(rs.proc.signals).toEqual([]);
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

describe("the sampled, asynchronous commit observation", () => {
	/** A stub child with a branch to watch and a baseline tip. */
	function observingChild(over: Record<string, any> = {}): any {
		return stubChild({
			isolationBranch: "pi-subagent-sampled",
			parentCwd: process.cwd(),
			stall: stallOf({ lastTip: "tip-unchanged" }),
			...over,
		});
	}

	it("S1: only a sample turn starts an observation", async () => {
		let spawns = 0;
		const run: CommitRunner = async () => {
			spawns++;
			return "tip-unchanged";
		};
		const rs = observingChild();

		// No spawn on any non-sample turn, however many turns run.
		for (let turn = 1; turn < STALL_SAMPLE_TURNS; turn++) {
			rs.progress.turns = turn;
			expect(turnCapTurn(rs, run).kind).toBe("none");
			await flush();
		}
		expect(spawns).toBe(0);

		// The sample turn starts exactly one, and the turn after it starts none.
		rs.progress.turns = STALL_SAMPLE_TURNS;
		turnCapTurn(rs, run);
		await flush();
		expect(spawns).toBe(1);
		rs.progress.turns = STALL_SAMPLE_TURNS + 1;
		turnCapTurn(rs, run);
		await flush();
		expect(spawns).toBe(1);

		// The grid is cumulative: a resumed dispatch at 137 earlier turns samples
		// on the same grid, even though this run has only made three turns.
		const resumed = observingChild({ turnsBefore: 137, progress: progressStub(3), stall: stallOf({ foldedTurn: 137 }) });
		let resumedSpawns = 0;
		turnCapTurn(resumed, async () => {
			resumedSpawns++;
			return "tip-unchanged";
		});
		await flush();
		expect(resumedSpawns).toBe(1);
	}, 30_000);

	it("S5: a killing turn starts no observation", () => {
		setTimeoutSpy = spyOn(globalThis, "setTimeout");
		let spawns = 0;
		const rs = observingChild({ turnCap: 20, turnCapReached: true, progress: progressStub(30) });

		expect(turnCapTurn(rs, async () => {
			spawns++;
			return "tip-unchanged";
		}).kind).toBe("kill");
		expect(spawns).toBe(0);
		expect(rs.proc.signals.length).toBeGreaterThan(0);
		for (const r of setTimeoutSpy!.mock.results as any[]) if (r.value) clearTimeout(r.value);
	}, 30_000);

	it("S6: a stall that begins after a commit is steered later than a fresh one", async () => {
		// Decision 046 states this number, so it is pinned rather than asserted in
		// prose: the fold that first sees the commit resets the counter, and the
		// steer then needs three more sample folds.
		//
		// Worst observed lag: 50 commit-free turns. The dispatch brief's bound is
		// 39 ("within one sample interval after N"), and no phase reaches it —
		// 41 is the best mid-run case. The band is ruled-and-not-met pending an
		// owner answer (decision 046 §Why); this row pins the miss rather than
		// proving the bound was satisfied.
		async function commitFreeTurns(commitAt: number): Promise<number> {
			const rs = observingChild();
			for (let turn = 1; turn <= STALL_TURNS * 6; turn++) {
				rs.progress.turns = turn;
				const tip = turn > commitAt ? "tip-moved" : "tip-unchanged";
				const action = turnCapTurn(rs, async () => tip);
				while (rs.stall.inFlight) await flush();
				if (action.kind === "stall-steer") return turn - commitAt;
			}
			return 0;
		}

		// Both ends of the band, because 41 is the number in dispute: it is the
		// best mid-run case and it already exceeds the brief's 39.
		expect(await commitFreeTurns(9)).toBe(41);
		expect(await commitFreeTurns(10)).toBe(50);
		// An interior phase and a commit before the first sample.
		expect(await commitFreeTurns(25)).toBe(45);
		expect(await commitFreeTurns(0)).toBe(50);
	}, 60_000);

	it("S4: a sample turn that arrives mid-observation starts no second spawn", async () => {
		let spawns = 0;
		let release: (tip: string) => void = () => {};
		const rs = observingChild();

		rs.progress.turns = STALL_SAMPLE_TURNS;
		turnCapTurn(rs, () => {
			spawns++;
			return new Promise<string>((resolve) => {
				release = resolve;
			});
		});
		await flush();
		expect(spawns).toBe(1);
		expect(rs.stall.inFlight).toBe(true);

		// The next sample turn arrives while the first observation is still out.
		rs.progress.turns = STALL_SAMPLE_TURNS * 2;
		turnCapTurn(rs, async () => {
			spawns++;
			return "tip-unchanged";
		});
		await flush();
		expect(spawns).toBe(1);

		// The outstanding observation still lands, and the next sample turn folds
		// it — the skipped sample costs nothing but the wait.
		release("tip-unchanged");
		expect(await waitFor(() => rs.stall.pending !== null, 5_000)).toBe(true);
		expect(rs.stall.pending.atTurn).toBe(STALL_SAMPLE_TURNS);
		expect(rs.stall.inFlight).toBe(false);
	}, 30_000);

	it("S2: a slow observation does not hold up the turn path", async () => {
		const rs = observingChild();
		rs.progress.turns = STALL_SAMPLE_TURNS;

		const started = Date.now();
		turnCapTurn(rs, () => new Promise<string>((resolve) => setTimeout(() => resolve("tip-unchanged"), 2000)));
		const turnMs = Date.now() - started;

		// The turn returns on its own; a two-second spawn is nowhere on it.
		expect(turnMs).toBeLessThan(500);
		expect(rs.stall.inFlight).toBe(true);
		expect(rs.stall.pending).toBe(null);

		// It lands afterwards, off the turn path, for a later turn to fold.
		expect(await waitFor(() => rs.stall.pending !== null, 10_000)).toBe(true);
		expect(rs.stall.pending.obs).toEqual({ observed: true, changed: false });
		expect(rs.stall.pending.atTurn).toBe(STALL_SAMPLE_TURNS);
		expect(rs.stall.inFlight).toBe(false);
	}, 30_000);

	it("S3: a stall is caught within one sample interval after N, and never before it", async () => {
		// A real branch that never moves, driven through the production command:
		// the sampling grid, the async spawn and the fold are all in play.
		const dir = mkdtempSync(join(tmpdir(), "wo090-stall-"));
		dirsToClean.push(dir);
		const repo = join(dir, "repo");
		const branch = "pi-subagent-stall";
		const git = (args: string[], author = false) =>
			execFileSync("git", args, {
				cwd: repo,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "ignore"],
				env: author
					? childEnv({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" })
					: childEnv(),
			});
		execFileSync("mkdir", ["-p", repo], { env: childEnv() });
		git(["init", "-q", "-b", "main"]);
		git(["commit", "-q", "--allow-empty", "-m", "base"], true);
		git(["branch", branch]);
		const rs = observingChild({
			isolationBranch: branch,
			parentCwd: repo,
			stall: stallOf({ lastTip: git(["rev-parse", branch]).trim() }),
		});

		let steeredAt = 0;
		for (let turn = 1; turn <= STALL_TURNS + STALL_SAMPLE_TURNS; turn++) {
			rs.progress.turns = turn;
			const action = turnCapTurn(rs);
			// The sample's spawn lands before the next turn: the row is about
			// where the result is applied, not about how long the spawn takes.
			while (rs.stall.inFlight) await flush();
			if (action.kind === "stall-steer") {
				steeredAt = turn;
				break;
			}
			await flush();
		}

		// A stall of N is not reported before N commit-free turns...
		expect(steeredAt).toBeGreaterThan(STALL_TURNS);
		// ...and the sample lag is the whole delay: one interval at most.
		expect(steeredAt).toBeLessThanOrEqual(STALL_TURNS + STALL_SAMPLE_TURNS);
		// The fold happens on a sample turn, not on the turn the observation
		// lands: folding on arrival would steer at 31, inside the window above.
		expect(steeredAt % STALL_SAMPLE_TURNS).toBe(0);
		expect(steeredTexts(rs)).toEqual([STALL_STEER]);
		// Still advisory: the observation never kills, and never re-steers.
		expect(rs.proc.signals).toEqual([]);
		while (rs.stall.inFlight) await flush();
		expect(turnCapTurn(rs).kind).toBe("none");
		expect(steeredTexts(rs)).toHaveLength(1);
	}, 60_000);
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

describe("the close path delivers through the fake pi", () => {
	it("W11: a finished child's result reaches the fake's sendUserMessage", async () => {
		const root = process.cwd();
		const { tools, sent, ctx } = harness(root);

		// The stand-in never runs a turn, so no billed call; SIGTERM directly
		// (not the kill tool, whose `resolveOnStop` path resolves the waiter
		// instead of delivering) is what makes the close handler deliver.
		process.argv[1] = standIn!;
		try {
			const res = await tools.subagent.execute(
				"w11",
				{ agent: "implement", task: "noop", cwd: root, isolate: false, review_policy: "skip" },
				undefined,
				undefined,
				ctx,
			);
			const sid = sidOf(res);
			track(sid, sid);

			const rs = _testRunning.get(sid);
			expect(rs).toBeTruthy();
			rs.proc.kill("SIGTERM");

			// Delivery runs through the spawn-time `pi`; a fake without
			// `sendUserMessage` throws here instead of skipping silently.
			expect(await waitFor(() => sent.some((m) => m.includes(`session: ${sid}`)), 30_000)).toBe(true);
			expect(sent.filter((m) => m.includes(`session: ${sid}`))).toHaveLength(1);
		} finally {
			process.argv[1] = realPi!;
		}
	}, 60_000);
});

describe("the flag reaches the parent's status surface", () => {
	it("W7: subagent_status renders the cap, the turns used, and the reached flag", async () => {
		const { tools } = fakePi();
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
		const { tools } = fakePi();
		const rs = stubChild({ turnCap: resolveTurnCap(0) });
		_testRunning.set(rs.sessionId, rs);
		sidsToClean.push(rs.sessionId);

		const res = await tools.subagent_status.execute("c1", { session_id: rs.sessionId });
		expect(String(res.content[0].text)).toContain("Turn cap: none (disabled)");
	});
});

describe("a cap the tool cannot honour is refused before anything spawns", () => {
	it("W10: turn_cap above the hard limit is an error naming both numbers, and no child is spawned", async () => {
		const { tools, ui } = fakePi();
		const before = _testRunning.size;

		const res = await tools.subagent.execute(
			"w10",
			{ agent: "implement", task: "noop", cwd: process.cwd(), turn_cap: 600 },
			undefined,
			undefined,
			liveCtx(process.cwd(), ui),
		);

		expect(res.isError).toBe(true);
		const text = String(res.content[0].text);
		// Both numbers, so the caller sees why 600 is not a cap it can have.
		expect(text).toContain("600");
		expect(text).toContain(String(MAX_TURNS_HARD));
		// Refused before any worktree or process exists (decision 046).
		expect(_testRunning.size).toBe(before);
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
		const { tools, ui } = fakePi();
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
				{ cwd: process.cwd(), sessionManager: { getSessionId: () => `w9-${randomUUID()}` }, ui } as any,
			);
			return { text: String(res.content[0].text), rs: _testRunning.get(sid) };
		} finally {
			try {
				await tools.subagent_kill.execute("w9k", { session_id: sid }, undefined, undefined, {} as any);
				// Artifact hygiene only: `running.delete` fires before the close
				// handler's commit steps and delivery, so this is not a wait on
				// delivery. W11 is the row that waits on delivery itself.
				await waitUntilUntracked(sid, 30_000);
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

/**
 * The `ExtensionAPI` the factory registers against. Every tool-surface row uses
 * this one: the close handler delivers through the spawn-time `pi`, so a fake
 * without `sendUserMessage` throws from inside the child's close path — in the
 * full suite that lands after the row that caused the close has finished, and
 * reds whatever row happens to be running.
 */
function fakePi() {
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
	return { pi, tools, sent, ui };
}

/** The ctx a tool call runs under, with a live session so delivery reaches `sent`. */
function liveCtx(root: string, ui: Record<string, unknown>) {
	const ctx: any = {
		cwd: root,
		sessionManager: { getSessionId: () => `turn-cap-test-${randomUUID()}` },
		getModel: () => undefined,
		ui,
	};
	_testSetLiveSessionCtx(ctx);
	return ctx;
}

/** Spawn a real child through the extension's own tool surface. */
function harness(root: string) {
	const { tools, sent, ui } = fakePi();
	return { tools, sent, ctx: liveCtx(root, ui) };
}

/** Let every settled promise's continuations run — the observation is async. */
function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
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

describe("E3b: a real isolated spawn publishes what the observation resolves", () => {
	it("the recorded branch resolves from the recorded parent cwd, and the live handle observes it", async () => {
		const root = process.cwd();
		const { tools, ctx } = harness(root);

		// A real isolated spawn — real worktree, real branch, real meta — with a
		// child that never runs a turn, so no billed call and nothing racy.
		process.argv[1] = standIn!;
		try {
			const res = await tools.subagent.execute(
				"e3b",
				{ agent: "implement", task: "noop", cwd: root, review_policy: "skip", isolate: true },
				undefined,
				undefined,
				ctx,
			);
			const text = String(res.content[0].text);
			const sid = sidOf(res);
			track(sid, sid);
			expect(text).not.toContain("stall_watch: none");

			const rs = _testRunning.get(sid);
			expect(rs?.isolationBranch).toBeTruthy();
			// The branch the spawn recorded is one git can resolve from the cwd the
			// spawn recorded — the join that makes the tripwire fire at all.
			const tip = execFileSync("git", ["rev-parse", String(rs?.isolationBranch)], {
				cwd: rs?.parentCwd,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "ignore"],
				env: childEnv(),
			}).trim();
			expect(tip).toBe(rs?.parentHeadCommit);
			// The live handle's own observation agrees, and it now has a baseline.
			expect(await observeCommit(rs)).toEqual({ observed: true, changed: false });
			expect(rs?.stall.lastTip).toBe(tip);
			expect(readMetaJson(sid)?.isolationBranch).toBe(rs?.isolationBranch);
			expect(readMetaJson(sid)?.parentCwd).toBe(rs?.parentCwd);
		} finally {
			try {
				await tools.subagent_kill.execute("e3bk", { session_id: `subagent-placeholder` }, undefined, undefined, {} as any);
			} catch {
				// nothing tracked under the placeholder
			}
			for (const sid of sidsToClean) {
				try {
					await tools.subagent_kill.execute("e3bk", { session_id: sid }, undefined, undefined, {} as any);
				} catch {
					// already gone
				}
				await waitUntilUntracked(sid, 10_000);
			}
			process.argv[1] = realPi!;
		}
	}, 120_000);
});

describe("E3a: the commit observation", () => {
	it("git rev-parse from the parent sees a commit made in a linked worktree, and no ref file under it does", () => {
		const dir = mkdtempSync(join(tmpdir(), "wo090-git-"));
		dirsToClean.push(dir);
		const repo = join(dir, "repo");
		const tree = join(dir, "wt");
		const branch = "pi-subagent-testcase";
		const git = (cwd: string, args: string[]) =>
			execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], env: childEnv() }).trim();
		const sh = (cwd: string, args: string[]) =>
			execFileSync("git", args, {
				cwd,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "ignore"],
				env: childEnv({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }),
			});

		execFileSync("mkdir", ["-p", repo], { env: childEnv() });
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
		// Killed at cap + grace — turn_cap 2 + 10 — and its session file survives,
		// so it stays resumable.
		const killedResult = sent.find((m) => m.startsWith("[Killed via turn-cap")) ?? "";
		expect(killedResult).toContain(`Turns: ${2 + TURN_CAP_GRACE} |`);
		expect(killedResult).toContain("turn_cap_reached: true");
		expect(existsSync(String(readMetaJson(sid)?.sessionFile))).toBe(true);
	}, 600_000);

	it("E3: the observation sees a linked worktree's commit and resets the stall counter", async () => {
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
			execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], env: childEnv() });
		const commit = (cwd: string, msg: string) =>
			execFileSync("git", ["commit", "-q", "--allow-empty", "-m", msg], {
				cwd,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "ignore"],
				env: childEnv({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }),
			});

		execFileSync("mkdir", ["-p", repo], { env: childEnv() });
		git(repo, ["init", "-q", "-b", "main"]);
		commit(repo, "base");
		git(repo, ["worktree", "add", "-q", tree, "-b", branch]);
		const baseline = git(repo, ["rev-parse", branch]).trim();

		const rs = stubChild({
			isolationBranch: branch,
			parentCwd: repo,
			stall: stallOf({ lastTip: baseline, stallTurns: 12, stallObserved: true }),
		});
		expect(await observeCommit(rs)).toEqual({ observed: true, changed: false });
		expect(rs.stall.stallTurns).toBe(12);

		commit(tree, "wip");
		const change = await observeCommit(rs);
		expect(change).toEqual({ observed: true, changed: true });
		expect(rs.stall.lastTip).toBe(git(repo, ["rev-parse", branch]).trim());
		expect(rs.stall.lastTip).not.toBe(baseline);
		// The turn that observed the commit resets the stall counter.
		expect(turnCapStep(rs, change)).toEqual({ kind: "none" });
		expect(rs.stall.stallTurns).toBe(0);

		// A run with no branch is unobserved, not "no commit". So is a branch the
		// command cannot resolve — both skip the stall arm rather than count it.
		expect(await observeCommit(stubChild({ isolationBranch: null }))).toEqual({ observed: false, changed: false });
		expect(
			await observeCommit(
				stubChild({ isolationBranch: "no-such-branch", parentCwd: repo, stall: stallOf({ lastTip: baseline }) }),
			),
		).toEqual({ observed: false, changed: false });
		// A real git repo, real worktree, real commits — the default 5 s bun
		// timeout reds this row in a full suite on a loaded box while it passes
		// alone. The row's own work is a handful of git spawns.
	}, 60_000);

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
