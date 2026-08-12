/**
 * Integration smoke test for the todo list's context injection (WO-2026-047).
 *
 * WO-2026-046 added the injection wiring to extensions/todo.ts (the
 * `pendingTodoInjection` flag, re-primed on session_start / session_tree /
 * session_compact, consumed by before_agent_start) but only golden-tested
 * renderTodoBlock's *output*. Nothing proved the handler actually fires after
 * compaction/resume, clears itself one-shot, and suppresses on empty /
 * all-done lists.
 *
 * This suite loads the extension through a minimal fake ExtensionAPI that
 * captures `on` handlers by event name and the `todo` tool def (extending the
 * createPiStub pattern from tests/subagent-async-kill.test.ts), then drives
 * the *real* handlers and the real tool `execute` against the 6-row matrix:
 *
 *   1. Re-prime after compaction (headline): add ×2 → session_compact →
 *      before_agent_start emits the injected message (both tasks, count 2),
 *      then returns undefined on the second call (one-shot).
 *   2. Resume injects: session_start reconstructs a non-empty branch →
 *      before_agent_start emits `[>] #1: X`.
 *   3. Fresh empty session → no message.
 *   4. Adding a task without a re-prime event → no message (event-driven,
 *      not every-turn).
 *   5. All-done list → flag set but renderTodoBlock returns "" → suppressed;
 *      a same-event discriminator proves the priming path was live, so the
 *      suppression is attributable to the empty-block guard.
 *   6. session_tree re-primes like session_start → emits `[ ] #1: Y`.
 *
 * Handler-driving contract: pi's ExtensionHandler is `(event, ctx)` for
 * EVERY event (dist/core/extensions/types.d.ts:851) and the runner invokes
 * `handler(event, ctx)`, so every lifecycle handler here is driven with a
 * minimally valid event object + ctx stub — never with invented arguments.
 * The todo handlers ignore the event/ctx args, but the fake still exercises
 * the real positional contract. The tool `execute` is driven with its full
 * positional signature (_toolCallId, params, _signal, _onUpdate, _ctx).
 *
 * Each test re-loads the extension on a fresh stub: module state (todos,
 * pendingTodoInjection) is closure-scoped per todoExtension(pi) call.
 *
 * Run: bun test tests/todo-injection.test.ts
 */
import { describe, expect, it } from "bun:test";
import todoExtension from "../extensions/todo";

/** Minimal ExtensionAPI stub: captures `on` handlers by event name and tool
 *  defs by name; everything else is an inert no-op. */
function createPiStub() {
	const handlers = new Map<string, (...args: any[]) => any>();
	const tools = new Map<string, any>();
	const pi: any = {
		events: { emit: () => {} },
		on: (event: string, handler: any) => {
			handlers.set(event, handler);
		},
		registerTool: (def: any) => {
			tools.set(def.name, def);
		},
		registerCommand: () => {},
	};
	return { pi, handlers, tools };
}

/** ctx with a test-controlled branch. mode !== "tui" so refreshWidget no-ops;
 *  ui.setWidget is a no-op; the fake must not depend on real pi-tui types. */
function ctxStub(branch: any[] = []) {
	return {
		mode: "rpc",
		sessionManager: { getBranch: () => branch },
		ui: { setWidget: () => {} },
	};
}

/** Minimal, shape-faithful lifecycle events (types.d.ts). The todo handlers
 *  ignore these args; the fields are present so the driving is faithful to
 *  what the real runtime constructs. */
const SESSION_START_EVENT = { type: "session_start", reason: "new" };
const SESSION_TREE_EVENT = { type: "session_tree", newLeafId: "leaf-2", oldLeafId: "leaf-1" };
const SESSION_COMPACT_EVENT = {
	type: "session_compact",
	compactionEntry: {
		type: "compaction",
		id: "entry-compact-1",
		parentId: "entry-0",
		timestamp: "2026-08-06T00:00:00.000Z",
		summary: "Compacted session context",
		firstKeptEntryId: "entry-10",
		tokensBefore: 12000,
	},
	fromExtension: false,
	reason: "manual",
	willRetry: false,
};
const BEFORE_AGENT_START_EVENT = {
	type: "before_agent_start",
	prompt: "user prompt",
	systemPrompt: "system prompt",
	systemPromptOptions: { cwd: "/repo" },
};

/** A branch carrying one todo toolResult snapshot — the shape
 *  reconstructState(ctx) consumes. */
