/**
 * A real Tuwunel homeserver for the chat rows (WO-2026-107 § Behaviour rows,
 * Harness). One per test file: the pinned release binary on a free loopback
 * port, a fresh database, and an appservice registration pointing at a chatd
 * on another loopback port. Plain HTTP on loopback only.
 *
 * The binary is cached at ~/.cache/pi-config/tuwunel/v2.1.0/ by `bin/setup`.
 * A missing or mismatched binary fails with the fetch command.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "./subagent-env.ts";

export const TUWUNEL_VERSION = "v2.1.0";
export const TUWUNEL_ASSET = "v2.1.0-release-default-x86_64-v1-linux-gnu-tuwunel.zst";
export const TUWUNEL_SHA256 = "05c686aeae2c8ef01d288de844347c0630cd982862b5f9cbb8972cd20dc424a4";

export function tuwunelCacheDir(home = homedir()): string {
	return join(home, ".cache", "pi-config", "tuwunel", TUWUNEL_VERSION);
}

const fetchHint = (dir: string) =>
	`fetch it with \`bash bin/setup\`, or: cd ${dir} && ` +
	`gh release download ${TUWUNEL_VERSION} -R matrix-construct/tuwunel -p '${TUWUNEL_ASSET}' && ` +
	`zstd -d ${TUWUNEL_ASSET} -o tuwunel && chmod +x tuwunel`;

const verified = new Set<string>();

/** The release ships for Linux x86_64 only: elsewhere the chat rows skip (bin/setup says so). */
export const TUWUNEL_PLATFORM_OK = process.platform === "linux" && process.arch === "x64";

/** The cached binary's path, after checking the release archive's sha256 once per process. */
export function tuwunelBinary(home = homedir()): string {
	const dir = tuwunelCacheDir(home);
	const archive = join(dir, TUWUNEL_ASSET);
	const binary = join(dir, "tuwunel");
	if (verified.has(binary)) return binary;
	if (!existsSync(archive) || !existsSync(binary)) {
		throw new Error(`Tuwunel ${TUWUNEL_VERSION} is not cached at ${dir}: ${fetchHint(dir)}`);
	}
	const sum = createHash("sha256").update(readFileSync(archive)).digest("hex");
	if (sum !== TUWUNEL_SHA256) {
		throw new Error(`${archive} has sha256 ${sum}, expected ${TUWUNEL_SHA256}: delete it and ${fetchHint(dir)}`);
	}
	verified.add(binary);
	return binary;
}

/** A free loopback TCP port. */
export function freePort(): number {
	const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
	const port = server.port;
	server.stop(true);
	return port;
}

export interface TestHomeserver {
	/** `http://127.0.0.1:<port>` */
	url: string;
	serverName: string;
	asToken: string;
	hsToken: string;
	/** Where the registration says chatd listens. */
	appservicePort: number;
	owner: { userId: string; password: string };
	dir: string;
	/** Combined server log, for assertions that nothing leaked into it. */
	logFile: string;
	start(): Promise<void>;
	stop(): Promise<void>;
	/** Stop, delete the state directory. */
	dispose(): Promise<void>;
}

export const TEST_SERVER_NAME = "test.local";

