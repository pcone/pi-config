/**
 * The homeserver client: plain `fetch` with the appservice token, acting as a
 * puppet through `?user_id=` (no Matrix SDK; WO-2026-107 § Prohibitions).
 *
 * Errors name the method, the path without its query, and the homeserver's
 * errcode. No error or log line carries a URL query or a token.
 */

export interface MatrixEvent {
	event_id: string;
	room_id: string;
	sender: string;
	type: string;
	state_key?: string;
	origin_server_ts: number;
	content: Record<string, unknown>;
	unsigned?: { prev_content?: { membership?: string }; redacted_because?: unknown };
}

/** The event an `m.in_reply_to` relation names, if any. */
export function replyToOf(content: Record<string, unknown>): string | undefined {
	return (content["m.relates_to"] as { "m.in_reply_to"?: { event_id?: string } } | undefined)?.["m.in_reply_to"]?.event_id;
}

export class HomeserverError extends Error {
	constructor(
		readonly status: number,
		readonly errcode: string | undefined,
		message: string,
	) {
		super(message);
	}
}

const q = encodeURIComponent;

export class Homeserver {
	constructor(
		private readonly base: string,
		private readonly asToken: string,
	) {}

	async call<T = Record<string, unknown>>(
		method: string,
		path: string,
		options: { body?: unknown; as?: string; query?: Record<string, string> } = {},
	): Promise<T> {
		const url = new URL(this.base + path);
		if (options.as) url.searchParams.set("user_id", options.as);
		for (const [k, v] of Object.entries(options.query ?? {})) url.searchParams.set(k, v);
		let r: Response;
		try {
			r = await fetch(url, {
				method,
				headers: { authorization: `Bearer ${this.asToken}`, "content-type": "application/json" },
				body: options.body === undefined ? undefined : JSON.stringify(options.body),
				signal: AbortSignal.timeout(15_000),
			});
		} catch (err) {
			throw new HomeserverError(0, undefined, `homeserver unreachable (${method} ${path}): ${(err as Error).message}`);
		}
		const text = await r.text();
		let json: Record<string, unknown> = {};
		try {
			json = text ? JSON.parse(text) : {};
		} catch {
			/* a non-JSON body: reported by status below */
		}
		if (!r.ok) {
			const errcode = typeof json.errcode === "string" ? json.errcode : undefined;
			const detail = typeof json.error === "string" ? json.error : text.slice(0, 200);
			throw new HomeserverError(r.status, errcode, `homeserver answered ${r.status} to ${method} ${path}: ${errcode ?? ""} ${detail}`.trim());
		}
		return json as T;
	}

	/** Register a puppet; an existing account is the same answer. */
	async register(localpart: string): Promise<void> {
		try {
			await this.call("POST", "/_matrix/client/v3/register", {
				body: { type: "m.login.application_service", username: localpart },
			});
		} catch (err) {
			if (err instanceof HomeserverError && err.errcode === "M_USER_IN_USE") return;
			throw err;
		}
	}

	setDisplayName(user: string, name: string): Promise<unknown> {
		return this.call("PUT", `/_matrix/client/v3/profile/${q(user)}/displayname`, { as: user, body: { displayname: name } });
	}

	setProfileField(user: string, key: string, value: string): Promise<unknown> {
		return this.call("PUT", `/_matrix/client/v3/profile/${q(user)}/${q(key)}`, { as: user, body: { [key]: value } });
	}

	async profile(user: string, as: string): Promise<Record<string, unknown> | undefined> {
		try {
			return await this.call("GET", `/_matrix/client/v3/profile/${q(user)}`, { as });
		} catch (err) {
			if (err instanceof HomeserverError && err.status === 404) return undefined;
			throw err;
		}
	}

	setPresence(user: string, presence: "online" | "offline", status: string): Promise<unknown> {
		return this.call("PUT", `/_matrix/client/v3/presence/${q(user)}/status`, {
			as: user,
			body: { presence, status_msg: status },
		});
	}

	/** Account data, or undefined when unset. */
	async accountData<T>(user: string, type: string, room?: string): Promise<T | undefined> {
		const path = room
			? `/_matrix/client/v3/user/${q(user)}/rooms/${q(room)}/account_data/${q(type)}`
			: `/_matrix/client/v3/user/${q(user)}/account_data/${q(type)}`;
		try {
			return await this.call<T>("GET", path, { as: user });
		} catch (err) {
			if (err instanceof HomeserverError && err.status === 404) return undefined;
			throw err;
		}
	}

	putAccountData(user: string, type: string, content: unknown, room?: string): Promise<unknown> {
		const path = room
			? `/_matrix/client/v3/user/${q(user)}/rooms/${q(room)}/account_data/${q(type)}`
			: `/_matrix/client/v3/user/${q(user)}/account_data/${q(type)}`;
		return this.call("PUT", path, { as: user, body: content });
	}

	async resolveAlias(alias: string): Promise<string | undefined> {
		try {
			const r = await this.call<{ room_id: string }>("GET", `/_matrix/client/v3/directory/room/${q(alias)}`);
			return r.room_id;
		} catch (err) {
			if (err instanceof HomeserverError && err.status === 404) return undefined;
			throw err;
		}
	}

