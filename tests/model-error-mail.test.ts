/**
 * Model HTTP errors mail a peer, throttled (WO-2026-065, decision
 * external-tools/008).
 *
 * Every row drives the real mechanism — `createModelErrorMail` over a real
 * mailbox directory, or the wired peer-link extension over an in-memory
 * session — with an injected clock. No live model and no live HTTP endpoint is
 * involved: the classifier is a table over the corpus strings, and the mail is
 * a file in a recipient's inbox.
 *
 * The corpus strings below are verbatim `errorMessage` values from this box's
 * session logs (`~/.pi/agent/sessions`), the population the classifier must
 * handle.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	ensureMailbox,
	readIncoming,
	sendEnvelope,
	writeHeartbeat,
	writeLastCorrespondent,
	type Envelope,
	type PeerInfo,
} from "../extensions/peer-link/mailbox";
import {
	MAIL_ERROR_CHARS,
	MAIL_THROTTLE_MS,
	composeModelErrorMail,
	createModelErrorMail,
	modelHttpStatus,
	type ModelErrorMail,
} from "../extensions/peer-link/model-error-mail";
import peerLink from "../extensions/peer-link/index";

// ---------------------------------------------------------------------------
// Corpus strings, verbatim
// ---------------------------------------------------------------------------

const E_429 = '429: {"code":"1302","message":"Rate limit reached for requests"}';
const E_503 = '503: {"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}';
const E_529 =
	'529 {"type":"error","error":{"type":"overloaded_error","message":"The server cluster is currently under high load. Please retry after a short wait and thank you for your patience. (2064) (529)"},"request_id":"062bd6b14136c890de0bacf068e7af8b"}';
const E_429_RATE = "429 Sorry, you've exhausted this model's rate limit";

const NOT_HTTP_ERRORS = [
	"terminated",
	"Operation aborted",
	"Request timed out.",
	"Connection error.",
	"Stream ended without finish_reason",
	"This operation was aborted",
	"Provider returned error",
];

// ---------------------------------------------------------------------------
// Harness: a real mailbox directory, a fake clock, real envelope writes
// ---------------------------------------------------------------------------

type Harness = {
	dir: string;
	warns: string[];
	clock: { now: number };
	peers: PeerInfo[];
	mail: ModelErrorMail;
	/** Envelopes waiting in a peer's inbox. */
	inbox: (peer: string) => ReturnType<typeof readIncoming>;
	/** A fresh notifier over the same mailbox state — emulates a restart. */
	restart: () => ModelErrorMail;
};

const SELF = "self-seat";
const CORRESPONDENT = "oracle-seat";

async function makeHarness(options: { correspondent?: string; peers?: PeerInfo[] } = {}): Promise<Harness> {
	const dir = await mkdtemp(join(tmpdir(), "model-error-mail-"));
	ensureMailbox(dir, SELF);
	if (options.correspondent) writeLastCorrespondent(dir, SELF, options.correspondent);
	const warns: string[] = [];
	const clock = { now: Date.parse("2026-11-03T04:00:00Z") };
	const peers = options.peers ?? [];
	const build = (): ModelErrorMail =>
		createModelErrorMail({
			mailbox: () => dir,
			peerName: () => SELF,
			sessionId: () => "session-019ff364-0000-7000-8000-000000000000",
			cwd: () => "/work/tfd",
			peers: () => peers,
			warn: (message) => warns.push(message),
			now: () => clock.now,
		});
	let mail = build();
	return {
		dir,
		warns,
		clock,
		peers,
		get mail() {
			return mail;
		},
		inbox: (peer: string) => readIncoming(dir, peer),
		restart: () => {
			mail = build();
			return mail;
		},
	} as Harness;
}

function assistantError(errorMessage: string) {
	return {
		stopReason: "error",
		errorMessage,
		provider: "opencode-go",
		model: "deepseek-v4.1-flash",
	};
}

const assistantOk = { stopReason: "stop", provider: "opencode-go", model: "deepseek-v4.1-flash" };

/** One online peer, announced the way the extension announces itself. */
function onlinePeer(name: string, ts = Date.now()): PeerInfo {
	return { name, ts, online: true };
}

