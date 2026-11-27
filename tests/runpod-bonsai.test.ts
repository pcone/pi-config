/**
 * extensions/runpod-bonsai: one pod however many sessions wake it
 * (decisions/providers/001).
 *
 * - winner() is the shared rule: the oldest running pod named pi-bonsai.
 * - converge() deletes the caller's own pod when it is not the winner, so
 *   sessions that both created a pod settle on one.
 * - withLock() serialises creation and removes a lock whose holder has exited.
 * - createPod() retries Runpod's transient no-capacity 400, and nothing else.
 *
 * No network: fetch is replaced. Keys go through the module's reader seam, so the
 * rows need no Keychain: the two failure messages are pinned separately against
 * `keychain()`'s own seam.
 *
 * Run: bun test tests/runpod-bonsai.test.ts
 */

import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { childEnv } from "./helpers/subagent-env.ts";
import { join } from "node:path";
import { _testSetKeyReader, converge, createPod, keychain, type Pod, winner, withLock } from "../extensions/runpod-bonsai/index.ts";

// No Keychain on the machine running this file: the reader seam answers with a
// fixed key, and the two failure messages are pinned through `keychain()` below.
_testSetKeyReader((item) => `test-key-for-${item}`);

const pod = (id: string, createdAt: string, status = "RUNNING", name = "pi-bonsai"): Pod => ({ id, name, status, createdAt });

describe("keychain — a missing item and a machine without `security` are different states", () => {
	// Both throw: an exec seam that returns normally would reach `.trim()` instead.
	const enoent = () => {
		throw Object.assign(new Error("spawnSync security ENOENT"), { code: "ENOENT" });
	};

	it("says the platform cannot read a Keychain when `security` is absent", () => {
		// The Linux box: the item may well exist, and nothing there can read it.
		expect(() => keychain("runpod-api-key", enoent as never)).toThrow(/no `security` tool on PATH/);
	});

	it("carries the reason and the command that adds the item when the read fails otherwise", () => {
		const denied = () => {
			throw Object.assign(new Error("security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain."), { code: 44 });
		};
		expect(() => keychain("runpod-api-key", denied as never)).toThrow(
			/cannot read Keychain item "runpod-api-key": security: SecKeychainSearchCopyNext.*If the item is missing, add it with: security add-generic-password -s runpod-api-key -a pi -w <key>/,
		);
		// A read that failed for a reason other than a missing item is not reported as
		// a missing item: the caller can only act on the reason the tool gave.
		expect(() => keychain("k", (() => {
			throw new Error("security: user interaction is not allowed");
		}) as never)).toThrow(/user interaction is not allowed/);
	});
});

describe("winner — the pod every session uses", () => {
	it("is the oldest running pi-bonsai pod", () => {
		const pods = [pod("b", "2026-11-25T07:00:02Z"), pod("a", "2026-11-25T07:00:01Z"), pod("c", "2026-11-25T07:00:03Z")];
		expect(winner(pods)?.id).toBe("a");
	});
	it("breaks a createdAt tie by id, so every session picks the same pod", () => {
		expect(winner([pod("y", "2026-11-25T07:00:00Z"), pod("x", "2026-11-25T07:00:00Z")])?.id).toBe("x");
	});
	it("ignores pods that are not running or not named pi-bonsai", () => {
		const pods = [
			pod("old-exited", "2026-11-25T06:00:00Z", "EXITED"),
			pod("other", "2026-11-25T06:00:00Z", "RUNNING", "bonsai-2.5-27b"),
			pod("live", "2026-11-25T07:00:00Z"),
		];
		expect(winner(pods)?.id).toBe("live");
		expect(winner([pod("x", "2026-11-25T07:00:00Z", "EXITED")])).toBeUndefined();
	});
});

