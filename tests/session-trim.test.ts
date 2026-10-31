/**
 * Session trim: the cut must not change what the model sees.
 *
 * The load-bearing assertion is context equality — `buildSessionContext()` before
 * and after a trim, compared as whole objects. A trim that keeps the file looking
 * plausible but drops a `model_change` would resume on the wrong model, and only
 * the object comparison catches it.
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import sessionTrim, {
	HINT_MIN_DROPPED_BYTES,
	nextArchivePath,
	planTrim,
	restartHint,
	treeNavigationBlocked,
	TRIM_MARKER,
	writeTrim,
} from "../extensions/session-trim";

const STAMP = "2026-10-30T00:00:00.000Z";

const message = (role: "user" | "assistant", text: string) => ({
	role,
	content: role === "user" ? text : [{ type: "text" as const, text }],
	...(role === "assistant"
		? {
				provider: "test",
				model: "test-model",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
				stopReason: "stop",
			}
		: {}),
});

/**
 * header
 *  ├ model_change → thinking_level_change → user → assistant   (dropped)
 *  ├ session_info, label on the first user message             (dropped)
 *  ├ user(kept) → assistant → compaction(firstKept=user-kept) → user
 */
function writeSession(dir: string, options: { compaction: boolean; name?: string }): string {
	const file = join(dir, "2026-10-30T00-00-00-000Z_test.jsonl");
	const body: SessionEntry[] = [
		{ type: "model_change", id: "mc1", parentId: null, timestamp: STAMP, provider: "p", modelId: "m" },
		{
			type: "thinking_level_change",
			id: "tl1",
			parentId: "mc1",
			timestamp: STAMP,
			thinkingLevel: "high",
		},
		{ type: "session_info", id: "si1", parentId: "tl1", timestamp: STAMP, name: options.name ?? "work" },
		{ type: "message", id: "u1", parentId: "si1", timestamp: STAMP, message: message("user", "old prompt") },
		{ type: "label", id: "lb1", parentId: "u1", timestamp: STAMP, targetId: "u1", label: "first" },
		{ type: "message", id: "a1", parentId: "lb1", timestamp: STAMP, message: message("assistant", "old answer") },
		{ type: "message", id: "u2", parentId: "a1", timestamp: STAMP, message: message("user", "kept prompt") },
		{ type: "message", id: "a2", parentId: "u2", timestamp: STAMP, message: message("assistant", "kept answer") },
	];
	if (options.compaction) {
		body.push({
			type: "compaction",
			id: "cp1",
			parentId: "a2",
			timestamp: STAMP,
			summary: "summary so far",
			firstKeptEntryId: "u2",
			tokensBefore: 1000,
		} as SessionEntry);
	}
	body.push({
		type: "message",
		id: "u3",
		parentId: options.compaction ? "cp1" : "a2",
		timestamp: STAMP,
		message: message("user", "after compaction"),
	});
	const header = {
		type: "session",
		version: 3,
		id: "01a10000-0000-7000-8000-000000000000",
		timestamp: STAMP,
		cwd: dir,
	};
	writeFileSync(file, [header, ...body].map((entry) => `${JSON.stringify(entry)}\n`).join(""));
	return file;
}

