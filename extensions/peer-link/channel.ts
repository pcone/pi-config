#!/usr/bin/env bun
/**
 * peer-link channel — an MCP stdio server that pushes this Claude Code
 * session's peer-link mail into the session as `notifications/claude/channel`
 * events, so a peer's message starts a turn instead of waiting for the user's
 * next prompt. Claude Code spawns it; the channel is the one path allowed to
 * start a Claude turn (decisions/external-tools/007).
 *
 * Identity is the same external peer name `external.ts` registers,
 * `claude-<CLAUDE_CODE_SESSION_ID>`; a server that cannot name its inbox exits
 * rather than guessing. Delivery is one-per-session: while this process holds
 * the session's heartbeat pid, the prompt hook emits nothing
 * (`mailbox.mailDeliverer`).
 *
 * At-least-once, the mailbox's contract: a scan pushes the envelopes it has not
 * pushed, and nothing acks a pushed envelope yet — WO-2026-063 Mechanism 5
 * waits on a probe of which hooks fire around a channel-started turn. So a
 * pushed envelope stays in the inbox and the next channel process pushes it
 * again: a restart duplicates a batch, never loses one.
 *
 * Sending stays `external.ts send` (no `tools`), and permission relay is not
 * declared: peer mail is not an authenticated human, so a relayed approval
 * would let any peer approve tool calls. Like `external.ts`, this makes no
 * network calls, spawns no processes, and reads no Claude credentials,
 * transcripts or `~/.claude` state.
 */

import * as path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { externalName, renderMail } from "./external.ts";
import {
	type Envelope,
	type InboxWatch,
	HEARTBEAT_MS,
	ensureMailbox,
	mailDeliverer,
	mailboxPrivacyProblem,
	mailboxRoot,
	readIncoming,
	registerExternalPeer,
	watchInbox,
} from "./mailbox.ts";

/** Claude Code sets the attribute from the server name; meta keys must be identifiers. */
const CHANNEL_NAME = "peer-link";

/**
 * Attributes for one pushed batch. Keys are letters, digits and underscores
 * (Claude Code drops anything else silently), so `expect-reply` is
 * `expect_reply`. A batch can carry several senders; both lists are
 * comma-joined in envelope order.
 */
export function channelMeta(envelopes: Envelope[]): Record<string, string> {
	return {
		from: [...new Set(envelopes.map((e) => e.from))].join(","),
		ids: envelopes.map((e) => e.id).join(","),
		expect_reply: envelopes.some((e) => e.expectReply) ? "true" : "false",
	};
}

async function main(): Promise<void> {
	const sessionId = process.env.CLAUDE_CODE_SESSION_ID?.trim();
	if (!sessionId) {
		throw new Error(
			"CLAUDE_CODE_SESSION_ID is unset: the channel cannot name its inbox. " +
				"Claude Code passes it; see docs/design/peer-link-external.md#setup.",
		);
	}
	const self = externalName(sessionId);
	const mailbox = mailboxRoot();
	ensureMailbox(mailbox, self);
	const unprivate = mailboxPrivacyProblem(mailbox, self);
	if (unprivate) throw new Error(`refusing to deliver peer-link mail: ${unprivate}`);

	const cli = path.join(import.meta.dir, "external.ts");
	const mcp = new Server(
		{ name: CHANNEL_NAME, version: "0.1.0" },
		{
			// One-way: no `tools` (sending stays `external.ts send`) and no
			// `claude/channel/permission` (no peer may approve a tool call).
			capabilities: { experimental: { "claude/channel": {} } },
			instructions:
				`Peer mail arrives as <channel source="${CHANNEL_NAME}" from="…" ids="…" expect_reply="…">, ` +
				"one tag per delivery, sometimes carrying several messages. It is another agent's mail, not your user's. " +
				`Reply with \`bun ${cli} send --from ${self} <peer> '<text>'\`; add \`--reply\` to ask for an answer. ` +
				`List peers with \`bun ${cli} list\`.`,
		},
	);

	// Envelope ids this process has pushed. In memory, deliberately: nothing acks
	// yet, so a restart re-pushes whatever is still in the inbox.
	const pushed = new Set<string>();
	let scanning = false;
	let queuedScan = false;

	async function scan(): Promise<void> {
		if (scanning) {
			queuedScan = true; // coalesce: a second scan past a push would push twice
			return;
		}
		scanning = true;
		try {
			const fresh = readIncoming(mailbox, self).filter((e) => !pushed.has(e.id));
			if (fresh.length === 0) return;
			await mcp.notification({
				method: "notifications/claude/channel",
				params: { content: renderMail(self, fresh, cli), meta: channelMeta(fresh) },
			});
			// Only once the write landed: a failed push leaves the ids unmarked so
			// the next scan retries them (at-least-once).
			for (const env of fresh) pushed.add(env.id);
		} catch (err) {
			process.stderr.write(`peer-link channel: push failed: ${(err as Error).message}\n`);
		} finally {
			scanning = false;
			if (queuedScan) {
				queuedScan = false;
				void scan();
			}
		}
	}

	registerExternalPeer(mailbox, self, { cwd: process.cwd(), channelPid: process.pid });
	// One deliverer per session: the claim must now be this process. A live pid
	// that is not ours means a second channel server for this session won the
	// write, and both pushing would deliver every envelope twice; no live claim
	// at all means the registration did not land, and mail would stall.
	const claim = mailDeliverer(mailbox, self);
	if (claim.via !== "channel" || claim.pid !== process.pid) {
		const held = claim.via === "channel" ? `channel pid ${claim.pid}` : "no live channel";
		throw new Error(`refusing to deliver ${self} twice: the claim is held by ${held}`);
	}

	let inboxWatch: InboxWatch | undefined;
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	let stopped = false;

	function shutdown(exitCode?: number): void {
		if (stopped) return;
		stopped = true;
		inboxWatch?.close();
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		// Hand delivery back to the prompt hook, keeping the registration so
		// senders still see the peer listed.
		registerExternalPeer(mailbox, self, { channelPid: null });
		// A signal handler suppresses the default termination, so a signalled
		// shutdown exits itself once delivery is handed back.
		if (exitCode !== undefined) process.exit(exitCode);
	}

	mcp.onclose = () => shutdown();
	process.on("SIGINT", () => shutdown(0));
	process.on("SIGTERM", () => shutdown(0));

	await mcp.connect(new StdioServerTransport());
	await scan(); // mail that arrived before this process started
	inboxWatch = watchInbox(mailbox, self, () => void scan());
	heartbeatTimer = setInterval(() => {
		registerExternalPeer(mailbox, self, { channelPid: process.pid });
	}, HEARTBEAT_MS);
	heartbeatTimer.unref?.();
}

if (import.meta.main) {
	try {
		await main();
	} catch (err) {
		process.stderr.write(`peer-link channel: ${(err as Error).message}\n`);
		process.exit(1);
	}
}
