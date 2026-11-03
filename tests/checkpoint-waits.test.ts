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
import { takePendingGo } from "../extensions/go.ts";
import peerLink from "../extensions/peer-link/index.ts";
import subagentAsyncFactory from "../extensions/subagent-async/index.ts";
import { readIncoming, sendEnvelope, writeHeartbeat } from "../extensions/peer-link/mailbox.ts";
import {
	WAIT_ENTRY_TYPE,
	WAIT_KINDS,
	_testClearWaitSources,
	manualWaits,
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

/**
 * Run the action `/go` would run after `checkpoint_fork` (session switching is
 * command-only in pi), capturing what the new session is sent. Same seam the
 * recoverability rows use; here the new session's sender is the observable.
 */
async function runFork(h: Harness): Promise<{ sent: string[]; file: string | null }> {
	const action = takePendingGo();
	if (!action) throw new Error("/go has no pending action");
	const sentToNewSession: string[] = [];
	let newSessionFile: string | null = null;
	const cmdCtx = {
		cwd: h.ctx.cwd,
		ui: { notify: () => {} },
		sessionManager: {
			getEntries: () => h.ctx.sessionManager.getEntries(),
			getSessionId: () => h.ctx.sessionManager.getSessionId(),
			getCwd: () => h.ctx.cwd,
		},
		switchSession: async (file: string, opts?: { withSession?: (n: any) => Promise<void> }) => {
			newSessionFile = file;
			await opts?.withSession?.({
				sendUserMessage: async (text: string) => {
					sentToNewSession.push(text);
				},
			});
		},
	};
	await action.run(cmdCtx as any);
	return { sent: sentToNewSession, file: newSessionFile };
}

/** A child the meta registry reports as running: same-process owner, fresh log. */
async function runningChild(registry: string, sid: string): Promise<void> {
	await writeFile(
		join(registry, `pi-subagent-${sid}.meta.json`),
		JSON.stringify({ ownerPid: process.pid, agentName: "implement", task: "do the thing", startedAt: 1000 }),
	);
	await writeFile(join(registry, `pi-subagent-${sid}.log`), "── Turn 1 ──\nworking…\n");
}

/** Register the subagent wait source; its own handlers are not driven here. */
function registerSubagentSource(): void {
	subagentAsyncFactory({
		on: () => {},
		registerTool: () => {},
		registerCommand: () => {},
		events: { emit: () => {} },
		ui: {},
	} as any);
}

/** Drive `checkpoint_fork` through its tool, then through `/go`. */
async function fork(
	h: Harness,
	newCwd: string,
	args: Record<string, unknown> = {},
): Promise<{ text: string; sent: string[]; file: string | null }> {
	const res = await h.tools
		.get("checkpoint_fork")
		.execute("call-f", { newCwd, summary: SUMMARY, nextSteps: "NEXT-STEP", ...args }, undefined, undefined, h.ctx);
	const { sent, file } = await runFork(h);
	return { text: String(res.content[0].text), sent, file };
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

	it("clears one manual wait by id and leaves the other", async () => {
		const { h } = await freshHarness();
		const first = await h.waitFor({ reason: "the owner's ruling on the retry policy", kind: "owner" });
		const id = /\[id ([^\]]+)\]/.exec(first.text)?.[1];
		expect(id).toBeTruthy();
		await h.waitFor({ reason: "restart to pick up the new extension", kind: "restart" });

		// Revert: invert the filter in clearManualWaits → it keeps the cleared wait
		// and drops the other one, so both assertions below flip.
		const after = await h.waitFor({ clear: true, id });
		expect(after.text).toContain("1 wait pending");
		expect(after.text).toContain("restart — restart to pick up the new extension");
		expect(after.text).not.toContain("the owner's ruling on the retry policy");
		expect(h.waits().map((w) => w.kind)).toEqual(["restart"]);
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

	it("continue: false stops with and without a wait, and the result says which arm", async () => {
		const bare = await freshHarness();
		// Revert: return `true` from the explicit arm → both of these send a kickoff.
		const stopped = await bare.h.checkpoint({ continue: false });
		expect(sentKickoff(bare.h)).toBe(false);
		expect(stopped.text).toContain("No wait pending → not continuing (continue: false)");

		const waiting = await freshHarness();
		await waiting.h.waitFor({ reason: "the owner's ruling on the retry policy", kind: "owner" });
		const overridden = await waiting.h.checkpoint({ continue: false });
		expect(sentKickoff(waiting.h)).toBe(false);
		expect(overridden.text).toContain("not continuing (continue: false)");
	}, 40_000);

	it("never infers a wait from prose", async () => {
		const { h } = await freshHarness();
		// The incident's shape: prose that names a hold while the state holds none.
		// Revert: sniff `nextSteps` for "hold"/"restart" → no kickoff, and a
		// WAITING ON block appears.
		const { text, kickoff } = await h.checkpoint({ nextSteps: "hold for the restart — start nothing else" });
		expect(text).toContain("No wait pending → continuing");
		expect(kickoff).not.toBeNull();
		expect(kickoff).toContain("hold for the restart");
		expect(kickoff).not.toContain("WAITING ON");
	}, 30_000);

	it("refuses to read a malformed snapshot as 'nothing pending'", async () => {
		const { h, sm } = await freshHarness();
		sm.appendCustomEntry(WAIT_ENTRY_TYPE, {
			waits: [{ id: "x", kind: "someday", reason: "r", since: null, source: "manual" }],
		});
		// Revert: `return []` on a bad snapshot → the checkpoint continues and
		// reports "No wait pending", the one answer that starts work.
		await expect(
			h.tools.get("checkpoint").execute("call-1", { summary: SUMMARY }, undefined, undefined, h.ctx),
		).rejects.toThrow(/Malformed checkpoint-wait snapshot/);
	}, 30_000);

	it("row 4: with no wait, an unset continue still continues", async () => {
		const { h } = await freshHarness();

		// The pre-existing default, pinned so the derivation cannot silently
		// flip it. Revert: make the no-wait arm return doContinue: false.
		const { text, kickoff } = await h.checkpoint({});
		expect(text).toContain("No wait pending → continuing");
		expect(kickoff).not.toBeNull();
		expect(kickoff).toContain("NEXT-STEP");
		expect(kickoff).not.toContain("WAITING ON");
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
		registerSubagentSource();
		const sid = "3f2a11cd-1111-2222-3333-444455556666";
		await runningChild(registry, sid);

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

	/** Send one `expectReply` through the real tool, as the model would. */
	async function sendExpectReply(to: string, message: string): Promise<void> {
		await peerTools.get("peer_send").execute(
			"call-p",
			{ to, message, expectReply: true },
			undefined,
			undefined,
			peerCtx,
		);
	}

	/** Wait for the 2 s delivery scan to inject an envelope (fs.watch accelerates it). */
	async function waitForInjected(needle: string): Promise<void> {
		const deadline = Date.now() + 15_000;
		while (!injected.some((text) => text.includes(needle)) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
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

		await sendExpectReply("bob", "which branch is main?");
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
		await waitForInjected("main, and here is why");
		expect(injected.join("\n")).toContain("main, and here is why");

		// Revert (other half): never delete on inReplyTo → the wait outlives its
		// reply and this checkpoint still stops.
		const after = await h.checkpoint({});
		expect(after.kickoff).toContain("NEXT-STEP");
		expect(after.text).toContain("No wait pending → continuing");
	}, 40_000);

	it("row 11: an external peer's wait ends on any envelope from it, and not on another peer's", async () => {
		const { h } = await freshHarness();
		// A Claude Code peer: listed, never online, and its replies carry no `inReplyTo`.
		writeHeartbeat(mailbox, { name: "claude-abc", external: true, ts: Date.now() });

		await sendExpectReply("claude-abc", "which branch is main?");

		// It is a wait, even though no `inReplyTo` will ever come back.
		// Revert: carve external sends out of the record → this checkpoint continues.
		const before = await h.checkpoint({});
		expect(sentKickoff(h)).toBe(false);
		expect(before.text).toContain('peer — reply from claude-abc "which branch is main?"');

		// An envelope from a different peer does not end it.
		// Revert: drop every wait on any inbound envelope → this assertion flips.
		sendEnvelope(mailbox, {
			id: "mail-other",
			from: "bob",
			to: "alice",
			text: "unrelated question",
			expectReply: false,
			sentAt: Date.now(),
		});
		await waitForInjected("unrelated question");
		expect(h.waits().filter((w) => w.kind === "peer")).toHaveLength(1);

		// An envelope from that peer, with no `inReplyTo`, ends it (ruling 3).
		// Revert: drop the per-peer fallback → the wait survives and this stops.
		sendEnvelope(mailbox, {
			id: "mail-claude",
			from: "claude-abc",
			to: "alice",
			text: "main, per the release notes",
			expectReply: false,
			sentAt: Date.now(),
		});
		await waitForInjected("main, per the release notes");
		expect(h.waits().filter((w) => w.kind === "peer")).toHaveLength(0);

		const after = await h.checkpoint({});
		expect(after.kickoff).toContain("NEXT-STEP");
		expect(after.text).toContain("No wait pending → continuing");
	}, 40_000);

	it("any envelope from the peer ends every wait for it, stamped reply included", async () => {
		const { h } = await freshHarness();
		await sendExpectReply("bob", "first question");
		await sendExpectReply("bob", "second question");
		const [first] = readIncoming(mailbox, "bob");
		expect(h.waits().filter((w) => w.kind === "peer")).toHaveLength(2);

		// A stamped reply to the first send. Revert: scope the sender rule behind
		// `else` → only the named wait ends and the second one blocks.
		sendEnvelope(mailbox, {
			id: "reply-first",
			from: "bob",
			to: "alice",
			text: "answer to the first",
			expectReply: false,
			inReplyTo: first.id,
			sentAt: Date.now(),
		});
		await waitForInjected("answer to the first");
		expect(h.waits().filter((w) => w.kind === "peer")).toHaveLength(0);

		const after = await h.checkpoint({});
		expect(after.kickoff).toContain("NEXT-STEP");
	}, 40_000);

	it("a relayed reply from a third peer ends the wait it names (the fast path)", async () => {
		const { h } = await freshHarness();
		await sendExpectReply("bob", "route this through carol");
		const [outbound] = readIncoming(mailbox, "bob");

		// carol relays bob's answer; only the `inReplyTo` identifies it.
		// Revert: delete the fast-path `awaitingReply.delete(env.inReplyTo)` → the
		// wait survives (carol holds nothing) and the checkpoint stops.
		writeHeartbeat(mailbox, { name: "carol", ts: Date.now() });
		sendEnvelope(mailbox, {
			id: "relay-1",
			from: "carol",
			to: "alice",
			text: "bob says: main",
			expectReply: false,
			inReplyTo: outbound.id,
			sentAt: Date.now(),
		});
		await waitForInjected("bob says: main");
		expect(h.waits().filter((w) => w.kind === "peer")).toHaveLength(0);

		const after = await h.checkpoint({});
		expect(after.kickoff).toContain("NEXT-STEP");
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
		await waitForInjected("unrelated question while you wait");
		// The wake-up is not the defect: mail still starts a turn.
		expect(injected).toHaveLength(1);
		expect(injected[0]).toContain("unrelated question while you wait");

		// Fire the checkpoint extension's own start handlers, so a "clear the wait
		// on any message" implementation is reachable here (a real mid-session
		// wake-up fires before_agent_start; session_start is fired too so a clear
		// placed there is caught as well). Revert: append an empty snapshot at the
		// top of the before_agent_start announcement → the wait is gone and this reds.
		await h.emit("session_start");
		await h.emit("before_agent_start");

		// Revert: clear manual waits when any message arrives → this continues.
		expect(h.waits().map((w) => w.kind)).toEqual(["owner"]);
		const { text } = await h.checkpoint({});
		expect(sentKickoff(h)).toBe(false);
		expect(text).toContain("owner — the owner's ruling on the retry policy");
		expect(text).toContain("not continuing");
	}, 40_000);
});

// ---------------------------------------------------------------------------
// checkpoint_fork — the same rule, and the kickoff carries the wait
// ---------------------------------------------------------------------------

describe("fork", () => {
	it("resolves the same rule, and its kickoff names the wait it carries", async () => {
		const { h } = await freshHarness();
		const target = await tmp("wo064-fork-");
		await h.waitFor({ reason: "restart to pick up the new extension", kind: "restart" });

		// (i) continue unset with a wait pending: nothing is sent into the new
		// session, and the new session's branch carries the snapshot.
		// Revert: force the explicit-continue arm at the fork's resolution → a kickoff appears.
		const stopped = await fork(h, target);
		expect(stopped.text).toContain("1 wait pending");
		expect(stopped.text).toContain("not continuing");
		expect(stopped.sent).toEqual([]);

		// Row 12 (decision checkpoint/003, ruling 4): the copy is a real
		// `checkpoint-wait` entry on the new branch, so a store over that branch
		// replays it. Revert: drop the appendCustomEntry → nothing replays.
		const copied = manualWaits(SessionManager.open(stopped.file!).getBranch());
		expect(copied.map((w) => w.kind)).toEqual(["restart"]);
		expect(copied[0].reason).toBe("restart to pick up the new extension");

		// (ii) continue true: the new session's first prompt names the wait.
		// Revert: pass an empty wait list to the fork's kickoff → no WAITING ON line.
		const continued = await fork(h, target, { continue: true });
		expect(continued.sent).toHaveLength(1);
		expect(continued.sent[0].startsWith("WAITING ON: restart — restart to pick up the new extension")).toBe(true);
		expect(continued.sent[0]).toContain("NEXT-STEP");
	}, 40_000);

	it("row 12: the continuing fork's prompt names the copied waits, not the source's derived ones", async () => {
		const { h } = await freshHarness();
		const target = await tmp("wo064-fork-kickoff-");
		const registry = await tmp("wo064-fork-registry-");
		_testSetInflightScanDir(registry);
		registerSubagentSource();
		await runningChild(registry, "5c4d3e2f-1111-2222-3333-444455556666");
		await h.waitFor({ reason: "restart to pick up the new extension", kind: "restart" });

		// Revert: hand the kickoff the unfiltered `waits` → it also announces the
		// subagent wait, which the new session can never clear.
		const forked = await fork(h, target, { continue: true });
		expect(forked.sent).toHaveLength(1);
		expect(forked.sent[0]).toContain("WAITING ON: restart — restart to pick up the new extension");
		expect(forked.sent[0]).not.toContain("subagent");
	}, 40_000);

	it("row 12: the copied wait stops the new session's first checkpoint", async () => {
		const { h } = await freshHarness();
		const target = await tmp("wo064-fork-new-");
		await h.waitFor({ reason: "restart to pick up the new extension", kind: "restart" });
		const stopped = await fork(h, target);

		// A store over the new session's branch, started the way a resumed
		// session starts: the copied wait is what decides its first checkpoint.
		// Revert: drop the appendCustomEntry → the new session continues.
		const newSession = SessionManager.open(stopped.file!);
		const fresh = makeHarness(newSession, target);
		await fresh.emit("session_start");
		const { text } = await fresh.checkpoint({});
		expect(sentKickoff(fresh)).toBe(false);
		expect(text).toContain("restart — restart to pick up the new extension");
		expect(text).toContain("not continuing");
	}, 40_000);

	it("row 12: only manual waits travel with the fork", async () => {
		const { h } = await freshHarness();
		const target = await tmp("wo064-fork-manual-");
		const registry = await tmp("wo064-fork-registry-");
		_testSetInflightScanDir(registry);
		registerSubagentSource();
		await runningChild(registry, "9a8b7c6d-1111-2222-3333-444455556666");
		await h.waitFor({ reason: "restart to pick up the new extension", kind: "restart" });

		// The source session is holding for two things: a manual wait and a
		// running child. Revert: copy `waits` instead of its manual subset → the
		// subagent wait lands in the new session's snapshot.
		expect(h.waits().map((w) => w.source).sort()).toEqual(["derived", "manual"]);
		const forked = await fork(h, target);
		const copied = manualWaits(SessionManager.open(forked.file!).getBranch());
		expect(copied.map((w) => w.source)).toEqual(["manual"]);
		expect(copied.map((w) => w.kind)).toEqual(["restart"]);
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
// A cleared wait stays cleared across a restart
// ---------------------------------------------------------------------------

describe("durability of a clear", () => {
	it("a cleared wait does not come back when the session is reopened", async () => {
		const cwd = await tmp("wo064-cleared-");
		const sessionDir = await tmp("wo064-cleared-session-");
		const sm = SessionManager.create(cwd, sessionDir);
		seedConversation(sm);
		const h = makeHarness(sm, cwd);

		await h.waitFor({ reason: "the owner's ruling on the retry policy", kind: "owner" });
		await h.waitFor({ clear: true });
		const file = sm.getSessionFile()!;

		// A new process reads the branch: the last snapshot is the empty one.
		// Revert: drop the persist from clearManualWaits → the wait resurrects
		// here, the announcement fires, and the checkpoint stops.
		const reopened = SessionManager.open(file);
		const h2 = makeHarness(reopened, cwd);
		await h2.emit("session_start");
		const [injected] = await h2.emit("before_agent_start");
		expect(injected).toBeUndefined();

		const { text } = await h2.checkpoint({});
		expect(text).toContain("No wait pending → continuing");
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

		// The kickoff arm for more than one wait, which the single-wait rows miss.
		const overridden = await h.checkpoint({ continue: true });
		expect(overridden.kickoff!.startsWith("WAITING ON: owner — the owner's ruling")).toBe(true);
		expect(overridden.kickoff).toContain("ALSO WAITING ON: restart — restart to pick up the new extension");
	}, 30_000);
});
