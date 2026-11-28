#!/usr/bin/env bun
/**
 * `chat`: a Claude Code session's door to chatd, run from its hooks and its
 * Bash tool (docs/design/chat.md § The chat CLI). It talks only to chatd's
 * local socket: no network call, no credential, nothing under ~/.claude.
 *
 *   chat hook session-start|prompt|session-end|notification   (stdin: hook input)
 *   chat send --from claude-<sid> [--reply] [--require-online] [--wait <minutes>] <to> <text | ->
 *   chat read --from <name> <room> [--since <event>] [--limit <n>]
 *   chat rooms --from <name> [create <name> [topic] | join <room> | leave <room> | level <room> all|mentions]
 *   chat who --from <name>
 *   chat watch --from <name>   (run in background; exits when mail arrives)
 *
 * Delivery is at-most-once: a hook, a watch or a reply-wait acks what it
 * takes before printing it (decision external-tools/012).
 */

import { readFileSync } from "node:fs";
import { ChatClient, reconnectWindowMs, reconnectWithin } from "./client.ts";
import { socketPath } from "./config.ts";
import { type AckResult, ChatError, type PeerEntry, type Pushed, type WaitResult, mailLabel, whereToRead } from "./protocol.ts";

const SELF = process.argv[1];

class Exit extends Error {
	constructor(
		readonly code: number,
		message = "",
	) {
		super(message);
	}
}

/** The session's Claude Code process: the nearest ancestor whose command is `claude` (WO-2026-107 P3). */
export function claudeAncestor(start = process.pid): number {
	let pid = start;
	for (let i = 0; i < 64 && pid > 1; i++) {
		let comm: string;
		let stat: string;
		try {
			comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
			stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		} catch {
			break;
		}
		if (comm === "claude" && pid !== process.pid) return pid;
		pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
	}
	throw new Exit(1, "chat: no `claude` process above this one; run it from a Claude Code session");
}

function sidOf(name: string): string {
	if (!name.startsWith("claude-")) throw new Exit(1, `chat: --from ${name} is not a Claude session's name (claude-<session id>)`);
	return name.slice("claude-".length);
}

interface Identity {
	name: string;
	session: string;
	cwd: string;
	model?: string;
}

/** Connect and identify. `register` makes the registration (the hooks); without it, one must exist. */
async function open(id: Identity, register: boolean): Promise<ChatClient> {
	const client = await ChatClient.connect(socketPath());
	await client.request("hello", {
		peer: id.name,
		kind: "claude",
		session: id.session,
		cwd: id.cwd,
		model: id.model,
		claudePid: claudeAncestor(),
		register,
	});
	return client;
}

const cmd = (args: string) => `bun ${SELF} ${args}`;
const sendUsage = (self: string, to = "<peer>") => cmd(`send --from ${self} ${to} '<text>'`);
const watchCommand = (self: string) => cmd(`watch --from ${self}`);

export function renderMail(self: string, events: Pushed[]): string {
	const blocks = [...events]
		.sort((a, b) => a.ts - b.ts)
		.map((e) => {
			const reply = e.expectReply ? `\n(${e.sender} asked for a reply: send one with \`${sendUsage(self, e.sender)}\`)` : "";
			return `${mailLabel(e)} ${e.body}${reply}`;
		});
	return `chat mail for ${self} (${events.length}):\n\n${blocks.join("\n\n")}`;
}

function emitContext(event: string, text: string): void {
	process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
}

/**
 * Ack, and keep only the events this call acked. An id that comes back
 * `already` was taken by a racing reader (a prompt hook and a watch), which
 * prints it: at-most-once means one of them does.
 */
async function ackAll(client: ChatClient, events: Pushed[]): Promise<Pushed[]> {
	if (events.length === 0) return [];
	const r = await client.request<AckResult>("ack", { event_ids: events.map((e) => e.event_id) });
	const mine = new Set(r.acked);
	return events.filter((e) => mine.has(e.event_id));
}

