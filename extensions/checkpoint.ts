/**
 * checkpoint — archive the session, compact it, and continue (or hold).
 *
 * A session can be waiting on someone: the owner's ruling, a restart, a peer's
 * reply, a subagent it must gate. That wait is session state, not prompt text
 * (decision checkpoint/003): it is recorded through the `wait_for` tool or
 * derived by the feature that owns it, and `continue` left unset continues only
 * when no wait is pending. An explicit `true` or `false` overrides. Nothing
 * here infers a wait from `nextSteps` or any other prose — a seat that forgot
 * its wait is told about it in the tool result and again in the kickoff prompt.
 *
 * Design: docs/design/checkpoint-waits.md, extensions/lib/waits.ts.
 */

import { mkdir, readdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import type { AgentMessage, AssistantMessage } from "@earendil-works/pi-agent-core";
import {
	SessionManager,
	type CompactionResult,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { setPendingGo } from "./go.ts";
import { CHECKPOINT_MARKER } from "./lib/checkpoint-marker.ts";
import {
	captureGitBinding,
	metaPathFor,
	recordTokensAfter,
	renderTokenDelta,
	tokensBefore,
	type CheckpointTokens,
	type GitBinding,
} from "./lib/checkpoint-meta.ts";
import {
	checkpointFileOps,
	renderMachineBlock,
	NONE,
	type InjectionFacts,
} from "./lib/checkpoint-summary.ts";
import { validateNextStepsOwnerState } from "./lib/owner-row.ts";
import { safeNotify } from "./lib/safe-notify.ts";
import {
	ReadTracker,
	collectPreservedReadPaths,
	formatRanges,
	mergeRegions,
	normalizePath,
	selectFreshRegions,
} from "./lib/read-tracking.ts";
import { listInFlightSubagents, type InFlightSubagent } from "./lib/subagent-state.ts";
import {
	WAIT_ENTRY_TYPE,
	describePending,
	pendingWaits,
	registerWaitSurface,
	resolveContinuation,
	sendKickoff,
	waitCollection,
	waitHost,
	type Continuation,
	type Wait,
} from "./lib/waits.ts";

const CHECKPOINT_DIR = ".pi/checkpoints";

// Fraction of context window to use for file injection (15%).
const INJECTION_BUDGET_FRACTION = 0.15;

// ---------------------------------------------------------------------------
// Summary schema + rendering
// ---------------------------------------------------------------------------

/**
 * The fixed summary schema both checkpoint tools accept (sanity-check §3 row 5,
 * §6 item 4). Kept verbatim in the archive meta as `summaryFields`.
 */
interface SummaryFields {
	goal: string;
	filesTouched: string[];
	decisions: string[];
	triedAndFailed: string[];
	constraints: string;
}

const SUMMARY_FORMAT_HINT =
	"`summary` is an object and every field is required: " +
	"`goal` (one paragraph: what this checkpoint is accomplishing), " +
	"`filesTouched` (repo-relative paths), " +
	"`decisions` (choices made, with why), " +
	"`triedAndFailed` (each entry names an approach tried, what happened, and why it failed — " +
	"the fresh window retries what it is not told about), " +
	"`constraints` (limits the next window must respect). " +
	'Empty means the literal "none"/["none"], never an omitted field or an empty list: ' +
	"`[]`, an omitted field and a blank string are rejected, and so is a checkpoint whose " +
	'`decisions` and `triedAndFailed` are both `"none"` — nothing to resume.';

/**
 * Every field required: presence is the point, so the typebox schema enforces
 * it. Presence is not enough — `validateSummaryFields` rejects the blank and
 * empty-list forms the schema cannot express, before any side effect.
 */
const SUMMARY_SCHEMA = Type.Object(
	{
		goal: Type.String({
			description: "One paragraph: what this checkpoint is accomplishing.",
		}),
		filesTouched: Type.Array(Type.String(), {
			description: "Repo-relative paths touched.",
		}),
		decisions: Type.Array(Type.String(), {
			description: 'Choices made and why. ["none"] when none.',
		}),
		triedAndFailed: Type.Array(Type.String(), {
			description:
				"Each entry: an approach tried, what happened, and why it failed. " +
				'The next window retries what it is not told about. ["none"] when none.',
		}),
		constraints: Type.String({
			description: 'Limits the next window must respect. "none" when none.',
		}),
	},
	{ description: SUMMARY_FORMAT_HINT },
);

/** `["none"]` and nothing else — the explicit N/A token. Total, so a malformed
 *  tool argument is reported by the validator instead of throwing here. */
function isNone(items: unknown): boolean {
	return (
		Array.isArray(items) &&
		items.length === 1 &&
		typeof items[0] === "string" &&
		items[0].trim().toLowerCase() === NONE
	);
}

/** `label: none`, or the label followed by one bullet per entry. */
function bulletSection(label: string, items: string[]): string {
	if (isNone(items)) return `${label}: ${NONE}`;
	return `${label}:\n${items.map((item) => `  - ${item}`).join("\n")}`;
}

/**
 * The canonical summary text. Its three consumers — the compaction
 * `customInstructions`, `meta.summary`, and `checkpoint_fork`'s seeded message —
 * all call this; none formats its own copy.
 */
function renderSummary(fields: SummaryFields, nextSteps: string): string {
	return [
		`Goal: ${fields.goal}`,
		`Files touched: ${isNone(fields.filesTouched) ? NONE : fields.filesTouched.join(", ")}`,
		bulletSection("Decisions", fields.decisions),
		bulletSection("Tried and failed (and why)", fields.triedAndFailed),
		`Constraints: ${fields.constraints}`,
		`Next: ${nextSteps}`,
	].join("\n");
}

/**
 * The field contract both tools enforce before any side effect (owner
 * 2026-10-31, `decisions/checkpoint/005`): every field present and non-blank,
 * with the literal `none` / `["none"]` as the only N/A token. `[]` is rejected
 * — an empty list is an omission, not a statement — as is a checkpoint that
 * records neither a decision nor a failed approach, because then there is
 * nothing to resume.
 *
 * Returns one line per violating field; the caller turns a non-empty list into
 * a single tool-error result, so a thin checkpoint lands nothing.
 */
function validateSummaryFields(fields: SummaryFields): string[] {
	const problems: string[] = [];

	if (typeof fields.goal !== "string" || fields.goal.trim().length === 0) {
		problems.push("goal: must be a non-blank paragraph saying what this checkpoint is for");
	}

	for (const name of ["filesTouched", "decisions", "triedAndFailed"] as const) {
		const items: unknown = fields[name];
		if (!Array.isArray(items)) {
			problems.push(`${name}: must be a list of strings; use ["none"] when there is nothing to report`);
			continue;
		}
		if (items.length === 0) {
			problems.push(`${name}: [] is rejected — use ["none"] when there is nothing to report`);
			continue;
		}
		if (items.some((item) => typeof item !== "string" || item.trim().length === 0)) {
			problems.push(`${name}: every entry must be a non-blank string`);
		}
	}

	if (typeof fields.constraints !== "string" || fields.constraints.trim().length === 0) {
		problems.push('constraints: must be a non-blank string; use "none" when there is nothing to report');
	}

	if (isNone(fields.decisions)) {
		if (isNone(fields.triedAndFailed)) {
			problems.push(
				'decisions + triedAndFailed: both are "none" — record the choice made or the approach tried, or there is nothing to resume',
			);
		}
	}

	return problems;
}

// ---------------------------------------------------------------------------
// Tool results
// ---------------------------------------------------------------------------

/** The tool-error result shape both tools return. */
interface ToolError {
	content: Array<{ type: "text"; text: string }>;
	isError: true;
}

/** Every rejection reason is one tool-error result, prefixed as today's callers read it. */
function toolError(text: string): ToolError {
	return { content: [{ type: "text", text: `Error: ${text}` }], isError: true };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RelevantPathEntry {
	path: string;
}

/** Everything an archive records besides the transcript itself. */
interface ArchiveMetaExtras {
	summaryFields: SummaryFields | null;
	tokens: CheckpointTokens;
	git: GitBinding | null;
	/** Set by `checkpoint_fork`: the cwd the new session lands in. */
	newCwd?: string;
}

/** State passed from checkpoint tool → compaction hook → onComplete callback. */
interface PendingCheckpoint {
	/**
	 * Everything known before the cut boundary: the authored text plus the
	 * in-flight section. The compaction hook appends the machine block, whose
	 * file facts only `preparation` has.
	 */
	summary: string;
	next: string;
	continuation: Continuation;
	/**
	 * The waits pending when the tool ran, resolved once. The tool result and the
	 * kickoff then tell one story even if a source ends mid-compaction.
	 */
	waits: Wait[];
	tokens: CheckpointTokens;
	git: GitBinding | null;
	archivePath?: string;
	relevantPaths: RelevantPathEntry[];
	cwd: string;
	contextWindow: number;
	injection?: InjectionFacts;
}

// ---------------------------------------------------------------------------
// Session-scoped state
// ---------------------------------------------------------------------------

/** Files read this session, keyed by normalized relative-to-cwd path. */
const reads = new ReadTracker();

/** Pending checkpoint data that bridges execute() → session_before_compact → onComplete. */
let pendingCheckpoint: PendingCheckpoint | null = null;

/**
 * True once the checkpoint tool has stashed a request and the turn's tool
 * results have not yet settled. `turn_end` consumes it: a later checkpoint
 * call in the same turn replaces the data but only one compaction fires.
 */
let compactRequested = false;

// ---------------------------------------------------------------------------
// In-flight subagent record (R3-1)
// ---------------------------------------------------------------------------

/**
 * The machine-built "In-flight subagents" section appended to every archived
 * summary. Sourced read-only from the subagent meta registry (tfd
 * process-controls R3, owner 2026-10-19) — never from the model's summary, so
 * work in flight cannot be lost by an omission in the prose. Empty registry
 * (or no running/orphaned child) means no section.
 */
export function formatInFlightSection(entries: InFlightSubagent[]): string {
	if (entries.length === 0) return "";
	const lines = ["### In-flight subagents", "_Recorded by the checkpoint tool from the subagent meta registry._"];
	for (const e of entries) {
		const agent = e.agentName ? ` (${e.agentName})` : "";
		const branch = e.branch ? `branch \`${e.branch}\`` : "no worktree branch";
		lines.push(`- \`${e.sid}\`${agent} — ${branch} — state: ${e.state} (${e.evidence})`);
		if (e.resumeCall) lines.push(`  - resumable: \`${e.resumeCall}\``);
	}
	return lines.join("\n");
}

/**
 * The stored summary: every section, authored text first, blank-line
 * separated. Empty sections are dropped — a section is empty only when its
 * producer has nothing to record (e.g. no in-flight subagents), which is a
 * stated absence, not a missing line.
 */
function composeSummary(sections: ReadonlyArray<string>): string {
	return sections.filter((section) => section.length > 0).join("\n\n");
}

/**
 * R6 (tfd process-controls, owner 2026-10-19): `nextSteps` states owner state
 * only by registry row id. `error` is the tool-error result for a violating
 * claim (the tool call lands nothing); `warning` is the existence lookup's
 * degradation when the repo's registry script cannot run — non-blocking, but
 * carried onto the tool result and a `ui.notify` warning so it is never silent.
 */
function checkOwnerState(
	nextSteps: string,
	cwd: string,
): { error?: ToolError; warning?: string } {
	const verdict = validateNextStepsOwnerState(nextSteps, cwd);
	if (verdict.ok) return { warning: verdict.warning };
	return { error: toolError(verdict.error) };
}

/**
 * Test hook: point the meta-registry scan at `dir` instead of /tmp. Owned by
 * the registry module — the subagent wait source reads the same override.
 */
export { _testSetInflightScanDir } from "./lib/subagent-state.ts";

// ---------------------------------------------------------------------------
// File injection
// ---------------------------------------------------------------------------

function estimateTokens(content: string): number {
	return Math.ceil(content.length / 4);
}

/**
 * One line saying what the injected block is: content re-read from disk at
 * checkpoint time, line ranges picked from an earlier read.
 */
const SNAPSHOT_LABEL =
	"[Disk snapshot taken at checkpoint time — line ranges were selected from an earlier read, so line numbers may have shifted.]";

/**
 * Read file contents for each entry in `relevantPaths`, skipping files that
 * are already preserved in the compacted context.
 *
 * Only the lines actually read this session are injected — if the whole file
 * was read the whole file goes through. Windows whose file changed since the
 * read are never served: their line numbers described an older version, so the
 * file is named for a re-read instead.
 *
 * Every requested path lands in exactly one bucket and every bucket is
 * rendered, so no path can vanish silently (§5.7: omission is misleading).
 */
async function buildFileInjection(
	relevantPaths: RelevantPathEntry[],
	cwd: string,
	contextWindow: number,
	preserved: Set<string>,
): Promise<InjectionFacts> {
	const budget = Math.round(contextWindow * INJECTION_BUDGET_FRACTION);
	const parts: string[] = [];
	const injected: string[] = [];
	const omitted: string[] = [];
	const skippedPreserved: string[] = [];
	const changed: string[] = [];
	const noTrackedRegion: string[] = [];
	let used = 0;
	if (relevantPaths.length === 0) {
		return { text: "", injected, omitted, skippedPreserved, changed, noTrackedRegion };
	}

	for (const entry of relevantPaths) {
		const key = normalizePath(entry.path, cwd);

		// Skip files already in the preserved context tail — the model
		// already has whatever lines it read during the preserved turns.
		if (preserved.has(key)) {
			skippedPreserved.push(entry.path);
			continue;
		}

		// No read regions tracked → nothing to inject, but the path is named with
		// its remedy instead of disappearing (a window that read via `bash` leaves
		// no tracked region, and silence reads as "carried").
		const regions = reads.regionsFor(entry.path, cwd);
		if (!regions || regions.length === 0) {
			noTrackedRegion.push(entry.path);
			continue;
		}

		// -- Read and format file content (matching read-tool output format) -
		const absolutePath = resolvePath(cwd, entry.path);
		let content: string;

		try {
			const [raw, snapshot] = await Promise.all([
				readFile(absolutePath, "utf-8"),
				stat(absolutePath),
			]);

			// A window read from another version of the file describes line
			// numbers that no longer hold, so it is dropped rather than served.
			const fresh = selectFreshRegions(regions, snapshot);
			if (fresh.length === 0) {
				changed.push(entry.path);
				continue;
			}
			// A partly fresh file is `injected`: its surviving windows are served,
			// and the block's own header says the line ranges came from an earlier
			// read. One bucket per path — `changed` means nothing was served.

			const merged = mergeRegions(fresh);
			const rawLines = raw.split("\n");
			const totalLines = rawLines.length;
			// Single region covering the whole file → no continuation hints.
			const isFullFile = merged.length === 1 && merged[0].offset === 1 && merged[0].endLine >= totalLines;
			const chunks: string[] = [];
			for (const r of merged) {
				const start = Math.max(0, r.offset - 1);
				const end = Math.min(rawLines.length, r.endLine);
				if (start >= end) continue;
				chunks.push(rawLines.slice(start, end).join("\n"));
				if (!isFullFile && end < totalLines) {
					chunks.push(`[L${r.offset}-${end} of ${totalLines} lines. offset=${end + 1} for more.]`);
				}
			}
			content = chunks.join("\n\n");
		} catch {
			// Gone or unreadable: its recorded windows no longer describe a file on
			// disk, which is the same fact as an edit.
			changed.push(entry.path);
			continue;
		}

		const tokens = estimateTokens(content);
		const block = `[${entry.path}]\n${content}`;
		const blockTokens = estimateTokens(block);

		if (used + blockTokens > budget) {
			omitted.push(entry.path);
			continue;
		}

		parts.push(block);
		injected.push(entry.path);
		used += blockTokens;
	}

	let text = parts.length > 0 ? `${SNAPSHOT_LABEL}\n${parts.join("\n\n")}` : "";

	const notes: string[] = [];
	if (skippedPreserved.length > 0) {
		notes.push(
			`${skippedPreserved.length} file(s) already in preserved context — skipped: ${skippedPreserved.join(", ")}. `,
		);
	}
	if (omitted.length > 0) {
		notes.push(
			`${parts.length} of ${relevantPaths.length} files included ` +
			`(budget: ${budget.toLocaleString()} tokens, ~${Math.round(INJECTION_BUDGET_FRACTION * 100)}% of context window). ` +
			`Omitted: ${omitted.join(", ")}. Use read tool if needed.`,
		);
	}
	if (changed.length > 0) {
		notes.push(
			`${changed.length} file(s) changed since read — re-read if needed: ${changed.join(", ")}. `,
		);
	}
	if (noTrackedRegion.length > 0) {
		notes.push(
			`${noTrackedRegion.length} file(s) with no tracked read region — re-read after compaction: ` +
				`${noTrackedRegion.join(", ")}. `,
		);
	}
	if (notes.length > 0) {
		text = text ? `${text}\n\n[${notes.join(" ")}]` : `[${notes.join(" ")}]`;
	}

	return { text, injected, omitted, skippedPreserved, changed, noTrackedRegion };
}

// ---------------------------------------------------------------------------
// Archive helpers
// ---------------------------------------------------------------------------

/** Drop thinking blocks from assistant messages. Archives are for reference, not API replay. */
function stripThinking(msg: AssistantMessage): AssistantMessage {
	const filtered = msg.content.filter((b) => b.type !== "thinking");
	return filtered.length === msg.content.length ? msg : { ...msg, content: filtered };
}

/** Write session entries to a JSONL archive, plus the single meta record beside it. */
async function archiveSession(
	cwd: string,
	entries: unknown[],
	summary: string,
	sessionId: string | undefined,
	extras: ArchiveMetaExtras,
): Promise<string> {
	const archiveDir = join(cwd, CHECKPOINT_DIR);
	await mkdir(archiveDir, { recursive: true });
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const sid = sessionId ? `${sessionId}-` : "";
	const archivePath = join(archiveDir, `session-${sid}${ts}.jsonl`);

	const lines: string[] = [];
	for (const entry of entries as Array<{ type: string; message?: AgentMessage }>) {
		if (entry?.type === "message" && entry.message?.role === "assistant") {
			lines.push(JSON.stringify({ ...entry, message: stripThinking(entry.message) }));
		} else {
			lines.push(JSON.stringify(entry));
		}
	}
	await writeFile(archivePath, lines.join("\n") + "\n", "utf8");

	const metaPath = metaPathFor(archivePath);
	await writeFile(
		metaPath,
		JSON.stringify(
			{
				timestamp: new Date().toISOString(),
				sessionId,
				archivePath,
				summary,
				entryCount: entries.length,
				summaryFields: extras.summaryFields,
				tokens: extras.tokens,
				git: extras.git,
				...(extras.newCwd ? { newCwd: extras.newCwd } : {}),
			},
			null,
			2,
		),
		"utf8",
	);
	return archivePath;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// The wait surface (`wait_for`, the restart announcement) lives with the
	// store it writes; this file owns only what a checkpoint does with a wait.
	registerWaitSurface(pi);

	// -- Read tracking ---------------------------------------------------
	pi.on("session_start", () => {
		reads.clear();
		pendingCheckpoint = null;
		compactRequested = false;
	});

	// Finalized read args arrive here, on `input`. `tool_execution_end` carries
	// no args at all, so tracking from it recorded nothing (WO-2026-055).
	pi.on("tool_result", async (event, ctx) => {
		await reads.recordToolResult(event, ctx.cwd);
	});

	// -- Compaction trigger ----------------------------------------------
	// The checkpoint tool only stashes its request in execute(); compaction is
	// triggered here, once the run has finished. Two constraints fix this point.
	//
	// After execute(): compacting from inside the tool disconnected the agent
	// mid-batch, so the checkpoint result was never persisted and a late tool
	// result attached to the compaction entry — the orphan-toolResult defect this
	// guards against.
	//
	// After the run, not at `turn_end`: `ctx.compact()` opens with
	// `await this.abort()`, which waits for the session to go idle, and `turn_end`
	// is dispatched *inside* the run loop (`_dispatchTurnEndBoundary` is awaited by
	// it). Compacting there asks the loop to go idle while the loop is waiting for
	// this handler: the run aborts instead — an empty `stopReason: error`
	// assistant message, persisted with every such checkpoint — and the compaction
	// waits for an idle that the handler it is blocking can never reach.
	// `agent_settled` is emitted after `_isAgentRunActive` is cleared, so `abort()`
	// finds the session idle and the compaction runs.
	pi.on("agent_settled", (_event, ctx) => {
		if (!compactRequested) return;
		compactRequested = false;
		// Snapshot: onComplete/onError own clearing the pending data. A later
		// checkpoint call replaces it before this fires (last request wins).
		const pending = pendingCheckpoint;
		ctx.compact({
			customInstructions: `${CHECKPOINT_MARKER}\n${pending?.summary ?? ""}`,
			onComplete: async (result: CompactionResult) => {
				const inj = pending?.injection;
				const tokens: CheckpointTokens = {
					before: result?.tokensBefore ?? pending?.tokens.before ?? null,
					after: result?.estimatedTokensAfter ?? null,
				};
				pendingCheckpoint = null;

				// Notify and continuation run before the meta patch below: pi does
				// not await this callback, and a checkpoint's user-visible outcome
				// must not wait on an archive write. The outer catch keeps a throw
				// visible as "Checkpoint failed" — pi's compaction wrapper only sees
				// synchronous throws from this callback.
				try {
					const archiveLine = pending?.archivePath ? `\nArchive: ${pending.archivePath}` : "";
					safeNotify(
						ctx,
						`Checkpoint complete — context cleared.${renderTokenDelta(tokens)}${archiveLine}`,
						"info",
					);
					if (pending?.continuation.doContinue) {
						await sendKickoff({
							parts: {
								context: inj?.text,
								next: pending.next,
								trailing: pending.archivePath ? [`Archive: ${pending.archivePath}`] : [],
							},
							waits: pending.waits,
							send: (text) => pi.sendUserMessage(text, { deliverAs: "followUp" }),
						});
					}
				} catch (err) {
					safeNotify(
						ctx,
						`Checkpoint failed: ${err instanceof Error ? err.message : String(err)}`,
						"error",
					);
				}

				try {
					await recordTokensAfter(pending?.archivePath, tokens);
				} catch { /* meta gone — the notify already carries the delta */ }
			},
			onError: (err) => {
				pendingCheckpoint = null;
				safeNotify(ctx, `Checkpoint failed: ${err.message}`, "error");
			},
		});
	});

	// -- Compaction hook -------------------------------------------------
	pi.on("session_before_compact", async (event, ctx) => {
		const { customInstructions, preparation } = event;

		if (customInstructions?.includes(CHECKPOINT_MARKER)) {
			const pending = pendingCheckpoint;
			if (!pending) {
				// A marker with no pending state is the post-reload case: the authored
				// text survives on the instructions, the machine facts do not.
				return {
					compaction: {
						summary: customInstructions.replace(CHECKPOINT_MARKER, "").trim(),
						firstKeptEntryId: preparation.firstKeptEntryId,
						tokensBefore: preparation.tokensBefore,
					},
				};
			}

			// Scope the scan to the entries being compacted: `getEntries()` also
			// holds off-branch reads, which are not in the model's context and
			// would wrongly suppress injection.
			const entries = event.branchEntries ?? ctx.sessionManager.getEntries();
			const preserved = collectPreservedReadPaths(
				entries,
				preparation.firstKeptEntryId,
				ctx.cwd,
			);
			// Built whether or not work continues: the injection now rides the
			// summary, which exists on both paths.
			const injection = await buildFileInjection(
				pending.relevantPaths,
				pending.cwd,
				pending.contextWindow,
				preserved,
			);
			pending.injection = injection;

			const fileOps = checkpointFileOps(
				preparation.fileOps,
				entries,
				preparation.firstKeptEntryId,
			);
			const summary = composeSummary([
				pending.summary,
				renderMachineBlock({
					git: pending.git,
					fileOps,
					archivePath: pending.archivePath,
					tokensBefore: preparation.tokensBefore,
					injection,
				}),
			]);

			return {
				compaction: {
					summary,
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					// Core does not inherit details from a hook compaction, so the file
					// trail across checkpoints is carried here.
					details: fileOps,
				},
			};
		}

		// Auto-compaction (not from checkpoint tool): archive independently.
		const autoSummary = `Auto-archived before compaction (${preparation.tokensBefore.toLocaleString()} tokens)`;
		try {
			const archivePath = await archiveSession(
				ctx.cwd,
				ctx.sessionManager.getEntries(),
				autoSummary,
				ctx.sessionManager.getSessionId(),
				{
					// No authored summary here — the auto path has no schema fields.
					summaryFields: null,
					tokens: { before: preparation.tokensBefore, after: null },
					git: await captureGitBinding(ctx.cwd),
				},
			);
			// Best-effort: the archive is written and compaction is what the user is
			// waiting on, so a stale ctx must not turn either outcome into an error.
			safeNotify(ctx, `📦 Archived session for grepping: ${archivePath}`, "info");
		} catch (err) {
			safeNotify(
				ctx,
				`Archive failed (compaction continues): ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
		}
	});

	// -- checkpoint tool -------------------------------------------------
	pi.registerTool({
		name: "checkpoint",
		label: "Checkpoint",
		description:
			"Archive the current session, clear context, and continue. " +
			"Use at logical task boundaries when work for this turn is done but more remains. " +
			"A checkpoint is not a pause: a fresh prompt starts the next turn unless a wait is pending. " +
			"Pass `continue: false` when you are stopping to wait, and record the wait with `wait_for` — see those parameters. " +
			"Preserved reads are skipped automatically — only files the model hasn't seen in the preserved tail are injected.",
		parameters: Type.Object({
			summary: SUMMARY_SCHEMA,
			nextSteps: Type.Optional(
				Type.String({
					description:
						"What comes next. Used as the kickoff prompt when the checkpoint continues. Defaults to 'Continue work'. " +
						"A wait you are holding for is carried into that prompt; record it with `wait_for` when nothing else can see it.",
				}),
			),
			continue: Type.Optional(
				Type.Boolean({
					description:
						"Unset continues only when no wait is pending; true always continues, false always stops. " +
						"A wait is a `wait_for` record, a running subagent, or an unanswered expectReply send. " +
						"Set false — or leave unset with a wait pending — when the next move belongs to someone else: " +
						"the owner's ruling or a restart, a peer you wrote to for a reply, or a subagent you must gate first. " +
						"The session then sits idle until a message arrives — the owner's, a peer's, or a finished subagent's — " +
						"which is the only way a wait leaks: mail and subagent events still start turns.",
				}),
			),
			relevantPaths: Type.Optional(
				Type.Array(
					Type.Object({
						path: Type.String({
							description:
								"File path relative to cwd (same convention as read/write tools).",
						}),
					}),
					{
						description:
							"Files to carry forward after compaction. Be conservative — only include files you are **certain** you'll need in the very next turn. " +
							"When in doubt, omit it: you can always read it again after the checkpoint. " +
							"Only the lines actually read are injected; files already in the preserved tail are skipped automatically.",
					},
				),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// Argument shape first (nothing is written on a rejection), then the R6
			// verdict: both are tool-error results, so neither may sit behind an
			// early `return`.
			const fieldProblems = validateSummaryFields(params.summary);
			if (fieldProblems.length > 0) {
				return toolError(
					[
						"summary rejected — nothing was archived or compacted. Fix every field below:",
						...fieldProblems.map((problem) => `- ${problem}`),
					].join("\n"),
				);
			}
			const ownerState = checkOwnerState(params.nextSteps ?? "", ctx.cwd);
			if (ownerState.error) return ownerState.error;
			if (ownerState.warning) safeNotify(ctx, ownerState.warning, "warning");

			const next = params.nextSteps ?? "Continue work";
			const waits = pendingWaits(waitHost(pi, ctx), waitCollection(ctx));
			const continuation = resolveContinuation(params.continue, waits);
			const relevantPaths: RelevantPathEntry[] = params.relevantPaths ?? [];
			const contextWindow = ctx.model?.contextWindow ?? 200_000;
			const summaryFields: SummaryFields = params.summary;

			// Captured before anything is written, so the archive's own untracked
			// files cannot show up in `git.dirty`.
			const git = await captureGitBinding(ctx.cwd);
			const tokens: CheckpointTokens = { before: tokensBefore(ctx), after: null };

			// R3-1: the archive and the restore path read the same text, so the
			// in-flight record is in the context after compaction. The machine block
			// is appended by the compaction hook, which is the only site holding the
			// file facts.
			const inFlight = listInFlightSubagents({
				selfSessionId: ctx.sessionManager.getSessionId(),
			});
			const summary = composeSummary([renderSummary(summaryFields, next), formatInFlightSection(inFlight)]);

			// Archive *before* compaction so all entries are captured in full.
			let archivePath: string | undefined;
			try {
				archivePath = await archiveSession(
					ctx.cwd,
					ctx.sessionManager.getEntries(),
					summary,
					ctx.sessionManager.getSessionId(),
					{ summaryFields, tokens, git },
				);
			} catch (err) {
				safeNotify(
					ctx,
					`Archive failed (compaction continues): ${err instanceof Error ? err.message : String(err)}`,
					"warning",
				);
			}

			// Stash params for session_before_compact to pick up (it has access
			// to firstKeptEntryId, which lets us skip preserved files) and mark
			// the request for the turn_end trigger. Do NOT compact here: the
			// tool result has not been persisted yet.
			pendingCheckpoint = {
				summary,
				next,
				continuation,
				waits,
				tokens,
				git,
				archivePath,
				relevantPaths,
				cwd: ctx.cwd,
				contextWindow,
			};
			compactRequested = true;

			const responseLines = [`Checkpoint queued.`];
			if (ownerState.warning) responseLines.push(ownerState.warning);
			if (inFlight.length > 0) {
				responseLines.push(
					`In-flight subagents recorded in the summary: ${inFlight.length} ` +
						`(${inFlight.map((e) => `${e.sid.slice(-8)} ${e.state}`).join(", ")}).`,
				);
			}
			if (archivePath) {
				responseLines.push(`Full session archived to:\n\`${archivePath}\``);
				responseLines.push(`Grep there with: \`rg PATTERN ${archivePath}\``);
			} else {
				responseLines.push(`Archive failed — session data is preserved in the session file.`);
			}
			responseLines.push(`Next: ${next}${continuation.doContinue ? "" : " (no auto-continue)"}`);
			// The model may have forgotten the wait it is holding. State it here,
			// with the resolved outcome, so a checkpoint cannot quietly start work.
			responseLines.push(describePending(waits, continuation));

			return {
				content: [{ type: "text", text: responseLines.join("\n\n") }],
			};
		},
	});

	// -- checkpoint_fork tool --------------------------------------------
	pi.registerTool({
		name: "checkpoint_fork",
		label: "Checkpoint Fork",
		description:
			"Archive the current session and stage a fork into a new working directory. " +
			"Run /go to commit the switch (session switching requires a user-initiated command). " +
			"You (the model) choose the target directory, author the summary from current context, " +
			"and pick nextSteps/continue — just like checkpoint. " +
			"The target dir must already exist.",
		parameters: Type.Object({
			newCwd: Type.String({
				description: "Target working directory for the forked session. Must already exist.",
			}),
			summary: SUMMARY_SCHEMA,
			nextSteps: Type.Optional(
				Type.String({
					description:
						"What comes next. Used as the kickoff prompt when the checkpoint continues. Default: 'Continue work'. " +
						"A wait you are holding for is carried into that prompt; record it with `wait_for` when nothing else can see it.",
				}),
			),
			continue: Type.Optional(
				Type.Boolean({
					description:
						"Unset continues only when no wait is pending; true always continues, false always stops — " +
						"as with `checkpoint`.",
				}),
			),
			relevantPaths: Type.Optional(
				Type.Array(
					Type.Object({
						path: Type.String({
							description:
								"File path relative to the *source* cwd (same convention as read/write tools). " +
								"Files are read from the source directory and injected into the new session.",
						}),
					}),
					{
						description:
							"Files from the source cwd to inject into the new session context. " +
							"Only the lines actually read are injected — if whole file, whole file goes through. " +
							"Forks start fresh — no preservation dedup applies.",
					},
				),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const fieldProblems = validateSummaryFields(params.summary);
			if (fieldProblems.length > 0) {
				return toolError(
					[
						"summary rejected — nothing was archived or staged. Fix every field below:",
						...fieldProblems.map((problem) => `- ${problem}`),
					].join("\n"),
				);
			}

			let targetStat;
			try {
				targetStat = await stat(params.newCwd);
			} catch {
				return toolError(`target directory does not exist: ${params.newCwd}`);
			}
			if (!targetStat.isDirectory()) {
				return toolError(`not a directory: ${params.newCwd}`);
			}

			// Argument shape first: the R6 verdict (refusal or warning) goes on the
			// tool result, so it must not sit behind an early `return`.
			const ownerState = checkOwnerState(params.nextSteps ?? "", ctx.cwd);
			if (ownerState.error) return ownerState.error;
			if (ownerState.warning) safeNotify(ctx, ownerState.warning, "warning");

			const next = params.nextSteps ?? "Continue work";
			const waits = pendingWaits(waitHost(pi, ctx), waitCollection(ctx));
			const continuation = resolveContinuation(params.continue, waits);
			const relevantPaths: RelevantPathEntry[] = params.relevantPaths ?? [];
			const oldSessionId = ctx.sessionManager.getSessionId();
			const oldCwd = ctx.sessionManager.getCwd();
			const contextWindow = ctx.model?.contextWindow ?? 200_000;
			const summaryFields: SummaryFields = params.summary;

			// The source tree's ref, captured when the fork is authored (the archive
			// itself is written at /go, after this): the summary describes this state.
			const git = await captureGitBinding(oldCwd);
			const tokens: CheckpointTokens = { before: tokensBefore(ctx), after: null };

			// R3-1: both the fork-source archive and the new session's summary
			// carry the in-flight record.
			const inFlight = listInFlightSubagents({
				selfSessionId: ctx.sessionManager.getSessionId(),
			});
			const summary = composeSummary([renderSummary(summaryFields, next), formatInFlightSection(inFlight)]);

			// Fork creates a new session — no preservation to dedup against.
			const injection = await buildFileInjection(
				relevantPaths,
				oldCwd,
				contextWindow,
				new Set(), // empty — nothing preserved
			);

			const included = injection.injected.length;

			setPendingGo({
				label: `fork → ${params.newCwd}`,
				run: async (cmdCtx) => {
					try {
						const forkArchivePath = await archiveSession(
							cmdCtx.cwd,
							cmdCtx.sessionManager.getEntries(),
							summary,
							cmdCtx.sessionManager.getSessionId(),
							{ summaryFields, tokens, git, newCwd: params.newCwd },
						);
						safeNotify(cmdCtx, `📦 Fork source archived: ${forkArchivePath}`, "info");
					} catch (err) {
						safeNotify(
							cmdCtx,
							`Fork archive failed (switch continues): ${err instanceof Error ? err.message : String(err)}`,
							"warning",
						);
					}
					const newSession = SessionManager.create(params.newCwd);
					newSession.appendMessage({
						role: "user",
						content: [
							{ type: "text", text: `This session was created from a checkpoint of session ${oldSessionId} (${oldCwd}).` },
						],
						timestamp: Date.now(),
					});
					newSession.appendMessage({
						role: "assistant",
						content: [{ type: "text", text: summary }],
						api: "anthropic",
						provider: "anthropic",
						model: "unknown",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
						stopReason: "end",
						timestamp: Date.now(),
					});
					// The fork inherits the source's manual-wait snapshot as a real
					// entry on its own branch, so a store over that branch replays it
					// (decision checkpoint/003, ruling 4). Derived waits do not
					// travel: each belongs to a process and a source, and the new
					// session has neither.
					const carried = waits.filter((wait) => wait.source === "manual");
					if (carried.length > 0) newSession.appendCustomEntry(WAIT_ENTRY_TYPE, { waits: carried });

					await cmdCtx.switchSession(newSession.getSessionFile()!, {
						withSession: async (n) => {
							if (!continuation.doContinue) return;
							// The kickoff names the waits the new session actually
							// holds — the copied manual ones. A derived wait belongs to
							// the source's process and source, so announcing it here
							// would name a hold the new session could never clear.
							await sendKickoff({
								parts: { context: injection.text, next },
								waits: carried,
								send: (text) => n.sendUserMessage(text),
							});
						},
					});
				},
			});

			safeNotify(ctx, `Fork prepared → ${params.newCwd}. Run /go to switch.`, "info");

			const responseLines = [`Fork prepared → ${params.newCwd}. Run /go to switch.`];
			if (ownerState.warning) responseLines.push(ownerState.warning);
			if (inFlight.length > 0) {
				responseLines.push(`In-flight subagents recorded in the summary: ${inFlight.length}.`);
			}
			responseLines.push(describePending(waits, continuation));
			if (relevantPaths.length > 0) {
				const notes: string[] = [];
				notes.push(
					`${included} of ${relevantPaths.length} files ` +
					`(~${Math.round(INJECTION_BUDGET_FRACTION * 100)}% context budget)`,
				);
				if (injection.omitted.length > 0) notes.push(`Omitted (budget): ${injection.omitted.join(", ")}`);
				if (injection.skippedPreserved.length > 0) notes.push(`Skipped (preserved): ${injection.skippedPreserved.join(", ")}`);
				if (injection.changed.length > 0) notes.push(`Changed since read: ${injection.changed.join(", ")}`);
				if (injection.noTrackedRegion.length > 0)
					notes.push(`No tracked read region: ${injection.noTrackedRegion.join(", ")}`);
				responseLines.push(`File injection: ${notes.join(". ")}`);
			}

			return {
				content: [{ type: "text", text: responseLines.join("\n\n") }],
			};
		},
	});

	// -- /checkpoints command --------------------------------------------
	pi.registerCommand("checkpoints", {
		description: "List archived session checkpoints.",
		async handler(_args, ctx) {
			const archiveDir = join(ctx.cwd, CHECKPOINT_DIR);
			try {
				const files = (await readdir(archiveDir)).filter((f) => f.endsWith(".meta.json"));
				if (files.length === 0) {
					safeNotify(ctx, "No checkpoints yet.", "info");
					return;
				}
				const lines: string[] = [`Checkpoints in ${archiveDir}:`];
				for (const f of files.sort().reverse()) {
					const meta = JSON.parse(await readFile(join(archiveDir, f), "utf8"));
					const shortPath = meta.archivePath ? meta.archivePath.replace(archiveDir, "") : f.replace(/\.meta\.json$/, ".jsonl");
					// First line of the rendered summary is its `Goal:` line.
					const headline = String(meta.summary ?? "(no summary)").split("\n")[0];
					const git = meta.git
						? ` [${meta.git.branch}@${String(meta.git.head).slice(0, 7)}${meta.git.dirty ? "+" : ""}]`
						: "";
					lines.push(`  ${meta.timestamp} — ${headline}${git}`);
					lines.push(`        archive: …${shortPath}`);
				}
				safeNotify(ctx, lines.join("\n"), "info");
			} catch {
				safeNotify(ctx, "No checkpoints yet.", "info");
			}
		},
	});

	// -- /checkpoint command ---------------------------------------------
	pi.registerCommand("checkpoint", {
		description:
			"Archive session and compact context. Sends a follow-up prompting the model to summarize and continue. Optional: /checkpoint <focus hint>",
		handler: async (args, ctx) => {
			const focus = args.trim();

			let fileHint = "";
			if (reads.size > 0) {
				const lines: string[] = [];
				for (const { path, merged, wholeFile } of reads.fileSummaries()) {
					lines.push(`- ${path}${wholeFile ? " (entire file)" : ` → ${formatRanges(merged)}`}`);
				}
				fileHint =
					`\n\nFiles read this session (be conservative with relevantPaths — only include files you're certain you'll need; ` +
					`when in doubt just re-read after checkpoint):\n${lines.join("\n")}`;
			}

			const basePrompt =
				"Run the checkpoint tool now. " + SUMMARY_FORMAT_HINT + " " +
				"Leave `continue` unset: it continues only when no wait is pending. " +
				"When the next move is someone else's — an owner ruling or restart, a peer's reply, a subagent you must gate — " +
				"record the wait that nothing else can see with the `wait_for` tool; a running subagent and an unanswered " +
				"expectReply send are already waits. " +
				"If you need file context carried forward, include a `relevantPaths` list — only list files " +
				"you will actually need after the checkpoint. " +
				"Be conservative: include only files you're 100% certain you'll need in the next turn. " +
				"When in doubt, omit it — you can always read it again.";

			const prompt = focus
				? `${basePrompt}\n\nFocus the summary on: ${focus}${fileHint}`
				: `${basePrompt}${fileHint}`;

			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			safeNotify(ctx, "Checkpoint queued — will run after current work.", "info");
		},
	});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

