/**
 * Tests for session-id resolution in subagent tools:
 *
 * 1. `subagent_review_status` with optional parent_session_id — defaults to
 *    the caller's own session id via getParentTrackerKey(ctx) when omitted.
 * 2. `resolveRunningSession` — exact match, partial suffix match, unknown.
 * 3. `getParentTrackerKey` — with sessionManager and fallback to `pid:<n>`.
 *
 * Run: bun test tests/subagent-id-resolution.test.ts
 */

import { describe, expect, it, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import {
	resolveTrackerKey,
	resolveSubagentMeta,
	writeMetaJson,
	metaPath,
	readPersistedSpawns,
	resolveRunningSession,
	_testRunning,
	getParentTrackerKey,
	buildSubagentArgs,
	buildSubagentEnv,
	rpcSend,
} from "../extensions/subagent-async/index.ts";
import subagentFactory from "../extensions/subagent-async/index.ts";

/**
 * On-disk path for a parent's reviewer-spawn log — mirrors reviewStatusPath
 * in index.ts so tests can find the same files the tool reads.
 */
function reviewStatusPath(parentKey: string): string {
	const safe = parentKey.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 200) || `pid_${process.pid}`;
	return `/tmp/pi-subagent-${safe}.reviewers.json`;
}

// Track files to clean up after each test
const filesToClean: string[] = [];
const trackerFilesToClean: string[] = [];

