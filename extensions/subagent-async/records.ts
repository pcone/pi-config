/**
 * Work-order records (decisions/work-order-records/001) — the spawner's side of
 * `scripts/wo_record.py`: the dispatch at spawn, each reviewer round, and the
 * completion at the implementer's close, then the check that all of it reached
 * the tree that gets committed.
 *
 * The record's cwd is that tree: the isolation worktree when the spawn is
 * isolated, else the spawner's repo root. A record written anywhere else is a
 * change nobody commits, and a lost record is invisible — WO-2026-094.
 *
 * Split out of `index.ts` by WO-2026-095.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { getFinalOutput } from "./worktree.ts";
import { readMetaJson, readPersistedSpawns } from "./index.ts";

// ── Work-order records (decisions/work-order-records/001) ───────────────────
// The spawner writes, into the tree that will be committed: the dispatch at
// spawn, then each reviewer round and the completion when the implementer
// closes. `scripts/wo_record.py` owns the format and the departure parsing.

const WO_RECORD_SCRIPT = "scripts/wo_record.py";

/** The absolute record file `append` names in its own output. The tool owns where a record
 *  lives; the harness only needs to know it to check the entry reached a commit. */
const NAMED_RECORD_FILE = /(?:^|\s)(\/[^\s()]+\.md)\b/;

/** An entry this run wrote, keyed the way `summary --json` reports it. */
export interface RecordEntryRef {
	kind: string;
	keys: Record<string, string>;
}

/** What a meta carries for the record. The write list below is per-run, so a resume starts
 *  a fresh one: only this process's appends are checked at its close. */
export interface PersistedWorkRecord {
	cwd: string; // the tree that will be committed: the isolation worktree, else the spawner's repo root
	woId: string; // WO-YYYY-NNN
}

export interface WorkRecord extends PersistedWorkRecord {
	/** The record files the appends named, absolute, in write order. */
	paths: string[];
	/** The entries this run wrote. */
	entries: RecordEntryRef[];
}

/** A record open for a run: the meta's fields, with this run's write list empty. */
export function openRecordContext(persisted: PersistedWorkRecord): WorkRecord {
	return { cwd: persisted.cwd, woId: persisted.woId, paths: [], entries: [] };
}

/** `review(session=subagent-…)` — how a failure names an entry that went missing. */
function recordLabel(entry: RecordEntryRef): string {
	return `${entry.kind}(${Object.entries(entry.keys).map(([k, v]) => `${k}=${v}`).join(",")})`;
}

function failureText(run: { error?: Error; stderr: string; status: number | null }): string {
	return run.error?.message || run.stderr.trim() || `exit ${run.status}`;
}

/** Append one entry through the tool and record where it landed. A tool that names no record
 *  file leaves the entry unverifiable, so that is a failure, not a success. */
function woRecordAppend(record: WorkRecord, args: string[], body: string): string | null {
	const run = spawnSync("python3", [path.join(record.cwd, WO_RECORD_SCRIPT), "append", ...args], {
		cwd: record.cwd, input: body, encoding: "utf8",
	});
	if (run.status !== 0 || run.error) return failureText(run);
	const named = NAMED_RECORD_FILE.exec(run.stdout);
	if (!named) return `append ${args[1]} named no record file: ${run.stdout.trim() || "(no output)"}`;
	if (!record.paths.includes(named[1])) record.paths.push(named[1]);
	return null;
}

/** A reviewer's task and final output, from its pi session file (JSONL, one entry per line).
 *  A malformed line throws: a record must not quietly lose part of a session. */
export function readSessionExchange(sessionFile: string): { task: string; output: string } | null {
	const messages: any[] = [];
	for (const line of fs.readFileSync(sessionFile, "utf-8").split("\n")) {
		if (line.trim()) {
			const entry = JSON.parse(line);
			if (entry.type === "message") messages.push(entry.message);
		}
	}
	const first = messages.find((m) => m?.role === "user");
	if (!first) return null;
	const task = typeof first.content === "string"
		? first.content
		: first.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
	return { task, output: getFinalOutput(messages) };
}