async function hook(event: string | undefined): Promise<void> {
	if (!["session-start", "prompt", "session-end", "notification"].includes(event ?? "")) {
		throw new Exit(1, `chat: unknown hook subcommand ${JSON.stringify(event)} (session-start, prompt, session-end, notification)`);
	}
	const input = JSON.parse(readFileSync(0, "utf8")) as {
		session_id?: string;
		cwd?: string;
		model?: string;
		message?: string;
		notification_type?: string;
	};
	if (typeof input.session_id !== "string" || !input.session_id) throw new Exit(1, "chat: hook input has no session_id");
	const self = `claude-${input.session_id}`;
	const id: Identity = { name: self, session: input.session_id, cwd: input.cwd ?? process.cwd(), model: input.model };
	switch (event) {
		case "session-start": {
			const client = await open(id, true);
			client.close();
			emitContext(
				"SessionStart",
				`chat: this session is \`${self}\` on the peers' chat. DMs and @mentions of it arrive with the user's next prompt, or wake its watch. ` +
					`Send: \`${sendUsage(self)}\` (\`<to>\` is a peer, \`owner\`, or a \`#room\`; text \`-\` reads stdin; \`--reply\` asks for an answer; ` +
					"`--require-online` fails instead of leaving it for later; `--wait <minutes>` (run in background) waits for the reply). " +
					`Start a watch in the background (Bash run_in_background): \`${watchCommand(self)}\`; it exits when mail arrives: handle it, then start it again. ` +
					`Peers: \`${cmd(`who --from ${self}`)}\`. Rooms: \`${cmd(`rooms --from ${self}`)}\`.`,
			);
			return;
		}
		case "prompt": {
			const client = await open(id, true);
			const pending = await client.request<{ events: Pushed[]; watchLive: boolean }>("pending", { prompt: true });
			const events = await ackAll(client, pending.events);
			const { watchLive } = pending;
			client.close();
			if (events.length === 0) return;
			const parts = [renderMail(self, events)];
			if (!watchLive) {
				parts.push(
					"chat: no watch is running for this session. Start one in the background " +
						`(Bash run_in_background): \`${watchCommand(self)}\`, and start it again after each exit.`,
				);
			}
			emitContext("UserPromptSubmit", parts.join("\n\n"));
			return;
		}
		case "session-end": {
			const client = await open(id, false);
			await client.request("bye");
			client.close();
			return;
		}
		case "notification": {
			const client = await open(id, false);
			await client.request("notify", { type: input.notification_type ?? "", message: input.message ?? "" });
			client.close();
			return;
		}
	}
}

function parseFrom(args: string[]): { self: string; rest: string[] } {
	const i = args.indexOf("--from");
	if (i < 0 || !args[i + 1]) throw new Exit(1, "chat: --from <name> is required");
	const self = args[i + 1];
	return { self, rest: [...args.slice(0, i), ...args.slice(i + 2)] };
}

function identityFrom(self: string): Identity {
	return { name: self, session: sidOf(self), cwd: process.cwd() };
}

function parseMinutes(value: string | undefined): number {
	const minutes = Number(value);
	if (!Number.isFinite(minutes) || minutes <= 0) throw new Exit(1, "chat send: --wait needs a positive number of minutes");
	return minutes;
}

async function send(args: string[]): Promise<number> {
	const { self, rest } = parseFrom(args);
	let expectReply = false;
	let requireOnline = false;
	let wait: number | undefined;
	const pos: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (a === "--reply") expectReply = true;
		else if (a === "--require-online") requireOnline = true;
		else if (a === "--wait") wait = parseMinutes(rest[++i]);
		else pos.push(a);
	}
	if (pos.length < 2) throw new Exit(1, "usage: chat send --from <name> [--reply] [--require-online] [--wait <minutes>] <to> <text | ->");
	const [to] = pos;
	if (wait !== undefined && (to.includes(",") || to === "*" || to.startsWith("#") || to === "owner")) {
		throw new Exit(1, "chat send: --wait takes one peer");
	}
	const text = pos[1] === "-" && pos.length === 2 ? readFileSync(0, "utf8").trim() : pos.slice(1).join(" ");
	if (!text) throw new Exit(1, "chat send: empty message");
	const id = identityFrom(self);
	let client = await open(id, false);
	let sent: { event_id: string; room: string; to: string; online?: boolean };
	try {
		sent = await client.request("send", { to, text, expectReply, requireOnline: requireOnline || wait !== undefined });
	} catch (err) {
		client.close();
		// § 4's table: a wait whose target is offline or unknown exits 3 (WO-2026-107 departure 12).
		if (wait !== undefined && err instanceof ChatError && (err.code === "offline" || err.code === "unknown-peer")) {
			console.error(`chat send: ${err.message}`);
			return 3;
		}
		throw err;
	}
	console.log(`sent to ${sent.to}${sent.online === false ? " (offline: it reads this when it next connects)" : ""}`);
	if (wait === undefined) {
		client.close();
		return 0;
	}
	const deadline = Date.now() + wait * 60_000;
	let resumed = false;
	for (;;) {
		try {
			const minutes = Math.max((deadline - Date.now()) / 60_000, 0.001);
			const r = await client.request<WaitResult>("wait", { event_id: sent.event_id, room: sent.room, minutes, resumed });
			if (r.outcome === "reply") {
				const mine = await ackAll(client, r.events);
				client.close();
				// The reply itself, unless a racing reader took the room's events with it.
				const show = r.events.length === 0 ? [r.reply] : mine;
				if (show.length > 0) console.log(renderMail(self, show));
				else console.log(`chat: the reply from ${sent.to} was shown at the prompt`);
				return 0;
			}
			client.close();
			if (r.outcome === "offline") {
				console.log(`peer ${r.target} is no longer online; no reply`);
				return 3;
			}
			const log = r.status ? ` Session log: ${r.status}` : "";
			console.log(`no reply from ${r.target} after ${wait} min; peer still online. Ask it for a progress update with another --wait.${log}`);
			return 4;
		} catch (err) {
			if (!(err instanceof ChatError) || err.code !== "refused") throw err;
			// chatd went away: one reconnect window per drop, then re-register the same ask.
			try {
				client = await reconnectWithin(() => open(id, true), reconnectWindowMs());
				resumed = true;
			} catch (gone) {
				throw new Exit(1, `chat: ${(gone as Error).message}`);
			}
		}
	}
}

