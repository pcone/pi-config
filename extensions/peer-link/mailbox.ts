/**
 * Pure file-system layer for the peer-link extension.
 *
 * A mailbox directory holds one subdirectory per peer. Peers publish a
 * heartbeat to `_peers/<name>.json` so others can discover who is online;
 * messages are envelope files dropped into the recipient's subdirectory.
 * Reading an inbox is non-destructive; the receiver acks (deletes) each
 * envelope only after successfully injecting it. Delivery is therefore
 * at-least-once across restarts: a crash between injection and ack can
 * duplicate a message, and a duplicate is preferable to a loss. A message
 * sent to a listed peer while it is offline just sits in its inbox until the
 * peer's next scan. (Senders gate on this: peer-link fails sends to names
 * that match no listed peer.)
 *
 * External peers (a non-pi tool, e.g. a Claude Code session via
 * `external.ts`) register a heartbeat with `external: true` and are read by
 * their prompt hook or their watch, not by a poll. They are listed but never
 * online, and age out after EXTERNAL_TTL_MS instead of the pi window.
 * See docs/design/peer-link-external.md.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export const ONLINE_MS = 30_000; // heartbeat freshness window for "online"
export const HEARTBEAT_MS = 5_000; // heartbeat publish interval
export const SCAN_MS = 2_000; // inbox poll interval (fs.watch is an accelerator)
export const EXTERNAL_TTL_MS = 24 * 60 * 60 * 1000; // external registration lifetime since last refresh

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
	/** Set by the sender: true on each copy of a fan-out (`*` or a list). Broadcasts never wake a watch (decision external-tools/014). */
	broadcast: boolean;
}

export interface PeerInfo {
	name: string;
	sessionFile?: string;
	cwd?: string;
	ts: number;
	autoreply?: boolean;
	/** Registered by a non-pi tool; reads its inbox only when its user prompts. */
	external?: boolean;
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
	writeFileAtomic(file, JSON.stringify(envelope, null, 2));
	return file;
}

/**
 * Write a file so a reader never parses a partial one: write a temp file whose
 * name the readers skip (no `.json` suffix), then rename it into place.
 */
