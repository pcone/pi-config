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
import { ChatClient } from "./client.ts";
import { socketPath } from "./config.ts";
import { ChatError, type PeerEntry, type Pushed, type WaitResult } from "./protocol.ts";

const SELF = process.argv[1];
const RECONNECT_MS = 30_000;

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

function label(p: Pushed): string {
	const who = p.sender === "owner" ? "owner" : `peer:${p.sender}`;
	return p.direct || p.what === "invite" ? `[${who}]` : `[${who} in ${p.room}]`;
}

export function renderMail(self: string, events: Pushed[]): string {
	const blocks = [...events]
		.sort((a, b) => a.ts - b.ts)
		.map((e) => {
			const reply = e.expectReply ? `\n(${e.sender} asked for a reply: send one with \`${sendUsage(self, e.sender)}\`)` : "";
			return `${label(e)} ${e.body}${reply}`;
		});
	return `chat mail for ${self} (${events.length}):\n\n${blocks.join("\n\n")}`;
}

function emitContext(event: string, text: string): void {
	process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
}

async function ackAll(client: ChatClient, events: Pushed[]): Promise<void> {
	if (events.length > 0) await client.request("ack", { event_ids: events.map((e) => e.event_id) });
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
			const { events, watchLive } = await client.request<{ events: Pushed[]; watchLive: boolean }>("pending", { prompt: true });
			await ackAll(client, events);
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
	const sent = await client.request<{ event_id: string; room: string; to: string; online?: boolean }>("send", {
		to,
		text,
		expectReply,
		requireOnline: requireOnline || wait !== undefined,
	});
	console.log(`sent to ${sent.to}${sent.online === false ? " (offline: it reads this when it next connects)" : ""}`);
	if (wait === undefined) {
		client.close();
		return 0;
	}
	const deadline = Date.now() + wait * 60_000;
	let reconnected = false;
	for (;;) {
		try {
			const minutes = Math.max((deadline - Date.now()) / 60_000, 0.001);
			const r = await client.request<WaitResult>("wait", { event_id: sent.event_id, room: sent.room, minutes });
			if (r.outcome === "reply") {
				await ackAll(client, r.events);
				client.close();
				console.log(renderMail(self, r.events.length > 0 ? r.events : [r.reply]));
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
			if (!(err instanceof ChatError) || err.code !== "refused" || reconnected) throw err;
			// chatd restarted: reconnect once, within 30 s, and re-register the same ask.
			reconnected = true;
			client = await reconnect(id);
		}
	}
}

async function reconnect(id: Identity): Promise<ChatClient> {
	const until = Date.now() + RECONNECT_MS;
	for (;;) {
		try {
			return await open(id, true);
		} catch (err) {
			if (Date.now() > until) throw new Exit(1, `chat: chatd did not come back within 30 s: ${(err as Error).message}`);
			await Bun.sleep(500);
		}
	}
}

async function watch(args: string[]): Promise<number> {
	const { self, rest } = parseFrom(args);
	if (rest.length > 0) throw new Exit(1, "usage: chat watch --from <name>");
	const client = await open(identityFrom(self), false);
	const parent = process.ppid;
	let reparented = false;
	const tick = setInterval(() => {
		if (process.ppid !== parent) {
			reparented = true;
			client.close();
		}
	}, 1_000);
	try {
		const r = await client.request<{ events: Pushed[] }>("watch");
		await ackAll(client, r.events);
		console.log(renderMail(self, r.events));
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
		console.log(`${p.name} (${p.online ? "online" : "offline"}, ${p.kind}) "${p.displayName}"${p.status ? ` — ${p.status}` : ""}`);
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