function branchWith(todos: any[], nextId: number, doc?: string) {
	return [
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "todo",
				details: { action: "list", todos, nextId, doc },
			},
		},
	];
}

/** A compaction entry as getBranch() returns it: getBranch() walks the full
 *  leaf→root ancestry and does NOT truncate at compaction (that truncation is
 *  buildContextEntries()'s job, for the LLM view only), so a real post-compaction
 *  branch still contains compaction entries inline — the shape these tests scan. */
function compactionEntry() {
	return {
		type: "compaction",
		id: "entry-compact-1",
		parentId: "entry-0",
		timestamp: "2026-08-06T00:00:00.000Z",
		summary: "Compacted session context",
		firstKeptEntryId: "entry-10",
		tokensBefore: 12000,
	};
}

/** Fresh stub + extension load. Module state is closure-scoped per load, so
 *  every test must call this to start clean. */
function loadExtension() {
	const { pi, handlers, tools } = createPiStub();
	todoExtension(pi);
	return { handlers, tools };
}

describe("todo context injection wiring (WO-2026-047)", () => {
	it("1: re-primes after compaction — one-shot message with the current list", async () => {
		const { handlers, tools } = loadExtension();

		// Fresh, empty session.
		await handlers.get("session_start")(SESSION_START_EVENT, ctxStub([]));
		// Add two tasks via the real tool.
		const add1 = await tools.get("todo").execute("tc1", { action: "add", text: "Task one" }, undefined, undefined, ctxStub());
		expect(add1.content[0].text).toBe("Added #1: Task one");
		const add2 = await tools.get("todo").execute("tc2", { action: "add", text: "Task two" }, undefined, undefined, ctxStub());
		expect(add2.content[0].text).toBe("Added #2: Task two");

		// Compaction re-primes the injection flag.
		await handlers.get("session_compact")(SESSION_COMPACT_EVENT, ctxStub());

		// First before_agent_start emits the injected message.
		const first = await handlers.get("before_agent_start")(BEFORE_AGENT_START_EVENT, ctxStub());
		expect(first).toBeDefined();
		expect(first.message.customType).toBe("todo-injection");
		expect(first.message.display).toBe(false);
		expect(first.message.details.count).toBe(2);
		expect(first.message.content).toContain("[ ] #1: Task one");
		expect(first.message.content).toContain("[ ] #2: Task two");

		// Second call: flag cleared — one-shot, no re-injection on every turn.
		expect(await handlers.get("before_agent_start")(BEFORE_AGENT_START_EVENT, ctxStub())).toBeUndefined();
	});

	it("2: resume injects after session_start reconstructs a non-empty list", async () => {
		const { handlers } = loadExtension();
		const ctx = ctxStub(
			branchWith([{ id: 1, text: "X", status: "in_progress" }], 2),
		);

		await handlers.get("session_start")(SESSION_START_EVENT, ctx);

		const msg = await handlers.get("before_agent_start")(BEFORE_AGENT_START_EVENT, ctxStub());
		expect(msg).toBeDefined();
		expect(msg.message.customType).toBe("todo-injection");
		expect(msg.message.display).toBe(false);
		expect(msg.message.details.count).toBe(1);
		expect(msg.message.content).toContain("[>] #1: X");
	});

	it("3: no injection on a fresh empty session", async () => {
		const { handlers } = loadExtension();

		await handlers.get("session_start")(SESSION_START_EVENT, ctxStub([]));

		expect(await handlers.get("before_agent_start")(BEFORE_AGENT_START_EVENT, ctxStub())).toBeUndefined();
	});

	it("4: adding a task without a re-prime event does not inject", async () => {
		const { handlers, tools } = loadExtension();

		await handlers.get("session_start")(SESSION_START_EVENT, ctxStub([]));
		await tools.get("todo").execute("tc1", { action: "add", text: "Just added" }, undefined, undefined, ctxStub());

		// The flag is event-driven (session_start/tree/compact), not every-turn.
		expect(await handlers.get("before_agent_start")(BEFORE_AGENT_START_EVENT, ctxStub())).toBeUndefined();
	});

	it("5: all-done list — flag set but empty block suppresses the message", async () => {
		const { handlers } = loadExtension();

		// All-done list: todos.length is 2 so the flag IS primed, but
		// renderTodoBlock returns "" for an all-done list → the handler's
		// `if (!block) return` suppresses.
		await handlers.get("session_start")(
			SESSION_START_EVENT,
			ctxStub(
				branchWith(
					[
						{ id: 1, text: "Ship it", status: "done" },
						{ id: 2, text: "Party", status: "done" },
					],
					3,
				),
			),
		);
		expect(await handlers.get("before_agent_start")(BEFORE_AGENT_START_EVENT, ctxStub())).toBeUndefined();

		// Discriminator: `undefined` alone can't distinguish "empty block
		// guard" from "flag never primed". Prove the priming path is live —
		// the SAME lifecycle event on a branch with a pending task must emit;
		// if session_start no longer primed the flag, this would be silent
		// too, and the all-done suppression above could only be the guard.
		await handlers.get("session_start")(
			SESSION_START_EVENT,
			ctxStub(branchWith([{ id: 3, text: "Y", status: "pending" }], 4)),
		);
		const msg = await handlers.get("before_agent_start")(BEFORE_AGENT_START_EVENT, ctxStub());
		expect(msg).toBeDefined();
		expect(msg.message.customType).toBe("todo-injection");
		expect(msg.message.display).toBe(false);
		expect(msg.message.details.count).toBe(1);
		expect(msg.message.content).toContain("[ ] #3: Y");
	});

	it("6: session_tree parity — re-primes on branch switch like session_start", async () => {
		const { handlers } = loadExtension();
		const ctx = ctxStub(branchWith([{ id: 1, text: "Y", status: "pending" }], 2));

		await handlers.get("session_tree")(SESSION_TREE_EVENT, ctx);

		const msg = await handlers.get("before_agent_start")(BEFORE_AGENT_START_EVENT, ctxStub());
		expect(msg).toBeDefined();
		expect(msg.message.customType).toBe("todo-injection");
		expect(msg.message.display).toBe(false);
		expect(msg.message.details.count).toBe(1);
		expect(msg.message.content).toContain("[ ] #1: Y");
	});

	// Cases 7–8 pin the load-bearing invariant for reconstruction correctness
	// across a reboot: getBranch() returns the FULL ancestry (no compaction
	// truncation), and reconstructState takes the LAST todo snapshot. Together
	// they prove a reboot-after-compaction cannot lose or stale the list — the
	// scenario the session_compact handler comment used to (wrongly) doubt.
	it("7: reconstruction takes the latest snapshot — a stale pre-compaction snapshot is overwritten", async () => {
		const { handlers } = loadExtension();
		// Full ancestry, root→leaf: an early (now-stale) snapshot, then a
		// compaction entry, then a later snapshot. reconstructState must land on
		// the latest, not the stale one.
		const ctx = ctxStub([
			...branchWith([{ id: 1, text: "Stale", status: "pending" }], 2),
			compactionEntry(),
			...branchWith(
				[
					{ id: 1, text: "Real one", status: "in_progress" },
					{ id: 2, text: "Real two", status: "pending" },
				],
				3,
			),
		]);

		await handlers.get("session_start")(SESSION_START_EVENT, ctx);

		const msg = await handlers.get("before_agent_start")(BEFORE_AGENT_START_EVENT, ctxStub());
		expect(msg).toBeDefined();
		expect(msg.message.details.count).toBe(2);
		expect(msg.message.content).toContain("[>] #1: Real one");
		expect(msg.message.content).toContain("[ ] #2: Real two");
		expect(msg.message.content).not.toContain("Stale");
	});

	it("8: reconstruction survives compaction when no todo call follows it (reboot-after-compaction)", async () => {
		const { handlers } = loadExtension();
		// The exact case the old session_compact comment doubted: the ONLY todo
		// snapshot sits before the compaction entry, and only a non-todo message
		// follows. On a real resume, getBranch() returns this full ancestry, the
		// snapshot is reachable, and reconstruction is NOT reset to empty.
		const ctx = ctxStub([
			...branchWith(
				[
					{ id: 1, text: "Survives", status: "pending" },
					{ id: 2, text: "reboot", status: "pending" },
				],
				3,
			),
			compactionEntry(),
			{ type: "message", message: { role: "user", content: "post-compaction prompt" } },
		]);

		await handlers.get("session_start")(SESSION_START_EVENT, ctx);

		const msg = await handlers.get("before_agent_start")(BEFORE_AGENT_START_EVENT, ctxStub());
		expect(msg).toBeDefined();
		expect(msg.message.details.count).toBe(2);
		expect(msg.message.content).toContain("[ ] #1: Survives");
		expect(msg.message.content).toContain("[ ] #2: reboot");
	});
});
