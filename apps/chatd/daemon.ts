/**
 * chatd: the homeserver's application service and the local sessions' one
 * door to it (docs/design/chat.md). One puppet per peer; one Unix socket for
 * local clients; one appservice endpoint for the homeserver's transactions.
 *
 * State lives on the homeserver: membership, `m.direct`, notification levels
 * and `dev.pi.pushed` (the pushed-delivery marker). What chatd holds in memory
 * is the registry of live connections, their push queues and the live waits,
 * all rebuilt from the homeserver and the clients after a restart.
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, statSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { type Level, type PeerKind, type Recipient, bodyMentions, classify } from "./classify.ts";
import type { Config } from "./config.ts";
import { Homeserver, HomeserverError, type MatrixEvent } from "./matrix.ts";
import { SYSTEM_LOCALPART, SYSTEM_NAME, localOf, localpart, peerName, userId, validatePeerName } from "./names.ts";
import {
	ChatError,
	type ClientKind,
	type Hello,
	type HelloResult,
	type PeerEntry,
	type Pushed,
	WAITING_TYPES,
	type WaitResult,
} from "./protocol.ts";

const DAY_MS = 86_400_000;
export const PRESENCE_PASS_MS = 30_000;
export const MIRROR_SWEEP_MS = 3_600_000;
export const MIRROR_KEEP_MS = 7 * DAY_MS;
export const CERT_MIN_DAYS = 20;

export interface Deps {
	now?: () => number;
	/** The homeserver certificate's notAfter. */
	checkCertificate: () => Promise<Date>;
	log?: (line: string) => void;
	/** Test seam: runs after a mirror copy is posted, before the transaction is answered. */
	afterMirrorCopy?: () => void;
}

interface Conn {
	id: number;
	socket: Socket;
	reg?: Registration;
	closed: boolean;
	send(msg: unknown): void;
}

interface Queued {
	event: MatrixEvent;
	pushed: Pushed;
}

interface Registration {
	peer: string;
	userId: string;
	kind: ClientKind;
	session: string;
	cwd: string;
	model?: string;
	claudePid?: number;
	displayName: string;
	conn?: Conn;
	queue: Queued[];
	/** Event ids a reply-wait handed to its waiter; hidden from prompt and watch until acked. */
	claimed: Set<string>;
	mdirect: Record<string, string[]>;
	directRooms: Set<string>;
	rooms: Set<string>;
	levels: Map<string, Level>;
	syncing: boolean;
	buffer: MatrixEvent[];
	watch?: { conn: Conn; id: number };
	notified: Set<string>;
	lastCorrespondent?: string;
}

interface WaitRec {
	conn: Conn;
	id: number;
	waiter: Registration;
	ask: string;
	room: string;
	askTs: number;
	target?: string;
	minutes?: number;
	timer?: ReturnType<typeof setTimeout>;
}

