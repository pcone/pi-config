/**
 * Tests for the subagent live-session lifetime contract (decision 026).
 *
 * `pi -p` (print mode) disposes the session when the run ends:
 * `runtimeHost.dispose()` emits `session_shutdown` and then invalidates the
 * extension runner, so any captured spawn-time `ctx` (and `pi`) throws on use.
 * Async subagents are designed to outlive the turn that spawned them, so the
 * child's socket `data` / close handlers must not assume the spawning session
 * is still live. Before this fix they called `updateFooter(ctx)` /
 * `ctx.ui.notify(...)` / `pi.sendUserMessage(...)` with the spawn-time ctx and
 * crashed the parent process from inside a socket handler.
 *
 * Coverage:
 *  1. `session_start` records the live ctx; `updateFooter` renders on it.
 *  2. Regression: with a live session, `deliverResult` still sends exactly
 *     once (same message shape / delivery behavior).
 *  3. With a live session, `notifyChildDetached` emits the exact child-end
 *     notification (pins the byte-identical claim).
 *  4. With a live session, `detach` restores/clears the attach UI and resets
 *     module attach state.
 *  5. After `session_shutdown`, `updateFooter`, `deliverResult`,
 *     `notifyChildDetached`, and `detach` are inert: no throw, no `ui` touch
 *     on either the live-ctx or `pi` surface, no `sendUserMessage` — the
 *     deliberate drop, not a swallowed exception — while module attach state
 *     is still reset.
 *  6. The stale-turn watchdog timer skips its `pi.sendUserMessage` wake-up
 *     when no live session exists (and still sends on a live session).
 *  7. The `wait` tool's timer does the same.
 *
 * Run: bun test tests/subagent-session-lifetime.test.ts
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import extension, {
	_testAttachSessionId,
	_testLiveSessionCtx,
	_testRunning,
	_testSetAttachState,
	_testSetLiveSessionCtx,
	bumpStaleWatchdog,
	detach,
	deliverResult,
	notifyChildDetached,
	updateFooter,
} from "../extensions/subagent-async/index.ts";

// ── Stubs ──────────────────────────────────────────────────────────────────

type UiCall = any[];

interface UiRecorder {
	status: UiCall[];
	notify: UiCall[];
	widget: UiCall[];
	editor: UiCall[];
}

function createUiRecorder(): UiRecorder {
	return { status: [], notify: [], widget: [], editor: [] };
}

/** Build an object with the `ctx.ui` surface backed by `recorder`. */
function recorderUi(recorder: UiRecorder): any {
	return {
		setStatus: (...args: UiCall) => { recorder.status.push(args); },
		notify: (...args: UiCall) => { recorder.notify.push(args); },
		setWidget: (...args: UiCall) => { recorder.widget.push(args); },
		setEditorComponent: (...args: UiCall) => { recorder.editor.push(args); },
	};
}

interface Stub {
	pi: any;
	handlers: Map<string, (event: any, ctx: any) => Promise<any> | any>;
	tools: Map<string, any>;
	sentMessages: string[];
	/** The `pi.ui` surface — NOT used by the guarded post-turn paths, but a
	 *  faithful stub API and a place to prove nothing leaks to it. */
	piUi: UiRecorder;
	/** The live-session `ctx.ui` surface — the only UI surface the guarded
	 *  post-turn paths may touch. Separate from `piUi` so assertions pin the
	 *  routing unambiguously. */
	ctxUi: UiRecorder;
}

/**
 * Minimal `ExtensionAPI` stub: captures event handlers and the `ui` surface.
 */
function createPiStub(): Stub {
	const handlers = new Map<string, (event: any, ctx: any) => Promise<any> | any>();
	const tools = new Map<string, any>();
	const sentMessages: string[] = [];
	const piUi = createUiRecorder();
	const pi: any = {
		events: { emit: () => {} },
		registerTool: (def: any) => { tools.set(def.name, def); },
		registerCommand: () => {},
		on: (event: string, handler: any) => { handlers.set(event, handler); },
		sendUserMessage: (message: string) => { sentMessages.push(message); },
		ui: recorderUi(piUi),
	};
	return { pi, handlers, tools, sentMessages, piUi, ctxUi: createUiRecorder() };
}

/** A ctx stub backed by the given UI recorder. */
function createCtx(recorder: UiRecorder): any {
	return {
		cwd: "/tmp",
		sessionManager: { getSessionId: () => `test-${randomUUID()}` },
		ui: recorderUi(recorder),
	};
}

/** RunningSubagent-shaped stub, just enough for the footer / delivery /
 *  notify / detach / timer paths. */
