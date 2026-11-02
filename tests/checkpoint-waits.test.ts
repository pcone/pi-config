/**
 * A pending wait is session state (WO-2026-064, decision checkpoint/003).
 *
 * Every row here drives the real extensions against stub `pi`/ctx objects: no
 * model, no network. The session branch is a real `SessionManager` (in memory
 * unless a row needs a file), so `pi.appendEntry` behaves exactly as it does in
 * a live session — durable, on the branch, invisible to the model.
 *
 * The rows are the work order's acceptance list, in order. Each one fails with
 * its mechanism reverted; the revert that turns it red is named in the row.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import checkpointFactory, { _testSetInflightScanDir } from "../extensions/checkpoint.ts";
import peerLink from "../extensions/peer-link/index.ts";
import subagentAsyncFactory from "../extensions/subagent-async/index.ts";
import { readIncoming, sendEnvelope, writeHeartbeat } from "../extensions/peer-link/mailbox.ts";
import {
	WAIT_ENTRY_TYPE,
	WAIT_KINDS,
	_testClearWaitSources,
	pendingWaits,
	type Wait,
} from "../extensions/lib/waits.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Sent {
	text: string;
	options?: unknown;
}

/** The tool/command/handler surface both extensions register into. */
interface Harness {
	tools: Map<string, any>;
	commands: Map<string, any>;
	sent: Sent[];
	compactCalls: any[];
	notifications: Array<{ message: string; level: string }>;
	ctx: any;
	emit(event: string, payload?: Record<string, unknown>, ctx?: any): Promise<unknown[]>;
	/** `checkpoint`'s execute → settle → compaction, with the compaction completing. */
	checkpoint(args: Record<string, unknown>): Promise<{ text: string; kickoff: string | null }>;
	/** Run the `wait_for` tool. */
	waitFor(args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }>;
	/** Every wait the store reports for this session. */
	waits(): Wait[];
	/** The kickoff text the last checkpoint sent, or null when it sent none. */
	lastKickoff(): string | null;
}

const SUMMARY = {
	goal: "wait-state fixture",
	filesTouched: [],
	decisions: ["none"],
	triedAndFailed: ["none"],
	constraints: "none",
};

function makeHarness(sm: SessionManager, cwd: string): Harness {
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const sent: Sent[] = [];
	const compactCalls: any[] = [];
	const notifications: Array<{ message: string; level: string }> = [];

	const ui = {
		notify: (message: string, level: string) => notifications.push({ message, level }),
		setStatus: () => {},
		setWidget: () => {},
		clearStatus: () => {},
	};
	const pi: any = {
		events: { emit: () => {}, on: () => {} },
		on: (event: string, handler: (e: any, ctx: any) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool: (def: any) => tools.set(def.name, def),
		registerCommand: (name: string, def: any) => commands.set(name, def),
		registerEntryRenderer: () => {},
		sendUserMessage: (text: string, options?: unknown) => {
			sent.push({ text, options });
		},
		sendMessage: () => {},
		appendEntry: (customType: string, data?: unknown) => {
			sm.appendCustomEntry(customType, data);
		},
		getSessionName: () => undefined,
		ui,
	};

	const ctx: any = {
		cwd,
		hasUI: true,
		model: { contextWindow: 200_000 },
		getContextUsage: () => ({ tokens: 1000, contextWindow: 200_000, percent: null }),
		ui,
		sessionManager: {
			getEntries: () => sm.getEntries(),
			getBranch: () => sm.getBranch(),
			getSessionId: () => sm.getSessionId(),
			getCwd: () => cwd,
			getSessionFile: () => sm.getSessionFile(),
			getSessionName: () => undefined,
		},
		compact: (options: any) => compactCalls.push(options),
	};

	checkpointFactory(pi);

	const emit = async (event: string, payload: Record<string, unknown> = {}, useCtx: any = ctx) => {
		const results: unknown[] = [];
		for (const handler of handlers.get(event) ?? []) {
			results.push(await handler({ type: event, ...payload }, useCtx));
		}
		return results;
	};

	const harness: Harness = {
		tools,
		commands,
		sent,
		compactCalls,
		notifications,
		ctx,
		emit,
		async checkpoint(args) {
			const before = sent.length;
			const result = await tools.get("checkpoint").execute(
				"call-1",
				{ summary: SUMMARY, nextSteps: "NEXT-STEP", ...args },
				undefined,
				undefined,
				ctx,
			);
			// Compaction fires at the settle, never inside the tool call.
			await emit("agent_settled");
			const compact = compactCalls[compactCalls.length - 1];
			if (compact) await compact.onComplete?.({});
			const kickoff = sent.length > before ? sent[sent.length - 1].text : null;
			return { text: String(result.content[0].text), kickoff };
		},
		async waitFor(args) {
			const result = await tools.get("wait_for").execute("call-w", args, undefined, undefined, ctx);
			return { text: String(result.content[0].text), isError: result.isError };
		},
		waits() {
			return pendingWaits(
				{ branch: () => sm.getBranch(), persist: (waits) => sm.appendCustomEntry(WAIT_ENTRY_TYPE, { waits }) },
				{ sessionId: sm.getSessionId() },
			);
		},
		lastKickoff() {
			return sent.length > 0 ? sent[sent.length - 1].text : null;
		},
	};

	return harness;
}

/** A session with one completed exchange, so a snapshot has a branch to sit on. */
function seedConversation(sm: SessionManager): void {
	sm.appendMessage({
		role: "user",
		content: [{ type: "text", text: "start" }],
		timestamp: Date.now(),
	} as any);
	sm.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "test",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
		stopReason: "end",
		timestamp: Date.now(),
	} as any);
}

