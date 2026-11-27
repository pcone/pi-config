#!/usr/bin/env bun
/**
 * External peer CLI: lets a non-pi tool (a Claude Code session) join the
 * peer-link mailbox. Not a pi extension — pi loads only peer-link/index.ts.
 *
 * Driven by Claude Code hooks (stdin = hook input JSON):
 *   external.ts hook session-start   register `claude-<session_id>`; print identity + usage
 *   external.ts hook prompt          refresh registration; claim and print pending mail
 *   external.ts hook session-end     unregister
 * And by the session itself:
 *   external.ts send --from <name> [--reply] [--require-online] [--wait <minutes>] <to> <text | ->
 *   external.ts watch --from <name>  block until direct mail arrives (run in background)
 *   external.ts list
 *
 * Mail is read only inside a hook the user's prompt fired, by a reply-wait
 * (`send --wait`, run in background), or by a watch (run in background). Each
 * claims what it prints. The prompt hook and the watch skip replies that a live
 * reply-wait owns. A reply-wait's or a watch's exit may start a turn; nothing
 * else here does. Why: docs/design/peer-link-external.md, decisions 012 and 014.
 * Delivery is at-most-once: each envelope is deleted by the one path that reads it.
 */

import * as fs from "node:fs";
import {
	type Envelope,
	claimIncoming,
	broadcastTargets,
	deliveryDecision,
	ensureMailbox,
	inboxDir,
	liveWaits,
	liveWatchPid,
	listPeers,
	mailboxRoot,
	newEnvelope,
	ownedByLiveWait,
	peerStatus,
	queuedStatus,
	removeHeartbeat,
	removeWait,
	removeWatchRecord,
	resolvePeerAddressAmong,
	sanitizePeerName,
	scanInbox,
	sendEnvelope,
	writeHeartbeat,
	writeWait,
	writeWatchRecord,
	type PeerInfo,
} from "./mailbox.ts";

const SELF = process.argv[1];

interface HookInput {
	session_id: string;
	cwd?: string;
	hook_event_name?: string;
}

function readStdin(): string {
	return fs.readFileSync(0, "utf8");
}

function hookInput(): HookInput {
	const input = JSON.parse(readStdin()) as HookInput;
	if (typeof input.session_id !== "string" || !input.session_id) {
		throw new Error("hook input has no session_id");
	}
	return input;
}

export function externalName(sessionId: string): string {
	return sanitizePeerName(`claude-${sessionId}`);
}

function register(mailbox: string, name: string, cwd: string | undefined): void {
	ensureMailbox(mailbox, name);
	writeHeartbeat(mailbox, { name, cwd, ts: Date.now(), external: true });
}

function emitContext(event: string, text: string): void {
	process.stdout.write(
		JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }),
	);
}

/** Render pending envelopes as prompt context. Exported for tests. */
export function renderMail(self: string, envelopes: Envelope[]): string {
	const blocks = envelopes
		.sort((a, b) => a.sentAt - b.sentAt)
		.map((e) => {
			const reply = e.expectReply
				? `\n(${e.from} asked for a reply: send one with \`${sendUsage(self, e.from)}\`)`
				: "";
			const bc = e.broadcast ? " (broadcast)" : "";
			const re = e.inReplyTo ? ` (reply to ${e.inReplyTo})` : "";
			return `[peer:${e.from}]${bc}${re} ${e.text}${reply}`;
		});
	return `peer-link mail for ${self} (${envelopes.length}):\n\n${blocks.join("\n\n")}`;
}

function sendUsage(self: string, to = "<peer>"): string {
	return `bun ${SELF} send --from ${self} ${to} '<text>'`;
}

function watchCommand(self: string): string {
	return `bun ${SELF} watch --from ${self}`;
}

/** The line naming unreadable inbox files, or undefined when there are none. */
function unreadableNote(mailbox: string, self: string): string | undefined {
	const { unreadable } = scanInbox(mailbox, self);
	if (unreadable.length === 0) return undefined;
	return `peer-link: ${unreadable.length} unreadable envelope(s) left in ${inboxDir(mailbox, self)}`;
}