function stubRunningSubagent(agentName = "test-agent"): any {
	return {
		proc: null,
		sessionId: `subagent-${randomUUID()}`,
		agentName,
		task: "test task",
		cwd: "/tmp",
		startedAt: Date.now(),
		progress: { turns: 3, filesRead: new Set(), filesModified: new Set(), errors: [], currentActivity: "testing" },
		messages: [],
		stdin: null,
		resolveOnStop: null,
		isDone: false,
		killedExplicitly: false,
		stoppedExplicitly: false,
		turnNudged: false,
		logPath: `/tmp/pi-subagent-test-${randomUUID()}.log`,
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
		parentTrackerKey: "test",
		usageStats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, latestCacheHitRate: undefined },
		staleTimer: null,
		lastActivityMs: Date.now(),
		silenceTimer: null,
		silenceTimeoutMs: 0,
		killedVia: null,
	};
}

// ── Timer spy ──────────────────────────────────────────────────────────────
//
// The timer-path guards are only observable by firing the scheduled callback
// after the session has shut down. bun's spyOn wraps-and-calls-through, so the
// real (5-min / N-s) timer is also scheduled; we clear it after each use.
const realSetTimeout = globalThis.setTimeout;
let setTimeoutSpy: ReturnType<typeof spyOn> | null = null;

function installSetTimeoutSpy(): void {
	setTimeoutSpy = spyOn(globalThis, "setTimeout");
}

afterEach(() => {
	if (setTimeoutSpy) {
		for (const result of setTimeoutSpy.mock.results) {
			try { clearTimeout((result as any).value); } catch { /* best-effort */ }
		}
		globalThis.setTimeout = realSetTimeout;
		setTimeoutSpy = null;
	}
});

/** Callback of the most recently scheduled timeout. */
function lastTimeoutCallback(): () => void {
	const calls = setTimeoutSpy!.mock.calls;
	return calls[calls.length - 1]![0] as () => void;
}

// ── Suite ──────────────────────────────────────────────────────────────────

