/**
 * Tests for `resolveTrackerKey` — resolves an orchestrator-supplied RPC handle
 * to the child's piSessionId via the persisted meta JSON.
 *
 * Also tests the producer↔consumer symmetry: that the key returned by
 * resolveTrackerKey matches the key used by recordReviewerSpawn (via
 * getParentTrackerKey) to write the tracker file, so readPersistedSpawns
 * can find it.
 *
 * Run: bun test tests/subagent-review-status.test.ts
 */

import { describe, expect, it, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import {
	resolveTrackerKey,
	writeMetaJson,
	metaPath,
	readPersistedSpawns,
} from "../extensions/subagent-async/index.ts";

// Track files to clean up after each test
const filesToClean: string[] = [];
// Track reviewer-spawn files separately (they're keyed differently)
const trackerFilesToClean: string[] = [];

afterEach(() => {
	for (const f of filesToClean) {
		try {
			if (existsSync(f)) unlinkSync(f);
		} catch {
			// best-effort cleanup
		}
	}
	filesToClean.length = 0;
	for (const f of trackerFilesToClean) {
		try {
			if (existsSync(f)) unlinkSync(f);
		} catch {
			// best-effort cleanup
		}
	}
	trackerFilesToClean.length = 0;
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function uniqueHandle(): string {
	return `subagent-${randomUUID()}`;
}

function trackCleanup(handle: string): void {
	filesToClean.push(metaPath(handle));
}

/**
 * Construct the reviewer-spawn tracker path, mirroring reviewStatusPath in
 * index.ts (this is the same logic readPersistedSpawns uses internally).
 */
function reviewStatusPath(parentKey: string): string {
	const safe = parentKey.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 200) || `pid_${process.pid}`;
	return `/tmp/pi-subagent-${safe}.reviewers.json`;
}

/**
 * Write a reviewer-spawn tracker file under the given key, mirroring what
 * recordReviewerSpawn in index.ts does atomically.
 */
function writeReviewerSpawnFile(
	parentKey: string,
	spawns: Array<{ reviewerKind: string; childSessionId: string; childAgentName: string; spawnedAt: number }>,
): void {
	const target = reviewStatusPath(parentKey);
	const tmp = `${target}.tmp.${process.pid}`;
	writeFileSync(
		tmp,
		JSON.stringify(
			{
				parentSessionId: parentKey,
				updatedAt: Date.now(),
				spawns,
				reviewRounds: spawns.length,
				reviewCapReached: true,
			},
			null,
			2,
		),
	);
	writeFileSync(target, JSON.stringify(
		{
			parentSessionId: parentKey,
			updatedAt: Date.now(),
			spawns,
			reviewRounds: spawns.length,
			reviewCapReached: true,
		},
		null,
		2,
	));
	unlinkSync(tmp);
	trackerFilesToClean.push(target);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("resolveTrackerKey", () => {
	it("1: resolves valid RPC handle to piSessionId from meta", () => {
		const handle = uniqueHandle();
		const piSid = randomUUID(); // acts as a UUIDv7 stand-in
		trackCleanup(handle);
		writeMetaJson(handle, { piSessionId: piSid });

		const result = resolveTrackerKey(handle);
		expect(result).toBe(piSid);
	});

	it("2: returns handle unchanged when no meta file exists", () => {
		const handle = uniqueHandle();
		const result = resolveTrackerKey(handle);
		expect(result).toBe(handle);
	});

	it("3: returns handle unchanged when meta is empty object", () => {
		const handle = uniqueHandle();
		trackCleanup(handle);
		writeMetaJson(handle, {});

		const result = resolveTrackerKey(handle);
		expect(result).toBe(handle);
	});

	it('4: returns handle unchanged when piSessionId is empty string', () => {
		const handle = uniqueHandle();
		trackCleanup(handle);
		writeMetaJson(handle, { piSessionId: "" });

		const result = resolveTrackerKey(handle);
		expect(result).toBe(handle);
	});

	it("5: returns handle unchanged when piSessionId is non-string (number)", () => {
		const handle = uniqueHandle();
		trackCleanup(handle);
		writeMetaJson(handle, { piSessionId: 42 });

		const result = resolveTrackerKey(handle);
		expect(result).toBe(handle);
	});

	it("6: returns handle unchanged when meta is malformed JSON", () => {
		const handle = uniqueHandle();
		const target = metaPath(handle);
		filesToClean.push(target);
		// Write malformed JSON directly (bypass writeMetaJson which writes valid JSON)
		writeFileSync(target, "{", "utf-8");

		const result = resolveTrackerKey(handle);
		expect(result).toBe(handle);
	});

	it("7: returns plain UUIDv7 (not subagent- prefixed) unchanged", () => {
		const plainUuid = randomUUID();
		const result = resolveTrackerKey(plainUuid);
		expect(result).toBe(plainUuid);
	});

	it("8: returns empty string unchanged", () => {
		const result = resolveTrackerKey("");
		expect(result).toBe("");
	});

	it('9: returns "pid:12345" fallback unchanged', () => {
		const pidStr = "pid:12345";
		const result = resolveTrackerKey(pidStr);
		expect(result).toBe(pidStr);
	});

	it("10: regex does not match subagent- with only 7 hex chars (lower bound)", () => {
		// The regex requires at least 8 hex/dash chars after "subagent-".
		// Write a meta file for this handle to prove the regex rejects FIRST
		// (if it were accepted, resolveTrackerKey would find the meta and
		// return the piSessionId instead of the handle unchanged).
		const shortHandle = "subagent-019fabc"; // 7 hex chars — one short
		trackCleanup(shortHandle);
		writeMetaJson(shortHandle, { piSessionId: "leaked-piSid" });

		const result = resolveTrackerKey(shortHandle);
		expect(result).toBe(shortHandle);
		expect(result).not.toBe("leaked-piSid");
	});

	it("11: regex does not match subagent- with non-hex suffix chars", () => {
		const nonHexHandle = "subagent-xyz12345";
		trackCleanup(nonHexHandle);
		writeMetaJson(nonHexHandle, { piSessionId: "leaked-piSid" });

		const result = resolveTrackerKey(nonHexHandle);
		expect(result).toBe(nonHexHandle);
		expect(result).not.toBe("leaked-piSid");
	});

	it("12: returns handle unchanged when piSessionId is null", () => {
		const handle = uniqueHandle();
		trackCleanup(handle);
		writeMetaJson(handle, { piSessionId: null });

		const result = resolveTrackerKey(handle);
		expect(result).toBe(handle);
	});

	// ── End-to-end symmetry test ───────────────────────────────────────
	// Proves the producer (recordReviewerSpawn) and consumer
	// (resolveTrackerKey → readPersistedSpawns) agree on the tracker key,
	// so a future change to getParentTrackerKey would be caught.

	it("13: resolveTrackerKey → readPersistedSpawns round-trips under the resolved piSessionId key", () => {
		const handle = uniqueHandle();
		const piSid = randomUUID();
		trackCleanup(handle);

		// Step 1: Write meta with piSessionId (simulates child's get_state)
		writeMetaJson(handle, { piSessionId: piSid });

		// Step 2: Write a reviewer-spawn file under the piSessionId key
		// (simulates what recordReviewerSpawn does via getParentTrackerKey)
		const spawnEntry = {
			reviewerKind: "implementation" as const,
			childSessionId: "subagent-reviewer-abc",
			childAgentName: "review-code",
			spawnedAt: Date.now(),
		};
		writeReviewerSpawnFile(piSid, [spawnEntry]);

		// Step 3: Resolve the handle to the piSessionId
		const resolved = resolveTrackerKey(handle);
		expect(resolved).toBe(piSid);

		// Step 4: Read the tracker file via the resolved key
		const state = readPersistedSpawns(resolved);
		expect(state.spawns.length).toBe(1);
		expect(state.spawns[0].reviewerKind).toBe("implementation");
		expect(state.spawns[0].childSessionId).toBe("subagent-reviewer-abc");

		// Step 5: Without resolution, the handle would not find the tracker
		const stateRaw = readPersistedSpawns(handle);
		expect(stateRaw.spawns.length).toBe(0);
	});
});
