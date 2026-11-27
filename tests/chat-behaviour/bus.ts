/**
 * The transport-neutral test interface for peer messaging (WO-2026-107 §
 * Preparatory refactor). Every row under tests/chat-behaviour/ is written
 * against `Bus`; an adapter implements it over one transport. A row that
 * passes on one adapter and fails on another found a behaviour change.
 *
 * Peers are real: a pi peer is the transport's pi extension driven through a
 * stand-in ExtensionAPI, and a Claude peer is the transport's CLI run as
 * Claude Code hooks run it, under a stand-in `claude` process.
 */

import type { Wait } from "../../extensions/lib/waits.ts";

export type Kind = "pi" | "claude" | "subagent";

export interface Injected {
	text: string;
	deliverAs: "steer" | "followUp";
}

export interface SendOptions {
	expectReply?: boolean;
	followUp?: boolean;
	requireOnline?: boolean;
	/** The id of the message this one answers (a relayed reply). */
	replyTo?: string;
}

export interface ConnectOptions {
	/** pi: the session's display name (`pi --name`). */
	sessionName?: string;
	/** pi: leave `PI_PEER_NAME` unset, to exercise the identity fallbacks. */
	noEnvName?: boolean;
	sessionId?: string;
	sessionFile?: string;
	cwd?: string;
	/** pi: replaces the injection; a throw is a failed injection. Default: record it. */
	inject?: (text: string, deliverAs: "steer" | "followUp") => void;
	/** pi: make `getSessionId` throw, an init failure. */
	failInit?: boolean;
}

export interface CliResult {
	code: number;
	out: string;
	err: string;
}

export interface Running {
	/** Resolves when the command exits; code -1 when the session's process went first. */
	readonly exited: Promise<CliResult>;
	/** Resolves once the command's process is gone, with what it printed. */
	gone(): Promise<{ out: string; err: string }>;
	kill(): void;
}

export interface PiPeer {
	readonly kind: "pi" | "subagent";
	/** The name the transport resolved for this session. */
	readonly name: string;
	/** Every injected message, in order (failed injections excluded). */
	readonly injected: Injected[];
	/** Notifications the extension raised. */
	readonly notices: { message: string; level?: string }[];
	/** Emit a pi event to the extension (`message_end`, `agent_settled`, …). */
	emit(event: string, payload?: Record<string, unknown>): Promise<void>;
	/** The branch the extension sees at `agent_settled`. */
	branch: unknown[];
	/** This session's derived `peer` waits. */
	waits(): Wait[];
	/** Call one of the extension's tools by its neutral role. */
	tool(role: "send" | "who", params: Record<string, unknown>): Promise<{ text: string; details?: unknown }>;
}

export interface ClaudePeer {
	readonly kind: "claude";
	readonly name: string;
	readonly sessionId: string;
	/** Run `hook <event>` with this session's hook input. */
	hook(event: string, extra?: Record<string, unknown>): Promise<CliResult>;
	/** Run a CLI subcommand to completion, as this session's Bash tool would. */
	run(args: string[], stdin?: string): Promise<CliResult>;
	/** Start a CLI subcommand that blocks, as a background Bash command. */
	spawn(args: string[]): Running;
	/** The CLI arguments naming this session as sender (`--from <name>`). */
	readonly from: string[];
	/** The session's Claude Code process exits. */
	exit(): Promise<void>;
}

export type Peer = PiPeer | ClaudePeer;

/** A real agent session (LIVE-NETWORK rows). */
export interface LivePeer {
	readonly name: string;
	prompt(message: string): Promise<void>;
	settled(timeoutMs?: number): Promise<void>;
	/** The user messages on its branch, injected ones included. */
	userTexts(): string[];
}

