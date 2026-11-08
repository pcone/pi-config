/**
 * Checkpoint archive retention. `archiveSession` writes one `.jsonl` plus its
 * `.meta.json` on every checkpoint and never removes them; a working seat
 * accumulates thousands (tfd: 1,054 files / 14 GB by 2026-11-08).
 *
 * The rule: keep every archive younger than the retention window, plus each
 * session's newest archive whatever its age. Nothing reads an older archive —
 * `/checkpoints` lists them, and resume works from the session file, not from
 * these — so the window is a courtesy rather than a dependency.
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { metaPathFor } from "./checkpoint-meta.ts";

/** Archives younger than this many days survive regardless of how many exist. */
export const ARCHIVE_RETENTION_DAYS = 14;

/** `session-<id>-<ISO timestamp>.jsonl`; the stamp is always 24 characters. */
const PREFIX = "session-";
const STAMP_LEN = 24;

/** The session a file belongs to: the meta's `sessionId` where it is readable,
 *  else the name between the prefix and the trailing timestamp. */
export function archiveSessionKey(file: string): string {
	const path = file.endsWith(".jsonl") ? metaPathFor(file) : file;
	const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.meta\.json$/, "");
	const sliced = name.startsWith(PREFIX) && name.length > PREFIX.length + STAMP_LEN + 1
		? name.slice(PREFIX.length, name.length - STAMP_LEN - 1)
		: name;
	try {
		const meta = JSON.parse(readFileSync(path, "utf8")) as { sessionId?: unknown };
		if (typeof meta.sessionId === "string" && meta.sessionId) return meta.sessionId;
	} catch {
		// an unreadable meta does not make the file unprotected
	}
	return sliced;
}

/**
 * Delete archives older than the retention window, keeping each session's
 * newest. Both halves of an archive go together: a `.jsonl` without its meta
 * (or the reverse) is litter, not a record.
 *
 * Best-effort by contract: a failed unlink leaves the file for the next
 * checkpoint rather than failing the checkpoint that triggered the sweep.
 */
export function pruneArchives(
	dir: string,
	now: number = Date.now(),
): { removed: number; freedBytes: number } {
	let files: string[];
	try {
		files = readdirSync(dir);
	} catch {
		return { removed: 0, freedBytes: 0 };
	}

	type Entry = { name: string; mtimeMs: number; size: number };
	const bySession = new Map<string, Entry[]>();
	for (const name of files) {
		if (!name.startsWith(PREFIX) || !name.endsWith(".jsonl")) continue;
		const full = join(dir, name);
		let st;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		const key = archiveSessionKey(full);
		const list = bySession.get(key);
		if (list) list.push({ name, mtimeMs: st.mtimeMs, size: st.size });
		else bySession.set(key, [{ name, mtimeMs: st.mtimeMs, size: st.size }]);
	}

	const cutoff = now - ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
	let removed = 0;
	let freedBytes = 0;
	for (const list of bySession.values()) {
		// Newest first: index 0 survives whatever its age.
		list.sort((a, b) => b.mtimeMs - a.mtimeMs);
		for (const entry of list.slice(1)) {
			if (entry.mtimeMs >= cutoff) continue;
			const archive = join(dir, entry.name);
			const meta = metaPathFor(archive);
			let metaSize = 0;
			try {
				if (existsSync(meta)) metaSize = statSync(meta).size;
			} catch {
				// size is reporting only
			}
			try {
				rmSync(archive);
				removed++;
				freedBytes += entry.size;
			} catch {
				continue; // keep its meta beside it
			}
			try {
				if (existsSync(meta)) {
					rmSync(meta);
					removed++;
					freedBytes += metaSize;
				}
			} catch {
				// the meta is small; the next sweep retries
			}
		}
	}
	return { removed, freedBytes };
}