	async createRoom(as: string, body: Record<string, unknown>): Promise<string> {
		return (await this.call<{ room_id: string }>("POST", "/_matrix/client/v3/createRoom", { as, body })).room_id;
	}

	async join(as: string, roomOrAlias: string): Promise<string> {
		return (await this.call<{ room_id: string }>("POST", `/_matrix/client/v3/join/${q(roomOrAlias)}`, { as, body: {} })).room_id;
	}

	invite(as: string, room: string, user: string): Promise<unknown> {
		return this.call("POST", `/_matrix/client/v3/rooms/${q(room)}/invite`, { as, body: { user_id: user } });
	}

	leave(as: string, room: string): Promise<unknown> {
		return this.call("POST", `/_matrix/client/v3/rooms/${q(room)}/leave`, { as, body: {} });
	}

	async send(as: string, room: string, content: Record<string, unknown>, txnId: string, type = "m.room.message"): Promise<string> {
		const r = await this.call<{ event_id: string }>("PUT", `/_matrix/client/v3/rooms/${q(room)}/send/${q(type)}/${q(txnId)}`, {
			as,
			body: content,
		});
		return r.event_id;
	}

	redact(as: string, room: string, event: string, txnId: string): Promise<unknown> {
		return this.call("PUT", `/_matrix/client/v3/rooms/${q(room)}/redact/${q(event)}/${q(txnId)}`, { as, body: {} });
	}

	messages(as: string, room: string, from?: string, limit = 100): Promise<{ chunk: MatrixEvent[]; end?: string }> {
		const query: Record<string, string> = { dir: "b", limit: String(limit) };
		if (from) query.from = from;
		return this.call("GET", `/_matrix/client/v3/rooms/${q(room)}/messages`, { as, query });
	}

	async event(as: string, room: string, id: string): Promise<MatrixEvent> {
		return this.call<MatrixEvent>("GET", `/_matrix/client/v3/rooms/${q(room)}/event/${q(id)}`, { as });
	}

	/** Every event relating to `id`, unfiltered: a reply is no relation type, so a rel-type filter misses it. */
	async relations(as: string, room: string, id: string): Promise<MatrixEvent[]> {
		const out: MatrixEvent[] = [];
		let from: string | undefined;
		for (;;) {
			const query: Record<string, string> = { limit: "100" };
			if (from) query.from = from;
			const r = await this.call<{ chunk: MatrixEvent[]; next_batch?: string }>(
				"GET",
				`/_matrix/client/v1/rooms/${q(room)}/relations/${q(id)}`,
				{ as, query },
			);
			out.push(...r.chunk);
			if (!r.next_batch) return out;
			from = r.next_batch;
		}
	}

	async joinedRooms(as: string): Promise<string[]> {
		return (await this.call<{ joined_rooms: string[] }>("GET", "/_matrix/client/v3/joined_rooms", { as })).joined_rooms;
	}

	async joinedMembers(as: string, room: string): Promise<Record<string, { display_name?: string | null }>> {
		return (await this.call<{ joined: Record<string, { display_name?: string | null }> }>(
			"GET",
			`/_matrix/client/v3/rooms/${q(room)}/joined_members`,
			{ as },
		)).joined;
	}

	async stateEvent<T>(as: string, room: string, type: string, key = ""): Promise<T | undefined> {
		try {
			return await this.call<T>("GET", `/_matrix/client/v3/rooms/${q(room)}/state/${q(type)}/${q(key)}`, { as });
		} catch (err) {
			if (err instanceof HomeserverError && err.status === 404) return undefined;
			throw err;
		}
	}

	pushRules(as: string): Promise<{ global?: { room?: { rule_id: string; actions: unknown[] }[] } }> {
		return this.call("GET", "/_matrix/client/v3/pushrules/", { as });
	}

	putRoomRule(as: string, room: string): Promise<unknown> {
		return this.call("PUT", `/_matrix/client/v3/pushrules/global/room/${q(room)}`, { as, body: { actions: [] } });
	}

	async deleteRoomRule(as: string, room: string): Promise<void> {
		try {
			await this.call("DELETE", `/_matrix/client/v3/pushrules/global/room/${q(room)}`, { as });
		} catch (err) {
			if (err instanceof HomeserverError && err.status === 404) return;
			throw err;
		}
	}

	readMarkers(as: string, room: string, event: string): Promise<unknown> {
		return this.call("POST", `/_matrix/client/v3/rooms/${q(room)}/read_markers`, {
			as,
			body: { "m.fully_read": event, "m.read": event },
		});
	}

	sync(as: string): Promise<{
		rooms?: {
			join?: Record<string, { unread_notifications?: { notification_count?: number } }>;
			invite?: Record<string, { invite_state?: { events?: { type: string; state_key?: string; sender: string; content: Record<string, unknown> }[] } }>;
		};
	}> {
		const filter = JSON.stringify({ room: { timeline: { limit: 0 }, state: { lazy_load_members: true } }, presence: { not_types: ["*"] } });
		return this.call("GET", "/_matrix/client/v3/sync", { as, query: { timeout: "0", filter } });
	}
}