function hook(event: string): void {
	const input = hookInput();
	const mailbox = mailboxRoot();
	const self = externalName(input.session_id);
	switch (event) {
		case "session-start":
			register(mailbox, self, input.cwd);
			emitContext(
				"SessionStart",
				`peer-link: this session is external peer \`${self}\`. pi peers can message it; ` +
					"their mail is added to the user's next prompt. " +
					`Send: \`${sendUsage(self)}\` (text \`-\` reads stdin; \`--reply\` asks for an answer; ` +
					"`--require-online` fails instead of queueing; `--wait <minutes>` (run in background) waits for the peer's reply; " +
					"`<to>` may be `*` or a comma-separated list to broadcast). " +
					`Start a watch in the background (Bash run_in_background): \`${watchCommand(self)}\`. ` +
					"It exits when direct mail arrives: handle the mail, then start it again. " +
					`Broadcasts arrive at the next prompt. List peers: \`bun ${SELF} list\`.`,
			);
			return;
		case "prompt": {
			register(mailbox, self, input.cwd);
			const waits = liveWaits(mailbox, self);
			const envelopes = claimIncoming(mailbox, self, (e) => !ownedByLiveWait(e, waits));
			const parts: string[] = [];
			if (envelopes.length > 0) parts.push(renderMail(self, envelopes));
			// Decision external-tools/014 § Watch liveness: nudge whenever no watch is live.
			if (liveWatchPid(mailbox, self) === undefined) {
				parts.push(
					"peer-link: no watch is running for this session. Start one in the background " +
						`(Bash run_in_background): \`${watchCommand(self)}\`, and start it again after each exit.`,
				);
			}
			const note = unreadableNote(mailbox, self);
			if (note !== undefined) parts.push(note);
			if (parts.length === 0) return;
			emitContext("UserPromptSubmit", parts.join("\n\n"));
			return;
		}
		case "session-end":
			removeHeartbeat(mailbox, self);
			return;
		default:
			throw new Error(`unknown hook event "${event}"`);
	}
}

const WAIT_POLL_MS = 1000;

function parseWaitMinutes(value: string | undefined): number {
	const minutes = Number(value);
	if (!Number.isFinite(minutes) || minutes <= 0) {
		throw new Error("send: --wait needs a positive number of minutes");
	}
	return minutes;
}

/**
 * Block until the target replies, goes offline, or the interval elapses.
 * Returns the exit code: 0 reply, 3 peer gone, 4 check-in due (decision 012).
 */
function waitForReply(mailbox: string, self: string, to: string, sentAt: number, minutes: number): number {
	const started = Date.now();
	for (;;) {
		// Claimed before printing: a waiter killed between the two loses the reply.
		const replies = claimIncoming(mailbox, self, (e) => e.from === to && e.sentAt >= sentAt);
		if (replies.length > 0) {
			console.log(renderMail(self, replies));
			return 0;
		}
		const peer = listPeers(mailbox).find((p) => p.name === to);
		if (!peer || !peer.online) {
			console.log(`peer ${to} is no longer online; no reply`);
			return 3;
		}
		if (Date.now() - started >= minutes * 60_000) {
			const log = peer.sessionFile ? ` Session log: ${peer.sessionFile}` : "";
			console.log(
				`no reply from ${to} after ${minutes} min; peer still online. Ask it for a progress update with another --wait.${log}`,
			);
			return 4;
		}
		Bun.sleepSync(WAIT_POLL_MS);
	}
}

/**
 * Block until direct mail arrives: print the pending mail and exit 0. Exit 3
 * when this session's registration is gone (SessionEnd). Exit 2 when a live
 * watch for this session already runs. No timeout: wakes stay bounded by mail
 * (decision external-tools/014).
 */
/** How often a running watch refreshes its registration (decision external-tools/014 § 6). */
const WATCH_REFRESH_MS = 60_000;

/** Internal test hook: PI_PEER_WATCH_REFRESH_MS shortens the refresh interval. Not a documented flag. */
function watchRefreshMs(): number {
	const raw = process.env.PI_PEER_WATCH_REFRESH_MS;
	if (raw === undefined) return WATCH_REFRESH_MS;
	const ms = Number(raw);
	if (!Number.isFinite(ms) || ms <= 0) {
		throw new Error(`PI_PEER_WATCH_REFRESH_MS must be a positive number of milliseconds, got ${raw}`);
	}
	return ms;
}

function watch(args: string[]): number {
	if (args.length !== 2 || args[0] !== "--from") throw new Error("usage: watch --from <name>");
	const self = sanitizePeerName(args[1]);
	const mailbox = mailboxRoot();
	const refreshMs = watchRefreshMs();
	const running = liveWatchPid(mailbox, self);
	if (running !== undefined) {
		console.error(`peer-link external: a watch for ${self} is already running (pid ${running})`);
		return 2;
	}
	const parent = process.ppid;
	writeWatchRecord(mailbox, self, { pid: process.pid, startedAt: Date.now(), ppid: parent });
	let refreshedAt = 0;
	try {
		for (;;) {
			// Reparented: the shell or session that started this watch has exited.
			if (process.ppid !== parent) {
				console.log(`peer-link: ${self}'s parent process is gone; watch exiting`);
				return 3;
			}
			const me = listPeers(mailbox).find((p) => p.name === self);
			if (!me) {
				console.log(`peer-link: ${self} is no longer registered (session ended); watch exiting`);
				return 3;
			}
			// A refresh keeps the 24 h external expiry from ending an idle session's watch.
			if (Date.now() - refreshedAt >= refreshMs) {
				register(mailbox, self, me.cwd);
				refreshedAt = Date.now();
			}
			const waits = liveWaits(mailbox, self);
			const direct = scanInbox(mailbox, self).valid.some(
				({ envelope }) => !envelope.broadcast && !ownedByLiveWait(envelope, waits),
			);
			if (direct) {
				// Broadcasts ride along: they are claimed here, not left for the next prompt.
				const mail = claimIncoming(mailbox, self, (e) => !ownedByLiveWait(e, waits));
				if (mail.length > 0) {
					console.log(renderMail(self, mail));
					const note = unreadableNote(mailbox, self);
					if (note !== undefined) console.log(note);
					console.log(
						`peer-link: handle the mail above, then start the watch again (Bash run_in_background): \`${watchCommand(self)}\``,
					);
					return 0;
				}
			}
			Bun.sleepSync(WAIT_POLL_MS);
		}
	} finally {
		removeWatchRecord(mailbox, self);
	}
}