function writeFileAtomic(file: string, text: string): void {
	const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp`);
	fs.writeFileSync(tmp, text, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

function isEnvelope(value: unknown): value is Envelope {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.id === "string" &&
		typeof v.from === "string" &&
		typeof v.to === "string" &&
		typeof v.text === "string" &&
		typeof v.sentAt === "number" &&
		typeof v.broadcast === "boolean"
	);
}

/**
 * A peer's inbox: valid envelopes with their files, and the files that are
 * not valid envelopes. Unreadable files are left in place for manual inspection.
 */
export function scanInbox(
	mailbox: string,
	name: string,
): { valid: { file: string; envelope: Envelope }[]; unreadable: string[] } {
	const dir = inboxDir(mailbox, name);
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return { valid: [], unreadable: [] };
	}
	const valid: { file: string; envelope: Envelope }[] = [];
	const unreadable: string[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const file = path.join(dir, entry);
		let envelope: unknown;
		try {
			envelope = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch {
			unreadable.push(file);
			continue;
		}
		if (!isEnvelope(envelope)) {
			unreadable.push(file);
			continue;
		}
		valid.push({ file, envelope });
	}
	return { valid, unreadable };
}

/**
 * Read all valid envelopes in a peer's inbox without consuming them.
 *
 * Non-destructive by design: the caller must call ackEnvelope() only after
 * the envelope has been delivered. This trades at-most-once for at-least-once
 * — an envelope read but not acked is retried (and may duplicate) rather than
 * silently dropped. Unreadable files are left in place for manual inspection.
 */
export function readIncoming(mailbox: string, name: string): Envelope[] {
	return scanInbox(mailbox, name).valid.map((s) => s.envelope);
}

/**
 * Read and delete the envelopes in a peer's inbox that `accept` takes. Each
 * envelope goes to exactly one caller: unlink is atomic, and a caller that
 * finds the file already gone skips it. At-most-once by design: a caller that
 * dies after claiming loses the mail (decision external-tools/012, owner
 * 2026-11-26).
 */
export function claimIncoming(
	mailbox: string,
	name: string,
	accept: (e: Envelope) => boolean = () => true,
): Envelope[] {
	const claimed: Envelope[] = [];
	for (const { file, envelope } of scanInbox(mailbox, name).valid) {
		if (!accept(envelope)) continue;
		try {
			fs.unlinkSync(file);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // another reader claimed it
			throw err;
		}
		claimed.push(envelope);
	}
	return claimed;
}

/**
 * Acknowledge (delete) an envelope after it has been successfully delivered.
 * Idempotent: an already-removed file is not an error. The filename matches
 * sendEnvelope's `${from}-${id}.json` convention.
 */
export function ackEnvelope(mailbox: string, name: string, env: Envelope): void {
	try {
		fs.unlinkSync(path.join(inboxDir(mailbox, name), `${env.from}-${env.id}.json`));
	} catch {
		// already acked (or vanished) — nothing to do
	}
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
			info.online = !info.external && now - info.ts <= ONLINE_MS;
			peers.push(info);
		} catch {
			// ignore corrupt heartbeat
		}
	}
	return peers;
}

/**
 * The peers online now, excluding this session: the broadcast target list.
 *
 * Both callers mean exactly this — `peer_send`'s `to: "*"` arm and the
 * model-error mail's recipient fallback — and the self exclusion is the part
 * worth having one home: a session addressed as its own recipient gets its
 * own message back as an injected user message.
 */
export function onlineExcept(peers: readonly PeerInfo[], self: string): PeerInfo[] {
	return peers.filter((peer) => peer.online && peer.name !== self);
}

/**
 * The peers a `*` send reaches, minus self: online pi peers and listed external
 * peers. With requireOnline, online pi peers only, since an external peer is
 * never online (decision external-tools/014 § Send and § 7). Both senders
 * (pi's peer_send, external.ts send) throw on zero targets when requireOnline is set.
 */
export function broadcastTargets(peers: readonly PeerInfo[], self: string, requireOnline: boolean): PeerInfo[] {
	return peers.filter(
		(peer) => peer.name !== self && (requireOnline ? peer.online : peer.online || peer.external),
	);
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
 * unchanged when no listed peer matches; the send-side delivery gate then
 * rejects it rather than queueing into an unread inbox.
 *
 * The full name ends with the UUID, so a tail matches via `endsWith`; the
 * length guard avoids ambiguous short-substring matches. When several listed
 * peers share a tail (same session id under two file names — resume/fork),
 * prefer the online one, then the freshest heartbeat: that is the live
 * reader of that identity's inbox.
 */
export function resolvePeerAddressAmong(listed: PeerInfo[], to: string): string {
	const exact = listed.find((p) => p.name === to);
	if (exact) return exact.name;
	if (to.length >= 8) {
		const matches = listed
			.filter((p) => p.name.endsWith(to))
			.sort((a, b) => Number(b.online) - Number(a.online) || b.ts - a.ts);
		if (matches[0]) return matches[0].name;
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
			const ttl = info.external ? EXTERNAL_TTL_MS : ONLINE_MS * 4;
			if (now - info.ts > ttl) fs.unlinkSync(path.join(dir, entry));
		} catch {
			// leave unreadable files alone
		}
	}
}

/**
 * Delivery gate for a direct send. Fails when the target is not a listed peer
 * (regardless of requireOnline — queueing to an unlisted name creates a
 * phantom inbox), and when the target is not online with requireOnline set
 * (an external peer never is). Otherwise ok, with the target's status.
 * Broadcast uses its own zero-targets check (different shape).
 */
export function deliveryDecision(
	to: string,
	peers: readonly { name: string; online: boolean; external?: boolean }[],
	requireOnline: boolean,
): { ok: true; online: boolean; external: boolean } | { ok: false; reason: string } {
	const known = peers.find((p) => p.name === to);
	if (!known) {
		const names = peers.map((p) => `${p.name} (${peerStatus(p)})`);
		const shown =
			names.slice(0, 6).join(", ") + (names.length > 6 ? `, … +${names.length - 6} more` : "");
		return {
			ok: false,
			reason:
				`peer "${to}" is not listed — not queued (no heartbeat matches that name; ` +
				`queueing it would land in an inbox nobody reads). Known peers: ${shown || "none"}. ` +
				`Call peer_list — offline peers age out of the registry ~2min after their last heartbeat.`,
		};
	}
	if (requireOnline && !known.online) {
		const why = known.external ? "is external (not online: its mail is read at its next prompt or by its watch)" : "is offline";
		return { ok: false, reason: `peer "${to}" ${why} and requireOnline is set — not queued` };
	}
	return { ok: true, online: known.online, external: known.external ?? false };
}

export function peerStatus(p: { online?: boolean; external?: boolean }): string {
	if (p.external) return "external";
	return p.online ? "online" : "offline";
}

/** What a sender is told about where its message went. */
export function queuedStatus(d: { online: boolean; external: boolean }): string {
	if (d.online) return "online";
	if (d.external) return "queued — external peer";
	return "queued for when it is online";
}

/** Build a fresh envelope (convenience for callers). A direct send is not a broadcast. */
export function newEnvelope(
	from: string,
	to: string,
	text: string,
	expectReply = false,
	inReplyTo?: string,
	deliverAs: "steer" | "followUp" = "steer",
	broadcast = false,
): Envelope {
	return { id: randomUUID(), from, to, text, expectReply, inReplyTo, deliverAs, sentAt: Date.now(), broadcast };
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

// ---------------------------------------------------------------------------
// Per-peer bookkeeping that is not mail
//
// `_state/` holds one small file per peer identity. Nothing here is ever read
// as an envelope: the inbox scan reads the peer's own directory, the registry
// reads `_peers/`. Keeping the state out of the inbox is what stops it being
// scanned 30× a minute and skipped.
// ---------------------------------------------------------------------------

/** Directory for per-peer non-mail state. Created on first write. */
export function stateDir(mailbox: string): string {
	return path.join(mailbox, "_state");
}

function stateFile(mailbox: string, name: string): string {
	return path.join(stateDir(mailbox), `${sanitizePeerName(name)}.json`);
}

/**
 * The sender of the newest envelope this session delivered, or undefined.
 *
 * Persisted so a restart keeps the address the next model-error mail goes to
 * (decision external-tools/008: the recipient is the last correspondent).
 * An unreadable or malformed record reads as "no correspondent".
 */
export function readLastCorrespondent(mailbox: string, name: string): string | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(stateFile(mailbox, name), "utf8")) as {
			from?: unknown;
		};
		return typeof parsed.from === "string" && parsed.from ? parsed.from : undefined;
	} catch {
		return undefined;
	}
}

/** Record the newest delivered envelope's sender. Throws only on a bad peer name. */
export function writeLastCorrespondent(mailbox: string, name: string, from: string): void {
	const file = stateFile(mailbox, name);
	fs.mkdirSync(stateDir(mailbox), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, JSON.stringify({ from, at: Date.now() }, null, 2), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Live reply-waits and the watch (decision external-tools/014)
//
// Both are pid-keyed records under `_state/`. A record whose pid is dead is
// stale and is deleted when it is read.
// ---------------------------------------------------------------------------

/** Whether a process is alive. EPERM means it is alive under another user. */
export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function unlinkIfPresent(file: string): void {
	try {
		fs.unlinkSync(file);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
}

function readJsonIfPresent(file: string): unknown | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
}

/** A reply-wait this peer is running: it waits for mail from `to` sent at or after `sentAt`. */
export interface Wait {
	to: string;
	sentAt: number;
	pid: number;
}

function waitsDir(mailbox: string, name: string): string {
	return path.join(stateDir(mailbox), `${sanitizePeerName(name)}.waits`);
}

/** Record a reply-wait before its send. Returns the record's file for removeWait. */
export function writeWait(mailbox: string, name: string, wait: Wait): string {
	const dir = waitsDir(mailbox, name);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = path.join(dir, `${wait.pid}.json`);
	writeFileAtomic(file, JSON.stringify(wait, null, 2));
	return file;
}

export function removeWait(file: string): void {
	unlinkIfPresent(file);
}

/** The live reply-waits of a peer. Records of dead pids are deleted here. */
export function liveWaits(mailbox: string, name: string): Wait[] {
	const dir = waitsDir(mailbox, name);
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
	const waits: Wait[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const file = path.join(dir, entry);
		const wait = readJsonIfPresent(file) as Wait | undefined;
		if (wait === undefined) continue;
		if (!pidAlive(wait.pid)) {
			unlinkIfPresent(file);
			continue;
		}
		waits.push(wait);
	}
	return waits;
}

/** Whether a live reply-wait owns the envelope: sent by its target at or after the wait's send. */
export function ownedByLiveWait(envelope: Envelope, waits: readonly Wait[]): boolean {
	return waits.some((w) => envelope.from === w.to && envelope.sentAt >= w.sentAt);
}

/** The watch record: the pid of the one live `watch` for a peer. */
export interface WatchRecord {
	pid: number;
	startedAt: number;
	/** The watch's parent at start. A change means the parent is gone and the watch is orphaned. */
	ppid: number;
}

function watchFile(mailbox: string, name: string): string {
	return path.join(stateDir(mailbox), `${sanitizePeerName(name)}.watch.json`);
}

/** The pid of the live watch for a peer, or undefined. A dead pid's record is deleted. */
export function liveWatchPid(mailbox: string, name: string): number | undefined {
	const file = watchFile(mailbox, name);
	const record = readJsonIfPresent(file) as WatchRecord | undefined;
	if (record === undefined) return undefined;
	if (pidAlive(record.pid)) return record.pid;
	unlinkIfPresent(file);
	return undefined;
}

export function writeWatchRecord(mailbox: string, name: string, record: WatchRecord): void {
	fs.mkdirSync(stateDir(mailbox), { recursive: true, mode: 0o700 });
	writeFileAtomic(watchFile(mailbox, name), JSON.stringify(record, null, 2));
}

export function removeWatchRecord(mailbox: string, name: string): void {
	unlinkIfPresent(watchFile(mailbox, name));
}
