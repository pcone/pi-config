/**
 * The test homeserver harness (tests/helpers/tuwunel.ts): the pinned binary,
 * a fresh server per call, the owner's account, and the appservice
 * registration pointing at a loopback port.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	TUWUNEL_ASSET,
	type TestHomeserver,
	ownerLogin,
	startTuwunel,
	tuwunelBinary,
	tuwunelCacheDir,
} from "./helpers/tuwunel.ts";

const homes: string[] = [];
afterAll(() => {
	for (const h of homes) rmSync(h, { recursive: true, force: true });
});

describe("tuwunel harness", () => {
	it("a missing binary fails with the fetch command", () => {
		const home = mkdtempSync(join(tmpdir(), "tuwunel-home-"));
		homes.push(home);
		expect(() => tuwunelBinary(home)).toThrow(`gh release download v2.1.0 -R matrix-construct/tuwunel -p '${TUWUNEL_ASSET}'`);
	});

	it("an archive that is not the pinned release fails naming both sums", () => {
		const home = mkdtempSync(join(tmpdir(), "tuwunel-home-"));
		homes.push(home);
		const dir = tuwunelCacheDir(home);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, TUWUNEL_ASSET), "tampered");
		writeFileSync(join(dir, "tuwunel"), "");
		expect(() => tuwunelBinary(home)).toThrow(/has sha256 [0-9a-f]{64}, expected 05c686ae/);
	});

	it("starts a fresh server: the owner logs in, and an event reaches the registered appservice port", async () => {
		const hs: TestHomeserver = await startTuwunel();
		const got: string[] = [];
		const as = Bun.serve({
			hostname: "127.0.0.1",
			port: hs.appservicePort,
			async fetch(req) {
				if (req.headers.get("authorization") === `Bearer ${hs.hsToken}`) {
					const body = (await req.json()) as { events?: { type: string }[] };
					for (const e of body.events ?? []) got.push(e.type);
				}
				return Response.json({});
			},
		});
		try {
			const token = await ownerLogin(hs);
			const r = await fetch(`${hs.url}/_matrix/client/v3/createRoom`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify({ invite: [`@pi-probe:${hs.serverName}`] }),
			});
			expect(r.status).toBe(200);
			const deadline = Date.now() + 10_000;
			while (!got.includes("m.room.member") && Date.now() < deadline) await Bun.sleep(50);
			expect(got).toContain("m.room.member");
		} finally {
			as.stop(true);
			await hs.dispose();
		}
	}, 30_000);
});
