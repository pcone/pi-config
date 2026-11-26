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
 *   external.ts list
 *
 * Mail is read only inside a hook the user's prompt fired, or by a reply-wait
 * (`send --wait`, run in background). A reply-wait's exit may start a turn;
 * nothing else here does. Why: docs/design/peer-link-external.md, decision 012.
 * Delivery is at-most-once: each envelope is deleted by the one path that reads it.
 */

import * as fs from "node:fs";
import {
	type Envelope,
	claimIncoming,
	deliveryDecision,
	ensureMailbox,
	listPeers,
	mailboxRoot,
	newEnvelope,
	peerStatus,
	queuedStatus,
	removeHeartbeat,
	resolvePeerAddressAmong,
	sanitizePeerName,
	sendEnvelope,
	writeHeartbeat,
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
			const re = e.inReplyTo ? ` (reply to ${e.inReplyTo})` : "";
			return `[peer:${e.from}]${re} ${e.text}${reply}`;
		});
	return `peer-link mail for ${self} (${envelopes.length}):\n\n${blocks.join("\n\n")}`;
}

function sendUsage(self: string, to = "<peer>"): string {
	return `bun ${SELF} send --from ${self} ${to} '<text>'`;
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
					"`--require-online` fails instead of queueing; `--wait <minutes>` (run in background) waits for the peer's reply). " +
					`List peers: \`bun ${SELF} list\`.`,
			);
			return;
		case "prompt": {
			register(mailbox, self, input.cwd);
			const envelopes = claimIncoming(mailbox, self);
			if (envelopes.length === 0) return;
			emitContext("UserPromptSubmit", renderMail(self, envelopes));
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
	from = sanitizePeerName(from);
	const text = rest[1] === "-" && rest.length === 2 ? readStdin().trim() : rest.slice(1).join(" ");
	if (!text) throw new Error("send: empty message");
	const mailbox = mailboxRoot();
	const listed = listPeers(mailbox);
	if (!listed.some((p) => p.name === from && p.external)) {
		throw new Error(`send: "${from}" is not a registered external peer (did the SessionStart hook run?)`);
	}
	const to = resolvePeerAddressAmong(listed, sanitizePeerName(rest[0]));
	const decision = deliveryDecision(to, listed, requireOnline);
	if (!decision.ok) throw new Error(`send: ${decision.reason}`);
	const envelope = newEnvelope(from, to, text, expectReply);
	sendEnvelope(mailbox, envelope);
	console.log(`sent to ${to} (${queuedStatus(decision)})`);
	if (waitMinutes !== undefined) {
		process.exitCode = waitForReply(mailbox, from, to, envelope.sentAt, waitMinutes);
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
		else if (cmd === "list") list();
		else throw new Error("usage: external.ts <hook <event> | send … | list>");
	} catch (err) {
		console.error(`peer-link external: ${(err as Error).message}`);
		process.exit(1);
	}
}
