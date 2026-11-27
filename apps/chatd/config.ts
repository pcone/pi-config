/**
 * chatd's configuration: the environment, with production defaults
 * (docs/design/chat.md § Configuration).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
	homeserver: string;
	serverName: string;
	listen: { host: string; port: number };
	socket: string;
	owner: string;
	tokensFile: string;
	asToken: string;
	hsToken: string;
}

/** The socket path clients and chatd agree on. */
export function socketPath(env: NodeJS.ProcessEnv = process.env): string {
	if (env.CHATD_SOCKET) return env.CHATD_SOCKET;
	if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, "chatd.sock");
	throw new Error("chatd: neither CHATD_SOCKET nor XDG_RUNTIME_DIR is set, so there is no socket path");
}

/** `KEY=value` lines; `#` comments and blank lines ignored. */
function readTokens(file: string): { asToken: string; hsToken: string } {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (err) {
		throw new Error(`chatd: cannot read the token file ${file}: ${(err as NodeJS.ErrnoException).code ?? err}`);
	}
	const values = new Map<string, string>();
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq < 0) continue;
		values.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
	}
	const asToken = values.get("AS_TOKEN");
	const hsToken = values.get("HS_TOKEN");
	const missing = [!asToken && "AS_TOKEN", !hsToken && "HS_TOKEN"].filter(Boolean);
	if (missing.length > 0) throw new Error(`chatd: the token file ${file} has no ${missing.join(" or ")}`);
	return { asToken: asToken!, hsToken: hsToken! };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const listenRaw = env.CHATD_LISTEN ?? "10.213.47.1:9009";
	const colon = listenRaw.lastIndexOf(":");
	const port = Number(listenRaw.slice(colon + 1));
	if (colon < 0 || !Number.isInteger(port) || port <= 0) throw new Error(`chatd: CHATD_LISTEN ${listenRaw} is not host:port`);
	const tokensFile = env.CHATD_TOKENS ?? join(homedir(), ".config", "chatd", "tokens");
	return {
		homeserver: (env.CHATD_HOMESERVER ?? "https://chat.sjmcd.me").replace(/\/$/, ""),
		serverName: env.CHATD_SERVER_NAME ?? "chat.sjmcd.me",
		listen: { host: listenRaw.slice(0, colon), port },
		socket: socketPath(env),
		owner: env.CHATD_OWNER ?? "@scott:chat.sjmcd.me",
		tokensFile,
		...readTokens(tokensFile),
	};
}
