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

/** The absolute record file a tool line names: `appended <kind> to <path>`, or `<kind> already
 *  recorded in <path> (…)` when it wrote nothing. The path runs to that line's `.md`, so a checkout
 *  whose directory holds a space or a parenthesis keeps its whole path. The tool owns where a
 *  record lives; the harness only needs it to check the entry reached a commit. */
const NAMED_RECORD_FILE = /^(?:appended \S+ to |\S+ already recorded in )(.+?\.md)\b/m;

function namedRecordFile(stdout: string): string | null {
	return NAMED_RECORD_FILE.exec(stdout)?.[1] ?? null;
}

/** An entry in a record, keyed the way `summary --json` reports it. */
export interface RecordEntryRef {
	kind: string;
	keys: Record<string, string>;
}

/** What a meta carries for the record. The write lists below are per-run, so a resume starts
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
	/** The entries the record must already hold: a resume re-opens the record its dispatch opened,
	 *  so it checks that entry too and reports a record split across two trees (WO-2026-094 Q-094-a). */
	expected: RecordEntryRef[];
}

/** A record open for a run: the meta's fields, with this run's write list empty. */
export function openRecordContext(persisted: PersistedWorkRecord, expected: RecordEntryRef[] = []): WorkRecord {
	return { cwd: persisted.cwd, woId: persisted.woId, paths: [], entries: [], expected };
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
	const named = namedRecordFile(run.stdout);
	if (!named) return `append ${args[1]} named no record file: ${run.stdout.trim() || "(no output)"}`;
	if (!record.paths.includes(named)) record.paths.push(named);
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

/** The entries a record holds, read through the tool rather than by parsing its text. A record
 *  this harness cannot read — the tool refuses, prints no JSON, or reports a shape that is not an
 *  entry list — is returned as text: it must never be read as an empty record, or the completion
 *  hook appends the reviews it already holds a second time. */
function readRecordEntries(record: WorkRecord): RecordEntryRef[] | string {
	const run = spawnSync("python3", [path.join(record.cwd, WO_RECORD_SCRIPT), "summary", record.woId, "--json"], {
		cwd: record.cwd, encoding: "utf8",
	});
	if (run.status !== 0 || run.error) return failureText(run);
	let parsed: any;
	try {
		parsed = JSON.parse(run.stdout);
	} catch (e) {
		return `summary is not JSON: ${e instanceof Error ? e.message : String(e)}`;
	}
	const entries = parsed?.entries;
	if (!Array.isArray(entries)) return `summary carries no entries array: ${run.stdout.trim().slice(0, 200) || "(no output)"}`;
	for (const [i, entry] of entries.entries()) {
		if (typeof entry?.kind !== "string" || typeof entry?.keys !== "object" || entry.keys === null || Array.isArray(entry.keys)) {
			return `summary entry ${i} is not a record entry: ${JSON.stringify(entry).slice(0, 200)}`;
		}
	}
	return entries as RecordEntryRef[];
}

/** The reviewer sessions a record already holds, and how many reviews. A failure is returned as
 *  text: the caller then writes nothing. */
function recordedReviews(record: WorkRecord): { sessions: Set<string>; count: number } | string {
	const entries = readRecordEntries(record);
	if (typeof entries === "string") return entries;
	const reviews = entries.filter((e) => e.kind === "review");
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

/** Commit the record files a run wrote, and nothing else, in the tree that carries them.
 *  A recovery commits its own record because it never runs the spawn's pre-commit steps, so its
 *  entries would otherwise sit uncommitted in a tree the reap or a later checkout discards (owner
 *  ruling Q-094-a, 2026-11-08: recovery commits the record it appended). Staging and committing by
 *  path keeps the tree's other work — the child's, or the spawner's — out of this commit. A commit
 *  is skipped when the paths hold nothing to commit: already committed is a stated state, so a
 *  second close is not a failure. Returns the commit failures; the caller runs `verifyWorkRecord`
 *  either way, which decides whether the entries actually reached the commit. */
export function commitRecordEntries(record: WorkRecord): string[] {
	const inside: string[] = [];
	for (const file of record.paths) {
		const rel = path.relative(record.cwd, file);
		// A path outside the tree is `verifyWorkRecord`'s failure to name, not something to stage.
		if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
		inside.push(rel);
	}
	if (inside.length === 0) return [];
	const git = (args: string[]) => spawnSync("git", args, { cwd: record.cwd, encoding: "utf8" });
	const staged = (why: string) => `${why} in ${record.cwd} (${inside.join(", ")})`;

	const added = git(["add", "-A", "--", ...inside]);
	if (added.status !== 0 || added.error) return [`record commit ${staged("could not stage")}: ${failureText(added)}`];
	const diff = git(["diff", "--cached", "--quiet", "--", ...inside]);
	if (diff.status === 0) return [];
	if (diff.status !== 1) return [`record commit ${staged("not checked")}: ${failureText(diff)}`];
	const commit = git(["commit", "-m", `work-order record: recovery append (${record.woId})`, "--", ...inside]);
	if (commit.status !== 0 || commit.error) return [`record commit ${staged("failed")}: ${failureText(commit)}`];
	return [];
}

/** Close-time gate (WO-2026-094 M2): every entry the record must hold is in the record, and every
 *  file this run wrote is in the tree that will be committed. `mustBeCommitted` is set when this
 *  process committed that tree and is about to remove it (an isolated spawn), so the file has to be
 *  committed there; a non-isolated spawn's tree is committed by the spawner later, so the entry only
 *  has to be in its working file.
 *  Returns the failures — each naming the record and what is missing — and empty when the record is
 *  where it will be committed. A run that wrote nothing and re-opened nothing has nothing to check;
 *  its note says why. Never throws: it runs in an async close handler whose work is already
 *  committed, where a throw would be an unhandled rejection and no delivery at all. */
export function verifyWorkRecord(record: WorkRecord, mustBeCommitted: boolean): string[] {
	const expected = [...record.expected, ...record.entries];
	if (expected.length === 0) return [];
	const where = record.paths.join(", ") || record.cwd;
	try {
		const failures: string[] = [];

		const held = readRecordEntries(record);
		if (typeof held === "string") {
			failures.push(`record ${where} not readable in ${record.cwd}: ${held}`);
		} else {
			const missing = expected.filter((want) =>
				!held.some((got) => got.kind === want.kind
					&& Object.entries(want.keys).every(([k, v]) => got.keys?.[k] === v)));
			if (missing.length > 0) {
				failures.push(`record ${where} is missing ${missing.map(recordLabel).join(", ")}`);
			}
		}

		// The committed leg. `git diff --quiet HEAD` answers 0 for a path that is untracked or
		// ignored — exactly the record nobody commits — so the state is read from `status` instead,
		// which reports `??`, `!!`, and every uncommitted change to a tracked file.
		if (mustBeCommitted) {
			for (const file of record.paths) {
				const rel = path.relative(record.cwd, file);
				if (rel.startsWith("..") || path.isAbsolute(rel)) {
					failures.push(`record file ${file} is outside the committed tree ${record.cwd}`);
					continue;
				}
				const state = spawnSync("git", ["status", "--porcelain", "--ignored", "--", rel], {
					cwd: record.cwd, encoding: "utf8",
				});
				const line = state.stdout.trim().split("\n")[0];
				if (state.status !== 0 || state.error) failures.push(`record file ${file} not checked: ${failureText(state)}`);
				else if (line) failures.push(`record file ${file} is not committed in ${record.cwd}: ${line}`);
			}
		}
		return failures;
	} catch (e) {
		return [`record ${where} not verified: ${e instanceof Error ? e.message : String(e)}`];
	}
}