/**
 * The listed peers a send addresses, as canonical names, and whether it is a
 * broadcast. `*` is every broadcast target; a comma-separated list is one
 * recipient per distinct name. A single name is a direct send.
 */
function recipientsOf(
	listed: readonly PeerInfo[],
	self: string,
	spec: string,
	requireOnline: boolean,
): { names: string[]; broadcast: boolean } {
	if (spec === "*") {
		const names = broadcastTargets(listed, self, requireOnline).map((p) => p.name);
		if (names.length === 0) {
			throw new Error(
				requireOnline
					? `send: * has no online pi peer besides ${self} (--require-online)`
					: `send: * has no targets: no online or external peer besides ${self}`,
			);
		}
		return { names, broadcast: true };
	}
	const names = [
		...new Set(spec.split(",").map((part) => resolvePeerAddressAmong(listed, sanitizePeerName(part)))),
	];
	return { names, broadcast: names.length > 1 };
}

function send(args: string[]): void {
	let from: string | undefined;
	let expectReply = false;
	let requireOnline = false;
	let waitMinutes: number | undefined;
	const rest: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--from") from = args[++i];
		else if (a === "--reply") expectReply = true;
		else if (a === "--require-online") requireOnline = true;
		else if (a === "--wait") waitMinutes = parseWaitMinutes(args[++i]);
		else rest.push(a);
	}
	if (!from || rest.length < 2) {
		throw new Error("usage: send --from <name> [--reply] [--require-online] [--wait <minutes>] <to> <text | ->");
	}
	// A wait on a peer that is not online is pointless: fail before sending.
	if (waitMinutes !== undefined) requireOnline = true;
	const sender = sanitizePeerName(from);
	const text = rest[1] === "-" && rest.length === 2 ? readStdin().trim() : rest.slice(1).join(" ");
	if (!text) throw new Error("send: empty message");
	const mailbox = mailboxRoot();
	const listed = listPeers(mailbox);
	if (!listed.some((p) => p.name === sender && p.external)) {
		throw new Error(`send: "${sender}" is not a registered external peer (did the SessionStart hook run?)`);
	}
	const { names, broadcast } = recipientsOf(listed, sender, rest[0], requireOnline);
	if (broadcast && waitMinutes !== undefined) {
		throw new Error("send: --wait takes one recipient, not a list or *");
	}
	// Every recipient passes the gate before any envelope is written.
	const gated = names.map((to) => {
		const decision = deliveryDecision(to, listed, requireOnline);
		if (!decision.ok) throw new Error(`send: ${decision.reason}`);
		return { to, status: queuedStatus(decision) };
	});
	const envelopes = gated.map((g) => newEnvelope(sender, g.to, text, expectReply, undefined, "steer", broadcast));
	// Registered before the send, so a reply that lands at once is already owned.
	const waitFile =
		waitMinutes === undefined
			? undefined
			: writeWait(mailbox, sender, { to: envelopes[0].to, sentAt: envelopes[0].sentAt, pid: process.pid });
	try {
		envelopes.forEach((envelope, i) => {
			sendEnvelope(mailbox, envelope);
			console.log(`sent to ${envelope.to} (${gated[i].status})`);
		});
		if (waitMinutes !== undefined) {
			process.exitCode = waitForReply(mailbox, sender, envelopes[0].to, envelopes[0].sentAt, waitMinutes);
		}
	} finally {
		if (waitFile !== undefined) removeWait(waitFile);
	}
}

function list(): void {
	const peers = listPeers(mailboxRoot());
	if (peers.length === 0) console.log("no peers listed");
	for (const p of peers) {
		const where = p.sessionFile ? ` — ${p.sessionFile}` : p.cwd ? ` — ${p.cwd}` : "";
		console.log(`${p.name} (${peerStatus(p)})${where}`);
	}
}

if (import.meta.main) {
	const [cmd, ...args] = process.argv.slice(2);
	try {
		if (cmd === "hook") hook(args[0]);
		else if (cmd === "send") send(args);
		else if (cmd === "watch") process.exitCode = watch(args);
		else if (cmd === "list") list();
		else throw new Error("usage: external.ts <hook <event> | send … | watch --from <name> | list>");
	} catch (err) {
		console.error(`peer-link external: ${(err as Error).message}`);
		process.exit(1);
	}
}
