/**
 * The checkpoint summary's machine block: the facts only tooling knows,
 * appended verbatim after the authored text (owner 2026-10-31,
 * `decisions/checkpoint/005`).
 *
 * `checkpoint.ts` renders the authored text (`renderSummary`) and composes the
 * halves; this module owns the appended half, the file-op merge that feeds it,
 * and the N/A token both halves spell. Deterministic by construction — a fixed
 * fact order, no timestamps, and file lists sorted here rather than by whoever
 * gathered them.
 *
 * Type-only pi imports, no pi runtime: this module must stay unit-testable.
 */
import assert from "node:assert/strict";
import type { FileOperations, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { GitBinding } from "./checkpoint-meta.ts";

/** The explicit N/A token the field contract, the authored text and this block all spell. */
export const NONE = "none";

/** File facts recorded on a checkpoint's compaction entry. */
export interface CheckpointFileOps {
	readFiles: string[];
	modifiedFiles: string[];
}

/**
 * What the injection produced, bucketed so that every requested path is named
 * somewhere in the rendered facts (sanity-check §5.7: a silently dropped path
 * is a misleading omission).
 */
export interface InjectionFacts {
	/** The block the fresh window receives; empty only when no path was requested. */
	text: string;
	/** Paths whose read windows were injected, in request order. */
	injected: string[];
	/** Paths already in the preserved tail, so re-injecting would duplicate them. */
	skippedPreserved: string[];
	/** Paths dropped for the injection budget. */
	omitted: string[];
	/** Paths whose recorded windows no longer match the file on disk. */
	changed: string[];
	/** Paths with no tracked read window at all. */
	noTrackedRegion: string[];
}

const MACHINE_HEADING = "### Machine facts";
const MACHINE_NOTE = "_Recorded by the checkpoint tool — facts, not authored text._";
const INJECTION_HEADING = "### Injection";

/** `a, b`, or `none`. */
function listOrNone(paths: readonly string[]): string {
	return paths.length > 0 ? paths.join(", ") : NONE;
}

/** `main @ fd3ee99 (clean; ahead 1, behind 0)`, or `none` outside a repo. */
function renderGitFact(git: GitBinding | null): string {
	if (!git) return `git: ${NONE}`;
	const state = git.dirty ? "dirty" : "clean";
	const tracking = git.aheadBehind
		? `ahead ${git.aheadBehind.ahead}, behind ${git.aheadBehind.behind}`
		: "ahead/behind unknown (no upstream)";
	return `git: ${git.branch} @ ${git.head.slice(0, 7)} (${state}; ${tracking})`;
}

/**
 * `120,000 → after: unknown`. The after count does not exist when the summary
 * is composed: pi appends the compaction entry and only then estimates the new
 * context (`dist/core/agent-session.js`: `appendCompaction` … then
 * `estimateMessagesTokens`), so that fact lands in the notify and the meta
 * instead (`recordTokensAfter`).
 */
function renderTokensFact(before: number): string {
	return `${before.toLocaleString("en-US")} → after: unknown`;
}

/**
 * The injection rides the summary, so a `continue: false` checkpoint keeps its
 * file context. The producer names every requested path in a bucket, so empty
 * text means no path was requested.
 */
function renderInjectionSection(injection: InjectionFacts): string {
	return `${INJECTION_HEADING}\n${injection.text || `${NONE} — no relevantPaths requested`}`;
}

/**
 * The machine block appended after the authored text: the facts only tooling
 * knows, one line each in a fixed order (owner 2026-10-31,
 * `decisions/checkpoint/005`).
 */
export function renderMachineBlock(facts: {
	git: GitBinding | null;
	fileOps: CheckpointFileOps;
	archivePath?: string;
	tokensBefore: number;
	injection: InjectionFacts;
}): string {
	const archive = facts.archivePath
		? `${facts.archivePath} — grep with \`rg PATTERN ${facts.archivePath}\``
		: `${NONE} (archive write failed; the session file holds it)`;
	const lines = [
		MACHINE_HEADING,
		MACHINE_NOTE,
		`- ${renderGitFact(facts.git)}`,
		`- files read: ${listOrNone(facts.fileOps.readFiles)}`,
		`- files modified: ${listOrNone(facts.fileOps.modifiedFiles)}`,
		`- archive: ${archive}`,
		`- tokens: ${renderTokensFact(facts.tokensBefore)}`,
	];
	return `${lines.join("\n")}\n\n${renderInjectionSection(facts.injection)}`;
}

/** Shape check for file-op details on a compaction entry (pi writes the same shape). */
function isFileOpsDetails(value: unknown): value is CheckpointFileOps {
	if (typeof value !== "object" || value === null) return false;
	const details = value as CheckpointFileOps;
	const isPathList = (list: unknown): boolean =>
		Array.isArray(list) && list.every((item) => typeof item === "string");
	return isPathList(details.readFiles) && isPathList(details.modifiedFiles);
}

/**
 * File facts for this checkpoint: what the summarised messages touched, unioned
 * with the nearest earlier compaction's record on the compacting branch.
 *
 * The walk is load-bearing because core never inherits `details` from a
 * hook-supplied compaction (`dist/core/compaction/compaction.js`:
 * `!prevCompaction.fromHook`), and every checkpoint compaction is `fromHook`.
 * Without it a window that touched nothing reports nothing, and the trail that
 * led here is lost.
 *
 * It starts at the cut boundary and follows parents, so an abandoned branch's
 * compaction cannot leak its file list in (sanity-check §5.4).
 */
export function checkpointFileOps(
	fileOps: FileOperations,
	branchEntries: ReadonlyArray<SessionEntry>,
	firstKeptEntryId: string,
): CheckpointFileOps {
	const byId = new Map(branchEntries.map((entry) => [entry.id, entry]));
	const boundary = byId.get(firstKeptEntryId);
	// pi's preparation names an entry of the compacting branch:
	// `findProjectedCutPoint` picks a real index, `prepareCompaction` refuses the
	// case where it has no id, and `firstKeptEntryId` is a `string`
	// (`dist/core/compaction/compaction.js`), so a miss is a broken caller, not
	// a state to paper over by walking the whole branch.
	assert(boundary, `checkpoint: firstKeptEntryId ${firstKeptEntryId} is not on the compacting branch`);

	let entry: SessionEntry | undefined = boundary;
	let previous: CheckpointFileOps | null = null;
	while (entry) {
		if (entry.type === "compaction" && isFileOpsDetails(entry.details)) {
			previous = entry.details;
			break;
		}
		entry = entry.parentId ? byId.get(entry.parentId) : undefined;
	}

	const modified = new Set<string>([
		...fileOps.written,
		...fileOps.edited,
		...(previous?.modifiedFiles ?? []),
	]);
	const read = new Set<string>([...fileOps.read, ...(previous?.readFiles ?? [])]);
	return {
		readFiles: [...read].filter((path) => !modified.has(path)).sort(),
		modifiedFiles: [...modified].sort(),
	};
}