let harnesses: Harness[] = [];

beforeEach(() => {
	harnesses = [];
});

afterEach(async () => {
	for (const h of harnesses) await rm(h.dir, { recursive: true, force: true });
});

async function harness(options?: Parameters<typeof makeHarness>[0]): Promise<Harness> {
	const h = await makeHarness(options);
	harnesses.push(h);
	return h;
}

// ---------------------------------------------------------------------------
// The classifier (rows 2 and 3, classification half)
// ---------------------------------------------------------------------------

describe("modelHttpStatus", () => {
	it("reads the leading status of an HTTP error message", () => {
		expect(modelHttpStatus(E_429)).toBe(429);
		expect(modelHttpStatus(E_503)).toBe(503);
		expect(modelHttpStatus(E_529)).toBe(529);
		expect(modelHttpStatus(E_429_RATE)).toBe(429);
		expect(modelHttpStatus("  500: {")).toBe(500);
		expect(modelHttpStatus("520: {")).toBe(520);
	});

	it("does not read a non-HTTP failure as an HTTP error", () => {
		for (const text of NOT_HTTP_ERRORS) {
			expect(modelHttpStatus(text)).toBeUndefined();
		}
	});

	it("requires the status to lead the message", () => {
		expect(modelHttpStatus("Streaming response failed: [500] Internal Server Error")).toBeUndefined();
		expect(modelHttpStatus("Internal Server Error")).toBeUndefined();
		expect(modelHttpStatus("")).toBeUndefined();
		expect(modelHttpStatus(undefined)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Row 1: a 4XX mails the recipient once, with the status and the message
// ---------------------------------------------------------------------------

describe("a 429 mails the last correspondent", () => {
	it("writes one envelope carrying status, session, cwd, model and the message", async () => {
		const h = await harness({ correspondent: CORRESPONDENT, peers: [onlinePeer(CORRESPONDENT)] });
		h.mail.onAssistantMessage(assistantError(E_429));

		const mail = h.inbox(CORRESPONDENT);
		expect(mail).toHaveLength(1);
		expect(h.inbox(SELF)).toHaveLength(0);

		const envelope = mail[0]!;
		expect(envelope.from).toBe(SELF);
		expect(envelope.to).toBe(CORRESPONDENT);
		expect(envelope.expectReply).toBe(false);
		expect(envelope.text).toBe(
			[
				"[model-error] opencode-go/deepseek-v4.1-flash returned HTTP 429",
				`session: ${SELF} (session-019ff364-0000-7000-8000-000000000000)`,
				"cwd: /work/tfd",
				`error: ${E_429}`,
			].join("\n"),
		);
	});

	it("truncates the carried message to 200 characters", async () => {
		const h = await harness({ correspondent: CORRESPONDENT, peers: [onlinePeer(CORRESPONDENT)] });
		const long = `429: {"message":"${"x".repeat(400)}"}`;
		h.mail.onAssistantMessage(assistantError(long));

		const text = h.inbox(CORRESPONDENT)[0]!.text;
		const errorLine = text.split("\n").find((line) => line.startsWith("error: "))!;
		// The order names the bound literally; the constant is what the code reads.
		expect(MAIL_ERROR_CHARS).toBe(200);
		expect(errorLine.slice("error: ".length)).toBe(long.slice(0, 200));
		expect(errorLine.length).toBe("error: ".length + 200);
	});

	it("carries no prompt text and no summary", async () => {
		const h = await harness({ correspondent: CORRESPONDENT, peers: [onlinePeer(CORRESPONDENT)] });
		h.mail.onAssistantMessage(assistantError(E_429));
		expect(h.inbox(CORRESPONDENT)[0]!.text.split("\n")).toHaveLength(4);
	});
});

// ---------------------------------------------------------------------------
// Row 2: 5XX mails too
// ---------------------------------------------------------------------------

describe("5XX mails too", () => {
	it("mails a 503", async () => {
		const h = await harness({ correspondent: CORRESPONDENT, peers: [onlinePeer(CORRESPONDENT)] });
		h.mail.onAssistantMessage(assistantError(E_503));
		const mail = h.inbox(CORRESPONDENT);
		expect(mail).toHaveLength(1);
		expect(mail[0]!.text).toContain("returned HTTP 503");
	});

	it("mails a 529", async () => {
		const h = await harness({ correspondent: CORRESPONDENT, peers: [onlinePeer(CORRESPONDENT)] });
		h.mail.onAssistantMessage(assistantError(E_529));
		const mail = h.inbox(CORRESPONDENT);
		expect(mail).toHaveLength(1);
		expect(mail[0]!.text).toContain("returned HTTP 529");
	});
});

// ---------------------------------------------------------------------------
// Row 3: non-HTTP failures mail nothing — one table row each
// ---------------------------------------------------------------------------

describe("non-HTTP failures mail nothing", () => {
	for (const text of NOT_HTTP_ERRORS) {
		it(`does not mail on ${JSON.stringify(text)}`, async () => {
			const h = await harness({ correspondent: CORRESPONDENT, peers: [onlinePeer(CORRESPONDENT)] });
			h.mail.onAssistantMessage(assistantError(text));
			expect(h.inbox(CORRESPONDENT)).toHaveLength(0);
			expect(h.warns).toEqual([]);
		});
	}
});

// ---------------------------------------------------------------------------
// Row 4: the throttle window
// ---------------------------------------------------------------------------

describe("throttle", () => {
	it("collapses three failures inside the window into one mail, then carries the count", async () => {
		const h = await harness({ correspondent: CORRESPONDENT, peers: [onlinePeer(CORRESPONDENT)] });
		const firstMailAt = h.clock.now;

		h.mail.onAssistantMessage(assistantError(E_429));
		h.clock.now += 60_000;
		h.mail.onAssistantMessage(assistantError(E_429));
		h.clock.now += 60_000;
		h.mail.onAssistantMessage(assistantError(E_429));
		expect(h.inbox(CORRESPONDENT)).toHaveLength(1);
		expect(h.inbox(CORRESPONDENT)[0]!.text).not.toContain("suppressed:");

		// Past the window: the next failure mails and reports what it dropped.
		h.clock.now = firstMailAt + MAIL_THROTTLE_MS;
		h.mail.onAssistantMessage(assistantError(E_429));

		const texts = h.inbox(CORRESPONDENT).map((envelope) => envelope.text);
		expect(texts).toHaveLength(2);
		const withCount = texts.filter((text) => text.includes("suppressed:"));
		expect(withCount).toHaveLength(1);
		expect(withCount[0]).toContain(
			`suppressed: 2 more qualifying failures since ${new Date(firstMailAt).toISOString()}`,
		);
	});

	it("treats the window as exclusive at its boundary", async () => {
		const h = await harness({ correspondent: CORRESPONDENT, peers: [onlinePeer(CORRESPONDENT)] });
		h.mail.onAssistantMessage(assistantError(E_429));
		h.clock.now += MAIL_THROTTLE_MS - 1;
		h.mail.onAssistantMessage(assistantError(E_429));
		expect(h.inbox(CORRESPONDENT)).toHaveLength(1);
		h.clock.now += 1;
		h.mail.onAssistantMessage(assistantError(E_429));
		expect(h.inbox(CORRESPONDENT)).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// Row 5: a good turn ends the stall
// ---------------------------------------------------------------------------

describe("a good turn clears the window", () => {
	it("mails immediately after a non-error assistant message", async () => {
		const h = await harness({ correspondent: CORRESPONDENT, peers: [onlinePeer(CORRESPONDENT)] });
		h.mail.onAssistantMessage(assistantError(E_429));
		h.clock.now += 60_000;
		h.mail.onAssistantMessage(assistantError(E_429));
		expect(h.inbox(CORRESPONDENT)).toHaveLength(1);

		h.mail.onAssistantMessage(assistantOk);
		h.clock.now += 60_000;
		h.mail.onAssistantMessage(assistantError(E_429));

		const texts = h.inbox(CORRESPONDENT).map((envelope) => envelope.text);
		expect(texts).toHaveLength(2);
		// Nothing was dropped, so neither mail carries a count.
		expect(texts.every((text) => !text.includes("suppressed:"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Row 7: an unsendable recipient warns once and does not throw
// ---------------------------------------------------------------------------

describe("no recipient", () => {
	it("warns once across failures and writes nothing", async () => {
		const h = await harness();
		expect(() => h.mail.onAssistantMessage(assistantError(E_429))).not.toThrow();
		h.clock.now += MAIL_THROTTLE_MS + 1;
		expect(() => h.mail.onAssistantMessage(assistantError(E_429))).not.toThrow();

		expect(h.warns).toHaveLength(1);
		expect(h.warns[0]).toContain("no recipient");
		expect(await readdir(h.dir)).not.toContain(CORRESPONDENT);
	});

	it("mails the next failure once a recipient exists", async () => {
		const h = await harness();
		h.mail.onAssistantMessage(assistantError(E_429));
		h.peers.push(onlinePeer("late-peer"));
		h.mail.onAssistantMessage(assistantError(E_429));
		expect(h.inbox("late-peer")).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Row 11: the recipient is the last correspondent
// ---------------------------------------------------------------------------

describe("recipient rule", () => {
	it("goes to the last correspondent, not to the online peers", async () => {
		const h = await harness({
			correspondent: CORRESPONDENT,
			peers: [onlinePeer(CORRESPONDENT), onlinePeer("bystander")],
		});
		h.mail.onAssistantMessage(assistantError(E_429));
		expect(h.inbox(CORRESPONDENT)).toHaveLength(1);
		expect(h.inbox("bystander")).toHaveLength(0);
	});

	it("keeps the correspondent across a restart", async () => {
		const h = await harness({ peers: [onlinePeer(CORRESPONDENT), onlinePeer("bystander")] });
		h.mail.recordCorrespondent(CORRESPONDENT);
		const restarted = h.restart();
		restarted.onAssistantMessage(assistantError(E_429));
		expect(h.inbox(CORRESPONDENT)).toHaveLength(1);
		expect(h.inbox("bystander")).toHaveLength(0);
	});

	it("broadcasts to the online peers when no peer ever mailed this session", async () => {
		const h = await harness({ peers: [onlinePeer("peer-a"), onlinePeer("peer-b")] });
		h.mail.onAssistantMessage(assistantError(E_429));
		expect(h.inbox("peer-a")).toHaveLength(1);
		expect(h.inbox("peer-b")).toHaveLength(1);
		expect(h.inbox(SELF)).toHaveLength(0);
	});

	it("never addresses a session that mailed itself", async () => {
		const h = await harness({ correspondent: SELF, peers: [onlinePeer("peer-a")] });
		h.mail.onAssistantMessage(assistantError(E_429));
		expect(h.inbox(SELF)).toHaveLength(0);
		expect(h.inbox("peer-a")).toHaveLength(1);
	});

	it("skips offline peers in the broadcast", async () => {
		const h = await harness({
			peers: [onlinePeer("peer-a"), { name: "peer-away", ts: 0, online: false }],
		});
		h.mail.onAssistantMessage(assistantError(E_429));
		expect(h.inbox("peer-a")).toHaveLength(1);
		expect(h.inbox("peer-away")).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Acceptance rows 1–6 (WO-2026-066): a dead correspondent is not a recipient
//
// The wired extension over an in-memory session, with real heartbeat and inbox
// files. Every row asserts which inboxes hold an envelope — never an internal
// list — and the heartbeats it writes are the ones `listPeers` reads.
// ---------------------------------------------------------------------------

describe("recipient liveness", () => {
	type Handler = (event: unknown, ctx: unknown) => unknown;

	const ME = "live-seat";

	async function wired(options: { record?: string; inbound?: Envelope } = {}) {
		const mailbox = await mkdtemp(join(tmpdir(), "model-error-live-"));
		ensureMailbox(mailbox, ME);
		// The persisted record: whoever mailed this session before a restart.
		if (options.record) writeLastCorrespondent(mailbox, ME, options.record);
		if (options.inbound) sendEnvelope(mailbox, options.inbound);
		const previous = { name: process.env.PI_PEER_NAME, mailbox: process.env.PI_PEER_MAILBOX };
		process.env.PI_PEER_NAME = ME;
		process.env.PI_PEER_MAILBOX = mailbox;

		const sessions = SessionManager.inMemory("/work/live");
		const notifies: Array<{ message: string; level?: string }> = [];
		const injected: string[] = [];
		const handlers = new Map<string, Handler[]>();
		const api = {
			on: (event: string, handler: Handler) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerTool: () => {},
			registerCommand: () => {},
			sendUserMessage: (text: string) => {
				injected.push(text);
				sessions.appendMessage({ role: "user", content: text, timestamp: Date.now() });
			},
		} as unknown as ExtensionAPI;
		const ctx = {
			cwd: "/work/live",
			ui: { notify: (message: string, level?: string) => notifies.push({ message, level }) },
			sessionManager: sessions,
		};
		peerLink(api);
		const emit = async (event: string, payload: unknown) => {
			for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
		};
		await emit("session_start", { type: "session_start" });
		return {
			mailbox,
			notifies,
			injected,
			/** A peer's heartbeat, published the way its own runtime publishes it. */
			heartbeat: (name: string, ageMs = 0) =>
				writeHeartbeat(mailbox, { name, ts: Date.now() - ageMs }),
			error: (errorMessage = E_429) =>
				emit("message_end", {
					type: "message_end",
					message: {
						role: "assistant",
						content: [],
						api: "openai-completions",
						provider: "opencode-go",
						model: "deepseek-v4.1-flash",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
						stopReason: "error",
						errorMessage,
						timestamp: Date.now(),
					},
				}),
			inbox: (peer: string) => readIncoming(mailbox, peer),
			cleanup: async () => {
				await emit("session_shutdown", { type: "session_shutdown" });
				if (previous.name === undefined) delete process.env.PI_PEER_NAME;
				else process.env.PI_PEER_NAME = previous.name;
				if (previous.mailbox === undefined) delete process.env.PI_PEER_MAILBOX;
				else process.env.PI_PEER_MAILBOX = previous.mailbox;
				await rm(mailbox, { recursive: true, force: true });
			},
		};
	}

	it("row 1: the correspondent recorded this process receives it, and only it", async () => {
		const w = await wired({
			inbound: {
				id: "env-row1",
				from: "corr-seat",
				to: ME,
				text: "status?",
				expectReply: false,
				sentAt: Date.now(),
			},
		});
		try {
			// The scan delivered the envelope at session_start, so it recorded
			// this session's correspondent in process memory.
			expect(w.injected).toHaveLength(1);
			w.heartbeat("corr-seat");
			w.heartbeat("bystander");

			await w.error();

			expect(w.inbox("corr-seat")).toHaveLength(1);
			expect(w.inbox("bystander")).toHaveLength(0);
		} finally {
			await w.cleanup();
		}
	});

	it("row 2: a correspondent read from the persisted record, online, is the only recipient", async () => {
		const w = await wired({ record: "corr-seat" });
		try {
			w.heartbeat("corr-seat");
			w.heartbeat("bystander");

			await w.error();

			expect(w.inbox("corr-seat")).toHaveLength(1);
			expect(w.inbox("bystander")).toHaveLength(0);
		} finally {
			await w.cleanup();
		}
	});

	it("row 3: a dead correspondent falls to the peers online now", async () => {
		const w = await wired({ record: "dead-seat" });
		try {
			// Aged out of the online window, still listed: exactly the subagent
			// whose inbox nobody reads.
			w.heartbeat("dead-seat", 60_000);
			w.heartbeat("live-peer");

			await w.error();

			expect(w.inbox("live-peer")).toHaveLength(1);
			expect(w.inbox("dead-seat")).toHaveLength(0);
		} finally {
			await w.cleanup();
		}
	});

	it("row 4: no live peer warns once, sends nothing, and leaves the window shut", async () => {
		const w = await wired({ record: "dead-seat" });
		try {
			w.heartbeat("dead-seat", 60_000);

			await w.error();

			expect(w.inbox("dead-seat")).toHaveLength(0);
			expect(w.inbox(ME)).toHaveLength(0);
			const warnings = w.notifies.filter((n) => n.level === "warning");
			expect(warnings).toHaveLength(1);
			expect(warnings[0]!.message).toContain("no recipient");

			// The window never opened, so the next failure mails at once.
			w.heartbeat("late-peer");
			await w.error();
			expect(w.inbox("late-peer")).toHaveLength(1);
		} finally {
			await w.cleanup();
		}
	});

	it("row 5: no correspondent ever, so every online peer is mailed", async () => {
		const w = await wired();
		try {
			w.heartbeat("peer-a");
			w.heartbeat("peer-b");

			await w.error();

			expect(w.inbox("peer-a")).toHaveLength(1);
			expect(w.inbox("peer-b")).toHaveLength(1);
			expect(w.inbox(ME)).toHaveLength(0);
		} finally {
			await w.cleanup();
		}
	});

	it("row 6: a record naming this session is never a recipient", async () => {
		const w = await wired({ record: ME });
		try {
			w.heartbeat("peer-a");

			await w.error();

			expect(w.inbox(ME)).toHaveLength(0);
			expect(w.inbox("peer-a")).toHaveLength(1);
		} finally {
			await w.cleanup();
		}

		// Alone, the self record still mails nobody.
		const alone = await wired({ record: ME });
		try {
			await alone.error();
			expect(alone.inbox(ME)).toHaveLength(0);
		} finally {
			await alone.cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// Row 6: the mail adds no user message and no tool call to this session
//
// Driven through the wired extension: `sendUserMessage` in the stub is the
// transport pi uses to append a user message, so a mail that routed through it
// would grow the branch. The branch is asserted directly, not spied on.
// ---------------------------------------------------------------------------

describe("the mail never enters this session's branch", () => {
	type Handler = (event: unknown, ctx: unknown) => unknown;

	async function wiredBranch(options: { correspondent?: string; inbound?: Envelope } = {}) {
		const mailbox = await mkdtemp(join(tmpdir(), "model-error-branch-"));
		ensureMailbox(mailbox, "branch-seat");
		if (options.correspondent) writeLastCorrespondent(mailbox, "branch-seat", options.correspondent);
		// A correspondent has to be online to receive: the mail's first arm is
		// gated on the heartbeat (WO-2026-066).
		if (options.correspondent)
			writeHeartbeat(mailbox, { name: options.correspondent, ts: Date.now() });
		// Placed before the session starts, so the extension's first inbox scan
		// delivers it and records the sender as the last correspondent.
		if (options.inbound) {
			writeHeartbeat(mailbox, { name: options.inbound.from, ts: Date.now() });
			sendEnvelope(mailbox, options.inbound);
		}
		const previous = { name: process.env.PI_PEER_NAME, mailbox: process.env.PI_PEER_MAILBOX };
		process.env.PI_PEER_NAME = "branch-seat";
		process.env.PI_PEER_MAILBOX = mailbox;

		const sessions = SessionManager.inMemory("/work/branch");
		const handlers = new Map<string, Handler[]>();
		const api = {
			on: (event: string, handler: Handler) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerTool: () => {},
			registerCommand: () => {},
			// What pi does with a user message: a user entry on the branch.
			sendUserMessage: (text: string) => {
				sessions.appendMessage({ role: "user", content: text, timestamp: Date.now() });
			},
		} as unknown as ExtensionAPI;
		const ctx = {
			cwd: "/work/branch",
			ui: { notify: () => {} },
			sessionManager: sessions,
		};
		peerLink(api);
		const emit = async (event: string, payload: unknown) => {
			for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
		};
		await emit("session_start", { type: "session_start" });
		return {
			sessions,
			mailbox,
			emitMessageEnd: (message: unknown) => emit("message_end", { type: "message_end", message }),
			cleanup: async () => {
				await emit("session_shutdown", { type: "session_shutdown" });
				if (previous.name === undefined) delete process.env.PI_PEER_NAME;
				else process.env.PI_PEER_NAME = previous.name;
				if (previous.mailbox === undefined) delete process.env.PI_PEER_MAILBOX;
				else process.env.PI_PEER_MAILBOX = previous.mailbox;
				await rm(mailbox, { recursive: true, force: true });
			},
		};
	}

	it("mails a 429 without adding an entry to the branch", async () => {
		const wired = await wiredBranch({ correspondent: "oracle-seat" });
		try {
			wired.sessions.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
			// A finished assistant turn too, so the "no tool call" check below has
			// an assistant entry to look at rather than matching nothing.
			wired.sessions.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "ready" }],
				api: "openai-completions",
				provider: "opencode-go",
				model: "deepseek-v4.1-flash",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
				stopReason: "stop",
				timestamp: Date.now(),
			});
			const before = wired.sessions.getBranch().map((entry) => entry.id);

			await wired.emitMessageEnd({
				role: "assistant",
				content: [],
				api: "openai-completions",
				provider: "opencode-go",
				model: "deepseek-v4.1-flash",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
				stopReason: "error",
				errorMessage: E_429,
				timestamp: Date.now(),
			});

			const after = wired.sessions.getBranch();
			expect(after.map((entry) => entry.id)).toEqual(before);
			expect(
				after.filter((entry) => entry.type === "message" && entry.message.role === "user"),
			).toHaveLength(1);
			const assistantEntries = after.filter(
				(entry) => entry.type === "message" && entry.message.role === "assistant",
			);
			expect(assistantEntries.length).toBeGreaterThan(0);
			expect(
				assistantEntries.some((entry) =>
					(entry as { message: { content: Array<{ type: string }> } }).message.content.some(
						(block) => block.type === "toolCall",
					),
				),
			).toBe(false);
			// The mail did go out, so the branch assertion is not vacuous.
			expect(readIncoming(wired.mailbox, "oracle-seat")).toHaveLength(1);
		} finally {
			await wired.cleanup();
		}
	});

	it("records the correspondent when a peer's envelope is delivered", async () => {
		const wired = await wiredBranch({
			inbound: {
				id: "env-corr",
				from: "oracle-seat",
				to: "branch-seat",
				text: "status?",
				expectReply: false,
				sentAt: Date.now(),
			},
		});
		try {
			await wired.emitMessageEnd({
				role: "assistant",
				content: [],
				api: "openai-completions",
				provider: "opencode-go",
				model: "deepseek-v4.1-flash",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
				stopReason: "error",
				errorMessage: E_429,
				timestamp: Date.now(),
			});
			// The delivered envelope's sender is now the mail's address.
			expect(readIncoming(wired.mailbox, "oracle-seat")).toHaveLength(1);
			expect(readIncoming(wired.mailbox, "oracle-seat")[0]!.to).toBe("oracle-seat");
		} finally {
			await wired.cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// Text shape
// ---------------------------------------------------------------------------

describe("composeModelErrorMail", () => {
	it("marks the mail as machine-generated and omits the suppressed line when nothing was dropped", () => {
		const text = composeModelErrorMail({
			peerName: "seat",
			sessionId: "sid",
			cwd: "/work",
			provider: "zai",
			model: "glm-5.2",
			status: 503,
			errorMessage: E_503,
			suppressed: null,
		});
		expect(text).toBe(
			[
				"[model-error] zai/glm-5.2 returned HTTP 503",
				"session: seat (sid)",
				"cwd: /work",
				`error: ${E_503}`,
			].join("\n"),
		);
	});

	it("reports the suppressed count with the window start", () => {
		const since = Date.parse("2026-11-03T04:00:00Z");
		const text = composeModelErrorMail({
			peerName: "seat",
			sessionId: "sid",
			cwd: "/work",
			provider: "zai",
			model: "glm-5.2",
			status: 429,
			errorMessage: E_429,
			suppressed: { count: 7, since },
		});
		expect(text.split("\n").at(-1)).toBe(
			`suppressed: 7 more qualifying failures since ${new Date(since).toISOString()}`,
		);
	});
});