async function watch(args: string[]): Promise<number> {
	const { self, rest } = parseFrom(args);
	if (rest.length > 0) throw new Exit(1, "usage: chat watch --from <name>");
	let client: ChatClient;
	try {
		client = await open(identityFrom(self), false);
	} catch (err) {
		// Session gone before the watch began: registration ended, or no Claude process above.
		if ((err instanceof ChatError && err.code === "gone") || (err instanceof Exit && err.message.includes("no `claude` process"))) {
			console.log(`chat: ${err.message}; watch exiting`);
			return 3;
		}
		throw err;
	}
	const parent = process.ppid;
	let reparented = false;
	const tick = setInterval(() => {
		if (process.ppid !== parent) {
			reparented = true;
			client.close();
		}
	}, 1_000);
	try {
		let mine: Pushed[] = [];
		// Events a racing prompt hook took first are not this watch's: wait again.
		while (mine.length === 0) {
			const r = await client.request<{ events: Pushed[] }>("watch");
			mine = await ackAll(client, r.events);
		}
		console.log(renderMail(self, mine));
		console.log(`chat: handle the mail above, then start the watch again (Bash run_in_background): \`${watchCommand(self)}\``);
		return 0;
	} catch (err) {
		if (reparented) {
			console.log(`chat: ${self}'s parent process is gone; watch exiting`);
			return 3;
		}
		if (err instanceof ChatError && err.code === "watch-live") {
			console.error(`chat: ${err.message}`);
			return 2;
		}
		if (err instanceof ChatError && (err.code === "gone" || err.code === "refused")) {
			console.log(`chat: ${err.message}; watch exiting`);
			return 3;
		}
		throw err;
	} finally {
		clearInterval(tick);
		client.close();
	}
}

async function who(args: string[]): Promise<void> {
	const { self } = parseFrom(args);
	const client = await open(identityFrom(self), false);
	const peers = await client.request<PeerEntry[]>("who");
	client.close();
	if (peers.length === 0) console.log("no peers");
	for (const p of peers) {
		const auto = p.autoreply === undefined ? "" : `, auto-reply ${p.autoreply ? "on" : "off"}`;
		const where = whereToRead(p);
		console.log(`${p.name} (${p.online ? "online" : "offline"}, ${p.kind}${auto}) "${p.displayName}" session ${p.session || "?"}${where ? ` — ${where}` : ""}`);
	}
}

async function read(args: string[]): Promise<void> {
	const { self, rest } = parseFrom(args);
	const params: Record<string, unknown> = {};
	const pos: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		if (rest[i] === "--since") params.since = rest[++i];
		else if (rest[i] === "--limit") params.limit = Number(rest[++i]);
		else pos.push(rest[i]);
	}
	if (pos.length !== 1) throw new Exit(1, "usage: chat read --from <name> <room> [--since <event>] [--limit <n>]");
	const client = await open(identityFrom(self), false);
	const r = await client.request<{ room: string; events: Pushed[] }>("read", { ...params, room: pos[0] });
	client.close();
	console.log(`${r.room} (${r.events.length}):`);
	for (const e of r.events) console.log(`${new Date(e.ts).toISOString()} ${e.sender}: ${e.body} [${e.event_id}]`);
}

async function rooms(args: string[]): Promise<void> {
	const { self, rest } = parseFrom(args);
	const [action = "list", ...more] = rest;
	const params: Record<string, unknown> = { action };
	if (action === "create") Object.assign(params, { name: more[0], topic: more.slice(1).join(" ") || undefined });
	else if (action === "join" || action === "leave") params.room = more[0];
	else if (action === "level") Object.assign(params, { room: more[0], level: more[1] });
	else if (action !== "list") throw new Exit(1, "usage: chat rooms --from <name> [create <name> [topic] | join <room> | leave <room> | level <room> all|mentions]");
	const client = await open(identityFrom(self), false);
	const r = await client.request<Record<string, unknown>>("rooms", params);
	client.close();
	console.log(JSON.stringify(r, null, 2));
}

if (import.meta.main) {
	const [sub, ...args] = process.argv.slice(2);
	try {
		if (sub === "hook") await hook(args[0]);
		else if (sub === "send") process.exitCode = await send(args);
		else if (sub === "watch") process.exitCode = await watch(args);
		else if (sub === "who") await who(args);
		else if (sub === "read") await read(args);
		else if (sub === "rooms") await rooms(args);
		else throw new Exit(1, "usage: chat <hook <event> | send … | read … | rooms … | who … | watch --from <name>>");
	} catch (err) {
		console.error(err instanceof Exit ? err.message : `chat: ${(err as Error).message}`);
		process.exitCode = err instanceof Exit ? err.code : 1;
	}
	process.exit(process.exitCode ?? 0);
}
