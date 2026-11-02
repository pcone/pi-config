/**
 * peer-link channel (peer-link/channel.ts): the MCP stdio server that pushes a
 * Claude Code session's peer-link mail into that session as
 * `notifications/claude/channel` events.
 *
 * The rows spawn the real server under the SDK's Client + StdioClientTransport
 * against a temp $PI_PEER_MAILBOX, and drive the prompt hook as real
 * subprocesses. No Claude process is involved anywhere.
 *
 * Run: bun test tests/peer-link-channel.test.ts
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { renderMail } from "../extensions/peer-link/external";
import {
	type Envelope,
	SCAN_MS,
	inboxDir,
	listPeers,
	mailboxPrivacyProblem,
	newEnvelope,
	readIncoming,
	sendEnvelope,
	watchInbox,
} from "../extensions/peer-link/mailbox";
import { childEnv, scrubSubagentEnv } from "./helpers/subagent-env.ts";

const CHANNEL = join(import.meta.dir, "..", "extensions", "peer-link", "channel.ts");
const CLI = join(import.meta.dir, "..", "extensions", "peer-link", "external.ts");
const SID = "0d1e2f3a-1111-2222-3333-444455556666";
const SELF = `claude-${SID}`;

// The rows spawn two real processes, so both halves of the idiom are needed:
// the scrub keeps the harness's injected PI_SUBAGENT_* out of this process, and
// childEnv() hands the live env (not bun's startup snapshot) to each spawn
// (tests/helpers/subagent-env.ts).
let restoreSubagentEnv: () => void = () => {};

beforeAll(() => {
	restoreSubagentEnv = scrubSubagentEnv();
});

afterAll(() => {
	restoreSubagentEnv();
});

let dir: string;
const running: RunningChannel[] = [];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "peer-channel-"));
});

afterEach(async () => {
	for (const ch of running.splice(0)) await ch.close();
	await rm(dir, { recursive: true, force: true });
});

interface RunningChannel {
	events: Array<{ method: string; params: { content: string; meta: Record<string, string> } }>;
	pid: number;
	capabilities: Record<string, unknown>;
	instructions: string | undefined;
	close: () => Promise<void>;
}

/** Start the channel as Claude Code would: a stdio child of this process. */
async function startChannel(env: Record<string, string | undefined> = {}): Promise<RunningChannel> {
	const events: RunningChannel["events"] = [];
	const transport = new StdioClientTransport({
		command: "bun",
		args: [CHANNEL],
		env: childEnv({
			PI_PEER_MAILBOX: dir,
			CLAUDE_CODE_SESSION_ID: SID,
			...env,
		}) as Record<string, string>,
		stderr: "pipe",
	});
	const client = new Client({ name: "peer-link-channel-test", version: "0.0.0" }, { capabilities: {} });
	// A field, not a constructor option: `notifications/claude/channel` has no
	// schema in the MCP core, so it lands on the fallback handler.
	client.fallbackNotificationHandler = async (notification) => {
		events.push(notification as unknown as RunningChannel["events"][number]);
	};
	await client.connect(transport);
	const pid = transport.pid;
	if (pid === null) throw new Error("channel transport reported no child pid");
	const ch: RunningChannel = {
		events,
		pid,
		capabilities: (client.getServerCapabilities() ?? {}) as Record<string, unknown>,
		instructions: client.getInstructions(),
		close: () => client.close(),
	};
	running.push(ch);
	return ch;
}

/** The channel's own `main()` exits when the transport closes; wait for the pid to go. */
async function waitForDead(pid: number, ms = 10_000): Promise<void> {	const start = Date.now();
	while (Date.now() - start < ms) {
		try {
			process.kill(pid, 0);
		} catch {
			return;
		}
		await sleep(50);
	}
	throw new Error(`channel pid ${pid} still alive after ${ms}ms`);
}