function withDir<T>(fn: (dir: string) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "session-trim-"));
	try {
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Awaiting variant: the extension handlers are async, so cleanup must wait for them. */
async function withDirAsync(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "session-trim-"));
	try {
		await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("planTrim", () => {
	it("cuts everything before the latest compaction's retained tail", () => {
		withDir((dir) => {
			const manager = SessionManager.open(writeSession(dir, { compaction: true }));
			const plan = planTrim(manager.getEntries(), manager.buildContextEntries());
			expect(plan).not.toBeNull();
			expect(plan!.keepFrom).toBe("u2");
			expect(plan!.dropped.map((entry) => entry.id)).toEqual(["mc1", "tl1", "si1", "u1", "lb1", "a1"]);
			expect(plan!.kept.map((entry) => entry.id)).toEqual(["u2", "a2", "cp1", "u3"]);
		});
	});

	it("carries the model, thinking level and session name across the cut", () => {
		withDir((dir) => {
			const manager = SessionManager.open(writeSession(dir, { compaction: true, name: "renamed" }));
			const plan = planTrim(manager.getEntries(), manager.buildContextEntries())!;
			expect(plan.carried.map((entry) => entry.type)).toEqual([
				"model_change",
				"thinking_level_change",
				"session_info",
			]);
			expect(plan.carried.every((entry) => entry.parentId !== undefined)).toBe(true);
			expect(plan.carried[0].parentId).toBeNull();
			expect(plan.carried[2].parentId).toBe(plan.carried[1].id);
			expect(plan.kept[0].parentId).toBe(plan.carried[2].id);
		});
	});

	it("is a no-op with no compaction: the live context reaches the first entry", () => {
		withDir((dir) => {
			const manager = SessionManager.open(writeSession(dir, { compaction: false }));
			expect(planTrim(manager.getEntries(), manager.buildContextEntries())).toBeNull();
		});
	});

	it("refuses a context entry that is not in the file", () => {
		withDir((dir) => {
			const manager = SessionManager.open(writeSession(dir, { compaction: true }));
			expect(() =>
				planTrim(manager.getEntries(), [{ id: "ghost", type: "message" } as SessionEntry]),
			).toThrow(/not in the session/);
		});
	});
});

describe("writeTrim", () => {
	it("keeps the model-facing context identical and the session name intact", () => {
		withDir((dir) => {
			const file = writeSession(dir, { compaction: true, name: "renamed" });
			const before = SessionManager.open(file);
			const expected = before.buildSessionContext();
			const expectedName = before.getSessionName();

			const plan = planTrim(before.getEntries(), before.buildContextEntries())!;
			const report = writeTrim(file, before.getHeader() as SessionHeader, plan);

			const after = SessionManager.open(file);
			expect(after.buildSessionContext()).toEqual(expected);
			expect(after.getSessionName()).toBe(expectedName);
			expect(report.droppedEntries).toBe(6);
			expect(report.bytesAfter).toBeLessThan(report.bytesBefore);
		});
	});

	it("moves the prefix to a numbered archive and never overwrites one", () => {
		withDir((dir) => {
			const file = writeSession(dir, { compaction: true });
			const header = SessionManager.open(file).getHeader() as SessionHeader;

			const trimOnce = () => {
				const manager = SessionManager.open(file);
				const plan = planTrim(manager.getEntries(), manager.buildContextEntries());
				return plan ? writeTrim(file, header, plan) : null;
			};

			const first = trimOnce()!;
			expect(first.archiveFile).toBe(`${file}.history1`);
			const archived = readFileSync(first.archiveFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
			expect(archived.map((entry) => entry.id)).toEqual(["mc1", "tl1", "si1", "u1", "lb1", "a1"]);

			// Second pass has nothing left to cut; a re-archive would reuse entry ids.
			expect(trimOnce()).toBeNull();
			expect(nextArchivePath(file)).toBe(`${file}.history2`);
		});
	});

	it("leaves a loadable session behind", () => {
		withDir((dir) => {
			const file = writeSession(dir, { compaction: true });
			const manager = SessionManager.open(file);
			const plan = planTrim(manager.getEntries(), manager.buildContextEntries())!;
			writeTrim(file, manager.getHeader() as SessionHeader, plan);

			const reloaded = SessionManager.open(file);
			expect(reloaded.getLeafId()).toBe("u3");
			expect(reloaded.getHeader()?.id).toBe("01a10000-0000-7000-8000-000000000000");
			expect(reloaded.getBranch().map((entry) => entry.id)).toEqual([
				"mc1",
				"tl1",
				"si1",
				"u2",
				"a2",
				"cp1",
				"u3",
			]);
		});
	});
});

describe("treeNavigationBlocked", () => {
	const marker = (archiveFile: string): SessionEntry =>
		({ id: "tm1", type: "custom", customType: TRIM_MARKER, parentId: null, timestamp: STAMP, data: { archiveFile } }) as SessionEntry;

	it("allows a target that is still in the session", () => {
		const entries = [marker("/x/a.jsonl.history1")];
		expect(treeNavigationBlocked(entries, "tm1")).toBeNull();
	});

	it("reports the archive for a target that was trimmed out", () => {
		const entries = [marker("/x/a.jsonl.history1")];
		expect(treeNavigationBlocked(entries, "u1")).toEqual({ archive: "/x/a.jsonl.history1" });
	});

	it("stays out of the way when this session was never trimmed", () => {
		expect(treeNavigationBlocked([], "u1")).toBeNull();
	});
});

describe("restartHint", () => {
	it("stays quiet below the threshold", () => {
		expect(restartHint(0)).toBeUndefined();
		expect(restartHint(HINT_MIN_DROPPED_BYTES - 1)).toBeUndefined();
	});

	it("reports the heap a restart reclaims, at 3x the trimmed JSON", () => {
		expect(restartHint(HINT_MIN_DROPPED_BYTES)).toBe("restart frees ~24 MB");
		expect(restartHint(60 * 1024 * 1024)).toBe("restart frees ~180 MB");
	});
});

describe("extension wiring", () => {
	/** A session whose dropped prefix is large enough to trip the restart hint. */
	function writeLargeSession(dir: string): string {
		const file = join(dir, "2026-10-30T00-00-00-000Z_bulk.jsonl");
		const header = {
			type: "session",
			version: 3,
			id: "01a10000-0000-7000-8000-000000000001",
			timestamp: STAMP,
			cwd: dir,
		};
		const body = [
			{ type: "model_change", id: "mc1", parentId: null, timestamp: STAMP, provider: "p", modelId: "m" },
			{ type: "message", id: "u1", parentId: "mc1", timestamp: STAMP, message: message("user", "old prompt") },
			{
				type: "message",
				id: "bulk",
				parentId: "u1",
				timestamp: STAMP,
				message: { role: "assistant", content: [{ type: "text", text: "x".repeat(9 * 1024 * 1024) }] },
			},
			{ type: "message", id: "u2", parentId: "bulk", timestamp: STAMP, message: message("user", "kept prompt") },
			{
				type: "compaction",
				id: "cp1",
				parentId: "u2",
				timestamp: STAMP,
				summary: "summary",
				firstKeptEntryId: "u2",
				tokensBefore: 1000,
			},
			{ type: "message", id: "u3", parentId: "cp1", timestamp: STAMP, message: message("user", "after") },
		];
		writeFileSync(file, [header, ...body].map((entry) => `${JSON.stringify(entry)}\n`).join(""));
		return file;
	}

	function loadExtension() {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
		const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
		const entries: Array<{ customType: string; data: unknown }> = [];
		const statuses: Array<[string, string | undefined]> = [];
		const pi = {
			on(event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) {
				handlers.set(event, handler);
			},
			registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, options.handler);
			},
			registerEntryRenderer() {},
			appendEntry(customType: string, data: unknown) {
				entries.push({ customType, data });
			},
		};
		const notifications: string[] = [];
		const ctxFor = (file: string) => ({
			hasUI: true,
			sessionManager: SessionManager.open(file),
			ui: {
				setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
				notify: (message: string) => notifications.push(message),
			},
		});
		sessionTrim(pi as never);
		return { handlers, commands, entries, statuses, notifications, ctxFor };
	}

	it("/trim rewrites the file, records a marker and shows the restart hint", async () => {
		await withDirAsync(async (dir) => {
			const file = writeLargeSession(dir);
			const { commands, entries, statuses, notifications, ctxFor } = loadExtension();
			await commands.get("trim")!("", ctxFor(file));
			expect(readFileSync(file, "utf8").length).toBeLessThan(1024 * 1024);
			expect(entries.map((entry) => entry.customType)).toEqual([TRIM_MARKER]);
			expect(statuses).toHaveLength(1);
			expect(statuses[0][0]).toBe("session-trim");
			expect(statuses[0][1]).toMatch(/^restart frees ~\d+ MB$/);
			expect(notifications[0]).toMatch(/^Trimmed 9\.0 MB \(3 entries\)/);
		});
	});

	it("leaves a small file alone on compaction", async () => {
		await withDirAsync(async (dir) => {
			const file = writeSession(dir, { compaction: true });
			const sizeBefore = readFileSync(file, "utf8").length;
			const { handlers, notifications, ctxFor } = loadExtension();
			await handlers.get("session_compact")!({ type: "session_compact" }, ctxFor(file));
			expect(readFileSync(file, "utf8").length).toBe(sizeBefore);
			expect(notifications).toEqual([]);
		});
	});

	it("clears the hint when a resume or fork swaps the session manager", async () => {
		const { handlers, statuses } = loadExtension();
		await handlers.get("session_start")!(
			{ type: "session_start", reason: "resume" },
			{ hasUI: true, ui: { setStatus: (key: string, text: string | undefined) => statuses.push([key, text]) } },
		);
		expect(statuses).toEqual([["session-trim", undefined]]);
	});
});