/** Open a work-order record for a spawn by writing its dispatch. `recordCwd` is the tree that
 *  will be committed — the isolation worktree, else the spawner's repo root — and the script is
 *  resolved there, so the append lands there. Returns the record to complete at close, plus the
 *  writes that failed. A repo without wo_record.py gets neither record nor failure.
 *  Only a spawn that OWNS the order calls this: a reviewer never owns one, so its spawn writes
 *  nothing (the `reviewerKind` gate at the `subagent` call site). */
export function openWorkRecord(
	recordCwd: string,
	workOrderPath: string,
	implementerId: string,
	task: string,
): { record?: WorkRecord; failures: string[] } {
	if (!fs.existsSync(path.join(recordCwd, WO_RECORD_SCRIPT))) return { failures: [] };
	const fail = (why: string) => ({ failures: [`work-order record not written: ${why}`] });
	try {
		const woId = path.basename(workOrderPath).match(/^WO-\d{4}-\d{3}/)?.[0];
		if (!woId) return fail(`${workOrderPath} has no WO-YYYY-NNN prefix`);
		const record = openRecordContext({ cwd: recordCwd, woId });
		const blob = spawnSync("git", ["hash-object", "--", workOrderPath], { cwd: recordCwd, encoding: "utf8" });
		if (blob.status !== 0 || blob.error) return fail(`git hash-object ${workOrderPath}: ${failureText(blob)}`);
		const err = woRecordAppend(record, [
			woId, "dispatch", "--wo_blob", blob.stdout.trim(), "--implementer", implementerId, "--work_order", workOrderPath,
		], task);
		if (err) return fail(err);
		record.entries.push({ kind: "dispatch", keys: { implementer: implementerId } });
		return { record, failures: [] };
	} catch (e) {
		return fail(e instanceof Error ? e.message : String(e));
	}
}

/** The reviewer sessions a record already holds, and how many reviews. Read through the tool, not
 *  by parsing its text. A failure is returned as text: the caller then writes nothing. */
function recordedReviews(record: WorkRecord): { sessions: Set<string>; count: number } | string {
	const run = spawnSync("python3", [path.join(record.cwd, WO_RECORD_SCRIPT), "summary", record.woId, "--json"], {
		cwd: record.cwd, encoding: "utf8",
	});
	if (run.status !== 0 || run.error) return failureText(run);
	const reviews = (JSON.parse(run.stdout).entries as { kind: string; keys: Record<string, string> }[])
		.filter((e) => e.kind === "review");
	return { sessions: new Set(reviews.map((e) => e.keys.session)), count: reviews.length };
}

/** The final text of a recovered run, from its session file (its messages never reached this process). */
export function sessionFinalText(sessionFile: string | undefined): string {
	return sessionFile ? (readSessionExchange(sessionFile)?.output ?? "") : "";
}

/** Write the reviews not yet in the record, then a completion, for a finished implementer. Reviews
 *  already recorded (by session id) are skipped, so a resumed or recovered run appends only what is
 *  new. `implementerKey` is its pi session id, the key its reviewers were registered under; `readFinal`
 *  yields its final report and runs inside the guard. Returns the writes that were skipped (`notes`)
 *  and the ones that failed (`failures` — a failed write loses part of the record). */
