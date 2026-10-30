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
import {
	nextArchivePath,
	planTrim,
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
