/**
 * Runpod Bonsai — registers `runpod/bonsai25-27b-v1` ("Bonsai 2.5 27B (Runpod)"),
 * served by an on-demand Runpod pod (decisions/providers/001-runpod-bonsai.md).
 *
 * Each request resolves the pod named POD_NAME. When none is running it creates
 * one and waits for the server; boot.sh downloads the pinned build and model and
 * terminates the pod after its idle timeout, so standby costs nothing. Requests
 * then go to the pod through pi's own OpenAI-compatible client.
 *
 * Keys come from the macOS Keychain: `runpod-api-key` (Runpod REST) and
 * `bonsai-llama-api-key` (the pod's llama-server, also passed to new pods). The
 * Keychain is macOS-only, so on a machine without `security` the provider cannot
 * serve a request and says exactly that; a key source for Linux is an owner
 * question, not something this code guesses at.
 */

import {
	type Api,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	openAICompletionsApi,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROVIDER = "runpod";
const MODEL_ID = "bonsai25-27b-v1";
const POD_NAME = "pi-bonsai";
const RUNPOD_API = "https://api.runpod.io/v2";
const RUNPOD_KEY_ITEM = "runpod-api-key";
const LLAMA_KEY_ITEM = "bonsai-llama-api-key";
const STATUS_KEY = "runpod-bonsai";

const WAKE_TIMEOUT_MS = 15 * 60_000;
const CREATE_ATTEMPTS = 5;
const CREATE_RETRY_MS = 10_000;
const POLL_MS = 5_000;
/** A health check younger than this skips the next one. */
const FRESH_MS = 30_000;
/** Serialises pod creation across pi processes (main session and subagents). */
const LOCK_PATH = join(homedir(), ".pi", "runpod-bonsai.lock");

const BOOT_SH = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "boot.sh"));

/** Create body for POST /v2/pods. Sizing and flags: boot.sh. */
function podSpec(llamaKey: string) {
	return {
		name: POD_NAME,
		cloud: "SECURE",
		image: "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404",
		gpu: { id: "NVIDIA GeForce RTX 4090", count: 1, minCudaVersion: "12.8" },
		disk: 20,
		ports: ["8080/http"],
		env: { BOOT_SH: BOOT_SH.toString("base64"), LLAMA_API_KEY: llamaKey, IDLE_MIN: "30" },
		entrypoint: ["/bin/bash", "-c"],
		cmd: ['echo "$BOOT_SH" | base64 -d > /root/boot.sh && exec bash /root/boot.sh'],
	};
}

export interface Pod {
	id: string;
	name: string;
	status: string;
	createdAt: string;
}

type KeyReader = (item: string) => string;

/** Read one Keychain item. `exec` is a seam so the two failure messages can be
 *  pinned without a Keychain on the machine running the tests. */
export function keychain(item: string, exec: typeof execFileSync = execFileSync): string {
	try {
		return exec("security", ["find-generic-password", "-s", item, "-w"], { encoding: "utf8" }).trim();
	} catch (err) {
		// No `security` binary is a different state from a missing item: the item may
		// exist and the platform simply cannot read it. Reporting "not found" there
		// sends the reader to add a password that a Linux box has nowhere to keep.
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
			throw new Error(
				`cannot read Keychain item "${item}": there is no \`security\` tool on PATH. This provider keeps its keys in the macOS Keychain (decisions/providers/001), so it cannot serve a request here`,
			);
		}
		// A locked Keychain, a denied ACL and a timeout land here too, so the reason
		// rides in the message: only the caller knows which of those it hit.
		const reason = err instanceof Error ? err.message : String(err);
		throw new Error(
			`cannot read Keychain item "${item}": ${reason.trim() || "the read failed"}. If the item is missing, add it with: security add-generic-password -s ${item} -a pi -w <key>`,
		);
	}
}

let readKey: KeyReader = (item) => keychain(item);

/** Test seam (@for-testing-only): replace the Keychain reader, so rows that are
 *  about pod convergence and retries do not need a Keychain to exist. */