describe("subagent live-session lifetime (decision 026)", () => {
	let stub: Stub;
	let ctx: any;

	beforeAll(async () => {
		stub = createPiStub();
		extension(stub.pi);
		ctx = createCtx(stub.ctxUi);
		// Fire the real session_start handler: it must record the live ctx.
		await stub.handlers.get("session_start")!({ type: "session_start", reason: "new" }, ctx);
		// The real handler scans /tmp and may connect to pre-existing orphan
		// sockets. Destroy those client connections immediately — leaving them
		// tracked (or clearing the map without destroying them) left their
		// close/error handlers armed, so one closing mid-test could deliver a
		// recovered result into the stub and flake the exactly-once assertion.
		for (const rs of [..._testRunning.values()]) {
			for (const socket of [...rs.sockClients]) {
				try { socket.destroy(); } catch { /* best-effort */ }
			}
		}
		_testRunning.clear();
		// Let the destroyed sockets' close handlers run (they see the live ctx
		// and may deliver a recovered result / touch the footer), then reset the
		// recorders so every test starts from a clean snapshot.
		await new Promise((resolve) => setTimeout(resolve, 10));
		_testRunning.clear();
		stub.sentMessages.length = 0;
		stub.ctxUi.status.length = 0;
		stub.ctxUi.notify.length = 0;
		stub.ctxUi.widget.length = 0;
		stub.ctxUi.editor.length = 0;
	});

	afterAll(() => {
		// Clear the live ctx, drop the running map, and stop the sleep-guard
		// timers/caffeinate the footer may have started.
		void stub.handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
		_testRunning.clear();
		updateFooter();
	});

	it("1: session_start records the live ctx and updateFooter renders on it", () => {
		expect(_testLiveSessionCtx()).toBe(ctx);

		// Ignore entries the /tmp recovery scan picked up; assert against a
		// single injected entry so the footer text is deterministic.
		_testRunning.clear();
		_testRunning.set("s1", stubRunningSubagent("footer-agent"));
		stub.ctxUi.status.length = 0;

		updateFooter();

		// The assertion is on the *ctx* recorder (routing), which is separate
		// from the pi recorder, so a `pi.ui` implementation cannot satisfy it.
		expect(stub.ctxUi.status).toContainEqual(["subagent-async", "subagents: footer-agent (3t)"]);
		expect(stub.piUi.status.length).toBe(0);
	});

	it("2: regression — with a live session, deliverResult sends exactly once", () => {
		stub.sentMessages.length = 0;
		const rs = stubRunningSubagent("deliver-agent");

		deliverResult(stub.pi as any, rs, 0);

		expect(stub.sentMessages.length).toBe(1);
		expect(stub.sentMessages[0]).toContain("[Subagent deliver-agent finished]");
		expect(stub.sentMessages[0]).toContain(`session: ${rs.sessionId}`);
	});

	it("3: with a live session, notifyChildDetached emits the exact child-end notification", () => {
		const rs = stubRunningSubagent("notify-agent");
		stub.ctxUi.notify.length = 0;

		notifyChildDetached(rs);

		expect(stub.ctxUi.notify).toEqual([
			[`Subagent ${rs.sessionId.slice(-8)} ended — detached.`, "info"],
		]);
		expect(stub.piUi.notify.length).toBe(0);
	});

	it("4: with a live session, detach restores/clears the attach UI and resets module state", () => {
		_testSetAttachState("attached-session", { ui: {} });
		stub.ctxUi.editor.length = 0;
		stub.ctxUi.widget.length = 0;
		stub.ctxUi.status.length = 0;

		expect(() => detach()).not.toThrow();

		expect(stub.ctxUi.editor).toContainEqual([undefined]);
		expect(stub.ctxUi.widget).toContainEqual(["subagent-attach", undefined]);
		expect(stub.ctxUi.status).toContainEqual(["subagent-attach", undefined]);
		expect(_testAttachSessionId()).toBeNull();
		expect(stub.piUi.editor.length).toBe(0);
		expect(stub.piUi.widget.length).toBe(0);
	});

	it("5: after session_shutdown, updateFooter / deliverResult / notifyChildDetached / detach are inert (no throw, no ui, no send)", async () => {
		// `session_shutdown` fires before the extension is invalidated, so this
		// is the exact ordering that precedes the stale-ctx throw.
		await stub.handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx);
		expect(_testLiveSessionCtx()).toBeNull();

		const rs = stubRunningSubagent("dead-session-agent");
		_testRunning.clear();
		_testRunning.set(rs.sessionId, rs);
		_testSetAttachState("attached-session", { ui: {} });

		const ctxCounts = {
			status: stub.ctxUi.status.length,
			notify: stub.ctxUi.notify.length,
			widget: stub.ctxUi.widget.length,
			editor: stub.ctxUi.editor.length,
		};
		const sentBefore = stub.sentMessages.length;

		expect(() => updateFooter()).not.toThrow();
		expect(() => deliverResult(stub.pi as any, rs, 0)).not.toThrow();
		expect(() => notifyChildDetached(rs)).not.toThrow();
		expect(() => detach()).not.toThrow();

		// The deliberate drop: no UI touch and no delivery after shutdown.
		expect(stub.ctxUi.status.length).toBe(ctxCounts.status);
		expect(stub.ctxUi.notify.length).toBe(ctxCounts.notify);
		expect(stub.ctxUi.widget.length).toBe(ctxCounts.widget);
		expect(stub.ctxUi.editor.length).toBe(ctxCounts.editor);
		expect(stub.piUi.status.length).toBe(0);
		expect(stub.piUi.notify.length).toBe(0);
		expect(stub.sentMessages.length).toBe(sentBefore);
		// detach still resets module attach state even without a live session.
		expect(_testAttachSessionId()).toBeNull();
	});

	it("6: bumpStaleWatchdog skips the wake-up with no live session (live session sends once)", () => {
		const sent: string[] = [];
		const localPi: any = { sendUserMessage: (m: string) => { sent.push(m); } };
		const rs = stubRunningSubagent("stale-agent");
		rs.progress.currentActivity = "wait"; // first branch: nested-wait wake-up
		_testRunning.clear();
		_testRunning.set(rs.sessionId, rs);

		// Live session → the nested-wait wake-up still fires.
		_testSetLiveSessionCtx(ctx);
		installSetTimeoutSpy();
		bumpStaleWatchdog(localPi, rs);
		lastTimeoutCallback()();
		expect(sent.length).toBe(1);
		expect(sent[0]).toContain("[Subagent waiting] stale-agent");

		// No live session → the same callback is inert (no throw, no send).
		_testSetLiveSessionCtx(null);
		bumpStaleWatchdog(localPi, rs);
		const deadCallback = lastTimeoutCallback();
		expect(() => deadCallback()).not.toThrow();
		expect(sent.length).toBe(1);
	});

	it("7: wait timer skips the wake-up with no live session (live session sends once)", async () => {
		const rs = stubRunningSubagent("wait-agent");
		_testRunning.clear();
		_testRunning.set(rs.sessionId, rs);
		const waitTool = stub.tools.get("wait");
		expect(waitTool).toBeDefined();

		// Live session → the timer fires a "still running" wake-up.
		_testSetLiveSessionCtx(ctx);
		installSetTimeoutSpy();
		stub.sentMessages.length = 0;
		await waitTool.execute("call-1", { seconds: 30 });
		lastTimeoutCallback()();
		expect(stub.sentMessages.length).toBe(1);
		expect(stub.sentMessages[0]).toContain("[wait timer] 30s elapsed");

		// No live session → the same callback is inert.
		_testSetLiveSessionCtx(null);
		await waitTool.execute("call-2", { seconds: 30 });
		const deadCallback = lastTimeoutCallback();
		const sentBefore = stub.sentMessages.length;
		expect(() => deadCallback()).not.toThrow();
		expect(stub.sentMessages.length).toBe(sentBefore);
	});
});
