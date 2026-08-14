/**
 * Tests for the peer-link extension: mailbox mechanics (unit) plus
 * integration with real agent sessions (SDK).
 *
 * Integration shape: one real session at a time with $PI_PEER_NAME set; the
 * test plays the other peer by writing/reading envelope files directly. This
 * exercises inbound consumption, user-message injection, the agent's reply
 * turn, auto-reply capture at agent_settled, and the peer_send tool — i.e.
 * every moving part of a two-terminal coordination loop except simultaneous
 * execution.
 *
 * Run:
 *   bash tests/setup.sh        # one-time: link global pi packages
 *   bun test tests/peer-link.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { mkdtemp, mkdir, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	deliveryModeFor,
	ensureMailbox,
	inboxDir,
	listPeers,
	mailboxRoot,
	ownPeerName,
	peerIdentityFrom,
	readIncoming,
	removeHeartbeat,
	resolvePeerAddressAmong,
	sanitizePeerName,
	sendEnvelope,
	sweepStalePeers,
	writeHeartbeat,
	type Envelope,
} from "../extensions/peer-link/mailbox";
import { deliveryDecision } from "../extensions/peer-link/index";

const PEER_LINK_INDEX = join(import.meta.dir, "..", "extensions", "peer-link", "index.ts");

// ---------------------------------------------------------------------------
// Unit tests: mailbox file layer
// ---------------------------------------------------------------------------

describe("peer-link mailbox", () => {
	let dir: string;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "peer-mailbox-"));
	});
	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("sanitizes peer names", () => {
		expect(sanitizePeerName("alice")).toBe("alice");
		expect(sanitizePeerName("  bob_2.x ")).toBe("bob_2.x");
		expect(() => sanitizePeerName("a/b")).toThrow();
		expect(() => sanitizePeerName("../evil")).toThrow();
		expect(() => sanitizePeerName("")).toThrow();
		expect(() => sanitizePeerName("x".repeat(65))).toThrow();
	});

	it("resolves mailbox root and default identity", () => {
		expect(mailboxRoot({ PI_PEER_MAILBOX: "/tmp/custom-mail" } as NodeJS.ProcessEnv)).toBe(
			"/tmp/custom-mail",
		);
		expect(mailboxRoot({ PI_PEER_MAILBOX: "  " } as NodeJS.ProcessEnv)).not.toBe("");
		expect(ownPeerName({ PI_PEER_NAME: " alice " } as NodeJS.ProcessEnv)).toBe("alice");
		expect(ownPeerName({} as NodeJS.ProcessEnv)).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*-\d+$/);
	});

	it("envelopes round-trip and are consumed on read", () => {
		ensureMailbox(dir, "bob");
		const env: Envelope = {
			id: "env-1",
			from: "alice",
			to: "bob",
			text: "hello",
			expectReply: true,
			sentAt: Date.now(),
		};
		sendEnvelope(dir, env);
		const got = readIncoming(dir, "bob");
		expect(got).toHaveLength(1);
		expect(got[0]).toEqual(env);
		expect(readIncoming(dir, "bob")).toHaveLength(0); // consumed
	});

	it("delivers offline mail: sender creates the recipient inbox", () => {
		const env: Envelope = {
			id: "env-2",
			from: "alice",
			to: "carol",
			text: "hi",
			expectReply: false,
			sentAt: Date.now(),
		};
		sendEnvelope(dir, env);
		expect(readIncoming(dir, "carol")).toHaveLength(1);
	});

	it("leaves unreadable files in place for manual inspection", async () => {
		ensureMailbox(dir, "dave");
		await writeFile(join(inboxDir(dir, "dave"), "broken.json"), "{not json");
		expect(readIncoming(dir, "dave")).toHaveLength(0);
		const files = await readdir(inboxDir(dir, "dave"));
		expect(files).toContain("broken.json");
	});

	it("delivery mode: one-way steers by default, pivots on follow-up or expectReply", () => {
		const one = (over: Partial<Envelope>): Envelope => ({
			id: "x",
			from: "a",
			to: "b",
			text: "t",
			expectReply: false,
			sentAt: 0,
			...over,
		});
		// One-way: default steer, explicit follow-up honored.
		expect(deliveryModeFor(one({}))).toBe("steer");
		expect(deliveryModeFor(one({ deliverAs: "steer" }))).toBe("steer");
		expect(deliveryModeFor(one({ deliverAs: "followUp" }))).toBe("followUp");
		// Reply-requested: always follow-up (clean pivot for the auto-reply
		// slicer), even when the sender asked for steer.
		expect(deliveryModeFor(one({ expectReply: true }))).toBe("followUp");
		expect(deliveryModeFor(one({ expectReply: true, deliverAs: "steer" }))).toBe("followUp");
	});

	it("heartbeat marks peers online/offline and stale peers age out", () => {
		writeHeartbeat(dir, { name: "alice", ts: Date.now() });
		writeHeartbeat(dir, { name: "old", ts: Date.now() - 5 * 60_000 });
		const peers = listPeers(dir);
		expect(peers.find((p) => p.name === "alice")?.online).toBe(true);
		expect(peers.find((p) => p.name === "old")?.online).toBe(false);
		sweepStalePeers(dir, Date.now());
		const names = listPeers(dir).map((p) => p.name);
		expect(names).toContain("alice");
		expect(names).not.toContain("old");
		removeHeartbeat(dir, "alice");
		expect(listPeers(dir).map((p) => p.name)).not.toContain("alice");
	});

	it("resolves a UUID-tail address to the full announced peer name", () => {
		const full = "2026-08-12T00-34-37-476Z_019ff364-7f24-7f68-90e2-640b2c649fc3";
		const tail = "019ff364-7f24-7f68-90e2-640b2c649fc3";
		writeHeartbeat(dir, { name: full, ts: Date.now() });
		const listed = listPeers(dir);
		expect(resolvePeerAddressAmong(listed, full)).toBe(full); // exact full name passes through
		expect(resolvePeerAddressAmong(listed, tail)).toBe(full); // UUID tail → full announced name
		expect(resolvePeerAddressAmong(listed, "no-such-peer")).toBe("no-such-peer"); // unknown → unchanged
		expect(resolvePeerAddressAmong(listed, "76")).toBe("76"); // short substring → not resolved (length guard)
		removeHeartbeat(dir, full);
	});
});

describe("peer_send requireOnline gate (deliveryDecision)", () => {
	const online = (names: string[]) => names.map((name) => ({ name, online: true }));
	it("ok when target online", () => {
		const r = deliveryDecision("bob", online(["bob"]), false);
		expect(r).toEqual({ ok: true, online: true });
	});
	it("ok when target offline and requireOnline false (default: queue)", () => {
		const r = deliveryDecision("bob", [{ name: "bob", online: false }], false);
		expect(r).toEqual({ ok: true, online: false });
	});
	it("fails when target offline and requireOnline true", () => {
		const r = deliveryDecision("bob", [{ name: "bob", online: false }], true);
		expect(r.ok).toBe(false);
	});
	it("fails when target absent and requireOnline true", () => {
		const r = deliveryDecision("bob", [], true);
		expect(r.ok).toBe(false);
	});
	it("ok when target online even with requireOnline true", () => {
		const r = deliveryDecision("bob", online(["bob"]), true);
		expect(r).toEqual({ ok: true, online: true });
	});
});

describe("peer-link identity chain (peerIdentityFrom)", () => {
	it("PI_PEER_NAME wins when set", () => {
		expect(peerIdentityFrom({ PI_PEER_NAME: "alice" }, "bug-triage", "/s/x.jsonl")).toBe("alice");
	});
	it("falls back to the session display name when PI_PEER_NAME is unset", () => {
		expect(peerIdentityFrom({}, "bug-triage", "/s/x.jsonl")).toBe("bug-triage");
	});
	it("rejects a non-name-shaped display name (spaces) → falls through to the file", () => {
		// sanitizePeerName rejects "Refactor auth" (space) → file basename used instead.
		expect(peerIdentityFrom({}, "Refactor auth", "/s/abc-123.jsonl")).toBe("abc-123");
	});
	it("falls back to the session file basename when no env and no name", () => {
		expect(peerIdentityFrom({}, undefined, "/s/abc-123.jsonl")).toBe("abc-123");
	});
	it("falls back to hostname-pid when nothing else is available", () => {
		expect(peerIdentityFrom({}, undefined, undefined)).toMatch(/.+-.+/);
	});
	it("trims the display name", () => {
		expect(peerIdentityFrom({}, "  bug-triage  ", undefined)).toBe("bug-triage");
	});
});

// ---------------------------------------------------------------------------
// Integration tests: real agent session + peer-link extension
// ---------------------------------------------------------------------------

function getModelText(entry: { message?: { content?: unknown } }): string {
	const content = entry.message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b: { type?: string }) => b.type === "text")
			.map((b: { text?: string }) => b.text ?? "")
			.join("\n");
	}
	return "";
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const value = probe();
		if (value !== undefined) return value;
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`Timeout (${timeoutMs}ms) waiting for ${what}`);
}

async function waitForSettled(session: { isStreaming: boolean }, timeoutMs = 180_000): Promise<void> {
	const start = Date.now();
	let stable = 0;
	while (Date.now() - start < timeoutMs) {
		await new Promise((r) => setTimeout(r, 200));
		if (session.isStreaming) {
			stable = 0;
		} else if (++stable >= 5) {
			return;
		}
	}
	throw new Error(`Timeout waiting for agent to settle (${timeoutMs / 1000}s)`);
}

interface SessionEnv {
	session: Awaited<ReturnType<typeof createAgentSession>>["session"];
	sessionManager: SessionManager;
	tmpCwd: string;
	tmpAgentDir: string;
	mailbox: string;
	cleanup: () => Promise<void>;
}

async function setupSession(opts: { peerName: string; mailbox: string; tools: string[] }): Promise<SessionEnv> {
	// The extension resolves identity/mailbox from the environment at
	// session_start; set them for the duration of this session.
	const prevName = process.env.PI_PEER_NAME;
	const prevMailbox = process.env.PI_PEER_MAILBOX;
	process.env.PI_PEER_NAME = opts.peerName;
	process.env.PI_PEER_MAILBOX = opts.mailbox;

	const tmpCwd = await mkdtemp(join(tmpdir(), "peer-link-cwd-"));
	const tmpAgentDir = await mkdtemp(join(tmpdir(), "peer-link-agent-"));
	await mkdir(opts.mailbox, { recursive: true, mode: 0o700 });

	const settingsManager = SettingsManager.inMemory({
		retry: { enabled: false },
	});
	const modelRuntime = await ModelRuntime.create({
		authPath: join(getAgentDir(), "auth.json"),
		modelsPath: join(getAgentDir(), "models.json"),
	});
	const model = modelRuntime.getModel("openrouter", "deepseek/deepseek-v4-flash");
	if (!model) throw new Error("Model openrouter/deepseek/deepseek-v4-flash not found");

	const loader = new DefaultResourceLoader({
		cwd: tmpCwd,
		agentDir: tmpAgentDir,
		additionalExtensionPaths: [PEER_LINK_INDEX],
		noSkills: true,
		noThemes: true,
		noPromptTemplates: true,
		noContextFiles: true,
		settingsManager,
		systemPromptOverride: () =>
			"You are a coding assistant. Be concise and follow instructions precisely.",
	});
	await loader.reload();

	const exts = loader.getExtensions();
	const toolNames = exts.extensions.flatMap((e) => [...e.tools.keys()]);
	for (const required of ["peer_send", "peer_list"]) {
		if (!toolNames.includes(required)) {
			const errors = exts.errors.map((e) => e.error).join("; ");
			throw new Error(`peer tools not registered. Errors: ${errors}`);
		}
	}

	const sessionManager = SessionManager.inMemory(tmpCwd);
	const { session } = await createAgentSession({
		cwd: tmpCwd,
		model,
		thinkingLevel: "off",
		modelRuntime,
		resourceLoader: loader,
		tools: opts.tools,
		sessionManager,
		settingsManager,
	});
	// The CLI modes call bindExtensions (which emits session_start) themselves;
	// bare SDK sessions need it to start session-scoped extension runtimes.
	await session.bindExtensions({ mode: "rpc" });

	return {
		session,
		sessionManager,
		tmpCwd,
		tmpAgentDir,
		mailbox: opts.mailbox,
		async cleanup() {
			try {
				session.dispose();
			} catch {}
			if (prevName === undefined) delete process.env.PI_PEER_NAME;
			else process.env.PI_PEER_NAME = prevName;
			if (prevMailbox === undefined) delete process.env.PI_PEER_MAILBOX;
			else process.env.PI_PEER_MAILBOX = prevMailbox;
			for (const d of [tmpCwd, tmpAgentDir]) {
				try {
					await rm(d, { recursive: true, force: true });
				} catch {}
			}
		},
	};
}

function readEnvelopeFiles(mailbox: string, peer: string): Envelope[] {
	try {
		return readIncoming(mailbox, peer);
	} catch {
		return [];
	}
}

describe("peer-link integration", () => {
	it("receives a peer message as a user message and auto-replies once", async () => {
		const mailbox = await mkdtemp(join(tmpdir(), "peer-link-mail-"));
		const env = await setupSession({ peerName: "bob", mailbox, tools: ["peer_list"] });

		try {
			// The test plays "alice": drop a message into bob's inbox.
			const incoming: Envelope = {
				id: "bob-test-1",
				from: "alice",
				to: "bob",
				text: "ping from alice",
				expectReply: true,
				sentAt: Date.now(),
			};
			sendEnvelope(mailbox, incoming);

			// Bob's extension consumes it and injects a user message.
			await waitFor(
				() => {
					const texts = env.sessionManager
						.getEntries()
						.filter(
							(e) =>
								e.type === "message" &&
								(e as { message?: { role?: string } }).message?.role === "user",
						)
						.map((e) => getModelText(e as { message?: { content?: unknown } }));
					return texts.find((t) => t.startsWith("[peer:alice]")) ? texts : undefined;
				},
				60_000,
				"injected peer message in bob's session",
			);

			// Bob's agent settles, then the auto-reply envelope lands in alice's inbox.
			await waitForSettled(env.session);
			const reply = await waitFor(
				() => readEnvelopeFiles(mailbox, "alice")[0],
				60_000,
				"auto-reply envelope in alice's inbox",
			);

			expect(reply.from).toBe("bob");
			expect(reply.to).toBe("alice");
			expect(reply.inReplyTo).toBe("bob-test-1");
			expect(reply.expectReply).toBe(false);
			expect(reply.text.trim().length).toBeGreaterThan(0);
		} finally {
			await env.cleanup();
			await rm(mailbox, { recursive: true, force: true });
		}
	}, 240_000);

	it("agent sends a message to a peer via the peer_send tool", async () => {
		const mailbox = await mkdtemp(join(tmpdir(), "peer-link-mail-"));
		const env = await setupSession({
			peerName: "alice",
			mailbox,
			tools: ["peer_list", "peer_send"],
		});

		try {
			await env.session.prompt(
				"Use the peer_send tool to send the message 'ping from alice' to the peer named 'bob'. " +
					"Do not use any other tools. Do not reply with text — the tool call is the whole task.",
			);
			await waitForSettled(env.session);

			const sent = await waitFor(
				() => {
					const files = readdirSyncSafe(join(mailbox, "bob"));
					return files.length > 0 ? files : undefined;
				},
				60_000,
				"outbound envelope in bob's inbox",
			);

			expect(sent.length).toBeGreaterThan(0);
			const envelope = readEnvelopeFiles(mailbox, "bob")[0];
			expect(envelope.from).toBe("alice");
			expect(envelope.text).toContain("ping from alice");
			expect(envelope.deliverAs).toBe("steer"); // default: agent called peer_send without followUp
		} finally {
			await env.cleanup();
			await rm(mailbox, { recursive: true, force: true });
		}
	}, 240_000);
});

function readdirSyncSafe(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}