const dirs: string[] = [];

async function tmp(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

/** A fresh in-memory session plus a harness over it. */
async function freshHarness(): Promise<{ h: Harness; sm: SessionManager; cwd: string }> {
	const cwd = await tmp("wo064-waits-");
	const sm = SessionManager.inMemory(cwd);
	seedConversation(sm);
	return { h: makeHarness(sm, cwd), sm, cwd };
}

beforeEach(() => {
	_testClearWaitSources();
});

afterEach(() => {
	_testClearWaitSources();
	_testSetInflightScanDir(undefined);
});

afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** Whether the last checkpoint sent a kickoff prompt at all. */
function sentKickoff(h: Harness): boolean {
	return h.sent.some((s) => s.text.includes("NEXT-STEP"));
}

// ---------------------------------------------------------------------------
// Row 1 — wait_for records a manual wait, and says so
// ---------------------------------------------------------------------------

describe("wait_for", () => {
	it("row 1: records a manual wait and lists it on the tool result", async () => {
		const { h, sm } = await freshHarness();

		const res = await h.waitFor({ reason: "restart to pick up the new extension", kind: "restart" });
		expect(res.isError).toBeUndefined();
		expect(res.text).toContain("1 wait pending");
		expect(res.text).toContain("restart — restart to pick up the new extension");
		expect(res.text).toContain("(manual");

		// Persisted as a snapshot on the branch, not held in process memory.
		// Revert: drop host.persist from addManualWait → no entry, and the next
		// process sees nothing.
		const snapshots = sm.getBranch().filter(
			(e: any) => e.type === "custom" && e.customType === WAIT_ENTRY_TYPE,
		);
		expect(snapshots).toHaveLength(1);
		expect((snapshots[0] as any).data.waits[0]).toMatchObject({
			kind: "restart",
			reason: "restart to pick up the new extension",
			source: "manual",
		});
	}, 30_000);

	it("row 8: clear drops it, and the next checkpoint continues", async () => {
		const { h } = await freshHarness();

		await h.waitFor({ reason: "the owner's ruling on the retry policy", kind: "owner" });
		const cleared = await h.waitFor({ clear: true });
		expect(cleared.text).toContain("No waits pending");
		expect(h.waits()).toHaveLength(0);

		// Revert: make clearManualWaits a no-op → this checkpoint stops.
		const { kickoff } = await h.checkpoint({});
		expect(kickoff).toContain("NEXT-STEP");
	}, 30_000);

	it("accepts every kind and rejects one outside the enum (the schema, not a runtime check)", async () => {
		const { h } = await freshHarness();
		const schema = h.tools.get("wait_for").parameters;
		for (const kind of WAIT_KINDS) {
			expect(Value.Check(schema, { reason: "x", kind })).toBe(true);
		}
		expect(Value.Check(schema, { reason: "x", kind: "someday" })).toBe(false);
	}, 30_000);

	it("refuses a wait with no reason, and an unknown id to clear", async () => {
		const { h } = await freshHarness();

		const blank = await h.waitFor({ reason: "   " });
		expect(blank.isError).toBe(true);
		expect(blank.text).toContain("reason");

		await h.waitFor({ reason: "something" });
		const unknown = await h.waitFor({ clear: true, id: "no-such-id" });
		expect(unknown.isError).toBe(true);
		expect(unknown.text).toContain("no-such-id");
		// The failed clear left the wait in place.
		expect(h.waits()).toHaveLength(1);
	}, 30_000);
});

// ---------------------------------------------------------------------------
// Rows 2–4 — what `continue` does with and without a wait
// ---------------------------------------------------------------------------

describe("continuation", () => {
	it("row 2: a pending manual wait stops an unset continue", async () => {
		const { h } = await freshHarness();
		await h.waitFor({ reason: "restart to pick up the new extension", kind: "restart" });

		// Revert: resolveContinuation ignores its waits argument, or the tool
		// passes [] → a kickoff is sent and the seat starts new work.
		const { text } = await h.checkpoint({});
		expect(sentKickoff(h)).toBe(false);
		expect(text).toContain("1 wait pending: restart — restart to pick up the new extension → not continuing");
	}, 30_000);

	it("row 3: continue: true is sent anyway, and the kickoff names the wait", async () => {
		const { h } = await freshHarness();
		await h.waitFor({ reason: "restart to pick up the new extension", kind: "restart" });

		// Revert: drop the waits argument from sendKickoff's compose → the
		// kickoff is sent without WAITING ON.
		const { kickoff } = await h.checkpoint({ continue: true });
		expect(kickoff).not.toBeNull();
		expect(kickoff!.startsWith("WAITING ON: restart — restart to pick up the new extension")).toBe(true);
		expect(kickoff).toContain("Answer what arrives and start nothing else.");
		expect(kickoff).toContain("NEXT-STEP");
	}, 30_000);

	it("row 4: with no wait, an unset continue still continues", async () => {
		const { h } = await freshHarness();

		// The pre-existing default, pinned so the derivation cannot silently
		// flip it. Revert: make the no-wait arm return doContinue: false.
		const { text, kickoff } = await h.checkpoint({});
		expect(kickoff).toContain("NEXT-STEP");
		expect(kickoff).not.toContain("WAITING ON");
		expect(text).toContain("No wait pending → continuing");
	}, 30_000);
});

// ---------------------------------------------------------------------------
// Row 5 — a running subagent is a wait
// ---------------------------------------------------------------------------

describe("derived: subagent", () => {
	it("row 5: a running child stops an unset continue; with the child gone, it continues", async () => {
		const { h } = await freshHarness();
		const registry = await tmp("wo064-registry-");
		_testSetInflightScanDir(registry);

		// The real extension registers the source; the factory's own handlers are
		// not driven here (its session_start scans /tmp and adopts sockets).
		subagentAsyncFactory({ on: () => {}, registerTool: () => {}, registerCommand: () => {}, events: { emit: () => {} }, ui: {} } as any);

		const sid = "3f2a11cd-1111-2222-3333-444455556666";
		await writeFile(
			join(registry, `pi-subagent-${sid}.meta.json`),
			JSON.stringify({ ownerPid: process.pid, agentName: "implement", task: "do the thing", startedAt: 1000 }),
		);
		await writeFile(join(registry, `pi-subagent-${sid}.log`), "── Turn 1 ──\nworking…\n");

		// Revert: filter the source to nothing (or drop registerWaitSource) → the
		// first checkpoint sends a kickoff over a live child.
		const first = await h.checkpoint({});
		expect(sentKickoff(h)).toBe(false);
		expect(first.text).toContain("subagent — implement 55556666 is still running");
		expect(first.text).toContain("→ not continuing");

		// The child finishes: its log ends with the completion footer, so the
		// registry no longer reports it as running. Same call, now continues.
		await appendFile(join(registry, `pi-subagent-${sid}.log`), "── Completed (1 turn) ──\n");
		const second = await h.checkpoint({});
		expect(second.kickoff).toContain("NEXT-STEP");
		expect(second.text).toContain("No wait pending → continuing");
	}, 30_000);
});

// ---------------------------------------------------------------------------
// Rows 6 and 9 — peer-link: an outbound expectReply is a wait; mail is not held
// ---------------------------------------------------------------------------

describe("derived: peer reply", () => {
	let mailbox: string;
	let peerPiHandlers: Map<string, Array<(event: any, ctx: any) => unknown>>;
	let peerTools: Map<string, any>;
	let injected: string[];
	let peerCtx: any;
	let env: { name?: string; mailbox?: string };

	function startPeerLink(): void {
		peerPiHandlers = new Map();
		peerTools = new Map();
		injected = [];
		const pi: any = {
			events: { emit: () => {} },
			on: (event: string, handler: (e: any, ctx: any) => unknown) => {
				const list = peerPiHandlers.get(event) ?? [];
				list.push(handler);
				peerPiHandlers.set(event, list);
			},
			registerTool: (def: any) => peerTools.set(def.name, def),
			registerCommand: () => {},
			sendUserMessage: (text: string) => {
				injected.push(text);
			},
		};
		peerLink(pi);
	}

	async function emitPeer(event: string): Promise<void> {
		for (const handler of peerPiHandlers.get(event) ?? []) await handler({ type: event }, peerCtx);
	}

	beforeEach(async () => {
		mailbox = await tmp("wo064-peer-mail-");
		env = { name: process.env.PI_PEER_NAME, mailbox: process.env.PI_PEER_MAILBOX };
		process.env.PI_PEER_NAME = "alice";
		process.env.PI_PEER_MAILBOX = mailbox;
		startPeerLink();
		const cwd = await tmp("wo064-peer-cwd-");
		peerCtx = {
			cwd,
			ui: { notify: () => {} },
			sessionManager: {
				getSessionFile: () => undefined,
				getSessionName: () => undefined,
			},
		};
		// "bob" is a listed, online peer: the send gate refuses unlisted names.
		writeHeartbeat(mailbox, { name: "bob", ts: Date.now() });
		await emitPeer("session_start");
	});

	afterEach(async () => {
		await emitPeer("session_shutdown");
		if (env.name === undefined) delete process.env.PI_PEER_NAME;
		else process.env.PI_PEER_NAME = env.name;
		if (env.mailbox === undefined) delete process.env.PI_PEER_MAILBOX;
		else process.env.PI_PEER_MAILBOX = env.mailbox;
	});

	it("row 6: an unanswered expectReply stops an unset continue; the reply ends the wait", async () => {
		const { h } = await freshHarness();

		await peerTools.get("peer_send").execute(
			"call-p",
			{ to: "bob", message: "which branch is main?", expectReply: true },
			undefined,
			undefined,
			peerCtx,
		);
		const [outbound] = readIncoming(mailbox, "bob");
		expect(outbound.expectReply).toBe(true);

		// Revert: drop the sendTracked record → the checkpoint sends a kickoff
		// while the seat is still holding for the answer.
		const before = await h.checkpoint({});
		expect(sentKickoff(h)).toBe(false);
		expect(before.text).toContain('peer — reply from bob "which branch is main?"');

		// The reply carries `inReplyTo`; the delivery scan matches it.
		sendEnvelope(mailbox, {
			id: "reply-1",
			from: "bob",
			to: "alice",
			text: "main, and here is why",
			expectReply: false,
			inReplyTo: outbound.id,
			sentAt: Date.now(),
		});
		const deadline = Date.now() + 15_000;
		while (injected.length === 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		expect(injected.join("\n")).toContain("main, and here is why");

		// Revert (other half): never delete on inReplyTo → the wait outlives its
		// reply and this checkpoint still stops.
		const after = await h.checkpoint({});
		expect(after.kickoff).toContain("NEXT-STEP");
		expect(after.text).toContain("No wait pending → continuing");
	}, 40_000);

	it("row 9: mail starts a turn, does not clear a manual wait, and the next checkpoint still stops", async () => {
		const { h } = await freshHarness();
		await h.waitFor({ reason: "the owner's ruling on the retry policy", kind: "owner" });

		sendEnvelope(mailbox, {
			id: "mail-1",
			from: "bob",
			to: "alice",
			text: "unrelated question while you wait",
			expectReply: false,
			sentAt: Date.now(),
		});
		const deadline = Date.now() + 15_000;
		while (injected.length === 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		// The wake-up is not the defect: mail still starts a turn.
		expect(injected).toHaveLength(1);
		expect(injected[0]).toContain("unrelated question while you wait");

		// Revert: clear manual waits when any message arrives → this continues.
		expect(h.waits().map((w) => w.kind)).toEqual(["owner"]);
		const { text } = await h.checkpoint({});
		expect(sentKickoff(h)).toBe(false);
		expect(text).toContain("owner — the owner's ruling on the retry policy");
		expect(text).toContain("not continuing");
	}, 40_000);
});

// ---------------------------------------------------------------------------
// Row 7 — the wait survives the process
// ---------------------------------------------------------------------------

describe("durability", () => {
	it("row 7: a snapshot is replayed from the session file, and session_start announces it", async () => {
		const cwd = await tmp("wo064-durable-");
		const sessionDir = await tmp("wo064-session-");
		const first = SessionManager.create(cwd, sessionDir);
		seedConversation(first);
		const h1 = makeHarness(first, cwd);

		await h1.waitFor({ reason: "restart to pick up the new extension", kind: "restart" });
		const file = first.getSessionFile()!;
		expect(existsSync(file)).toBe(true);

		// A new process: same session file, no shared memory.
		const second = SessionManager.open(file);
		const h2 = makeHarness(second, cwd);
		await h2.emit("session_start");
		const [injectedMessage] = await h2.emit("before_agent_start");

		// Revert: read manual waits from a module-level cache instead of the
		// branch → this process sees nothing.
		const content = String((injectedMessage as any)?.message?.content ?? "");
		expect(content.startsWith("WAITING ON: restart — restart to pick up the new extension")).toBe(true);
		expect(content).toContain("Answer what arrives and start nothing else.");

		// And the replayed state decides: unset continue stops.
		const { text } = await h2.checkpoint({});
		expect(sentKickoff(h2)).toBe(false);
		expect(text).toContain("→ not continuing");
	}, 30_000);
});

// ---------------------------------------------------------------------------
// Row 10 — the tool result states the wait and the outcome
// ---------------------------------------------------------------------------

describe("the tool result", () => {
	it("row 10: names the pending wait and the resolved outcome, explicit continue included", async () => {
		const { h } = await freshHarness();
		await h.waitFor({ reason: "restart to pick up the new extension", kind: "restart" });

		// Revert: drop describePending from the tool result → the model that
		// forgot the wait learns nothing.
		const stopped = await h.checkpoint({});
		expect(stopped.text).toContain(
			"1 wait pending: restart — restart to pick up the new extension → not continuing",
		);

		const overridden = await h.checkpoint({ continue: true });
		expect(overridden.text).toContain("1 wait pending");
		expect(overridden.text).toContain("→ continuing anyway (continue: true overrides the wait)");
	}, 30_000);

	it("names several waits in one line", async () => {
		const { h } = await freshHarness();
		await h.waitFor({ reason: "the owner's ruling", kind: "owner" });
		await h.waitFor({ reason: "restart to pick up the new extension", kind: "restart" });

		const { text } = await h.checkpoint({});
		expect(text).toContain(
			"2 waits pending: owner — the owner's ruling; restart — restart to pick up the new extension → not continuing",
		);
	}, 30_000);
});
