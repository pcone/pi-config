/**
 * chatd for tests: the production daemon with the clock and the certificate
 * check injected from the environment, and a crash point for the mirror row.
 * Not a production entry point: apps/chatd/main.ts is.
 *
 *   TEST_CERT_NOT_AFTER  ISO date the certificate check returns
 *   TEST_CERT_ERROR      message the certificate check fails with
 *   TEST_NOW_OFFSET_MS   added to Date.now() for chatd's clock
 *   TEST_EXIT_AFTER_MIRROR  exit after the first mirror copy, before answering the transaction
 */

import { loadConfig } from "../../apps/chatd/config.ts";
import { startChatd } from "../../apps/chatd/main.ts";

const offset = Number(process.env.TEST_NOW_OFFSET_MS ?? 0);
const chatd = await startChatd(loadConfig(), {
	now: () => Date.now() + offset,
	checkCertificate: async () => {
		if (process.env.TEST_CERT_ERROR) throw new Error(process.env.TEST_CERT_ERROR);
		return new Date(process.env.TEST_CERT_NOT_AFTER ?? "2099-01-01T00:00:00Z");
	},
	afterMirrorCopy: process.env.TEST_EXIT_AFTER_MIRROR ? () => process.exit(137) : undefined,
});
process.on("SIGTERM", async () => {
	await chatd.stop();
	process.exit(0);
});
// Test-only control over stdin: `sweep` runs the mirror sweep, `cert` the certificate watch.
for await (const line of console) {
	if (line === "sweep") console.log(`swept ${await chatd.sweepMirror()}`);
	if (line === "cert") {
		await chatd.certificateWatch();
		console.log("cert done");
	}
	if (line === "presence") {
		await chatd.presencePass();
		console.log("presence done");
	}
}
