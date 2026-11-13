/**
 * One extension evaluated twice in one process — one runner.
 *
 * pi can evaluate `extensions/subagent-async/index.ts` twice. jiti resolves a
 * relative import through the importing file's realpath, while pi's loader
 * hands jiti the configured path unresolved
 * (`dist/core/extensions/loader.js:527`). With the extension loaded from a
 * path that traverses a symlink, `index.ts`'s cycle re-entry
 * (`index.ts` → `worktree.ts` → `index.ts`) lands on a second module record:
 * the evaluation whose factory pi registered is not the evaluation every
 * sibling module imports. Its `session_start` sets a binding the delivery path
 * never reads, so a completion is dropped in a process with a live session.
 * See `docs/investigations/subagent-wait-wake-2026-11.md`.
 *
 * The state therefore lives in one `globalThis` registry
 * (`extensions/subagent-async/process-state.ts`), and every row here asserts a
 * property that holds only if the second evaluation shares it. `running`,
 * `session_start`/`session_shutdown` and the attach state are the state the
 * child's close path reads.
 *
 * bun's importer collapses path spellings (`import(link/m.ts)` and
 * `import(real/m.ts)` return one instance — verified on 1.3.11), so the second
 * evaluation is constructed with a cache-busting query. The distinctness guard
 * below keeps that honest: if the two imports ever collapse into one, this
 * file fails loudly instead of passing while testing a single evaluation. The
 * real spelling-based duplicate is driven end-to-end in
 * `tests/subagent-wait-wake-e2e.test.ts`.
 */
import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "extensions", "subagent-async", "index.ts");

/** The evaluation every sibling module binds to (`sleep-guard.ts` imports
 *  `./index.ts` without a query, so it always lands here). */
const plain: any = await import(ENTRY);
/** A second evaluation of the same file, holding the handlers/tool closures in
 *  the field shape. */
const dup: any = await import(`${ENTRY}?second-evaluation`);

function stubRunningSubagent(agentName = "dup-agent"): any {
	return {
		proc: null,
		sessionId: `subagent-${randomUUID()}`,
		agentName,
		task: "test task",
		cwd: "/tmp",
		startedAt: Date.now(),
		progress: { turns: 2, filesRead: new Set(), filesModified: new Set(), errors: [], currentActivity: "testing" },
		messages: [],
		stdin: null,
		resolveOnStop: null,
		isDone: true,
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

function stubPi(sent: string[]): any {
	return { sendUserMessage: (message: string) => { sent.push(message); } };
}

describe("the extension evaluated twice shares one runner state", () => {
	it("0: premise — the two imports are distinct evaluations", () => {
		// Pins the row's own setup: a collapsed pair would make every row below
		// assert nothing.
		expect(dup.default).not.toBe(plain.default);
	});

	it("1: a completion delivered through the sibling evaluation's module record lands on the live session", () => {
		// `session_start` runs on the evaluation pi registered; the child's close
		// handler runs in the module graph the siblings import. Setting through
		// one and delivering through the other is exactly the field split.
		dup._testSetLiveSessionCtx({ ui: {} });
		const sent: string[] = [];
		const rs = stubRunningSubagent("dup-deliver-agent");

		// The real close path's single delivery owner (index.ts re-export).
		const path = plain.deliverCloseResult(stubPi(sent), rs, 0, "");

		expect(path).toBe("deliver");
		expect(sent.length).toBe(1);
		expect(sent[0]).toContain("[Subagent dup-deliver-agent finished]");
		plain._testSetLiveSessionCtx(null);
	});

	it("2: the running map is one map", () => {
		const rs = stubRunningSubagent("shared-map-agent");
		plain._testRunning.clear();

		// A child recorded by the evaluation that holds the tool closures must be
		// visible to the one every other module reads.
		dup._testRunning.set(rs.sessionId, rs);

		expect(plain._testRunning.has(rs.sessionId)).toBe(true);
		expect(plain._testRunning.size).toBe(dup._testRunning.size);
		plain._testRunning.clear();
	});

	it("3: a stale evaluation's clear leaves the live session's ctx alone", () => {
		// The registry is shared, so a clear is only valid for the evaluation that
		// set the ctx. Called directly: on pi 1.4.0 the duplicate record's factory
		// never runs, so it has no `session_shutdown` handler to arrive through
		// (decisions/subagents/052).
		const ctx = { ui: {} };
		dup._testSetLiveSessionCtx(ctx);
		plain.clearLiveSession();
		expect(dup._testLiveSessionCtx()).toBe(ctx);

		// The evaluation that set it clears it.
		dup.clearLiveSession();
		expect(dup._testLiveSessionCtx()).toBeNull();
	});

	it("4: the attach state is one state", () => {
		dup._testSetAttachState("attached-session", { ui: {} });
		expect(plain._testAttachSessionId()).toBe("attached-session");
		expect(plain.attachCtx()).not.toBeNull();
		plain._testSetAttachState(null);
		expect(dup._testAttachSessionId()).toBeNull();
	});
});