export async function startTuwunel(): Promise<TestHomeserver> {
	const binary = tuwunelBinary();
	const dir = await mkdtemp(join(tmpdir(), "tuwunel-"));
	const port = freePort();
	const appservicePort = freePort();
	const asToken = randomBytes(24).toString("hex");
	const hsToken = randomBytes(24).toString("hex");
	const ownerPassword = randomBytes(12).toString("hex");
	mkdirSync(join(dir, "as"));
	writeFileSync(
		join(dir, "as", "chatd.yaml"),
		[
			"id: chatd",
			`url: http://127.0.0.1:${appservicePort}`,
			`as_token: ${asToken}`,
			`hs_token: ${hsToken}`,
			"sender_localpart: pi-system",
			"namespaces:",
			"  users:",
			"    - exclusive: true",
			`      regex: '@pi-.*:${TEST_SERVER_NAME.replace(".", "\\.")}'`,
			// Puppets create `#peers`, `#dm-mirror` and agents' own rooms by alias;
			// Tuwunel refuses an appservice user an alias outside its namespace.
			"  aliases:",
			"    - exclusive: false",
			`      regex: '#.*:${TEST_SERVER_NAME.replace(".", "\\.")}'`,
			"rate_limited: false",
			"",
		].join("\n"),
		{ mode: 0o600 },
	);
	const config = join(dir, "tuwunel.toml");
	writeFileSync(
		config,
		[
			"[global]",
			`server_name = "${TEST_SERVER_NAME}"`,
			`database_path = "${join(dir, "db")}"`,
			'address = ["127.0.0.1"]',
			`port = ${port}`,
			"allow_registration = false",
			"allow_federation = false",
			`appservice_dir = "${join(dir, "as")}"`,
			"",
		].join("\n"),
	);
	const logFile = join(dir, "tuwunel.log");
	const url = `http://127.0.0.1:${port}`;
	let proc: Bun.Subprocess | undefined;
	let first = true;

	async function start(): Promise<void> {
		if (proc) throw new Error("tuwunel already running");
		const args = [binary, "-c", config];
		// The owner's account exists from the first start: registration is closed,
		// so it is made by the admin console, as on the VPS.
		if (first) args.push("--execute", `users create-user scott ${ownerPassword}`);
		first = false;
		const log = openSync(logFile, "a");
		proc = Bun.spawn(args, { stdout: log, stderr: log, stdin: "ignore", env: childEnv() });
		const deadline = Date.now() + 15_000;
		for (;;) {
			try {
				const r = await fetch(`${url}/_matrix/client/versions`);
				if (r.ok) break;
			} catch {
				/* not listening yet */
			}
			if (proc.exitCode !== null) throw new Error(`tuwunel exited ${proc.exitCode}; log: ${logFile}`);
			if (Date.now() > deadline) throw new Error(`tuwunel not ready after 15 s; log: ${logFile}`);
			await Bun.sleep(25);
		}
	}

	async function stop(): Promise<void> {
		if (!proc) return;
		const p = proc;
		proc = undefined;
		p.kill("SIGTERM");
		const killed = setTimeout(() => p.kill("SIGKILL"), 10_000);
		await p.exited;
		clearTimeout(killed);
	}

	try {
		await start();
	} catch (err) {
		// A failed start leaves no server and no directory behind.
		if (proc) {
			const p = proc;
			proc = undefined;
			p.kill("SIGKILL");
			await p.exited;
		}
		rmSync(dir, { recursive: true, force: true });
		throw err;
	}
	const hs: TestHomeserver = {
		url,
		serverName: TEST_SERVER_NAME,
		asToken,
		hsToken,
		appservicePort,
		owner: { userId: `@scott:${TEST_SERVER_NAME}`, password: ownerPassword },
		dir,
		logFile,
		start,
		stop,
		async dispose() {
			await stop();
			rmSync(dir, { recursive: true, force: true });
		},
	};
	try {
		await waitForOwner(hs);
	} catch (err) {
		await hs.dispose();
		throw err;
	}
	return hs;
}

/** The console command runs after startup; wait until the owner can log in. */
async function waitForOwner(hs: TestHomeserver): Promise<void> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const r = await fetch(`${hs.url}/_matrix/client/v3/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				type: "m.login.password",
				identifier: { type: "m.id.user", user: "scott" },
				password: hs.owner.password,
			}),
		});
		if (r.ok) return;
		if (Date.now() > deadline) throw new Error(`owner login failed (${r.status}); log: ${hs.logFile}`);
		await Bun.sleep(50);
	}
}

/** Log the owner in with a password, as Element does; returns an access token. */
export async function ownerLogin(hs: TestHomeserver): Promise<string> {
	const r = await fetch(`${hs.url}/_matrix/client/v3/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			type: "m.login.password",
			identifier: { type: "m.id.user", user: "scott" },
			password: hs.owner.password,
		}),
	});
	if (!r.ok) throw new Error(`owner login: ${r.status} ${await r.text()}`);
	return ((await r.json()) as { access_token: string }).access_token;
}