async function waitForNotifications(ch: RunningChannel, count: number, ms = 15_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < ms) {
		if (ch.events.length >= count) return;
		await sleep(50);
	}
	throw new Error(`waited ${ms}ms for ${count} channel notification(s), saw ${ch.events.length}`);
}

/** Let a scan that should not happen have time to happen. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stop tracking a channel we already closed, so afterEach does not re-close it. */
function forget(ch: RunningChannel): void {
	const at = running.indexOf(ch);
	if (at >= 0) running.splice(at, 1);
}

function runCli(args: string[], stdin = ""): { code: number; out: string; err: string } {
	const p = Bun.spawnSync(["bun", CLI, ...args], {
		stdin: new TextEncoder().encode(stdin),
		env: childEnv({ PI_PEER_MAILBOX: dir }),
	});
	return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

const hookJson = (event: string) => JSON.stringify({ session_id: SID, cwd: "/w", hook_event_name: event });

function spawnChannelRaw(env: Record<string, string | undefined>): { code: number; out: string; err: string } {
	const p = Bun.spawnSync(["bun", CHANNEL], {
		stdin: new TextEncoder().encode(""),
		env: childEnv({ PI_PEER_MAILBOX: dir, CLAUDE_CODE_SESSION_ID: SID, ...env }),
		// A refusal row expects an exit; if the server starts instead, nothing would
		// close it once stdin ends, so bound the wait.
		timeout: 15_000,
	});
	return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe("channel notifications", () => {
	it("pushes an un-pushed envelope as one channel notification, renderMail content and identifier meta", async () => {
		const ch = await startChannel();
		// The capability is what makes Claude Code register the listener at all;
		// no `tools` (sending stays external.ts) and no permission relay (a peer
		// is not an authenticated human).
		const experimental = ch.capabilities.experimental as Record<string, unknown>;
		expect(experimental["claude/channel"]).toEqual({});
		expect(experimental["claude/channel/permission"]).toBeUndefined();
		expect(ch.capabilities.tools).toBeUndefined();

		const env = newEnvelope("bug-triage", SELF, "issue #42 filed", true);
		sendEnvelope(dir, env);
		await waitForNotifications(ch, 1);

		// Mechanism 4's other half: the instructions are the only text telling the
		// model how to reply, and they are negotiated at connect time.
		const instructions = ch.instructions ?? "";
		expect(instructions).toContain('<channel source="peer-link"');
		expect(instructions).toContain(`${CLI} send --from ${SELF}`);

		const [note] = ch.events;
		expect(note.method).toBe("notifications/claude/channel");
		expect(note.params.content).toBe(renderMail(SELF, [env], CLI));
		// Literals, so the row does not accept whatever renderMail happens to do.
		expect(note.params.content).toContain(`peer-link mail for ${SELF} (1):`);
		expect(note.params.content).toContain("[peer:bug-triage] issue #42 filed");
		// The reply hint has to name external.ts: rendered from channel.ts, a hint
		// built from process.argv[1] would tell Claude to run the channel as a CLI.
		expect(note.params.content).toContain(`${CLI} send --from ${SELF}`);
		expect(note.params.meta).toEqual({
			from: "bug-triage",
			ids: env.id,
			expect_reply: "true",
		});
		// Claude Code silently drops meta keys that are not identifiers.
		for (const key of Object.keys(note.params.meta)) expect(key).toMatch(/^[A-Za-z0-9_]+$/);
	}, 120_000);

	it("carries three envelopes found by one scan in one notification", async () => {
		const stamped = (from: string, text: string, at: number): Envelope => ({
			...newEnvelope(from, SELF, text),
			sentAt: at,
		});
		const batch = [
			stamped("bug-triage", "first", 1_000),
			stamped("review-code", "second", 2_000),
			stamped("bug-triage", "third", 3_000),
		];
		for (const env of batch) sendEnvelope(dir, env);

		const ch = await startChannel();
		await waitForNotifications(ch, 1);
		// A second push of the same batch can only land on a later scan, so the
		// settle window has to outlast one poll.
		await sleep(SCAN_MS + 1_000);
		expect(ch.events).toHaveLength(1);

		const [note] = ch.events;
		expect(note.params.content).toBe(renderMail(SELF, batch, CLI));
		expect(note.params.meta.from).toBe("bug-triage,review-code");
		expect(new Set(note.params.meta.ids.split(","))).toEqual(new Set(batch.map((e) => e.id)));
		expect(note.params.meta.expect_reply).toBe("false");
	}, 120_000);

	it("pushes an envelope once per process: later scans do not push it again", async () => {
		const ch = await startChannel();
		const env = newEnvelope("bug-triage", SELF, "pushed exactly once");
		sendEnvelope(dir, env);
		await waitForNotifications(ch, 1);
		// Two more polls, and two more arrivals that must each get their own push:
		// the pushed set has to suppress only what it already pushed.
		await sleep(SCAN_MS * 2 + 500);
		expect(ch.events).toHaveLength(1);

		const second = newEnvelope("review-code", SELF, "a later arrival");
		sendEnvelope(dir, second);
		await waitForNotifications(ch, 2);
		await sleep(SCAN_MS + 500);
		expect(ch.events).toHaveLength(2);
		expect(ch.events.map((e) => e.params.meta.ids)).toEqual([env.id, second.id]);
	}, 120_000);

	it("re-pushes an un-acked envelope after a server restart (duplicate, never a loss)", async () => {
		const first = await startChannel();
		const env = newEnvelope("bug-triage", SELF, "must survive a channel restart");
		sendEnvelope(dir, env);
		await waitForNotifications(first, 1);
		expect(first.events[0].params.meta.ids).toBe(env.id);
		// Nothing acks a pushed envelope yet (WO-2026-063 Mechanism 5 is pending a
		// hook probe), so it stays on disk and the next process pushes it again.
		expect(readIncoming(dir, SELF).map((e) => e.id)).toEqual([env.id]);

		await first.close();
		await waitForDead(first.pid);
		forget(first);

		const second = await startChannel();
		await waitForNotifications(second, 1);
		expect(second.events[0].params.meta.ids).toBe(env.id);
		expect(second.events[0].params.content).toContain("must survive a channel restart");
	}, 120_000);
});

describe("one deliverer per session", () => {
	it("keeps the prompt hook silent and non-acking while the channel lives, and delivers once its pid is dead", async () => {
		const ch = await startChannel();
		const registered = listPeers(dir).find((p) => p.name === SELF);
		expect(registered?.channelPid).toBe(ch.pid); // the heartbeat names the live channel

		const env = newEnvelope("bug-triage", SELF, "delivered by the channel");
		sendEnvelope(dir, env);
		await waitForNotifications(ch, 1);

		// A prompt now would duplicate the delivery, so the hook emits nothing and
		// records nothing inflight: the envelope is still there for the channel's
		// ack path.
		const prompt = runCli(["hook", "prompt"], hookJson("UserPromptSubmit"));
		expect(prompt.code).toBe(0);
		expect(prompt.out).toBe("");
		expect(readIncoming(dir, SELF).map((e) => e.id)).toEqual([env.id]);

		await ch.close();
		await waitForDead(ch.pid);
		forget(ch);

		// Channel gone: delivery is the hook's again, so the same prompt delivers.
		const next = runCli(["hook", "prompt"], hookJson("UserPromptSubmit"));
		expect(next.code).toBe(0);
		expect(next.out).toContain("delivered by the channel");
		expect(readIncoming(dir, SELF)).toHaveLength(1); // inflight, not acked at prompt
		expect(runCli(["hook", "stop"], hookJson("Stop")).code).toBe(0);
		expect(readIncoming(dir, SELF)).toEqual([]);
	}, 120_000);
});

describe("refusals", () => {
	it("exits non-zero when CLAUDE_CODE_SESSION_ID is unset, naming it", () => {
		// Exactly 1: the server's own refusal, not the 15 s timeout kill (which
		// reports a null code) standing in for it.
		const missing = spawnChannelRaw({ CLAUDE_CODE_SESSION_ID: undefined });
		expect(missing.code).toBe(1);
		expect(missing.err).toContain("CLAUDE_CODE_SESSION_ID");

		const blank = spawnChannelRaw({ CLAUDE_CODE_SESSION_ID: "   " });
		expect(blank.code).toBe(1);
		expect(blank.err).toContain("CLAUDE_CODE_SESSION_ID");
	}, 120_000);

	it("refuses to start on an inbox another user can write", async () => {
		const inbox = inboxDir(dir, SELF);
		mkdirSync(inbox, { recursive: true, mode: 0o700 });
		mkdirSync(join(dir, "_peers"), { recursive: true, mode: 0o700 });

		chmodSync(inbox, 0o770); // group-writable
		const groupWritable = spawnChannelRaw({});
		expect(groupWritable.code).toBe(1);
		expect(groupWritable.err).toContain("0770");

		chmodSync(inbox, 0o707); // world-writable
		const worldWritable = spawnChannelRaw({});
		expect(worldWritable.code).toBe(1);
		expect(worldWritable.err).toContain("0707");

		chmodSync(inbox, 0o700);
		// The other half of the check: `_peers` is writable, the inbox is not.
		const peers = join(dir, "_peers");
		chmodSync(peers, 0o770);
		const peersWritable = spawnChannelRaw({});
		expect(peersWritable.code).toBe(1);
		expect(peersWritable.err).toContain("_peers");
		expect(peersWritable.err).toContain("0770");

		chmodSync(peers, 0o707);
		const peersWorldWritable = spawnChannelRaw({});
		expect(peersWorldWritable.code).toBe(1);
		expect(peersWorldWritable.err).toContain("_peers");
		expect(peersWorldWritable.err).toContain("0707");

		chmodSync(peers, 0o700);
		await startChannel(); // the same mailbox starts once it is private again
	}, 120_000);

	it("refuses to verify ownership where the platform reports no uid", () => {
		const inbox = inboxDir(dir, SELF);
		mkdirSync(inbox, { recursive: true, mode: 0o700 });
		mkdirSync(join(dir, "_peers"), { recursive: true, mode: 0o700 });
		expect(mailboxPrivacyProblem(dir, SELF)).toBeUndefined();

		// The only way to reach the arm: the platform itself has no getuid. Stubbing
		// the global capability, not an internal seam — the arm exists for exactly
		// this environment, and the doc claims the refusal unconditionally.
		const getuid = process.getuid;
		Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
		try {
			expect(mailboxPrivacyProblem(dir, SELF)).toContain("cannot verify mailbox ownership");
		} finally {
			Object.defineProperty(process, "getuid", { value: getuid, configurable: true });
		}
		expect(mailboxPrivacyProblem(dir, SELF)).toBeUndefined();
	}, 120_000);
});

describe("mailbox.watchInbox (the loop pi and the channel share)", () => {
	it("reports an arrival within one poll and reports nothing after close", async () => {
		mkdirSync(inboxDir(dir, SELF), { recursive: true, mode: 0o700 });
		let scans = 0;
		const watch = watchInbox(dir, SELF, () => {
			scans++;
		});
		await sleep(SCAN_MS + 1_500); // the poll itself fires with nothing new
		expect(scans).toBeGreaterThan(0);

		const before = scans;
		sendEnvelope(dir, newEnvelope("bug-triage", SELF, "arrives by poll"));
		const start = Date.now();
		while (scans === before && Date.now() - start < SCAN_MS + 3_000) await sleep(25);
		expect(scans).toBeGreaterThan(before);

		watch.close();
		const closedAt = scans;
		// An arrival after close must reach nobody: this is what reds a leaked
		// fs.watch callback as well as a leaked interval.
		sendEnvelope(dir, newEnvelope("bug-triage", SELF, "arrives after close"));
		await sleep(SCAN_MS + 1_500);
		expect(scans).toBe(closedAt);
	}, 120_000);
});
