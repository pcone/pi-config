/**
 * A chatd process against a test homeserver (tests/helpers/tuwunel.ts), on the
 * registration's loopback port, with its own socket and token file.
 */

import { mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatClient } from "../../apps/chatd/client.ts";
import { childEnv } from "./subagent-env.ts";
import { type TestHomeserver, startTuwunel } from "./tuwunel.ts";

const ENTRY = join(import.meta.dir, "chatd-entry.ts");

export interface TestChatd {
	hs: TestHomeserver;
	socket: string;
	dir: string;
	logFile: string;
	/** The env a client (CLI, extension) needs to reach this chatd. */
	clientEnv: Record<string, string>;
	start(env?: Record<string, string>): Promise<void>;
	/** SIGKILL: no shutdown, no answers. */
	kill(): Promise<void>;
	stop(): Promise<void>;
	restart(env?: Record<string, string>): Promise<void>;
	/** Send a control line to the test entry and wait for its answer line. */
	control(line: "sweep" | "cert" | "presence"): Promise<string>;
	log(): string;
	/** A client connection to the socket. */
	client(): Promise<ChatClient>;
	dispose(): Promise<void>;
}

export async function startChatdWithHomeserver(env: Record<string, string> = {}): Promise<TestChatd> {
	const hs = await startTuwunel();
	const dir = mkdtempSync(join(tmpdir(), "chatd-test-"));
	const socket = join(dir, "chatd.sock");
	const tokens = join(dir, "tokens");
	writeFileSync(tokens, `AS_TOKEN=${hs.asToken}\nHS_TOKEN=${hs.hsToken}\n`, { mode: 0o600 });
	const logFile = join(dir, "chatd.log");
	let proc: Bun.Subprocess<"pipe", "pipe", number> | undefined;
	let out = "";
	const daemonEnv = {
		CHATD_HOMESERVER: hs.url,
		CHATD_SERVER_NAME: hs.serverName,
		CHATD_LISTEN: `127.0.0.1:${hs.appservicePort}`,
		CHATD_SOCKET: socket,
		CHATD_TOKENS: tokens,
		CHATD_OWNER: hs.owner.userId,
	};
	let lastEnv = env;

	async function start(extra: Record<string, string> = lastEnv): Promise<void> {
		if (proc) throw new Error("chatd already running");
		lastEnv = extra;
		const log = openSync(logFile, "a");
		proc = Bun.spawn(["bun", ENTRY], {
			env: childEnv({ ...daemonEnv, ...extra }),
			stdin: "pipe",
			stdout: "pipe",
			stderr: log,
		}) as Bun.Subprocess<"pipe", "pipe", number>;
		out = "";
		const p = proc;
		void (async () => {
			const reader = p.stdout.getReader();
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				out += new TextDecoder().decode(value);
			}
		})();
		const deadline = Date.now() + 20_000;
		for (;;) {
			if (readFileSync(logFile, "utf8").includes(`listening on ${socket}`)) {
				const pending = readFileSync(logFile, "utf8").split("listening on").length - 1;
				if (pending >= starts + 1) break;
			}
			if (p.exitCode !== null) throw new Error(`chatd exited ${p.exitCode}: ${readFileSync(logFile, "utf8").slice(-2000)}`);
			if (Date.now() > deadline) throw new Error(`chatd did not start: ${readFileSync(logFile, "utf8").slice(-2000)}`);
			await Bun.sleep(25);
		}
		starts++;
	}
	let starts = 0;

	async function kill(): Promise<void> {
		if (!proc) return;
		const p = proc;
		proc = undefined;
		p.kill("SIGKILL");
		await p.exited;
	}

	async function stop(): Promise<void> {
		if (!proc) return;
		const p = proc;
		proc = undefined;
		p.kill("SIGTERM");
		await p.exited;
	}

	await start(env);
	return {
		hs,
		socket,
		dir,
		logFile,
		clientEnv: { CHATD_SOCKET: socket },
		start,
		kill,
		stop,
		async restart(extra) {
			await kill();
			await start(extra ?? lastEnv);
		},
		async control(line) {
			if (!proc) throw new Error("chatd is not running");
			const before = out.length;
			proc.stdin.write(`${line}\n`);
			proc.stdin.flush();
			const deadline = Date.now() + 30_000;
			while (!out.slice(before).includes("\n")) {
				if (Date.now() > deadline) throw new Error(`no answer to ${line}`);
				await Bun.sleep(20);
			}
			return out.slice(before).trim();
		},
		log: () => readFileSync(logFile, "utf8"),
		client: () => ChatClient.connect(socket),
		async dispose() {
			await stop();
			await hs.dispose();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
