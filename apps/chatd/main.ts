#!/usr/bin/env bun
/**
 * chatd's entry point: `bun apps/chatd/main.ts`, run by chatd.service.
 * Design: docs/design/chat.md.
 */

import { connect } from "node:tls";
import { type Config, loadConfig } from "./config.ts";
import { Chatd, type Deps } from "./daemon.ts";

/** The homeserver certificate's notAfter, read from a TLS handshake. */
export function certificateNotAfter(homeserver: string): Promise<Date> {
	const url = new URL(homeserver);
	if (url.protocol !== "https:") return Promise.reject(new Error(`${homeserver} is not https; there is no certificate to check`));
	return new Promise((resolve, reject) => {
		const socket = connect({ host: url.hostname, port: Number(url.port || 443), servername: url.hostname, timeout: 15_000 }, () => {
			const cert = socket.getPeerCertificate();
			socket.end();
			if (!cert?.valid_to) reject(new Error("the server sent no certificate"));
			else resolve(new Date(cert.valid_to));
		});
		socket.once("timeout", () => {
			socket.destroy();
			reject(new Error("TLS handshake timed out"));
		});
		socket.once("error", reject);
	});
}

export async function startChatd(config: Config, deps: Partial<Deps> = {}): Promise<Chatd> {
	const chatd = new Chatd(config, { checkCertificate: () => certificateNotAfter(config.homeserver), ...deps });
	await chatd.start();
	return chatd;
}

if (import.meta.main) {
	try {
		const chatd = await startChatd(loadConfig());
		const shutdown = async () => {
			await chatd.stop();
			process.exit(0);
		};
		process.on("SIGTERM", shutdown);
		process.on("SIGINT", shutdown);
	} catch (err) {
		console.error((err as Error).message);
		process.exit(1);
	}
}
