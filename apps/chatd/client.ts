/**
 * A connection to chatd's Unix socket, shared by the `chat` CLI and the pi
 * extension. Requests are multiplexed by id; pushes go to `onPush`.
 */

import { connect, type Socket } from "node:net";
import { ChatError, type ErrorCode, type Pushed } from "./protocol.ts";

export class ChatClient {
	private seq = 0;
	private buf = "";
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private pushHandlers: ((p: Pushed) => void)[] = [];
	private closeHandlers: (() => void)[] = [];
	closed = false;

	private constructor(private readonly socket: Socket) {
		socket.setEncoding("utf8");
		socket.on("data", (d: string) => this.handleData(d));
		socket.on("close", () => this.handleClose());
		socket.on("error", () => {
			/* reported by close */
		});
	}

	static connect(path: string): Promise<ChatClient> {
		return new Promise((resolve, reject) => {
			const s = connect(path);
			const fail = (err: Error) => reject(new ChatError(`chatd is not reachable at ${path}: ${err.message}`, "refused"));
			s.once("error", fail);
			s.once("connect", () => {
				s.off("error", fail);
				resolve(new ChatClient(s));
			});
		});
	}

	onPush(fn: (p: Pushed) => void): void {
		this.pushHandlers.push(fn);
	}

	onClose(fn: () => void): void {
		this.closeHandlers.push(fn);
	}

	request<T = unknown>(verb: string, params: Record<string, unknown> = {}): Promise<T> {
		if (this.closed) return Promise.reject(new ChatError("the connection to chatd is closed", "refused"));
		const id = ++this.seq;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
			this.socket.write(`${JSON.stringify({ ...params, id, verb })}\n`);
		});
	}

	close(): void {
		this.socket.end();
		this.socket.destroy();
	}

	private handleData(d: string): void {
		this.buf += d;
		let i: number;
		while ((i = this.buf.indexOf("\n")) >= 0) {
			const line = this.buf.slice(0, i);
			this.buf = this.buf.slice(i + 1);
			if (!line) continue;
			const msg = JSON.parse(line) as { id?: number; ok?: boolean; result?: unknown; error?: string; code?: ErrorCode; push?: Pushed };
			if (msg.push) {
				for (const h of this.pushHandlers) h(msg.push);
				continue;
			}
			const p = msg.id === undefined ? undefined : this.pending.get(msg.id);
			if (!p) continue;
			this.pending.delete(msg.id!);
			if (msg.ok) p.resolve(msg.result);
			else p.reject(new ChatError(msg.error ?? "chatd error", msg.code));
		}
	}

	private handleClose(): void {
		if (this.closed) return;
		this.closed = true;
		for (const p of this.pending.values()) p.reject(new ChatError("chatd closed the connection", "refused"));
		this.pending.clear();
		for (const h of this.closeHandlers) h();
	}
}