describe("converge — racing creators settle on one pod", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	function fakeRunpod(pods: Pod[]) {
		const calls: string[] = [];
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			calls.push(`${method} ${new URL(url).pathname}`);
			if (method === "GET") return new Response(JSON.stringify({ pods }), { status: 200 });
			if (method === "DELETE") return new Response(null, { status: 204 });
			throw new Error(`unexpected ${method} ${url}`);
		}) as typeof fetch;
		return calls;
	}

	it("deletes the caller's pod and returns the older one", async () => {
		const calls = fakeRunpod([pod("theirs", "2026-11-25T07:00:01Z"), pod("mine", "2026-11-25T07:00:02Z")]);
		expect(await converge("mine")).toBe("theirs");
		expect(calls).toEqual(["GET /v2/pods", "DELETE /v2/pods/mine"]);
	});
	it("keeps the caller's pod when it is the oldest, deleting nothing", async () => {
		const calls = fakeRunpod([pod("mine", "2026-11-25T07:00:01Z"), pod("theirs", "2026-11-25T07:00:02Z")]);
		expect(await converge("mine")).toBe("mine");
		expect(calls).toEqual(["GET /v2/pods"]);
	});
	it("fails when the pod just created is not listed as running", async () => {
		fakeRunpod([]);
		await expect(converge("mine")).rejects.toThrow("not listed as RUNNING");
	});
});

describe("createPod — retries Runpod's transient capacity refusal", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});
	const NO_CAPACITY = JSON.stringify({ detail: "This machine does not have the resources to deploy your pod. Please try a different machine", status: 400 });

	function fakeCreates(responses: Array<[number, string]>) {
		let posts = 0;
		globalThis.fetch = (async (_url: string, init?: RequestInit) => {
			if (init?.method !== "POST") throw new Error("only POST expected");
			const [status, body] = responses[Math.min(posts++, responses.length - 1)];
			return new Response(body, { status });
		}) as typeof fetch;
		return () => posts;
	}

	it("retries a no-capacity 400 and returns the pod that lands", async () => {
		const posts = fakeCreates([[400, NO_CAPACITY], [400, NO_CAPACITY], [200, JSON.stringify(pod("new", "2026-11-25T07:00:00Z"))]]);
		expect((await createPod(undefined, 1)).id).toBe("new");
		expect(posts()).toBe(3);
	});
	it("fails at once on any other error", async () => {
		const posts = fakeCreates([[400, JSON.stringify({ detail: "invalid gpu id" })]]);
		await expect(createPod(undefined, 1)).rejects.toThrow("invalid gpu id");
		expect(posts()).toBe(1);
	});
	it("gives up after the last attempt with Runpod's error", async () => {
		const posts = fakeCreates([[400, NO_CAPACITY]]);
		await expect(createPod(undefined, 1)).rejects.toThrow("does not have the resources");
		expect(posts()).toBe(5);
	}, 2_000);
});

describe("withLock — serialises creation across processes", () => {
	let dir: string;
	afterEach(() => rmSync(dir, { recursive: true, force: true }));
	const lockIn = () => join((dir = mkdtempSync(join(tmpdir(), "runpod-bonsai-lock-"))), "lock");

	it("holds the lock with its pid and releases it", async () => {
		const lock = lockIn();
		const seen = await withLock(lock, undefined, async () => readFileSync(lock, "utf8"));
		expect(seen).toBe(String(process.pid));
		expect(existsSync(lock)).toBe(false);
	});
	it("never runs two holders at once", async () => {
		const lock = lockIn();
		let inside = 0;
		let maxInside = 0;
		const hold = () =>
			withLock(lock, undefined, async () => {
				maxInside = Math.max(maxInside, ++inside);
				await new Promise((r) => setTimeout(r, 50));
				inside--;
			});
		await Promise.all([hold(), hold(), hold()]);
		expect(maxInside).toBe(1);
	});
	it("removes a lock whose holder has exited", async () => {
		const lock = lockIn();
		const dead = spawnSync("true", [], { env: childEnv() }).pid!; // exited by the time spawnSync returns
		writeFileSync(lock, String(dead));
		const ran = await Promise.race([
			withLock(lock, undefined, async () => true),
			new Promise((r) => setTimeout(() => r(false), 1_000)),
		]);
		expect(ran).toBe(true);
	});
	it("waits while the holder is alive", async () => {
		const lock = lockIn();
		writeFileSync(lock, String(process.pid)); // this process: alive
		const abort = new AbortController();
		const attempt = withLock(lock, abort.signal, async () => "ran");
		await new Promise((r) => setTimeout(r, 300));
		abort.abort(new Error("gave up"));
		await expect(attempt).rejects.toThrow("gave up");
		expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
	});
});