afterEach(() => {
	// Clear the running map injected entries
	_testRunning.clear();

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
 * Write a reviewer-spawn tracker file under the given key, mirroring what
 * recordReviewerSpawn in index.ts does atomically.
 */
function writeReviewerSpawnFile(
	parentKey: string,
	spawns: Array<{ reviewerKind: string; childSessionId: string; childAgentName: string; spawnedAt: number }>,
): void {
	const target = reviewStatusPath(parentKey);
	const tmp = `${target}.tmp.${process.pid}`;
	const payload = {
		parentSessionId: parentKey,
		updatedAt: Date.now(),
		spawns,
		reviewRounds: spawns.length,
		reviewCapReached: true,
	};
	writeFileSync(tmp, JSON.stringify(payload, null, 2));
	writeFileSync(target, JSON.stringify(payload, null, 2));
	unlinkSync(tmp);
	trackerFilesToClean.push(target);
}

// ── Case 1-4: subagent_review_status parent_session_id resolution ─────────

describe("subagent_review_status parent_session_id resolution", () => {
	it("1: empty arg defaults to own tracker via getParentTrackerKey", () => {
		// When parent_session_id is undefined, the tool should resolve
		// using getParentTrackerKey(ctx). That returns the session id from
		// ctx.sessionManager or falls back to "pid:<pid>".
		// We verify the fallback path: with no ctx.sessionManager, the
		// returned key matches the pid pattern.
		const ctx: any = {}; // no sessionManager
		const key = getParentTrackerKey(ctx);
		expect(key).toMatch(/^pid:\d+$/);

		// Write a spawn file under that key so readPersistedSpawns finds it
		const spawnEntry = {
			reviewerKind: "implementation" as const,
			childSessionId: "subagent-reviewer-abc",
			childAgentName: "review-code",
			spawnedAt: Date.now(),
		};
		writeReviewerSpawnFile(key, [spawnEntry]);

		// Verify readPersistedSpawns can find it using the key
		const state = readPersistedSpawns(key);
		expect(state.spawns.length).toBe(1);
		expect(state.spawns[0].reviewerKind).toBe("implementation");
	});

	it("2: explicit own piSessionId finds own tracker", () => {
		const piSid = randomUUID();
		const spawnEntry = {
			reviewerKind: "tests" as const,
			childSessionId: "subagent-reviewer-xyz",
			childAgentName: "review-tests",
			spawnedAt: Date.now(),
		};
		writeReviewerSpawnFile(piSid, [spawnEntry]);

		const state = readPersistedSpawns(piSid);
		expect(state.spawns.length).toBe(1);
		expect(state.spawns[0].reviewerKind).toBe("tests");
		expect(state.spawns[0].childSessionId).toBe("subagent-reviewer-xyz");
	});

	it("3: orchestrator passes full RPC handle → resolves via meta, finds tracker", () => {
		const handle = uniqueHandle();
		const piSid = randomUUID();
		trackCleanup(handle);
		writeMetaJson(handle, { piSessionId: piSid });

		// Write tracker file under the piSessionId key
		const spawnEntry = {
			reviewerKind: "implementation" as const,
			childSessionId: "subagent-reviewer-def",
			childAgentName: "review-code",
			spawnedAt: Date.now(),
		};
		writeReviewerSpawnFile(piSid, [spawnEntry]);

		// Resolve the handle to piSessionId (simulates what the tool does)
		const resolved = resolveTrackerKey(handle);
		expect(resolved).toBe(piSid);

		// Read via the resolved key
		const state = readPersistedSpawns(resolved);
		expect(state.spawns.length).toBe(1);
		expect(state.spawns[0].childSessionId).toBe("subagent-reviewer-def");

		// Without resolution, the raw handle would NOT find the tracker
		const stateRaw = readPersistedSpawns(handle);
		expect(stateRaw.spawns.length).toBe(0);
	});

	it("4: unknown id → empty spawns (no throw)", () => {
		const unknownId = "nonexistent-session-id";
		const state = readPersistedSpawns(unknownId);
		expect(state.spawns).toEqual([]);
		expect(state.reviewRounds).toBe(0);
		expect(state.reviewCapReached).toBe(false);
	});
});

// ── Cases 5-7: resolveRunningSession ───────────────────────────────────────

describe("resolveRunningSession", () => {
	it("5: exact match returns RunningSubagent from running map", () => {
		const sid = randomUUID();
		const mock = { sessionId: sid, agentName: "test-agent" } as any;
		_testRunning.set(sid, mock);

		const result = resolveRunningSession(sid);
		expect(result).toBe(mock);
		expect(result!.sessionId).toBe(sid);
	});

	it("6: partial suffix match resolves via resolveSubagentMeta then running map", () => {
		// Create a real meta file so resolveSubagentMeta can find it
		const fullSid = `subagent-${randomUUID()}`;
		const partial = fullSid.slice(-12);
		trackCleanup(fullSid);
		writeMetaJson(fullSid, { piSessionId: fullSid });

		// Put it in the running map under the full sid
		const mock = { sessionId: fullSid, agentName: "test-agent" } as any;
		_testRunning.set(fullSid, mock);

		// resolveSubagentMeta should find it via the partial suffix
		const meta = resolveSubagentMeta(partial);
		expect(meta).not.toBeNull();
		expect(meta!.sid).toBe(fullSid);

		// resolveRunningSession should find it via partial → meta → running
		const result = resolveRunningSession(partial);
		expect(result).toBe(mock);
		expect(result!.sessionId).toBe(fullSid);
	});

	it("7: unknown id returns null", () => {
		const result = resolveRunningSession("nonexistent-session-id");
		expect(result).toBeNull();
	});

	it("ambiguous partial suffix throws from resolveSubagentMeta", () => {
		// Two meta files sharing a 12-char suffix → resolveSubagentMeta throws
		const base = "subagent-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
		const suffix = base.slice(-12);
		const sid1 = `subagent-11111111-2222-3333-4444-${suffix}`;
		const sid2 = `subagent-55555555-6666-7777-8888-${suffix}`;
		trackCleanup(sid1);
		trackCleanup(sid2);
		writeMetaJson(sid1, {});
		writeMetaJson(sid2, {});

		expect(() => resolveSubagentMeta(suffix)).toThrow(/ambiguous partial session/i);

		// resolveRunningSession propagates the throw uncaught
		expect(() => resolveRunningSession(suffix)).toThrow(/ambiguous partial session/i);
	});
});

// ── Cases 8-9: getParentTrackerKey ─────────────────────────────────────────

describe("getParentTrackerKey", () => {
	it("8: with sessionManager.getSessionId() returns the session id", () => {
		const sessionId = randomUUID();
		const ctx: any = {
			sessionManager: {
				getSessionId: () => sessionId,
			},
		};
		const key = getParentTrackerKey(ctx);
		expect(key).toBe(sessionId);
	});

	it("9: without sessionManager falls back to pid:<n>", () => {
		const ctx: any = {};
		const key = getParentTrackerKey(ctx);
		expect(key).toMatch(/^pid:\d+$/);
	});

	it("9b: with sessionManager.getSessionId returning empty string falls back", () => {
		const ctx: any = {
			sessionManager: {
				getSessionId: () => "",
			},
		};
		const key = getParentTrackerKey(ctx);
		expect(key).toMatch(/^pid:\d+$/);
	});

	it("9c: getSessionId throws → fallback to pid:<n>", () => {
		const ctx: any = {
			sessionManager: {
				getSessionId: () => { throw new Error("no session"); },
			},
		};
		const key = getParentTrackerKey(ctx);
		expect(key).toMatch(/^pid:\d+$/);
	});
});

// ── Cross-case: resolveTrackerKey edge cases ───────────────────────────────

describe("resolveTrackerKey (cross-reference)", () => {
	it("returns handle unchanged when no meta file exists", () => {
		const handle = uniqueHandle();
		const result = resolveTrackerKey(handle);
		expect(result).toBe(handle);
	});

	it("returns plain UUIDv7 (no subagent- prefix) unchanged", () => {
		const plainUuid = randomUUID();
		const result = resolveTrackerKey(plainUuid);
		expect(result).toBe(plainUuid);
	});

	it('returns "pid:12345" fallback unchanged', () => {
		const result = resolveTrackerKey("pid:12345");
		expect(result).toBe("pid:12345");
	});
});

// ── Spawn-args composition: unified session id ─────────────────────────────
// The subagent handle is passed to the child as `--session-id`, so the child's
// pi session id IS the handle (searchable in /resume, joinable via
// `pi --session-id <id>`). Resumes reopen the session file instead.

describe("buildSubagentArgs (session id unification)", () => {
	it("passes the handle as --session-id on a fresh spawn", () => {
		const handle = uniqueHandle();
		const args = buildSubagentArgs({
			model: "openrouter/deepseek/deepseek-v4-flash",
			tools: ["read", "bash"],
			excludeTools: [],
			sessionId: handle,
		});
		expect(args).toContain("--session-id");
		expect(args[args.indexOf("--session-id") + 1]).toBe(handle);
		expect(args).not.toContain("--session");
	});

	it("reopens the session file on resume instead of --session-id", () => {
		const args = buildSubagentArgs({
			model: "openrouter/deepseek/deepseek-v4-flash",
			tools: [],
			excludeTools: [],
			sessionFile: "/tmp/pi-subagent-x.jsonl",
		});
		expect(args).toContain("--session");
		expect(args).not.toContain("--session-id");
	});

	it("rejects --session-id and --session together", () => {
		const handle = uniqueHandle();
		expect(() =>
			buildSubagentArgs({
				model: "m",
				tools: [],
				excludeTools: [],
				sessionFile: "/tmp/pi-subagent-x.jsonl",
				sessionId: handle,
			}),
		).toThrow(/mutually exclusive/);
	});
});

// ── Spawn env: peer-link identity ──────────────────────────────────────────
// The subagent's peer name is its session id (PI_PEER_NAME), so the same id
// steers it, resumes it, and addresses peer messages to it. Always set — an
// inherited PI_PEER_NAME would make sibling subagents collide on one mailbox.

describe("buildSubagentEnv (peer identity)", () => {
	it("names the subagent after its session id", () => {
		const handle = uniqueHandle();
		const env = buildSubagentEnv({
			sessionId: handle,
			allowlist: undefined,
			worktreePath: null,
			parentCwdForCleanup: "",
			depth: 1,
		});
		expect(env.PI_PEER_NAME).toBe(handle);
	});

	it("sets the subagent marker always, allowlist only when present", () => {
		const env = buildSubagentEnv({
			sessionId: "subagent-x",
			allowlist: ["implement", "scout"],
			worktreePath: null,
			parentCwdForCleanup: "",
			depth: 1,
		});
		expect(env.PI_IS_SUBAGENT).toBe("1");
		expect(env.PI_SUBAGENT_ALLOWLIST).toBe("implement,scout");
		expect(env.PI_SUBAGENT_DEPTH).toBe("1");

		const noAllow = buildSubagentEnv({
			sessionId: "subagent-x",
			allowlist: undefined,
			worktreePath: null,
			parentCwdForCleanup: "",
			depth: 1,
		});
		expect(noAllow.PI_SUBAGENT_ALLOWLIST).toBeUndefined();
	});

	it("sets parent-cwd guard only when isolated in a worktree", () => {
		const isolated = buildSubagentEnv({
			sessionId: "subagent-x",
			allowlist: undefined,
			worktreePath: "/tmp/pi-subagent-wt-abc",
			parentCwdForCleanup: "/Users/scott/repo",
			depth: 1,
		});
		expect(isolated.PI_SUBAGENT_WORKTREE).toBe("/tmp/pi-subagent-wt-abc");
		expect(isolated.PI_SUBAGENT_PARENT_CWD).toBe("/Users/scott/repo");

		const bare = buildSubagentEnv({
			sessionId: "subagent-x",
			allowlist: undefined,
			worktreePath: null,
			parentCwdForCleanup: "/Users/scott/repo",
			depth: 1,
		});
		expect(bare.PI_SUBAGENT_WORKTREE).toBe("");
		expect(bare.PI_SUBAGENT_PARENT_CWD).toBe("");
	});
});

// ── Steer into a stopped session ──────────────────────────────────────────
// Regression tests for "steers silently queued into a dead child's pipe".
// The steer tool must refuse to write when the subagent has completed or
// exited, and report truthfully when a write cannot land.

describe("rpcSend (honest delivery)", () => {
	it("returns false for null or destroyed stdin", () => {
		expect(rpcSend(null, { type: "prompt" })).toBe(false);
		expect(rpcSend({ destroyed: true } as any, { type: "prompt" })).toBe(false);
	});

	it("writes the payload and returns true on a writable stream", () => {
		const written: string[] = [];
		const ok = rpcSend({ destroyed: false, write: (s: string) => { written.push(s); return true; } } as any, {
			type: "prompt",
			message: "hi",
			streamingBehavior: "steer",
		});
		expect(ok).toBe(true);
		expect(written[0]).toBe('{"type":"prompt","message":"hi","streamingBehavior":"steer"}\n');
	});

	it("returns false when the write throws", () => {
		expect(
			rpcSend(
				{ destroyed: false, write: () => { throw new Error("EPIPE"); } } as any,
				{ type: "prompt" },
			),
		).toBe(false);
	});
});

describe("subagent_steer refuses stopped sessions", () => {
	const tools: Record<string, any> = {};
	const pi = {
		on: () => {},
		registerTool: (t: any) => { tools[t.name] = t; },
		registerCommand: () => {},
	} as any;
	const factory = subagentFactory;
	factory(pi);
	const steer = tools.subagent_steer;

	async function run(sid: string, overrides: Record<string, any> = {}) {
		_testRunning.set(sid, { sessionId: sid, agentName: "test-agent", isDone: false, procExited: false, stdin: null, ...overrides } as any);
		return steer.execute("c1", { session_id: sid, message: "wrap up" }, undefined, undefined, {} as any);
	}

	it("reports not-delivered when the process has exited", async () => {
		const sid = randomUUID();
		const res = await run(sid, { procExited: true });
		expect(res.content[0].text).toMatch(/not delivered/);
		expect(res.content[0].text).toMatch(/process exited/);
	});

	it("reports not-delivered when the subagent has completed", async () => {
		const sid = randomUUID();
		const res = await run(sid, { isDone: true });
		expect(res.content[0].text).toMatch(/not delivered/);
		expect(res.content[0].text).toMatch(/completed/);
	});

	it("reports not-delivered when stdin is destroyed", async () => {
		const sid = randomUUID();
		const res = await run(sid, { stdin: { destroyed: true } });
		expect(res.content[0].text).toMatch(/not delivered/);
	});

	it("actually writes the payload to a healthy session", async () => {
		const sid = randomUUID();
		const written: string[] = [];
		const res = await run(sid, {
			stdin: { destroyed: false, write: (s: string) => { written.push(s); return true; } },
		});
		expect(res.content[0].text).toMatch(/sent/);
		expect(written[0]).toContain('"message":"wrap up"');
	});

	it("reports not-delivered when the write cannot land despite a healthy-looking stdin", async () => {
		const sid = randomUUID();
		const res = await run(sid, {
			stdin: { destroyed: false, write: () => { throw new Error("EPIPE"); } },
		});
		expect(res.content[0].text).toMatch(/NOT delivered/);
	});
});
