/**
 * Work-order records (decisions/work-order-records/001) — the spawner's side of
 * `scripts/wo_record.py`: the dispatch at spawn, each reviewer round, and the
 * completion at the implementer's close. The implementer's worktree is never
 * written (two writers would conflict at merge); the script owns the format.
 *
 * Split out of `index.ts` by WO-2026-095. Behaviour is unchanged.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { getFinalOutput } from "./worktree.ts";
import { readMetaJson, readPersistedSpawns } from "./index.ts";

// ── Work-order records (decisions/work-order-records/001) ───────────────────
// The spawner writes, into its own repo: the dispatch at spawn, then each
// reviewer round and the completion when the implementer closes. The
// implementer's worktree is never written — two writers would conflict at
// merge. `scripts/wo_record.py` owns the format and the departure parsing.

const WO_RECORD_SCRIPT = "scripts/wo_record.py";

export interface WorkRecord {
	cwd: string; // the spawner's repo root
	woId: string; // WO-YYYY-NNN
}

function failureText(run: { error?: Error; stderr: string; status: number | null }): string {
	return run.error?.message || run.stderr.trim() || `exit ${run.status}`;
}

function woRecordAppend(cwd: string, args: string[], body: string): string | null {
	const run = spawnSync("python3", [path.join(cwd, WO_RECORD_SCRIPT), "append", ...args], {
		cwd, input: body, encoding: "utf8",
	});
	return run.status === 0 && !run.error ? null : failureText(run);
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

/** Open a work-order record for a spawn by writing its dispatch. Returns the record to complete at
 *  close, plus notes to surface. Never throws; a repo without wo_record.py gets neither record nor note.
 *  Only a spawn that OWNS the order calls this: a reviewer never owns one, so its spawn writes nothing
 *  (the `reviewerKind` gate at the `subagent` call site). */
export function openWorkRecord(
	cwd: string,
	workOrderPath: string,
	implementerId: string,
	task: string,
): { record?: WorkRecord; notes: string[] } {
	if (!fs.existsSync(path.join(cwd, WO_RECORD_SCRIPT))) return { notes: [] };
	const fail = (why: string) => ({ notes: [`work-order record not written: ${why}`] });
	try {
		const woId = path.basename(workOrderPath).match(/^WO-\d{4}-\d{3}/)?.[0];
		if (!woId) return fail(`${workOrderPath} has no WO-YYYY-NNN prefix`);
		const blob = spawnSync("git", ["hash-object", "--", workOrderPath], { cwd, encoding: "utf8" });
		if (blob.status !== 0 || blob.error) return fail(`git hash-object ${workOrderPath}: ${failureText(blob)}`);
		const err = woRecordAppend(cwd, [
			woId, "dispatch", "--wo_blob", blob.stdout.trim(), "--implementer", implementerId, "--work_order", workOrderPath,
		], task);
		return err ? fail(err) : { record: { cwd, woId }, notes: [] };
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
 *  yields its final report and runs inside the guard. Returns notes for the writes that failed. */
export function completeWorkRecord(record: WorkRecord, implementerKey: string, readFinal: () => string): string[] {
	const { cwd, woId } = record;
	try {
		const recorded = recordedReviews(record);
		if (typeof recorded === "string") return [`work-order record: ${woId} not read, nothing written: ${recorded}`];
		const notes: string[] = [];
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
				const err = woRecordAppend(cwd, [
					woId, "review", "--seat", entry.childAgentName, "--round", String(round + 1), "--session", entry.childSessionId,
				], JSON.stringify({ brief: exchange.task, output: exchange.output }));
				if (err) notes.push(`work-order record: ${where} not written: ${err}`);
				else {
					round += 1;
					recorded.sessions.add(entry.childSessionId);
				}
			} catch (e) {
				notes.push(`work-order record: ${where} not written: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		const finalText = readFinal();
		const err = finalText.trim()
			? woRecordAppend(cwd, [woId, "completion", "--implementer", implementerKey], finalText)
			: "implementer has no final report";
		if (err) notes.push(`work-order record: completion not written: ${err}`);
		return notes;
	} catch (e) {
		return [`work-order record: completion not written: ${e instanceof Error ? e.message : String(e)}`];
	}
}