export function completeWorkRecord(
	record: WorkRecord,
	implementerKey: string,
	readFinal: () => string,
): { notes: string[]; failures: string[] } {
	const { woId } = record;
	try {
		const recorded = recordedReviews(record);
		if (typeof recorded === "string") {
			return { notes: [], failures: [`work-order record: ${woId} not read, nothing written: ${recorded}`] };
		}
		const notes: string[] = [];
		const failures: string[] = [];
		let round = recorded.count;
		for (const entry of readPersistedSpawns(implementerKey).spawns) {
			if (recorded.sessions.has(entry.childSessionId)) continue;
			const where = `review ${entry.childSessionId}`;
			try {
				const sessionFile = readMetaJson(entry.childSessionId)?.sessionFile;
				const exchange = sessionFile ? readSessionExchange(sessionFile) : null;
				if (!exchange) {
					notes.push(`work-order record: ${where} not written: no session file with a task`);
					continue;
				}
				const err = woRecordAppend(record, [
					woId, "review", "--seat", entry.childAgentName, "--round", String(round + 1), "--session", entry.childSessionId,
				], JSON.stringify({ brief: exchange.task, output: exchange.output }));
				if (err) failures.push(`work-order record: ${where} not written: ${err}`);
				else {
					round += 1;
					recorded.sessions.add(entry.childSessionId);
					record.entries.push({ kind: "review", keys: { session: entry.childSessionId } });
				}
			} catch (e) {
				failures.push(`work-order record: ${where} not written: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		const finalText = readFinal();
		if (!finalText.trim()) {
			notes.push("work-order record: completion not written: implementer has no final report");
			return { notes, failures };
		}
		const err = woRecordAppend(record, [woId, "completion", "--implementer", implementerKey], finalText);
		if (err) failures.push(`work-order record: completion not written: ${err}`);
		else record.entries.push({ kind: "completion", keys: { implementer: implementerKey } });
		return { notes, failures };
	} catch (e) {
		return { notes: [], failures: [`work-order record: completion not written: ${e instanceof Error ? e.message : String(e)}`] };
	}
}

/** Close-time gate (WO-2026-094 M2): every entry this run wrote must be in the tree that will be
 *  committed. `mustBeCommitted` is set when this process committed that tree and is about to remove
 *  it (an isolated spawn), so the entry has to be in its HEAD; a non-isolated spawn's tree is
 *  committed by the spawner later, so the entry only has to be in its working file.
 *  Returns the failures — each naming the record and what is missing — and empty when the record is
 *  where it will be committed. A run that wrote nothing has nothing to check; its note says why. */
export function verifyWorkRecord(record: WorkRecord, mustBeCommitted: boolean): string[] {
	if (record.entries.length === 0) return [];
	const failures: string[] = [];
	const where = record.paths.join(", ") || record.cwd;

	const run = spawnSync("python3", [path.join(record.cwd, WO_RECORD_SCRIPT), "summary", record.woId, "--json"], {
		cwd: record.cwd, encoding: "utf8",
	});
	let held: { kind: string; keys: Record<string, string> }[] | null = null;
	if (run.status !== 0 || run.error) {
		failures.push(`record ${where} not readable in ${record.cwd}: ${failureText(run)}`);
	} else {
		try {
			held = JSON.parse(run.stdout).entries;
		} catch (e) {
			failures.push(`record ${where} summary is not JSON: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	if (held) {
		const missing = record.entries.filter((want) =>
			!held.some((got) => got.kind === want.kind
				&& Object.entries(want.keys).every(([k, v]) => got.keys?.[k] === v)));
		if (missing.length > 0) {
			failures.push(`record ${where} is missing ${missing.map(recordLabel).join(", ")}`);
		}
	}

	if (mustBeCommitted) {
		for (const file of record.paths) {
			const rel = path.relative(record.cwd, file);
			if (rel.startsWith("..") || path.isAbsolute(rel)) {
				failures.push(`record file ${file} is outside the committed tree ${record.cwd}`);
				continue;
			}
			const diff = spawnSync("git", ["diff", "--quiet", "HEAD", "--", rel], { cwd: record.cwd, encoding: "utf8" });
			if (diff.status === 1) failures.push(`record file ${file} is not committed in ${record.cwd}`);
			else if (diff.status !== 0) failures.push(`record file ${file} not checked: ${failureText(diff)}`);
		}
	}
	return failures;
}
