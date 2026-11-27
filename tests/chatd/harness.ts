/**
 * Socket-level peers for the chatd rows: a hello'd client that records its
 * pushes, plus the homeserver calls a row uses to look behind chatd.
 */

import { ChatClient } from "../../apps/chatd/client.ts";
import { localpart } from "../../apps/chatd/names.ts";
import type { Pushed } from "../../apps/chatd/protocol.ts";
import type { TestChatd } from "../helpers/chatd.ts";

export interface SocketPeer {
	name: string;
	userId: string;
	client: ChatClient;
	pushes: Pushed[];
	req<T = unknown>(verb: string, params?: Record<string, unknown>): Promise<T>;
	/** Resolves with the first push whose body contains `needle`. */
	pushed(needle: string, timeoutMs?: number): Promise<Pushed>;
	ack(...events: Pushed[]): Promise<void>;
	close(): void;
}

let seq = 0;
export const uniq = (base: string) => `${base}-${Date.now().toString(36).slice(-4)}${++seq}`;

export async function connectPeer(
	t: TestChatd,
	name: string,
	kind: "pi" | "subagent" | "claude" = "pi",
	extra: Record<string, unknown> = {},
): Promise<SocketPeer> {
	const client = await t.client();
	const pushes: Pushed[] = [];
	client.onPush((p) => pushes.push(p));
	const hello = await client.request<{ userId: string }>("hello", {
		peer: name,
		kind,
		session: `${name}-session`,
		cwd: "/w",
		...(kind === "claude" ? { claudePid: process.pid } : {}),
		...extra,
	});
	return {
		name,
		userId: hello.userId,
		client,
		pushes,
		req: (verb, params = {}) => client.request(verb, params),
		async pushed(needle, timeoutMs = 10_000) {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				const p = pushes.find((x) => x.body.includes(needle));
				if (p) return p;
				if (Date.now() > deadline) throw new Error(`${name}: no push containing "${needle}" (got: ${pushes.map((x) => x.body).join(" | ")})`);
				await Bun.sleep(20);
			}
		},
		async ack(...events) {
			await client.request("ack", { event_ids: events.map((e) => e.event_id) });
		},
		close: () => client.close(),
	};
}

/** A homeserver call as the appservice, optionally as a puppet. */
export async function asCall(t: TestChatd, method: string, path: string, user?: string, body?: unknown): Promise<{ status: number; json: any }> {
	const url = new URL(t.hs.url + path);
	if (user) url.searchParams.set("user_id", user);
	const r = await fetch(url, {
		method,
		headers: { authorization: `Bearer ${t.hs.asToken}`, "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await r.text();
	return { status: r.status, json: text ? JSON.parse(text) : {} };
}

export async function ownerCall(t: TestChatd, token: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
	const r = await fetch(t.hs.url + path, {
		method,
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await r.text();
	return { status: r.status, json: text ? JSON.parse(text) : {} };
}

export const puppet = (t: TestChatd, name: string) => `@${localpart(name)}:${t.hs.serverName}`;
export const q = encodeURIComponent;

export async function quiet(ms = 600): Promise<void> {
	await Bun.sleep(ms);
}