function sha(s: string): Buffer {
	return createHash("sha256").update(s).digest();
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** The repo a cwd belongs to: the nearest directory holding `.git`, else the cwd itself. */
function repoName(cwd: string): string {
	let dir = cwd;
	for (;;) {
		if (existsSync(join(dir, ".git"))) return basename(dir);
		const up = dirname(dir);
		if (up === dir) return basename(cwd) || "session";
		dir = up;
	}
}

export class Chatd {
	readonly hs: Homeserver;
	private readonly now: () => number;
	private readonly log: (line: string) => void;
	private readonly systemUser: string;
	private regs = new Map<string, Registration>();
	private waits = new Set<WaitRec>();
	private processed = new Set<string>();
	private kinds = new Map<string, PeerKind>();
	private roomLabels = new Map<string, string>();
	private dmPairs = new Map<string, [string, string] | null>();
	private encryptedNotified = new Set<string>();
	private systemDirect: Record<string, string[]> = {};
	/** Matrix presence chatd wants per puppet, and whether the last write landed. */
	private presence = new Map<string, { want: "online" | "offline"; status: string; written?: string }>();
	private dailyDms = new Map<string, number>();
	private connSeq = 0;
	private conns = new Set<Conn>();
	peersRoom = "";
	mirrorRoom = "";
	private http?: ReturnType<typeof Bun.serve>;
	private server?: Server;
	private timers: ReturnType<typeof setInterval>[] = [];

	constructor(
		readonly config: Config,
		private readonly deps: Deps,
	) {
		this.hs = new Homeserver(config.homeserver, config.asToken);
		this.now = deps.now ?? Date.now;
		this.log = deps.log ?? ((line) => console.error(line));
		this.systemUser = userId(SYSTEM_LOCALPART, config.serverName);
		this.kinds.set(this.systemUser, "system");
	}

	// ── lifecycle ─────────────────────────────────────────────────────────

	async start(): Promise<void> {
		await this.claimSocket();
		await this.hs.register(SYSTEM_LOCALPART);
		await this.hs.setDisplayName(this.systemUser, "pi-system");
		await this.hs.setProfileField(this.systemUser, "dev.pi.kind", "system");
		this.systemDirect = (await this.hs.accountData<Record<string, string[]>>(this.systemUser, "m.direct")) ?? {};
		this.peersRoom = await this.ownedRoom("peers", [this.config.owner]);
		this.mirrorRoom = await this.ownedRoom("dm-mirror", [this.config.owner]);
		this.http = Bun.serve({
			hostname: this.config.listen.host,
			port: this.config.listen.port,
			fetch: (req) => this.onHttp(req),
		});
		await this.listenSocket();
		this.timers.push(setInterval(() => void this.presencePass(), PRESENCE_PASS_MS));
		this.timers.push(setInterval(() => void this.sweepMirror(), MIRROR_SWEEP_MS));
		this.timers.push(setInterval(() => void this.certificateWatch(), DAY_MS));
		void this.certificateWatch();
		this.log(`chatd: listening on ${this.config.socket} and ${this.config.listen.host}:${this.config.listen.port}`);
	}

	async stop(): Promise<void> {
		for (const t of this.timers) clearInterval(t);
		this.http?.stop(true);
		for (const c of this.conns) c.socket.destroy();
		await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
	}

	/** Find a room chatd owns by its alias, or create it as `@pi-system`. Never encrypted (015/29). */
	private async ownedRoom(alias: string, invite: string[]): Promise<string> {
		const full = `#${alias}:${this.config.serverName}`;
		const found = await this.hs.resolveAlias(full);
		if (found) return found;
		const room = await this.hs.createRoom(this.systemUser, {
			room_alias_name: alias,
			name: alias,
			preset: "private_chat",
			invite,
		});
		this.log(`chatd: created ${full}`);
		return room;
	}

	private async claimSocket(): Promise<void> {
		const path = this.config.socket;
		if (!existsSync(path)) return;
		const live = await new Promise<boolean>((resolve) => {
			const s = createConnection(path);
			s.once("connect", () => {
				s.destroy();
				resolve(true);
			});
			s.once("error", () => resolve(false));
		});
		if (live) throw new Error(`chatd: something listens on ${path}; another chatd runs`);
		if (!statSync(path).isSocket()) throw new Error(`chatd: ${path} exists and is not a socket`);
		unlinkSync(path);
	}

	private listenSocket(): Promise<void> {
		this.server = createServer((socket) => this.onConnection(socket));
		const old = process.umask(0o177);
		return new Promise((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(this.config.socket, () => {
				process.umask(old);
				chmodSync(this.config.socket, 0o600);
				resolve();
			});
		});
	}

	// ── the appservice endpoint ──────────────────────────────────────────

	private authorized(req: Request, url: URL): boolean {
		const header = req.headers.get("authorization");
		const given = header?.startsWith("Bearer ") ? header.slice(7) : url.searchParams.get("access_token");
		if (!given) return false;
		return timingSafeEqual(sha(given), sha(this.config.hsToken));
	}

	private async onHttp(req: Request): Promise<Response> {
		const url = new URL(req.url);
		if (!this.authorized(req, url)) {
			this.log(`chatd: refused ${req.method} ${url.pathname}: bad or missing hs_token`);
			return Response.json({ errcode: "M_FORBIDDEN" }, { status: 403 });
		}
		const m = /^\/_matrix\/app\/v1\/transactions\/([^/]+)$/.exec(url.pathname);
		if (req.method === "PUT" && m) {
			const body = (await req.json()) as { events?: MatrixEvent[] };
			try {
				for (const e of body.events ?? []) {
					if (this.processed.has(e.event_id)) continue;
					await this.onEvent(e);
					this.processed.add(e.event_id);
				}
				return Response.json({});
			} catch (err) {
				this.log(`chatd: transaction ${m[1]} failed, homeserver will redeliver: ${(err as Error).message}`);
				return Response.json({ errcode: "M_UNKNOWN" }, { status: 500 });
			}
		}
		if (url.pathname === "/_matrix/app/v1/ping") return Response.json({});
		return Response.json({ errcode: "M_NOT_FOUND" }, { status: 404 });
	}

	private joins = new Set<string>();

	/** Resolves once a transaction carried `user`'s join of `room`. */
	private async joinSeen(room: string, user: string): Promise<void> {
		const deadline = Date.now() + 15_000;
		while (!this.joins.has(`${room}|${user}`)) {
			if (Date.now() > deadline) throw new ChatError(`the homeserver did not deliver ${user}'s join of ${room} within 15 s`, "homeserver");
			await Bun.sleep(10);
		}
	}

	/** Every event of a transaction, push or not. A throw answers 500 (redelivery). */
	private async onEvent(e: MatrixEvent): Promise<void> {
		if (e.type === "m.room.member" && e.content.membership === "join") this.joins.add(`${e.room_id}|${e.state_key}`);
		if (e.type === "m.room.member") await this.onMember(e);
		if (e.type === "m.room.encrypted") await this.onEncrypted(e);
		if (e.type === "m.room.message") await this.mirror(e);
		for (const reg of this.regs.values()) {
			if (reg.syncing) {
				reg.buffer.push(e);
				continue;
			}
			const invited = e.type === "m.room.member" && e.state_key === reg.userId;
			if (reg.rooms.has(e.room_id) || invited) await this.offer(reg, e);
		}
		this.matchWaits(e);
	}

	private async onMember(e: MatrixEvent): Promise<void> {
		const target = e.state_key ?? "";
		const local = localOf(target, this.config.serverName);
		if (!local || !local.startsWith("pi-") || target === this.systemUser) return;
		const membership = e.content.membership;
		const reg = this.regByUser(target);
		if (membership === "invite") {
			const direct = e.content.is_direct === true;
			const kind = reg?.kind ?? (await this.kindOf(target));
			if (reg) reg.rooms.add(e.room_id);
			if (direct || kind === "subagent") {
				await this.hs.register(local);
				await this.hs.join(target, e.room_id);
				if (direct) await this.recordDirect(target, e.sender, e.room_id);
				if (reg && !reg.syncing) {
					await this.offer(reg, e);
					await this.catchUp(reg, e.room_id, undefined, "invite");
				}
			}
		} else if (membership === "join") {
			reg?.rooms.add(e.room_id);
		} else if (reg) {
			reg.rooms.delete(e.room_id);
		}
	}

	private async onEncrypted(e: MatrixEvent): Promise<void> {
		this.log(`chatd: encrypted event in ${e.room_id} not delivered (agent rooms are unencrypted, 015/29)`);
		if (this.encryptedNotified.has(e.room_id)) return;
		await this.systemDm(
			this.config.owner,
			`An encrypted message was sent in ${await this.roomLabel(e.room_id)} (${e.room_id}). Agent rooms are unencrypted and agents cannot read encrypted messages, so it was not delivered.`,
		);
		this.encryptedNotified.add(e.room_id);
	}

	// ── classify, queue, deliver, ack ────────────────────────────────────

	private recipient(reg: Registration): Recipient {
		return {
			userId: reg.userId,
			peer: reg.peer,
			kind: reg.kind,
			isDirect: (room) => reg.directRooms.has(room),
			level: (room) => reg.levels.get(room) ?? "all",
		};
	}

	/** Queue `e` for `reg` when `classify` pushes it; deliver to a live pi connection. */
	private async offer(reg: Registration, e: MatrixEvent, deliver = true): Promise<void> {
		if (classify(e, e.room_id, this.recipient(reg)) !== "push") return;
		if (reg.queue.some((q) => q.event.event_id === e.event_id)) return;
		const q: Queued = { event: e, pushed: await this.render(reg, e) };
		reg.queue.push(q);
		if (!deliver) return;
		if (reg.conn && !reg.conn.closed) reg.conn.send({ push: q.pushed });
		this.wakeWatch(reg);
	}

	private senderLabel(id: string): string {
		if (id === this.config.owner) return "owner";
		if (id === this.systemUser) return SYSTEM_NAME;
		const local = localOf(id, this.config.serverName);
		return (local && peerName(local)) ?? id;
	}

	private async render(reg: Registration, e: MatrixEvent): Promise<Pushed> {
		const c = e.content;
		const expectReply = c["dev.pi.expect_reply"] === true;
		const delivery = expectReply || c["dev.pi.delivery"] === "followUp" ? "followUp" : "steer";
		const replyTo = (c["m.relates_to"] as { "m.in_reply_to"?: { event_id?: string } } | undefined)?.["m.in_reply_to"]?.event_id;
		const invite = e.type === "m.room.member";
		const direct = reg.directRooms.has(e.room_id) || (invite && c.is_direct === true);
		const room = direct ? "direct" : await this.roomLabel(e.room_id, e.sender, reg.userId);
		return {
			event_id: e.event_id,
			room_id: e.room_id,
			room,
			direct,
			sender: this.senderLabel(e.sender),
			what: invite ? "invite" : "message",
			body: invite ? (direct ? "opened a direct chat with you" : `invited you to ${room}`) : String(c.body ?? ""),
			expectReply,
			delivery,
			replyTo,
			ts: e.origin_server_ts,
		};
	}

	/** `#alias`, else the room's name, else its id; read as the first of `readers` that can see the room. */
	private async roomLabel(room: string, ...readers: string[]): Promise<string> {
		const cached = this.roomLabels.get(room);
		if (cached) return cached;
		for (const as of [...readers, this.systemUser]) {
			if (!localOf(as, this.config.serverName)?.startsWith("pi-")) continue;
			try {
				const alias = await this.hs.stateEvent<{ alias?: string }>(as, room, "m.room.canonical_alias");
				const name = alias?.alias ? undefined : await this.hs.stateEvent<{ name?: string }>(as, room, "m.room.name");
				const label = alias?.alias?.split(":")[0] ?? name?.name ?? room;
				this.roomLabels.set(room, label);
				return label;
			} catch {
				// Not a member: the next reader.
			}
		}
		return room;
	}

	/** Whether a live reply-wait of `reg` would end on this event. */
	private ownedByWait(reg: Registration, e: MatrixEvent): boolean {
		for (const w of this.waits) if (w.waiter === reg && this.ends(w, e)) return true;
		return false;
	}

	/** What a prompt or a watch may take now: not claimed by a wait, not owned by a live one. */
	private visible(reg: Registration): Pushed[] {
		return reg.queue.filter((q) => !reg.claimed.has(q.event.event_id) && !this.ownedByWait(reg, q.event)).map((q) => q.pushed);
	}

	private wakeWatch(reg: Registration): void {
		if (!reg.watch) return;
		const events = this.visible(reg);
		if (events.length === 0) return;
		const { conn, id } = reg.watch;
		reg.watch = undefined;
		conn.send({ id, ok: true, result: { events } });
	}

	/** The pushed-delivery marker's one writer (docs/design/chat.md § Delivery state). */
	private async ack(reg: Registration, ids: string[]): Promise<void> {
		for (const id of ids) {
			const i = reg.queue.findIndex((q) => q.event.event_id === id);
			if (i < 0) throw new ChatError(`event ${id} is not pending for ${reg.peer}`);
			const room = reg.queue[i].event.room_id;
			const head = reg.queue.find((q) => q.event.room_id === room)!;
			if (head.event.event_id !== id) {
				throw new ChatError(`out-of-order ack in ${room}: expected ${head.event.event_id}, got ${id}`);
			}
			const sender = reg.queue[i].pushed.sender;
			if (sender !== SYSTEM_NAME && sender !== reg.lastCorrespondent && !sender.startsWith("@")) {
				await this.hs.putAccountData(reg.userId, "dev.pi.last_correspondent", { peer: sender });
				reg.lastCorrespondent = sender;
			}
			await this.hs.putAccountData(reg.userId, "dev.pi.pushed", { event_id: id }, room);
			reg.queue.splice(i, 1);
			reg.claimed.delete(id);
		}
	}

	/**
	 * Backlog on connect: in every joined room, the events since `dev.pi.pushed`,
	 * else since the puppet's own join event, each offered to `classify`.
	 */
	private async backlog(reg: Registration): Promise<void> {
		for (const room of await this.hs.joinedRooms(reg.userId)) {
			reg.rooms.add(room);
			const marker = (await this.hs.accountData<{ event_id?: string }>(reg.userId, "dev.pi.pushed", room))?.event_id;
			await this.catchUp(reg, room, marker, "join");
		}
	}

	/**
	 * Offer `room`'s events newer than `marker`, or than the puppet's own
	 * `stopAt` membership event. A join chatd made for an invite catches up from
	 * the invite: the homeserver sends an invited puppet's rooms nothing, so a
	 * message between the invite and the join would otherwise never reach it.
	 */
	private async catchUp(reg: Registration, room: string, marker: string | undefined, stopAt: "join" | "invite"): Promise<void> {
		const events: MatrixEvent[] = [];
		let from: string | undefined;
		paging: for (;;) {
			const page = await this.hs.messages(reg.userId, room, from);
			for (const e of page.chunk) {
				e.room_id = room;
				if (marker && e.event_id === marker) break paging;
				if (!marker && e.type === "m.room.member" && e.state_key === reg.userId && e.content.membership === stopAt) break paging;
				events.unshift(e);
			}
			if (!page.end || page.chunk.length === 0) break;
			from = page.end;
		}
		for (const e of events) await this.offer(reg, e, !reg.syncing);
	}

	// ── registry ─────────────────────────────────────────────────────────

	private regByUser(id: string): Registration | undefined {
		for (const r of this.regs.values()) if (r.userId === id) return r;
		return undefined;
	}

	private online(reg: Registration | undefined): boolean {
		if (!reg) return false;
		if (reg.kind === "claude") {
			if (reg.claudePid !== undefined && pidAlive(reg.claudePid)) return true;
			this.endRegistration(reg, "its Claude Code process is gone");
			return false;
		}
		return !!reg.conn && !reg.conn.closed;
	}

	private async kindOf(user: string): Promise<PeerKind | undefined> {
		const known = this.kinds.get(user);
		if (known) return known;
		const p = await this.hs.profile(user, this.systemUser);
		const kind = p?.["dev.pi.kind"] as PeerKind | undefined;
		if (kind) this.kinds.set(user, kind);
		return kind;
	}

	private async hello(conn: Conn, h: Hello & { register?: boolean }): Promise<HelloResult> {
		const peer = validatePeerName(String(h.peer ?? ""));
		if (peer === SYSTEM_NAME) throw new ChatError("system is @pi-system's name; no client speaks as it", "refused");
		if (!["pi", "claude", "subagent"].includes(h.kind)) throw new ChatError(`hello: unknown kind ${JSON.stringify(h.kind)}`);
		if (h.kind === "claude" && !(Number.isInteger(h.claudePid) && (h.claudePid as number) > 0)) {
			throw new ChatError("hello: a claude peer needs claudePid");
		}
		const existing = this.regs.get(peer);
		if (existing && existing.kind !== "claude" && existing.conn && !existing.conn.closed && existing.conn !== conn) {
			throw new ChatError(`${peer} is already connected (connection ${existing.conn.id})`, "refused");
		}
		if (h.register === false && !(existing && existing.kind === h.kind)) {
			throw new ChatError(`no registration for ${peer} (did the session-start hook run?)`, "gone");
		}
		if (existing && existing.kind === h.kind && h.kind === "claude") {
			existing.claudePid = h.claudePid;
			existing.cwd = h.cwd ?? existing.cwd;
			conn.reg = existing;
			return this.helloResult(existing);
		}
		const user = userId(localpart(peer), this.config.serverName);
		await this.hs.register(localpart(peer));
		const reg: Registration = {
			peer,
			userId: user,
			kind: h.kind,
			session: String(h.session ?? ""),
			cwd: String(h.cwd ?? ""),
			model: h.model,
			claudePid: h.claudePid,
			displayName: "",
			conn: h.kind === "claude" ? undefined : conn,
			queue: [],
			claimed: new Set(),
			mdirect: {},
			directRooms: new Set(),
			rooms: new Set(),
			levels: new Map(),
			syncing: true,
			buffer: [],
			notified: new Set(),
		};
		this.kinds.set(user, h.kind);
		reg.displayName = await this.displayNameFor(reg);
		await this.hs.setDisplayName(user, reg.displayName);
		await this.hs.setProfileField(user, "dev.pi.kind", h.kind);
		await this.hs.setProfileField(user, "dev.pi.session", reg.session);
		await this.hs.setProfileField(user, "dev.pi.cwd", reg.cwd);
		if (h.model) await this.hs.setProfileField(user, "dev.pi.model", h.model);
		const members = await this.hs.joinedMembers(this.systemUser, this.peersRoom);
		if (!members[user]) {
			// Joined before the registration exists, and the transaction carrying the
			// invite and the join is processed first: chatd's own bookkeeping is no
			// news to the session (its backlog starts after the join).
			await this.hs.invite(this.systemUser, this.peersRoom, user);
			await this.hs.join(user, this.peersRoom);
			await this.joinSeen(this.peersRoom, user);
		}
		reg.mdirect = (await this.hs.accountData<Record<string, string[]>>(user, "m.direct")) ?? {};
		for (const rooms of Object.values(reg.mdirect)) for (const r of rooms) reg.directRooms.add(r);
		for (const rule of (await this.hs.pushRules(user)).global?.room ?? []) {
			if (!rule.actions.includes("notify")) reg.levels.set(rule.rule_id, "mentions");
		}
		reg.lastCorrespondent = (await this.hs.accountData<{ peer?: string }>(user, "dev.pi.last_correspondent"))?.peer;
		this.regs.set(peer, reg);
		conn.reg = reg;
		try {
			await this.backlog(reg);
			for (const e of reg.buffer.splice(0)) {
				const invited = e.type === "m.room.member" && e.state_key === reg.userId;
				if (reg.rooms.has(e.room_id) || invited) await this.offer(reg, e, false);
			}
		} catch (err) {
			this.regs.delete(peer);
			throw err;
		}
		reg.syncing = false;
		this.setPresence(reg, "online");
		if (reg.conn) for (const q of reg.queue) reg.conn.send({ push: q.pushed });
		return this.helloResult(reg);
	}

	private helloResult(reg: Registration): HelloResult {
		return { peer: reg.peer, userId: reg.userId, displayName: reg.displayName, lastCorrespondent: reg.lastCorrespondent };
	}

	/** The session's name, or for an unnamed one `<repo> <kind>`, unique among `#peers` by a suffix (015/20). */
	private async displayNameFor(reg: Registration): Promise<string> {
		const unnamed = reg.kind !== "pi" || new RegExp(`^${hostname().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d+$`).test(reg.peer);
		if (!unnamed) return reg.peer;
		const members = await this.hs.joinedMembers(this.systemUser, this.peersRoom);
		const taken = new Set(Object.entries(members).filter(([u]) => u !== reg.userId).map(([, m]) => m.display_name ?? ""));
		const base = `${repoName(reg.cwd)} ${reg.kind}`;
		if (!taken.has(base)) return base;
		for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
	}

	private endRegistration(reg: Registration, why: string): void {
		if (this.regs.get(reg.peer) !== reg) return;
		this.regs.delete(reg.peer);
		this.setPresence(reg, "offline");
		if (reg.watch) {
			reg.watch.conn.send({ id: reg.watch.id, ok: false, code: "gone", error: `${reg.peer}'s session is gone (${why})` });
			reg.watch = undefined;
		}
		for (const w of [...this.waits]) {
			if (w.waiter === reg) this.dropWait(w);
			else if (w.target === reg.userId && w.minutes !== undefined) this.endWait(w, { outcome: "offline", target: reg.peer });
		}
	}

	private setPresence(reg: Registration, want: "online" | "offline"): void {
		this.presence.set(reg.userId, { want, status: reg.session });
		void this.writePresence(reg.userId);
	}

	private async writePresence(user: string): Promise<void> {
		const p = this.presence.get(user);
		if (!p || p.written === p.want) return;
		try {
			await this.hs.setPresence(user, p.want, p.status);
			p.written = p.want;
		} catch (err) {
			p.written = undefined;
			this.log(`chatd: presence for ${user} not written; the next pass retries: ${(err as Error).message}`);
		}
	}

	/** Every 30 s: end Claude registrations whose process is gone; rewrite presence that changed or failed. */
	async presencePass(): Promise<void> {
		for (const reg of [...this.regs.values()]) if (reg.kind === "claude") this.online(reg);
		for (const user of this.presence.keys()) await this.writePresence(user);
	}

	// ── rooms and DMs ────────────────────────────────────────────────────

	private async recordDirect(user: string, other: string, room: string): Promise<void> {
		const reg = this.regByUser(user);
		const current = reg?.mdirect ?? (user === this.systemUser ? this.systemDirect : (await this.hs.accountData<Record<string, string[]>>(user, "m.direct")) ?? {});
		const rooms = current[other] ?? [];
		if (!rooms.includes(room)) {
			const next = { ...current, [other]: [...rooms, room] };
			await this.hs.putAccountData(user, "m.direct", next);
			if (reg) reg.mdirect = next;
			if (user === this.systemUser) this.systemDirect = next;
		}
		reg?.directRooms.add(room);
		reg?.rooms.add(room);
	}

	/** The DM room `from` holds with `to`, created on first need and recorded in `m.direct`. */
	private async directRoom(from: string, fromDirect: Record<string, string[]>, to: string): Promise<string> {
		const existing = fromDirect[to]?.[0];
		if (existing) return existing;
		const room = await this.hs.createRoom(from, { preset: "trusted_private_chat", is_direct: true, invite: [to] });
		await this.recordDirect(from, to, room);
		const toLocal = localOf(to, this.config.serverName);
		if (toLocal?.startsWith("pi-")) {
			await this.hs.register(toLocal);
			await this.hs.join(to, room);
			await this.recordDirect(to, from, room);
			if (from !== this.systemUser && to !== this.systemUser) this.dmPairs.set(room, [from, to]);
		}
		return room;
	}

	async systemDm(to: string, text: string): Promise<void> {
		const room = await this.directRoom(this.systemUser, this.systemDirect, to);
		await this.hs.send(this.systemUser, room, { msgtype: "m.text", body: text }, randomUUID());
	}

	private async dailyOwnerDm(key: string, text: string): Promise<void> {
		const day = Math.floor(this.now() / DAY_MS);
		if (this.dailyDms.get(key) === day) return;
		await this.systemDm(this.config.owner, text);
		this.dailyDms.set(key, day);
	}

	/** Whether the room is a DM between two agent puppets (015/32), with the pair. */
	private async agentPair(room: string, sender: string): Promise<[string, string] | null> {
		if (this.dmPairs.has(room)) return this.dmPairs.get(room)!;
		let pair: [string, string] | null = null;
		const members = Object.keys(await this.hs.joinedMembers(sender, room));
		const puppets = members.filter((m) => m !== this.systemUser && localOf(m, this.config.serverName)?.startsWith("pi-"));
		if (members.length === 2 && puppets.length === 2) {
			const direct = (await this.hs.accountData<Record<string, string[]>>(sender, "m.direct")) ?? {};
			const other = puppets.find((p) => p !== sender)!;
			if (direct[other]?.includes(room)) pair = [sender, other];
		}
		this.dmPairs.set(room, pair);
		return pair;
	}

	private async mirror(e: MatrixEvent): Promise<void> {
		if (e.room_id === this.mirrorRoom || e.sender === this.systemUser) return;
		if (!localOf(e.sender, this.config.serverName)?.startsWith("pi-")) return;
		const pair = await this.agentPair(e.room_id, e.sender);
		if (!pair) return;
		const to = pair[0] === e.sender ? pair[1] : pair[0];
		const body = `${this.senderLabel(e.sender)} → ${this.senderLabel(to)}: ${String(e.content.body ?? "")}\nhttps://matrix.to/#/${e.room_id}/${e.event_id}`;
		await this.hs.send(this.systemUser, this.mirrorRoom, { msgtype: "m.notice", body, "dev.pi.original": e.event_id }, `mirror-${e.event_id}`);
		this.deps.afterMirrorCopy?.();
	}

	/** Redact `#dm-mirror` copies older than 7 days. Its next hourly run is the retry. */
	async sweepMirror(): Promise<number> {
		let redacted = 0;
		try {
			const cutoff = this.now() - MIRROR_KEEP_MS;
			let from: string | undefined;
			for (;;) {
				const page = await this.hs.messages(this.systemUser, this.mirrorRoom, from);
				for (const e of page.chunk) {
					if (e.type !== "m.room.message" || e.sender !== this.systemUser) continue;
					if (e.origin_server_ts >= cutoff || Object.keys(e.content).length === 0) continue;
					await this.hs.redact(this.systemUser, this.mirrorRoom, e.event_id, `sweep-${e.event_id}`);
					redacted++;
				}
				if (!page.end || page.chunk.length === 0) break;
				from = page.end;
			}
		} catch (err) {
			this.log(`chatd: mirror sweep failed; the next run retries: ${(err as Error).message}`);
		}
		return redacted;
	}

	/** At start and daily: fewer than 20 days on the homeserver's certificate, or a failed check, DMs the owner. */
	async certificateWatch(): Promise<void> {
		try {
			let notAfter: Date;
			try {
				notAfter = await this.deps.checkCertificate();
			} catch (err) {
				await this.dailyOwnerDm("cert-failed", `The certificate check for ${this.config.serverName} failed: ${(err as Error).message}`);
				return;
			}
			const days = (notAfter.getTime() - this.now()) / DAY_MS;
			if (days < CERT_MIN_DAYS) {
				await this.dailyOwnerDm(
					"cert",
					`${this.config.serverName}'s certificate expires ${notAfter.toISOString()}: ${Math.floor(days)} days left (fewer than ${CERT_MIN_DAYS}).`,
				);
			}
		} catch (err) {
			this.log(`chatd: certificate watch could not DM the owner; tomorrow's run retries: ${(err as Error).message}`);
		}
	}

	// ── peers ────────────────────────────────────────────────────────────

	private async peerNames(): Promise<Map<string, string>> {
		const members = await this.hs.joinedMembers(this.systemUser, this.peersRoom);
		const names = new Map<string, string>();
		for (const id of Object.keys(members)) {
			if (id === this.systemUser) continue;
			const local = localOf(id, this.config.serverName);
			const name = local && peerName(local);
			if (name) names.set(name, id);
		}
		return names;
	}

	/** An exact name, else a unique tail of at least 8 characters, among `#peers` members. */
	private async resolvePeer(to: string): Promise<{ name: string; userId: string }> {
		const names = await this.peerNames();
		const exact = names.get(to);
		if (exact) return { name: to, userId: exact };
		const tails = to.length >= 8 ? [...names.keys()].filter((n) => n.endsWith(to)) : [];
		if (tails.length === 1) return { name: tails[0], userId: names.get(tails[0])! };
		if (tails.length > 1) throw new ChatError(`peer "${to}" is ambiguous: candidates ${tails.join(", ")}`, "unknown-peer");
		const known = [...names.keys()].map((n) => `${n} (${this.online(this.regs.get(n)) ? "online" : "offline"})`);
		throw new ChatError(`no peer matches "${to}" — not sent. Peers: ${known.join(", ") || "none"}`, "unknown-peer");
	}

	private async statusOf(name: string, user: string): Promise<{ status: string; kind: string }> {
		const reg = this.regs.get(name);
		if (reg) return { status: reg.session || reg.cwd, kind: reg.kind };
		const p = await this.hs.profile(user, this.systemUser);
		return { status: String(p?.["dev.pi.session"] || p?.["dev.pi.cwd"] || ""), kind: String(p?.["dev.pi.kind"] ?? "?") };
	}

	private async who(): Promise<PeerEntry[]> {
		const members = await this.hs.joinedMembers(this.systemUser, this.peersRoom);
		const out: PeerEntry[] = [];
		for (const [name, user] of await this.peerNames()) {
			const { status, kind } = await this.statusOf(name, user);
			out.push({ name, kind, online: this.online(this.regs.get(name)), displayName: members[user]?.display_name ?? name, status });
		}
		return out;
	}

	// ── socket verbs ─────────────────────────────────────────────────────

	private onConnection(socket: Socket): void {
		const conn: Conn = {
			id: ++this.connSeq,
			socket,
			closed: false,
			send: (msg) => {
				if (!conn.closed) socket.write(`${JSON.stringify(msg)}\n`);
			},
		};
		this.conns.add(conn);
		let buf = "";
		socket.setEncoding("utf8");
		socket.on("data", (d: string) => {
			buf += d;
			let i: number;
			while ((i = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 1);
				if (line) void this.onRequest(conn, line);
			}
		});
		socket.on("error", () => {});
		socket.on("close", () => {
			conn.closed = true;
			this.conns.delete(conn);
			for (const w of [...this.waits]) if (w.conn === conn) this.dropWait(w);
			const reg = conn.reg;
			if (reg?.watch?.conn === conn) reg.watch = undefined;
			if (reg && reg.conn === conn) this.endRegistration(reg, "its connection closed");
		});
	}

	private async onRequest(conn: Conn, line: string): Promise<void> {
		let req: Record<string, unknown> & { id: number; verb: string };
		try {
			req = JSON.parse(line);
		} catch {
			conn.send({ ok: false, error: "not JSON" });
			return;
		}
		try {
			const result = await this.dispatch(conn, req);
			if (result !== DEFERRED) conn.send({ id: req.id, ok: true, result });
		} catch (err) {
			const code = err instanceof ChatError ? err.code : err instanceof HomeserverError ? "homeserver" : "invalid";
			conn.send({ id: req.id, ok: false, error: (err as Error).message, code });
		}
	}

	private registered(conn: Conn): Registration {
		const reg = conn.reg;
		if (!reg || this.regs.get(reg.peer) !== reg) throw new ChatError("no registration: send hello first (did the session-start hook run?)", "gone");
		if (reg.kind === "claude" && !this.online(reg)) throw new ChatError(`${reg.peer}'s session is gone`, "gone");
		return reg;
	}

	private async dispatch(conn: Conn, req: Record<string, unknown> & { id: number; verb: string }): Promise<unknown> {
		switch (req.verb) {
			case "hello":
				return this.hello(conn, req as unknown as Hello);
			case "send":
				return this.send(this.registered(conn), req);
			case "read":
				return this.read(this.registered(conn), req);
			case "rooms":
				return this.rooms(this.registered(conn), req);
			case "who":
				this.registered(conn);
				return this.who();
			case "ack":
				return this.ack(this.registered(conn), (req.event_ids as string[]) ?? []);
			case "wait":
				return this.wait(conn, this.registered(conn), req);
			case "watch":
				return this.watch(conn, this.registered(conn), req.id);
			case "pending": {
				const reg = this.registered(conn);
				if (req.prompt === true) reg.notified.clear();
				return { events: this.visible(reg), watchLive: !!reg.watch && !reg.watch.conn.closed };
			}
			case "bye": {
				const reg = this.registered(conn);
				this.endRegistration(reg, "its session ended");
				return {};
			}
			case "notify":
				return this.notify(this.registered(conn), String(req.type ?? ""), String(req.message ?? ""));
			case "system_mail":
				return this.systemMail(this.registered(conn), req);
			default:
				throw new ChatError(`unknown verb ${JSON.stringify(req.verb)}`);
		}
	}

	private async roomOf(reg: Registration, room: string): Promise<string> {
		if (room === "owner") return this.directRoom(reg.userId, reg.mdirect, this.config.owner);
		if (room.startsWith("!")) return room;
		if (room.startsWith("#")) {
			const full = room.includes(":") ? room : `${room}:${this.config.serverName}`;
			const id = await this.hs.resolveAlias(full);
			if (!id) throw new ChatError(`no room ${room}`);
			return id;
		}
		const target = await this.resolvePeer(validatePeerName(room));
		return this.directRoom(reg.userId, reg.mdirect, target.userId);
	}

	private async send(reg: Registration, p: Record<string, unknown>): Promise<{ event_id: string; room: string; to: string; online?: boolean }> {
		const to = String(p.to ?? "");
		const text = String(p.text ?? "");
		if (!text) throw new ChatError("send: empty message");
		let room: string;
		let label: string;
		let online: boolean | undefined;
		if (to === "owner") {
			room = await this.directRoom(reg.userId, reg.mdirect, this.config.owner);
			label = "owner";
		} else if (to.startsWith("#")) {
			room = await this.roomOf(reg, to);
			if (!(await this.hs.joinedRooms(reg.userId)).includes(room)) throw new ChatError(`${reg.peer} is not in ${to} — not sent`, "refused");
			label = to;
		} else {
			const target = await this.resolvePeer(validatePeerName(to));
			online = this.online(this.regs.get(target.name));
			if (p.requireOnline === true && !online) {
				throw new ChatError(`peer "${target.name}" is offline and requireOnline is set — not sent`, "offline");
			}
			room = await this.directRoom(reg.userId, reg.mdirect, target.userId);
			label = target.name;
		}
		const names = await this.peerNames();
		const userIds = new Set<string>();
		for (const m of text.matchAll(/(?:^|[^A-Za-z0-9._@-])@([A-Za-z0-9][A-Za-z0-9._-]*)/g)) {
			const token = m[1].replace(/[.]+$/, "");
			if (token === "room") continue;
			const id = names.get(token);
			if (id) userIds.add(id);
		}
		const roomMention = bodyMentions(text, "@room");
		if (to.startsWith("#")) {
			const members = await this.hs.joinedMembers(reg.userId, room);
			for (const id of userIds) if (!members[id]) await this.hs.invite(reg.userId, room, id);
		}
		const expectReply = p.expectReply === true;
		const content: Record<string, unknown> = {
			msgtype: "m.text",
			body: text,
			"m.mentions": roomMention ? { user_ids: [...userIds], room: true } : { user_ids: [...userIds] },
			"dev.pi.delivery": expectReply || p.whenIdle === true ? "followUp" : "steer",
			"dev.pi.expect_reply": expectReply,
		};
		if (typeof p.replyTo === "string" && p.replyTo) content["m.relates_to"] = { "m.in_reply_to": { event_id: p.replyTo } };
		const event_id = await this.hs.send(reg.userId, room, content, randomUUID());
		return { event_id, room, to: label, online };
	}

	private async read(reg: Registration, p: Record<string, unknown>): Promise<{ room: string; events: Pushed[] }> {
		const room = await this.roomOf(reg, String(p.room ?? ""));
		const limit = Math.min(Number(p.limit ?? 20) || 20, 200);
		const since = typeof p.since === "string" ? p.since : undefined;
		const page = await this.hs.messages(reg.userId, room, undefined, Math.max(limit * 2, 50));
		const out: MatrixEvent[] = [];
		for (const e of page.chunk) {
			if (since && e.event_id === since) break;
			if (e.type === "m.room.message") out.unshift({ ...e, room_id: room });
			if (out.length >= limit) break;
		}
		const events: Pushed[] = [];
		for (const e of out) events.push(await this.render(reg, e));
		const newest = out.at(-1);
		if (newest) await this.hs.readMarkers(reg.userId, room, newest.event_id);
		return { room: await this.roomLabel(room, reg.userId), events };
	}

	private async rooms(reg: Registration, p: Record<string, unknown>): Promise<unknown> {
		const action = String(p.action ?? "list");
		if (action === "list") {
			const sync = await this.hs.sync(reg.userId);
			const joined = [];
			for (const [id, r] of Object.entries(sync.rooms?.join ?? {})) {
				const topic = (await this.hs.stateEvent<{ topic?: string }>(reg.userId, id, "m.room.topic"))?.topic ?? "";
				const level = reg.levels.get(id) ?? "all";
				joined.push({
					room: await this.roomLabel(id, reg.userId),
					room_id: id,
					topic,
					level,
					direct: reg.directRooms.has(id),
					unread: level === "all" ? (r.unread_notifications?.notification_count ?? 0) : undefined,
				});
			}
			const invites = Object.entries(sync.rooms?.invite ?? {}).map(([id, r]) => {
				const ev = r.invite_state?.events ?? [];
				const alias = ev.find((x) => x.type === "m.room.canonical_alias")?.content.alias as string | undefined;
				const name = ev.find((x) => x.type === "m.room.name")?.content.name as string | undefined;
				const inviter = ev.find((x) => x.type === "m.room.member" && x.state_key === reg.userId)?.sender;
				return { room: alias?.split(":")[0] ?? name ?? id, room_id: id, inviter: inviter ? this.senderLabel(inviter) : undefined };
			});
			return { joined, invites };
		}
		if (action === "create") {
			const name = String(p.name ?? "").replace(/^#/, "");
			if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) throw new ChatError(`rooms create: ${JSON.stringify(name)} is not a room name ([a-z0-9._-])`);
			const invite = [];
			for (const n of (p.invite as string[] | undefined) ?? []) invite.push((await this.resolvePeer(validatePeerName(n))).userId);
			const room = await this.hs.createRoom(reg.userId, {
				room_alias_name: name,
				name,
				topic: typeof p.topic === "string" ? p.topic : undefined,
				preset: "private_chat",
				invite,
			});
			reg.rooms.add(room);
			return { room: `#${name}`, room_id: room };
		}
		const room = await this.roomOf(reg, String(p.room ?? ""));
		if (action === "join") {
			await this.hs.join(reg.userId, room);
			reg.rooms.add(room);
			return { room_id: room };
		}
		if (action === "leave") {
			await this.hs.leave(reg.userId, room);
			reg.rooms.delete(room);
			return { room_id: room };
		}
		if (action === "level") {
			const level = p.level;
			// The agent's own request (015/28): chatd sets no level on its own.
			if (level === "all") await this.hs.deleteRoomRule(reg.userId, room);
			else if (level === "mentions") await this.hs.putRoomRule(reg.userId, room);
			else throw new ChatError("rooms level: level is all or mentions");
			if (level === "all") reg.levels.delete(room);
			else reg.levels.set(room, "mentions");
			return { room_id: room, level };
		}
		throw new ChatError(`rooms: unknown action ${JSON.stringify(action)}`);
	}

	private async systemMail(reg: Registration, p: Record<string, unknown>): Promise<{ sent: string[] }> {
		const text = String(p.text ?? "");
		const to = (p.to as string[] | undefined) ?? [];
		if (!text || to.length === 0) throw new ChatError("system_mail: to and text are required");
		const sent: string[] = [];
		for (const name of to) {
			const user = name === "owner" ? this.config.owner : (await this.resolvePeer(validatePeerName(name))).userId;
			if (user === reg.userId) throw new ChatError("system_mail: a session never mails itself");
			await this.systemDm(user, text);
			sent.push(name);
		}
		return { sent };
	}

	private async notify(reg: Registration, type: string, message: string): Promise<{ sent: boolean }> {
		if (!(WAITING_TYPES as readonly string[]).includes(type)) return { sent: false };
		if (reg.notified.has(type)) return { sent: false };
		const room = await this.directRoom(reg.userId, reg.mdirect, this.config.owner);
		await this.hs.send(reg.userId, room, { msgtype: "m.text", body: `${reg.displayName} is waiting: ${message}` }, randomUUID());
		reg.notified.add(type);
		return { sent: true };
	}

	private watch(conn: Conn, reg: Registration, id: number): unknown {
		if (reg.kind !== "claude") throw new ChatError("watch is for Claude peers; a pi session gets pushes on its connection");
		if (reg.watch && !reg.watch.conn.closed) throw new ChatError(`a watch for ${reg.peer} is already running`, "watch-live");
		reg.watch = { conn, id };
		this.wakeWatch(reg);
		return DEFERRED;
	}

	// ── reply-waits (015/33) ─────────────────────────────────────────────

	private ends(w: WaitRec, e: MatrixEvent): boolean {
		const replyTo = (e.content["m.relates_to"] as { "m.in_reply_to"?: { event_id?: string } } | undefined)?.["m.in_reply_to"]?.event_id;
		if (replyTo === w.ask) return true;
		return (
			w.target !== undefined &&
			e.type === "m.room.message" &&
			e.sender === w.target &&
			e.room_id === w.room &&
			e.origin_server_ts > w.askTs
		);
	}

	private async wait(conn: Conn, reg: Registration, p: Record<string, unknown>): Promise<unknown> {
		const ask = String(p.event_id ?? "");
		const room = String(p.room ?? "");
		if (!ask || !room) throw new ChatError("wait: event_id and room are required");
		const minutes = p.minutes === undefined ? undefined : Number(p.minutes);
		if (minutes !== undefined && !(minutes > 0)) throw new ChatError("wait: minutes must be positive");
		const askEvent = await this.hs.event(reg.userId, room, ask);
		const target = Object.entries(reg.mdirect).find(([, rooms]) => rooms.includes(room))?.[0];
		const w: WaitRec = { conn, id: p.id as number, waiter: reg, ask, room, askTs: askEvent.origin_server_ts, target, minutes };
		const targetName = target ? this.senderLabel(target) : room;
		this.waits.add(w);
		// A reply sent before the wait registered, or while chatd was down, still ends it.
		const replies = (await this.hs.relations(reg.userId, room, ask)).filter((e) => this.ends(w, { ...e, room_id: e.room_id ?? room }));
		let found = replies.sort((a, b) => a.origin_server_ts - b.origin_server_ts)[0];
		if (!found && target) {
			const page = await this.hs.messages(reg.userId, room, undefined, 100);
			found = page.chunk
				.map((e) => ({ ...e, room_id: room }))
				.filter((e) => this.ends(w, e))
				.sort((a, b) => a.origin_server_ts - b.origin_server_ts)[0];
		}
		if (found) {
			await this.endWithReply(w, found);
			return DEFERRED;
		}
		if (minutes !== undefined && target && !this.online(this.regByUser(target))) {
			this.endWait(w, { outcome: "offline", target: targetName });
			return DEFERRED;
		}
		if (minutes !== undefined) {
			w.timer = setTimeout(async () => {
				const t = this.regByUser(target ?? "");
				const status = t ? t.session || t.cwd : target ? (await this.statusOf(targetName, target)).status : "";
				this.endWait(w, { outcome: "checkin", target: targetName, status });
			}, minutes * 60_000);
		}
		return DEFERRED;
	}

	private matchWaits(e: MatrixEvent): void {
		for (const w of [...this.waits]) if (this.ends(w, e)) void this.endWithReply(w, e);
	}

	private async endWithReply(w: WaitRec, e: MatrixEvent): Promise<void> {
		if (!this.waits.has(w)) return;
		this.waits.delete(w);
		const reg = w.waiter;
		const i = reg.queue.findIndex((q) => q.event.event_id === e.event_id);
		const events = i < 0 ? [] : reg.queue.slice(0, i + 1).filter((q) => q.event.room_id === e.room_id).map((q) => q.pushed);
		if (reg.kind === "claude") for (const x of events) reg.claimed.add(x.event_id);
		const reply = i < 0 ? await this.render(reg, e) : reg.queue[i].pushed;
		this.endWait(w, { outcome: "reply", reply, events });
	}

	private endWait(w: WaitRec, result: WaitResult): void {
		this.waits.delete(w);
		if (w.timer) clearTimeout(w.timer);
		w.conn.send({ id: w.id, ok: true, result });
	}

	private dropWait(w: WaitRec): void {
		this.waits.delete(w);
		if (w.timer) clearTimeout(w.timer);
		const reg = w.waiter;
		// A waiter that went without acking hands its claimed events back.
		for (const q of reg.queue) reg.claimed.delete(q.event.event_id);
	}
}

const DEFERRED = Symbol("deferred");
