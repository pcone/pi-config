/**
 * Checkpoint archive retention (extensions/lib/checkpoint-archive.ts).
 *
 * The rule under test: keep every archive younger than the window, plus each
 * session's newest archive whatever its age; delete the rest as a pair
 * (`.jsonl` and `.meta.json`).
 */
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARCHIVE_RETENTION_DAYS, pruneArchives } from "../extensions/lib/checkpoint-archive.ts";

const dirs: string[] = [];
const DAY = 24 * 60 * 60 * 1000;

afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function archiveDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ck-retention-"));
	dirs.push(dir);
	return dir;
}

/** Write an archive pair stamped `ageDays` ago. Returns its base name. */
function archive(dir: string, session: string, stamp: string, ageDays: number): string {
	const base = `session-${session}-${stamp}`;
	writeFileSync(join(dir, `${base}.jsonl`), "{}\n", "utf8");
	writeFileSync(join(dir, `${base}.meta.json`), JSON.stringify({ sessionId: session }), "utf8");
	const when = (Date.now() - ageDays * DAY) / 1000;
	utimesSync(join(dir, `${base}.jsonl`), when, when);
	utimesSync(join(dir, `${base}.meta.json`), when, when);
	return base;
}

const OLD = "2026-01-01T00-00-00-000Z";
const OLDER = "2026-01-02T00-00-00-000Z";
const YOUNG = "2026-11-01T00-00-00-000Z";

describe("pruneArchives", () => {
	it("R1: an archive past the window that is not its session's newest is deleted with its meta", () => {
		const dir = archiveDir();
		const old = archive(dir, "s1", OLD, 40);
		archive(dir, "s1", OLDER, 30);
		expect(existsSync(join(dir, `${old}.jsonl`))).toBe(true);

		const { removed } = pruneArchives(dir);

		expect(removed).toBe(2); // the jsonl and its meta
		expect(existsSync(join(dir, `${old}.jsonl`))).toBe(false);
		expect(existsSync(join(dir, `${old}.meta.json`))).toBe(false);
	});

	it("R2: each session's newest archive survives past the window", () => {
		const dir = archiveDir();
		archive(dir, "s1", OLD, 60);
		const newest = archive(dir, "s1", OLDER, 45);
		const other = archive(dir, "s2", OLD, 90);

		pruneArchives(dir);

		expect(existsSync(join(dir, `${newest}.jsonl`))).toBe(true);
		expect(existsSync(join(dir, `${other}.jsonl`))).toBe(true);
	});

	it("R3: an archive inside the window survives even when it is not the newest", () => {
		const dir = archiveDir();
		const young = archive(dir, "s1", YOUNG, ARCHIVE_RETENTION_DAYS - 1);
		archive(dir, "s1", OLDER, 30);

		pruneArchives(dir);

		expect(existsSync(join(dir, `${young}.jsonl`))).toBe(true);
	});

	it("R4: files that are not archive pairs are left alone", () => {
		const dir = archiveDir();
		writeFileSync(join(dir, "notes.txt"), "x", "utf8");
		writeFileSync(join(dir, "session-notanarchive.jsonl"), "x", "utf8");
		const old = archive(dir, "s1", OLD, 40);
		archive(dir, "s1", OLDER, 30);

		pruneArchives(dir);

		expect(existsSync(join(dir, "notes.txt"))).toBe(true);
		expect(existsSync(join(dir, "session-notanarchive.jsonl"))).toBe(true);
		expect(existsSync(join(dir, `${old}.jsonl`))).toBe(false);
	});

	it("R5: a directory that does not exist is a no-op, not a throw", () => {
		expect(() => pruneArchives(join(tmpdir(), "ck-retention-does-not-exist"))).not.toThrow();
		expect(pruneArchives(join(tmpdir(), "ck-retention-does-not-exist")).removed).toBe(0);
	});

	it("R6: a session with only young archives keeps every one of them", () => {
		const dir = archiveDir();
		archive(dir, "s1", "2026-11-01T00-00-00-000Z", 2);
		archive(dir, "s1", "2026-11-02T00-00-00-000Z", 1);
		const before = readdirSync(dir).length;

		pruneArchives(dir);

		expect(readdirSync(dir).length).toBe(before);
	});
});