export function _testSetKeyReader(reader: KeyReader | null): void {
	readKey = reader ?? ((item) => keychain(item));
}

async function runpod(method: string, path: string, signal?: AbortSignal, body?: unknown): Promise<any> {
	const res = await fetch(`${RUNPOD_API}${path}`, {
		method,
		signal,
		headers: { Authorization: `Bearer ${readKey(RUNPOD_KEY_ITEM)}`, "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	if (!res.ok) throw new RunpodError(`${method} ${path}`, res.status, text);
	return text ? JSON.parse(text) : undefined;
}

class RunpodError extends Error {
	constructor(
		request: string,
		readonly status: number,
		readonly body: string,
	) {
		super(`Runpod ${request} → ${status}: ${body.slice(0, 500)}`);
	}
}

const serverUrl = (podId: string) => `https://${podId}-8080.proxy.runpod.net`;

async function healthy(podId: string, signal?: AbortSignal): Promise<boolean> {
	try {
		const res = await fetch(`${serverUrl(podId)}/health`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) });
		return res.ok;
	} catch (err) {
		if (signal?.aborted) throw err;
		return false;
	}
}

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason); }, { once: true });
	});

let ui: ExtensionContext["ui"] | undefined;
const status = (text: string | undefined) => ui?.setStatus(STATUS_KEY, text);

let ready: { podId: string; checkedAt: number } | undefined;

/** Whether a process with this pid exists. EPERM means it exists under another user. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: any) {
		return err?.code === "EPERM";
	}
}

/**
 * Run fn holding the cross-process lock, which keeps concurrent sessions from
 * each creating a pod. The file holds its holder's pid; a lock whose holder has
 * exited is removed, so a crashed session cannot block the rest. Removal can
 * race a third process taking the lock; the duplicate pod that race can cause
 * is resolved by converge(), which is what guarantees one pod.
 */
export async function withLock<T>(lockPath: string, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
	for (;;) {
		try {
			const fd = openSync(lockPath, "wx");
			writeSync(fd, String(process.pid));
			closeSync(fd);
			break;
		} catch (err: any) {
			if (err?.code !== "EEXIST") throw err;
			let holder: number;
			try {
				holder = Number(readFileSync(lockPath, "utf8"));
			} catch {
				continue; // released meanwhile
			}
			// An empty file is a holder between open and write: wait for it.
			if (holder > 0 && !alive(holder)) {
				try { unlinkSync(lockPath); } catch { /* another waiter removed it */ }
				continue;
			}
			status("Bonsai: waiting for another session's pod start…");
			await sleep(2_000, signal);
		}
	}
	try {
		return await fn();
	} finally {
		try { unlinkSync(lockPath); } catch { /* removed as stale while fn ran */ }
	}
}

/** The pod every session uses: the oldest running pod named POD_NAME. */
export function winner(pods: Pod[]): Pod | undefined {
	return pods
		.filter((p) => p.name === POD_NAME && p.status === "RUNNING")
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
}

/**
 * After creating `mine`, keep only the winner. Every creator applies the same
 * rule, so racing sessions (a lost lock race, another machine) agree on one pod
 * and each deletes its own extra.
 */
export async function converge(mine: string, signal?: AbortSignal): Promise<string> {
	const { pods } = (await runpod("GET", "/pods", signal)) as { pods: Pod[] };
	const keep = winner(pods);
	if (!keep) throw new Error(`Bonsai pod ${mine} was created but is not listed as RUNNING.`);
	if (keep.id !== mine) {
		status(`Bonsai: another session started pod ${keep.id}; removing duplicate ${mine}`);
		await runpod("DELETE", `/pods/${mine}`, signal);
	}
	return keep.id;
}

async function waitHealthy(podId: string, started: number, signal?: AbortSignal): Promise<void> {
	while (!(await healthy(podId, signal))) {
		const pod: Pod = await runpod("GET", `/pods/${podId}`, signal);
		if (pod.status !== "RUNNING") throw new Error(`Bonsai pod ${podId} is ${pod.status}, not RUNNING. Its boot log is /root/boot.log.`);
		const elapsed = Date.now() - started;
		if (elapsed > WAKE_TIMEOUT_MS) throw new Error(`Bonsai pod ${podId} not serving after ${WAKE_TIMEOUT_MS / 60_000} min. Its boot log is /root/boot.log.`);
		status(`Bonsai: pod ${podId} booting (${Math.round(elapsed / 1000)}s)`);
		await sleep(POLL_MS, signal);
	}
}

