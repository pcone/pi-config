/**
 * A pi session stand-in for a transport's pi extension: the ExtensionAPI
 * surface the extension uses, with `sendUserMessage` as the observed
 * injection, and a session context. Shared by every adapter, so the pi side of
 * each row runs the same harness against each extension.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Wait } from "../../../extensions/lib/waits.ts";
import type { ConnectOptions, Injected, PiPeer } from "../bus.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type Tool = { name: string; execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; details?: unknown }> };

export interface PiStandin {
	peer: PiPeer;
	shutdown(): Promise<void>;
}

export async function makePiPeer(spec: {
	factory: (api: ExtensionAPI) => void;
	/** `PI_PEER_NAME` while the session starts, or undefined to leave it unset. */
	envName: string | undefined;
	kind: "pi" | "subagent";
	options: ConnectOptions;
	/** Extra env while the session starts (a subagent's markers, the transport's address). */
	env?: Record<string, string>;
	roles: { send: string; who: string };
	selfName: (tool: PiPeer["tool"]) => Promise<string>;
	waits: () => Wait[];
}): Promise<PiStandin> {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, Tool>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> | void }>();
	const injected: Injected[] = [];
	const notices: { message: string; level?: string }[] = [];
	const options = spec.options;
	const inject =
		options.inject ??
		((text: string, deliverAs: "steer" | "followUp") => {
			injected.push({ text, deliverAs });
		});
	const api = {
		events: { emit: () => {}, on: () => {} },
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool: (def: Tool) => tools.set(def.name, def),
		registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> | void }) => commands.set(name, def),
		sendUserMessage: (text: string, opts?: { deliverAs?: "steer" | "followUp" }) => {
			const deliverAs = opts?.deliverAs ?? "steer";
			inject(text, deliverAs);
			if (options.inject) injected.push({ text, deliverAs });
		},
	} as unknown as ExtensionAPI;

	const peer = {
		kind: spec.kind,
		name: "",
		injected,
		notices,
		branch: [] as unknown[],
		async emit(event: string, payload: Record<string, unknown> = {}) {
			for (const h of handlers.get(event) ?? []) await h({ type: event, ...payload }, ctx);
		},
		waits: spec.waits,
		async command(name: string, args = "") {
			const c = commands.get(name);
			if (!c) throw new Error(`command ${name} not registered`);
			await c.handler(args, ctx);
		},
		async tool(role: string, params: Record<string, unknown>) {
			const name = (spec.roles as Record<string, string>)[role] ?? role;
			const tool = tools.get(name);
			if (!tool) throw new Error(`tool ${name} not registered`);
			const r = await tool.execute("call-bus", params, undefined, undefined, ctx);
			return { text: r.content.map((c) => c.text).join("\n"), details: r.details };
		},
	};
	const ctx = {
		cwd: options.cwd ?? "/w",
		ui: { notify: (message: string, level?: string) => notices.push({ message, level }) },
		sessionManager: {
			getSessionFile: () => options.sessionFile,
			getSessionName: () => options.sessionName,
			getSessionId: () => {
				if (options.failInit) throw new Error("getSessionId failed (test)");
				return options.sessionId ?? "bus-session";
			},
			getBranch: () => peer.branch,
		},
	};

	spec.factory(api);
	const saved = new Map<string, string | undefined>();
	const env = { PI_PEER_NAME: spec.envName, ...(spec.env ?? {}) };
	for (const [k, v] of Object.entries(env)) {
		saved.set(k, process.env[k]);
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		await peer.emit("session_start");
	} catch (err) {
		// An init-failure row reads what the failed session saw.
		throw Object.assign(err as Error, { standin: peer as PiPeer });
	} finally {
		for (const [k, v] of saved) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
	peer.name = await spec.selfName(peer.tool);
	return {
		peer: peer as PiPeer,
		shutdown: () => peer.emit("session_shutdown"),
	};
}
