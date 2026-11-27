/**
 * A real pi agent session with a transport's extension loaded, for the
 * LIVE-NETWORK rows: real billed model calls (openrouter/deepseek/deepseek-v4-flash,
 * authorized from the live `~/.pi/agent/auth.json`). `SessionManager.inMemory`,
 * so no transcript is persisted.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { disposeSessionLikeTheRuntime } from "../../helpers/session-teardown.ts";
import type { LivePeer } from "../bus.ts";

function text(entry: { message?: { content?: unknown } }): string {
	const content = entry.message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b: { type?: string }) => b.type === "text")
			.map((b: { text?: string }) => b.text ?? "")
			.join("\n");
	}
	return "";
}

export async function startLiveSession(spec: {
	name: string;
	extensionPath: string;
	tools: string[];
	/** Env while the session binds its extensions. */
	env: Record<string, string>;
}): Promise<LivePeer & { cleanup(): Promise<void> }> {
	const saved = new Map<string, string | undefined>();
	for (const [k, v] of Object.entries({ PI_PEER_NAME: spec.name, ...spec.env })) {
		saved.set(k, process.env[k]);
		process.env[k] = v;
	}
	const cwd = await mkdtemp(join(tmpdir(), "bus-live-cwd-"));
	const agentDir = await mkdtemp(join(tmpdir(), "bus-live-agent-"));
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
	const modelRuntime = await ModelRuntime.create({
		authPath: join(getAgentDir(), "auth.json"),
		modelsPath: join(getAgentDir(), "models.json"),
	});
	const model = modelRuntime.getModel("openrouter", "deepseek/deepseek-v4-flash");
	if (!model) throw new Error("Model openrouter/deepseek/deepseek-v4-flash not found");
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		additionalExtensionPaths: [spec.extensionPath],
		noSkills: true,
		noThemes: true,
		noPromptTemplates: true,
		noContextFiles: true,
		settingsManager,
		systemPromptOverride: () => "You are a coding assistant. Be concise and follow instructions precisely.",
	});
	await loader.reload();
	const exts = loader.getExtensions();
	const registered = exts.extensions.flatMap((e) => [...e.tools.keys()]);
	for (const t of spec.tools) {
		if (!registered.includes(t)) {
			throw new Error(`tool ${t} not registered. Errors: ${exts.errors.map((e) => e.error).join("; ")}`);
		}
	}
	const sessionManager = SessionManager.inMemory(cwd);
	const { session } = await createAgentSession({
		cwd,
		model,
		thinkingLevel: "off",
		modelRuntime,
		resourceLoader: loader,
		tools: spec.tools,
		sessionManager,
		settingsManager,
	});
	try {
		await session.bindExtensions({ mode: "rpc" });
	} finally {
		for (const [k, v] of saved) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
	return {
		name: spec.name,
		async prompt(message) {
			await session.prompt(message);
		},
		async settled(timeoutMs = 180_000) {
			const start = Date.now();
			let stable = 0;
			while (Date.now() - start < timeoutMs) {
				await Bun.sleep(200);
				if (session.isStreaming) stable = 0;
				else if (++stable >= 5) return;
			}
			throw new Error(`timed out waiting for ${spec.name} to settle`);
		},
		userTexts: () =>
			sessionManager
				.getEntries()
				.filter((e) => e.type === "message" && (e as { message?: { role?: string } }).message?.role === "user")
				.map((e) => text(e as { message?: { content?: unknown } })),
		async cleanup() {
			try {
				await disposeSessionLikeTheRuntime(session);
			} catch {}
			await rm(cwd, { recursive: true, force: true });
			await rm(agentDir, { recursive: true, force: true });
		},
	};
}