/**
 * Create the pod. Runpod refuses a create with 400 when the host it picked has
 * no free 4090 at that moment ("does not have the resources"); a retry seconds
 * later usually lands elsewhere. Any other error, or the last refusal, fails.
 */
export async function createPod(signal?: AbortSignal, retryMs = CREATE_RETRY_MS): Promise<Pod> {
	for (let attempt = 1; ; attempt++) {
		status(`Bonsai: creating pod (RTX 4090)${attempt > 1 ? `, attempt ${attempt}/${CREATE_ATTEMPTS}` : ""}…`);
		try {
			return (await runpod("POST", "/pods", signal, podSpec(readKey(LLAMA_KEY_ITEM)))) as Pod;
		} catch (err) {
			const noCapacity = err instanceof RunpodError && err.status === 400 && /does not have the resources|no instances available/i.test(err.body);
			if (!noCapacity || attempt === CREATE_ATTEMPTS) throw err;
			await sleep(retryMs, signal);
		}
	}
}

/** The id of a running, serving Bonsai pod, creating one when none runs. */
async function ensurePod(signal?: AbortSignal): Promise<string> {
	if (ready && Date.now() - ready.checkedAt < FRESH_MS) return ready.podId;
	if (ready && (await healthy(ready.podId, signal))) {
		ready.checkedAt = Date.now();
		return ready.podId;
	}
	ready = undefined;
	const started = Date.now();
	try {
		const podId = await withLock(LOCK_PATH, signal, async () => {
			const { pods } = (await runpod("GET", "/pods", signal)) as { pods: Pod[] };
			// POD_NAME is reserved for this extension: a pod by that name that is not
			// running (exited, stopped by Runpod) is a dead instance, never reused.
			for (const p of pods.filter((p) => p.name === POD_NAME && p.status !== "RUNNING")) {
				status(`Bonsai: removing ${p.status} pod ${p.id}`);
				await runpod("DELETE", `/pods/${p.id}`, signal);
			}
			let podId = winner(pods)?.id;
			if (!podId) podId = await converge((await createPod(signal)).id, signal);
			await waitHealthy(podId, started, signal);
			return podId;
		});
		ready = { podId, checkedAt: Date.now() };
		return podId;
	} finally {
		status(undefined);
	}
}

function streamBonsai(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	(async () => {
		try {
			const podId = await ensurePod(options?.signal);
			const target = { ...model, api: "openai-completions", baseUrl: `${serverUrl(podId)}/v1` } as Model<"openai-completions">;
			for await (const event of openAICompletionsApi().streamSimple(target, context, options)) stream.push(event);
			stream.end();
		} catch (error) {
			stream.push({
				type: "error",
				reason: options?.signal?.aborted ? "aborted" : "error",
				error: {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: options?.signal?.aborted ? "aborted" : "error",
					errorMessage: error instanceof Error ? error.message : String(error),
					timestamp: Date.now(),
				},
			});
			stream.end();
		}
	})();
	return stream;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ui = ctx.ui;
	});

	pi.registerProvider(PROVIDER, {
		name: "Runpod",
		baseUrl: RUNPOD_API, // replaced per request with the live pod's URL
		apiKey: `!security find-generic-password -s ${LLAMA_KEY_ITEM} -w`,
		api: "runpod-bonsai",
		models: [
			{
				id: MODEL_ID,
				name: "Bonsai 2.5 27B (Runpod)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 229_376,
				maxTokens: 32_768,
				compat: {
					thinkingFormat: "qwen-chat-template",
					supportsDeveloperRole: false,
					supportsStore: false,
					supportsReasoningEffort: false,
					maxTokensField: "max_tokens",
				},
			},
		],
		streamSimple: streamBonsai,
	});
}
