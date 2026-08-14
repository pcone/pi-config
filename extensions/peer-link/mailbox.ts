/**
 * Pure file-system layer for the peer-link extension.
 *
 * A mailbox directory holds one subdirectory per peer. Peers publish a
 * heartbeat to `_peers/<name>.json` so others can discover who is online;
 * messages are envelope files dropped into the recipient's subdirectory.
 * Envelopes are consumed on read (deleted), which makes delivery
 * at-most-once across restarts: a message sent while the peer is offline
 * just sits in its inbox until the next scan.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export const ONLINE_MS = 30_000; // heartbeat freshness window for "online"
export const HEARTBEAT_MS = 5_000; // heartbeat publish interval
export const SCAN_MS = 2_000; // inbox poll interval (fs.watch is an accelerator)

export interface Envelope {
	id: string;
	from: string;
	to: string;
	text: string;
	expectReply: boolean;
	/** How the receiver injects this: "steer" (next turn boundary, default) or "followUp" (wait until agent idle). Reply-requested messages ignore this and always pivot via followUp. */
	deliverAs?: "steer" | "followUp";
	inReplyTo?: string;
	sentAt: number;
}

export interface PeerInfo {
	name: string;
	sessionFile?: string;
	cwd?: string;
	ts: number;
	autoreply?: boolean;
	online?: boolean;
}

export function defaultMailboxRoot(): string {
	return path.join(os.homedir(), CONFIG_DIR_NAME, "peer-mail");
}

export function mailboxRoot(env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env.PI_PEER_MAILBOX?.trim();
	return explicit || defaultMailboxRoot();
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Peer names become directory/file names; keep them filesystem-safe. */
export function sanitizePeerName(name: string): string {
	const trimmed = name.trim();
	if (!NAME_RE.test(trimmed)) {
		throw new Error(
			`Invalid peer name ${JSON.stringify(trimmed)}: use 1-64 chars of [A-Za-z0-9._-]`,
		);
	}
	return trimmed;
}

export function ownPeerName(env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env.PI_PEER_NAME?.trim();
	if (explicit) return sanitizePeerName(explicit);
	return `${os.hostname()}-${process.pid}`;
}

/**
 * Full peer-identity chain: PI_PEER_NAME → session display name (--name) →
 * session file basename → hostname-pid. Pure; exported for unit tests.
 *
 * The display-name fallback lets `pi --name bug-triage` identify the session
 * as "bug-triage" WITHOUT PI_PEER_NAME. sanitizePeerName rejects human-readable
 * names (spaces, punctuation), so only name-shaped display names qualify —
 * casual names like "Refactor auth" fall through to the filename, which keeps
 * the display-label-vs-routing-key distinction intact.
 */
export function peerIdentityFrom(
	env: NodeJS.ProcessEnv,
	sessionName: string | undefined,
	sessionFile: string | undefined,
): string {
	const explicit = env.PI_PEER_NAME?.trim();
	if (explicit) {
		try {
			return sanitizePeerName(explicit);
		} catch {
			/* invalid explicit name — fall through */
		}
	}
	const name = sessionName?.trim();
	if (name) {
		try {
			return sanitizePeerName(name);
		} catch {
			/* not a valid peer name (e.g. has spaces) — fall through */
		}
	}
	if (sessionFile) {
		const base = path.basename(sessionFile).replace(/\.jsonl?$/, "");
		try {
			return sanitizePeerName(base);
		} catch {
			/* fall through to pid identity */
		}
	}
	return `${os.hostname()}-${process.pid}`;
}

export function inboxDir(mailbox: string, name: string): string {
	return path.join(mailbox, sanitizePeerName(name));
}

export function peersDir(mailbox: string): string {
	return path.join(mailbox, "_peers");
}

export function ensureMailbox(mailbox: string, name: string): void {
	fs.mkdirSync(inboxDir(mailbox, name), { recursive: true, mode: 0o700 });
	fs.mkdirSync(peersDir(mailbox), { recursive: true, mode: 0o700 });
}

export function sendEnvelope(mailbox: string, envelope: Envelope): string {
	const dir = inboxDir(mailbox, envelope.to);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = path.join(dir, `${envelope.from}-${envelope.id}.json`);
	fs.writeFileSync(file, JSON.stringify(envelope, null, 2), { mode: 0o600 });
	return file;
}

function isEnvelope(value: unknown): value is Envelope {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.id === "string" &&
		typeof v.from === "string" &&
		typeof v.to === "string" &&
		typeof v.text === "string" &&
		typeof v.sentAt === "number"
	);
}