export interface Bus {
	readonly name: string;
	/** Per-row reset: disconnect every peer from the previous row. */
	reset(): Promise<void>;
	/**
	 * Connect a session. `peer` is the pi session's `PI_PEER_NAME`, or the Claude
	 * session's id (its name is `claude-<id>`).
	 */
	connect(peer: string, kind: "pi" | "subagent", options?: ConnectOptions): Promise<PiPeer>;
	connect(peer: string, kind: "claude", options?: ConnectOptions): Promise<ClaudePeer>;
	/** A real agent session with the transport's extension, holding the given tool roles. */
	connectLive(peer: string, tools: Array<"send" | "who">): Promise<LivePeer>;
	/** The transport's tool name for a role, as a prompt names it. */
	toolName(role: "send" | "who"): string;
	/** Send as `from`. Throws (pi) or exits non-zero (Claude) on a refused send. */
	send(from: Peer, to: string, text: string, options?: SendOptions): Promise<{ text: string; code: number; id?: string }>;
	/** The id of the newest message `from` sent to `to`, for a row that answers it. */
	sentId(from: Peer, to: string): Promise<string>;
	/**
	 * What reached `peer`. pi: the injected messages so far. Claude: runs the
	 * prompt hook, which prints (and claims) its pending mail.
	 */
	pushed(peer: PiPeer): Injected[];
	pushed(peer: ClaudePeer): Promise<CliResult>;
	/** `send --wait <minutes>` from a Claude peer, running. */
	wait(from: ClaudePeer, to: string, text: string, minutes: number): Running;
	/** `watch` for a Claude peer, running. */
	watch(peer: ClaudePeer): Running;
	/** Resolves once others see `peer` as offline. */
	untilOffline(peer: string): Promise<void>;
	/** Resolves once a watch for `peer` is live. */
	untilWatching(peer: ClaudePeer): Promise<void>;
	/** The peer list as `peer` sees it: pi's tool text, or the CLI's output. */
	who(peer: Peer): Promise<string>;
	/** How others see `peer`: online, offline (known), or absent. */
	presence(peer: string): Promise<"online" | "offline" | "absent">;
	/** The session goes away: pi shuts down, a Claude session's process exits. It stays known. */
	disconnect(peer: Peer): Promise<void>;
	/** Restart the transport's daemon, if it has one. */
	restart(): Promise<void>;
	dispose(): Promise<void>;
}

/** A peer as the model-error mail's recipient rule sees it. */
export interface MailPeer {
	name: string;
	online: boolean;
	kind: Kind;
}

/** The model-error mail module over a recipient list the row controls, with a fake clock. */
export interface MailHarness {
	readonly warns: string[];
	readonly clock: { now: number };
	/** Mutable: a row adds a peer that appears later. */
	readonly peers: MailPeer[];
	onAssistantMessage(message: { stopReason: string; errorMessage?: string; provider: string; model: string }): void | Promise<void>;
	/** A delivery from `name` (the last-correspondent rule). */
	recordCorrespondent(name: string): void;
	/** The mail texts `peer` received. */
	inbox(peer: string): string[];
	/** A fresh module over the same persisted state: a session restart. */
	restart(): void;
}

export interface MailBody {
	peerName: string;
	sessionId: string;
	cwd: string;
	provider: string;
	model: string;
	status: number;
	errorMessage: string;
	suppressed: { count: number; since: number } | null;
}

export interface MailModule {
	MAIL_ERROR_CHARS: number;
	MAIL_THROTTLE_MS: number;
	modelHttpStatus(errorMessage: string | undefined): number | undefined;
	composeModelErrorMail(body: MailBody): string;
	harness(options: { self: string; sessionId: string; cwd: string; correspondent?: string; peers: MailPeer[] }): Promise<MailHarness>;
}

export interface Adapter {
	readonly name: string;
	setup(): Promise<Bus>;
	readonly mail: MailModule;
}

export async function until<T>(
	probe: () => T | undefined | Promise<T | undefined>,
	timeoutMs: number,
	what: string,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
		await Bun.sleep(25);
	}
}

/** Wait for an injected message containing `needle`. */
export function injectedWith(peer: PiPeer, needle: string, timeoutMs = 15_000): Promise<Injected> {
	return until(() => peer.injected.find((m) => m.text.includes(needle)), timeoutMs, `"${needle}" injected into ${peer.name}`);
}

let nameSeq = 0;
const runTag = Math.random().toString(36).slice(2, 6);

/** A peer name no earlier row used, so rows never see each other's mail. */
export function fresh(base: string): string {
	return `${base}-${runTag}${++nameSeq}`;
}