/** Read and consume (delete) all valid envelopes in a peer's inbox. */
export function readIncoming(mailbox: string, name: string): Envelope[] {
	const dir = inboxDir(mailbox, name);
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const envelopes: Envelope[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const file = path.join(dir, entry);
		let envelope: unknown;
		try {
			envelope = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch {
			continue; // leave unreadable files for manual inspection
		}
		if (!isEnvelope(envelope)) continue;
		try {
			fs.unlinkSync(file);
		} catch {
			continue; // another consumer won the race; it will deliver
		}
		envelopes.push(envelope);
	}
	return envelopes;
}

export function writeHeartbeat(mailbox: string, info: PeerInfo): void {
	const dir = peersDir(mailbox);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = path.join(dir, `${sanitizePeerName(info.name)}.json`);
	fs.writeFileSync(file, JSON.stringify(info, null, 2), { mode: 0o600 });
}

export function removeHeartbeat(mailbox: string, name: string): void {
	try {
		fs.unlinkSync(path.join(peersDir(mailbox), `${sanitizePeerName(name)}.json`));
	} catch {
		// already gone
	}
}

export function listPeers(mailbox: string, now = Date.now()): PeerInfo[] {
	const dir = peersDir(mailbox);
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const peers: PeerInfo[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		try {
			const info = JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8")) as PeerInfo;
			if (typeof info.name !== "string") continue;
			info.online = now - info.ts <= ONLINE_MS;
			peers.push(info);
		} catch {
			// ignore corrupt heartbeat
		}
	}
	return peers;
}

/**
 * Resolve a `to` address to a listed peer's canonical announced name.
 *
 * Peer names are the full session-filename identity (e.g.
 * `2026-08-12T00-34-37-476Z_019ff364-…`), but callers — especially agents
 * using peer_send — often address by the UUID tail (`019ff364-…`). Without
 * resolution a tail-addressed envelope lands in a phantom `<tail>` inbox the
 * recipient never reads (its consumeInbox reads its full-name inbox) and the
 * online check reports "queued for when it is online" even though peer_list
 * shows the peer online. This resolves either form to the listed peer's
 * actual announced name so the envelope + online check agree. Returns `to`
 * unchanged when no listed peer matches (genuinely unknown/offline → queued).
 *
 * The full name ends with the UUID, so a tail matches via `endsWith`; the
 * length guard avoids ambiguous short-substring matches.
 */
export function resolvePeerAddressAmong(listed: PeerInfo[], to: string): string {
	const exact = listed.find((p) => p.name === to);
	if (exact) return exact.name;
	if (to.length >= 8) {
		const byTail = listed.find((p) => p.name.endsWith(to));
		if (byTail) return byTail.name;
	}
	return to;
}

/** Remove heartbeat files not refreshed for a while, so dead peers age out. */
export function sweepStalePeers(mailbox: string, now = Date.now()): void {
	const dir = peersDir(mailbox);
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		try {
			const info = JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8")) as PeerInfo;
			if (now - info.ts > ONLINE_MS * 4) fs.unlinkSync(path.join(dir, entry));
		} catch {
			// leave unreadable files alone
		}
	}
}

/** Build a fresh envelope (convenience for callers). */
export function newEnvelope(
	from: string,
	to: string,
	text: string,
	expectReply = false,
	inReplyTo?: string,
	deliverAs: "steer" | "followUp" = "steer",
): Envelope {
	return { id: randomUUID(), from, to, text, expectReply, inReplyTo, deliverAs, sentAt: Date.now() };
}

/**
 * How an inbound envelope is injected into this session.
 *
 * `steer` lands at the next tool-call boundary (sooner, but the agent weaves
 * the message into its current turn). `followUp` waits for the agent to finish
 * all in-flight work — a clean turn pivot. One-way messages default to `steer`
 * for liveness; an explicit `deliverAs: "followUp"` opts into wait-until-idle
 * for messages that must not interrupt in-flight work. Reply-requested messages
 * (`expectReply: true`) ALWAYS pivot via `followUp` regardless of `deliverAs`:
 * the auto-reply slicer anchors the response at the injected message and only
 * produces a clean reply from a discrete pivot, not from a steer interleaved
 * with whatever the agent was mid-turn on.
 */
export function deliveryModeFor(env: Envelope): "steer" | "followUp" {
	if (env.expectReply) return "followUp";
	return env.deliverAs === "followUp" ? "followUp" : "steer";
}
