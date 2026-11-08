/**
 * Recovery: who owns an orphaned child, and what a finished one leaves behind.
 *
 * Two halves of one question, asked at two points in the lifecycle: the spawn
 * fields a meta file carries and the reading of them (ownership, resume
 * pre-checks, the not-found answer), then the `session_start` scan that adopts
 * a previous session's children (decision 027) and the R3-2 reap of their
 * finished worktrees.
 *
 * Split out of `index.ts` by WO-2026-095. Behaviour is unchanged.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type CommandRunner,
	createReapBuildOutput,
	describeBuildOutput,
} from "../lib/build-output-reaper.ts";
import { discoverSessions } from "../lib/subagent-discovery.ts";
import {
	decideRecoveryAdoption,
	gatherSubagentDiskFacts,
	hasTerminalFooter,
	idMatchesQuery,
	isOwnerAlive,
	listSubagentMetas,
	readSubagentState,
	readTerminalFooter,
	resolveSubagentMeta,
	resumeCallFor,
	resolveTurnCap,
	type OwnerProbe,
} from "../lib/subagent-state.ts";
import { completeWorkRecord, sessionFinalText, type WorkRecord } from "./records.ts";
import { removeWorktreeTree } from "./worktree.ts";
import {
	debugLog,
	deliverResult,
	getParentTrackerKey,
	git,
	readMetaJson,
	running,
	updateFooter,
	updateMetaAt,
	type RunningSubagent,
} from "./index.ts";

// ── Recovery ownership ─────────────────────────────────────────────────────
// Moved to ../lib/subagent-state.ts so checkpoint's in-flight section (R3-1)
// shares 027's gate instead of re-deriving it; re-exported at the top of this
// file for the existing importers.

/** The non-owner fields persisted to the meta file at spawn. */
export interface SpawnMetaFields {
	agentName: string;
	task: string;
	cwd: string;
	startedAt: number;
	worktreePath: string | null;
	isolationBranch: string | null;
	parentHeadCommit: string | null;
	parentCwd: string;
	tools: string[];
	model: string;
	systemPrompt?: string;
	allowedSubagents: string[];
	excludeTools: string[];
	/** Set when the spawn opened a work-order record; resume and recovery complete it. */
	workRecord?: WorkRecord;
	/** Decision 046: the resolved turn cap, stored in the spawn's own input
	 *  convention so a resume can hand it straight back to `resolveTurnCap` —
	 *  `0` is the disabled state. */
	turnCap: number;
}

/**
 * Build the meta payload written at spawn, stamping the spawning process's
 * identity (`ownerPid` + `ownerStartToken`) that `decideRecoveryAdoption`
 * reads. Extracted so the owner stamp is unit-testable: if these fields are
 * dropped, every new meta degrades to legacy and recovery silently stops.
 * Exported for unit testing.
 */
export function buildSpawnMeta(
	fields: SpawnMetaFields,
	owner: { pid: number; startToken: string | null; sessionId: string },
): Record<string, any> {
	return {
		...fields,
		ownerPid: owner.pid,
		ownerStartToken: owner.startToken,
		parentSessionId: owner.sessionId,
	};
}

/**
 * R4: does this agent's completion-report schema declare `owner_asks`?
 *
 * The gate is live only where the field is declared (agents/implement.md,
 * agents/orchestrator.md): scouts, reviewers and the other report shapes are
 * untouched. Derived from the prompt mechanically — no agent-name list, no new
 * frontmatter key — so a future report-producing agent inherits the gate by
 * declaring the field in its own schema. Exported for unit testing.
 */
export function reportDeclaresOwnerAsks(systemPrompt: string | null | undefined): boolean {
	if (typeof systemPrompt !== "string") return false;
	// Case-insensitive: a prompt spelling the field `OWNER_ASKS:` declares the
	// same schema, and silently leaving it ungated is the failure this gate
	// exists to prevent. Only the two report-schema prompts contain the token.
	return /(^|\n)[ \t]*(?:[-*][ \t]+)?\**owner_asks\**[ \t]*:/i.test(systemPrompt);
}

/**
 * Match a session query against the running map. Shared by /watch and /attach
 * so both accept the same forms, and backed by `idMatchesQuery` — the one
 * definition of what an id query means (the /tmp meta scan uses it too).
 * @for-testing-only — pure over the injected map
 */
export function findRunningByQuery(
	runningMap: Map<string, RunningSubagent>,
	query: string,
): RunningSubagent | undefined {
	for (const [id, rs] of runningMap) {
		if (idMatchesQuery(id, query)) return rs;
	}
	return undefined;
}

/**
 * Not-found message for the tracker-based tools. Distinguishes an id that
 * matches nothing from a session that exists on disk but is not attached to
 * this process — the two used to share one sentence, so a live child queried
 * with a slightly-off id read as dead. Reports the disk facts (branch,
 * worktree, log) and whether the recorded owner process is still alive.
 * Exported for unit testing.
 */
export function describeUnknownSession(idQuery: string): string {
	let resolved: { sid: string; meta: Record<string, any> } | null = null;
	try {
		resolved = resolveSubagentMeta(idQuery);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	if (!resolved) {
		return (
			`No session matches "${idQuery}". Pass the full id (subagent-<uuid>) or its last 8+ characters ` +
			`(with or without the subagent- prefix); /subagents lists this session's running children.`
		);
	}

	const { sid, meta } = resolved;
	// R3-3: the answer leads with the classified state and the evidence it was
	// read from, so one word never has to carry "may have finished or stopped".
	const reading = readSubagentState(gatherSubagentDiskFacts(sid, { meta }));
	const parts = [
		`State: ${reading.state} — ${reading.evidence}.`,
		`Session ${sid} is not attached to this session's tracker.`,
	];
	const recordedPid = meta.ownerPid;
	const sock = `/tmp/pi-subagent-${sid}.sock`;
	// Report the facts that were checked, never a fact the code did not observe.
	// The old single sentence ("No running subagent found") read as death and got
	// live worktrees force-reaped, so the state must stay legible from the text:
	// whether a socket file is present, whether an owner was recorded, and
	// whether that owner is still alive. `isOwnerAlive` alone returns true for a
	// legacy meta with no owner, which would render "pid undefined is alive".
	const hasRecordedOwner = Number.isInteger(recordedPid) && recordedPid > 0;
	const ownerAlive = hasRecordedOwner ? isOwnerAlive(meta) : undefined;
	const sockExists = fs.existsSync(sock);
	const sockFact = sockExists
		? `a socket file exists at ${sock}`
		: `no socket file exists at ${sock}`;
	const ownerFact = hasRecordedOwner
		? `its recorded owner process (pid ${recordedPid}) is ${ownerAlive ? "still running" : "gone"}`
		: "no owner process was recorded for it";

	if (sockExists && ownerAlive === true) {
		parts.push(
			`Running under another session (owner pid ${recordedPid}) — query it there or use /subagents in that session.`,
		);
	} else {
		// No claim about the child's state beyond the two observed facts: a
		// leftover socket file with a dead owner is common, and only the owner
		// session can settle whether the child is still there.
		parts.push(`Not attached here: ${sockFact}, and ${ownerFact}.`);
	}
	if (meta.isolationBranch) parts.push(`Branch: ${meta.isolationBranch}.`);
	if (meta.worktreePath) parts.push(`Worktree: ${meta.worktreePath}.`);
	parts.push(`Log: /tmp/pi-subagent-${sid}.log`);
	// R3-2 reap kept a finished child's dirty tree: the work is still on disk and
	// resumable, so the answer says so — with the WO's own label for it — instead
	// of reporting a bare completion.
	if (meta.worktreeKept) {
		parts.push(
			`Uncommitted work kept in ${meta.worktreePath ?? "the worktree"} ` +
				`(${meta.worktreeKept?.reason ?? "uncommitted work"}) — orphaned-resumable: ${resumeCallFor(sid, meta)}`,
		);
	}
	// R3-3: an orphaned session is the recoverable one — say so with the call.
	if (reading.state === "orphaned") parts.push(`Resume with: ${resumeCallFor(sid, meta)}`);
	return parts.join(" ");
}

/**
 * The working directory pi recorded in a session file's header, or null when
 * the file is unreadable or carries no cwd. pi refuses to resume a session
 * whose stored cwd is missing, and in rpc mode there is no prompt to choose a
 * replacement — the child exits 1 before its first turn.
 * @for-testing-only — pure over the filesystem
 */
export function readSessionCwd(sessionFile: string): string | null {
	try {
		const fd = fs.openSync(sessionFile, "r");
		let buf: Buffer;
		try {
			// The header is the first line; 16KB is far beyond its real size and
			// avoids reading a multi-megabyte transcript to reach it.
			buf = Buffer.alloc(16 * 1024);
			const n = fs.readSync(fd, buf, 0, buf.length, 0);
			buf = buf.subarray(0, n);
		} finally {
			fs.closeSync(fd);
		}
		const firstLine = buf.toString("utf-8").split("\n", 1)[0];
		const header = JSON.parse(firstLine);
		// Mirror pi's header acceptance (parseSessionHeaderCandidate: type
		// "session" + a string id). A line 1 that pi does not recognize as the
		// header is not what pi reads the cwd from — it falls back to its own
		// cwd — so refusing on that cwd could block a resume pi would accept.
		if (header?.type !== "session" || typeof header.id !== "string") return null;
		return typeof header.cwd === "string" && header.cwd.trim() ? header.cwd : null;
	} catch {
		return null;
	}
}

/**
 * Validate a meta object read from disk for resume. Returns either
 * { ok: true } or { ok: false, error, isError }. Module scope so tests can
 * cover every error path without spawning real processes.
 * @for-testing-only — pure over the filesystem
 */
export function validateResumeMeta(
	meta: Record<string, any> | null,
	sid: string,
): { ok: true } | { ok: false; error: string; isError: boolean } {
	if (!meta) {
		return {
			ok: false,
			error: `No prior session found with id "${sid}". The session may have been purged or never existed. Spawn a fresh subagent instead.`,
			isError: false,
		};
	}
	if (!meta.sessionFile) {
		return {
			ok: false,
			error: `Session file not captured for "${sid}". The original subagent may have crashed before reporting its session. Spawn a fresh subagent instead.`,
			isError: true,
		};
	}
	if (!fs.existsSync(meta.sessionFile)) {
		return {
			ok: false,
			error: `Session file ${meta.sessionFile} no longer exists. Cannot resume.`,
			isError: true,
		};
	}
	// The stored cwd, not the spawn cwd, is what pi validates when the session
	// file is opened. A missing one kills the child at startup, so say why and
	// name the two ways out instead of reporting a 0-turn child that exited 1.
	const storedCwd = readSessionCwd(meta.sessionFile);
	if (storedCwd && !fs.existsSync(storedCwd)) {
		return {
			ok: false,
			error:
				`Cannot resume: the session's recorded working directory no longer exists.\n` +
				`  recorded cwd: ${storedCwd}\n` +
				`pi refuses to resume a session whose stored cwd is missing, and rpc mode has no prompt to pick another (the child would exit 1 before its first turn).\n` +
				`Recreate it and retry:  mkdir -p "${storedCwd}"\n` +
				`Or point it at a live checkout:  ln -s "<checkout>" "${storedCwd}"`,
			isError: true,
		};
	}
	return { ok: true };
}

/**
 * Resolve an orchestrator-supplied parent_session_id to the actual tracker
 * key. The orchestrator passes the RPC handle returned by the subagent
 * dispatch (e.g. `subagent-81f2a34c-...`). Since the handle is passed to
 * the child as `--session-id`, it IS the child's pi session id (meta
 * persists the same value from get_state) — so this is effectively the
 * identity, kept as a safety net for legacy meta files written before the
 * ids were unified.
 *
 * If the arg looks like an RPC handle, look up the meta file and return
 * meta.piSessionId if it's a non-empty string. Otherwise (no meta, malformed
 * meta, missing piSessionId, arg isn't a handle) return the arg unchanged —
 * preserves prior behavior for direct piSessionId args and handles called
 * before get_state fired.
 */
export function resolveTrackerKey(requestedId: string): string {
	// Detection: starts with "subagent-" followed by at least 8 hex/dash chars
	if (!/^subagent-[0-9a-f-]{8,}$/i.test(requestedId)) {
		return requestedId;
	}
	try {
		const meta = readMetaJson(requestedId);
		if (meta && typeof meta.piSessionId === "string" && meta.piSessionId.length > 0) {
			return meta.piSessionId;
		}
	} catch {
		// Swallow all errors — fall through to return requestedId unchanged
	}
	return requestedId;
}

/** @internal test hook — override the directory the real `session_start`
 *  recovery scan reads (defaults to /tmp). Lets a test fire the captured
 *  handler and observe adoption without touching real /tmp. */
let recoveryScanDirOverride: string | undefined;
export function _testSetRecoveryScanDir(dir: string | undefined): void {
	recoveryScanDirOverride = dir;
}

/** @internal test hook — override the home whose shared cargo target root the
 *  reap's bound walks (defaults to the real one). A row must never measure —
 *  or, over the bound, `cargo clean -p` — the box's real shared dirs. */
let cargoHomeOverride: string | undefined;
export function _testSetCargoHome(home: string | undefined): void {
	cargoHomeOverride = home;
}

// ── Orphan recovery scan ─────────────────────────────────────────────────────

export interface RecoveryScanDeps {
	/** Directory holding the `pi-subagent-*.{sock,log,meta.json}` triplets. */
	dir?: string;
	/** Override for the current process pid (tests). */
	selfPid?: number;
	/** Override for the current session id (tests); defaults to the live session's. */
	selfSessionId?: string;
	/** Override for the OS owner probe (tests). */
	probe?: OwnerProbe;
	/** Override for the socket client factory (tests). */
	connect?: (sockPath: string) => net.Socket;
	/** Override for the home the reap's bound walks (tests); defaults to the
	 *  real one, whose `~/.cache/cargo-target` holds one dir per clone. */
	home?: string;
	/** Override for the reap's `cargo` / `git` calls (tests). */
	run?: CommandRunner;
	/** Override for the bound's directory-size measure (tests). */
	sizeOf?: (dir: string) => number | Promise<number>;
}

/**
 * `session_start` recovery scan: re-attach to subagent sockets left behind by a
 * previous session. Decision 027 gates adoption on the spawning process's
 * identity (see `decideRecoveryAdoption`); a live foreign owner is skipped.
 *
 * Extracted with injectable directory / pid / probe / connection factory so the
 * adopt-skip matrix and the `unref` contract are unit-testable without touching
 * /tmp or opening real sockets. Best-effort: never throws (the caller also
 * wraps it, but keeping the scan self-contained makes every branch safe).
 */
export function recoverOrphanedSubagents(
	pi: ExtensionAPI,
	ctx: any,
	deps: RecoveryScanDeps = {},
): void {
	try {
		const sockDir = deps.dir ?? recoveryScanDirOverride ?? "/tmp";
		const connect = deps.connect ?? ((p: string) => net.createConnection(p));
		// The tmp dir's SOCK scan, and only that (`socketsOnly`): no log-only
		// arm, and no readdir, meta read or turn regex of its own (WO-2026-083).
		// The ownership predicate stays here — discovery reports disk facts and
		// carries no session identity — and `resolveSubagentMeta`'s meta glob is a
		// separate question, not folded.
		const sessions = discoverSessions({ dir: sockDir, socketsOnly: true }).filter((s) => s.running);
		for (const s of sessions) {
			const { id: sid, sockPath, logPath, meta } = s;
			if (running.has(sid)) continue; // already tracked

			// An unreadable or missing meta is not a session we can attribute. The
			// predicate would answer the same (`skip-legacy`), but the explicit skip
			// is what keeps the sock file: only a failed `connect` unlinks.
			if (!meta) continue;

			// Decision 027: adopt only if the owner is this process (session
			// reload / new in the same process) or the owner process is gone.
			const adoption = decideRecoveryAdoption(meta, {
				selfPid: deps.selfPid,
				selfSessionId: deps.selfSessionId ?? ctx.sessionManager.getSessionId(),
				probe: deps.probe,
			});
			if (adoption !== "adopt") {
				debugLog(`recovery: ${adoption} for ${sid} (ownerPid=${meta?.ownerPid ?? "none"})`);
				continue;
			}

			// Turns as discovery counted them: the same turn-header lines from the
			// same single log read, `0` when the log could not be read.
			const turns = s.turns;

			const rs: RunningSubagent = {
				proc: null as any,
				sessionId: sid,
				agentName: meta.agentName || "?",
				task: meta.task || "?",
				cwd: meta.cwd || ctx.cwd,
				startedAt: meta.startedAt || Date.now(),
				progress: { turns, filesRead: new Set(), filesModified: new Set(), errors: [], currentActivity: "recovered" },
				messages: [],
				stdin: null,
				resolveOnStop: null,
				isDone: false,
				procExited: false,
				// Classified from the log footer the dead session wrote — see
				// `readTerminalFooter` in the close handler below.
				recoveredFooterWord: null,
				// Recovered subagents are re-attached to a fresh pi
				// session; the kill flag never applies (the previous
				// session died, not killed). Initialize to false to
				// satisfy the RunningSubagent interface contract.
				// `stoppedExplicitly` is likewise N/A on recovery.
				killedExplicitly: false,
				stoppedExplicitly: false,
				turnNudged: false,
				// Decision 046: display-only on a recovered handle — the turn accounting
				// runs in the child's own spawning process, not here. The cap comes from
				// the meta and the count continues the recorded one.
				turnCap: resolveTurnCap(meta.turnCap),
				turnsBefore: meta.turnsUsed ?? 0,
				turnCapReached: false,
				stall: {
					stallTurns: 0,
					stallSteered: false,
					// A recovered handle watches nothing: the accounting ran in the
					// child's spawning process (decision 046).
					stallObserved: false,
					lastTip: null,
					pending: null,
					foldedTurn: meta.turnsUsed ?? 0,
					inFlight: false,
				},
				toolInFlight: 0,
				logPath,
				logLines: [],
				stderrLines: [],
				watchHandle: null,
				sockPath,
				sockServer: null as any,
				sockClients: new Set(),
				worktreePath: meta.worktreePath || null,
				isolationBranch: meta.isolationBranch || null,
				parentHeadCommit: meta.parentHeadCommit || null,
				parentCwd: meta.parentCwd || ctx.cwd,
				workRecord: meta.workRecord,
				// Recovered (orphan-reattached) subagents don't carry the
				// parent's tracker key from the metadata file. Use a stable
				// pid fallback so re-attached sessions don't pollute the
				// live tracker's view. If we had a `parentSessionId` field
				// in the meta file, we'd use it here instead.
				parentTrackerKey: getParentTrackerKey(ctx),
				ownerAsksRequired: reportDeclaresOwnerAsks(meta.systemPrompt),
				reviewParentRequirements: undefined,
				usageStats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, latestCacheHitRate: undefined },
				carried: null,
				staleTimer: null,
				lastActivityMs: Date.now(),
				silenceTimer: null,
				silenceTimeoutMs: 0,
				killedVia: null,
			};

			// Monitor via socket — when it closes, subagent exited.
			// The socket may already be dead (previous pi died without
			// cleanup), in which case connect() fails with ECONNREFUSED.
			// Without an `error` handler that event becomes an
			// uncaughtException and crashes the new pi session.
			const sock = connect(sockPath);
			// Decision 027 liveness hygiene: a recovery connection must NEVER
			// pin the event loop, or `pi -p` hangs until the recovered child
			// exits. unref is unconditional — a recovered child is not this
			// process's own work (the spawn-time handles stay ref'd on
			// purpose; see decision 027).
			sock.unref();
			let connected = false;
			sock.on("connect", () => {
				connected = true;
			});
			sock.on("error", () => {
				rs.sockClients.delete(sock);
				if (connected) return; // socket lived, then died — close handler will run
				// Orphan: previous session left a sock file behind with no listener.
				// Clean up and skip live tracking.
				try {
					fs.unlinkSync(sockPath);
				} catch {
					/* already gone */
				}
				running.delete(sid);
				updateFooter();
			});
			sock.on("close", () => {
				rs.sockClients.delete(sock);
				if (!connected) return; // orphan already handled in error handler
				rs.isDone = true;
				// Read final output from log
				let finalOutput = "(no output)";
				// The footer is this path's only terminal evidence: the child's
				// messages never reached this process. Its word and exit code
				// classify the run exactly as the live close handler would have
				// (WO-2026-078 N4). A log with no footer records no ending at all, so
				// there is likewise no evidence of a finished run: `null` (not
				// pre-078's assumed exit 0) leaves the classification to the exit
				// code, which then says "terminated, not exited".
				let recoveredExitCode: number | null = null;
				try {
					const log = fs.readFileSync(logPath, "utf-8");
					const footer = readTerminalFooter(log);
					if (footer) {
						rs.progress.turns = footer.turns;
						rs.recoveredFooterWord = footer.word;
						recoveredExitCode = footer.exitCode;
						finalOutput = log.split("── ").pop()?.trim() || finalOutput;
					}
				} catch {}
				// The recovered child's messages never reached this process; its session file has them.
				const recordNotes = rs.workRecord
					? completeWorkRecord(rs.workRecord, meta.piSessionId ?? sid, () => sessionFinalText(meta.sessionFile))
					: [];
				rs.recordNotes = recordNotes;
				deliverResult(pi, rs, recoveredExitCode, `\n[Isolation] Recovered from previous session.${recordNotes.map((n) => `\n${n}`).join("")}`);
				running.delete(sid);
				updateFooter();
			});

			rs.sockClients.add(sock);
			running.set(sid, rs);
			updateFooter();
		}
	} catch { /* best-effort */ }
}

/** Outcome of one finished-worktree reap decision. */
export interface ReapResult {
	sid: string;
	outcome: "removed" | "kept-uncommitted" | "kept-unlock-failed" | "kept-remove-failed" | "kept-git-error";
	worktreePath: string;
	detail?: string;
}

/**
 * R3-2 reap: on session start, remove subagent worktrees whose child is
 * provably finished and whose bytes are preserved.
 *
 * Two gates, both required:
 *   - 027's adoption gate — a live foreign owner's tree is never touched, and a
 *     legacy meta is unattributable;
 *   - child-side terminal evidence — the log's last line is a terminal footer
 *     (`hasTerminalFooter`, one of `OUTCOME_WORD`'s words or `Exited`/
 *     `Stopped`), the same evidence the status vocabulary reads. Owner death
 *     alone is NOT enough: the child is a separate process and a dead owner can
 *     outlive it.
 *
 * Then: a clean tree (`git status --porcelain -uall` empty, so the work lives
 * on the branch) is unlocked and removed with a plain `worktree remove` — no
 * `--force`, so even a race cannot delete uncommitted work. A dirty tree is
 * left in place, marked in the meta (`worktreeKept`) so the status answer
 * offers `subagent_resume` for it, and the reap moves on. A removal or prune
 * failure is reported in the result, never thrown; a bug in the build-output
 * helpers is not swallowed, and surfaces through the caller's `reap: unhandled`
 * log line.
 *
 * Build output (WO-2026-091) is not this function's: a removed tree loses its
 * `target/` and its share of the clone's shared cargo dir through
 * `removeWorktreeTree`, a kept one loses its `target/` once its branch has
 * landed or is gone, and a shared dir over its bound is pruned. That half lives
 * in `lib/build-output-reaper.ts`; the bound is checked here, once per session
 * start, never on the spawn path.
 */
export async function reapFinishedWorktrees(
	pi: ExtensionAPI,
	ctx: any,
	deps: RecoveryScanDeps = {},
): Promise<ReapResult[]> {
	const results: ReapResult[] = [];
	const buildOutput = createReapBuildOutput({
		home: deps.home ?? cargoHomeOverride,
		run: deps.run,
		sizeOf: deps.sizeOf,
	});
	try {
		const dir = deps.dir ?? recoveryScanDirOverride ?? "/tmp";
		for (const { sid, meta } of listSubagentMetas(dir)) {
			const worktreePath = typeof meta.worktreePath === "string" ? meta.worktreePath : null;
			const parentCwd = typeof meta.parentCwd === "string" ? meta.parentCwd : "";
			const isolationBranch = typeof meta.isolationBranch === "string" ? meta.isolationBranch : null;
			// A namespace path the disk no longer has is the bound's dead set (M3).
			if (worktreePath) buildOutput.noteGone(worktreePath, parentCwd);

			if (running.has(sid)) continue; // this process is still tracking it
			if (
				decideRecoveryAdoption(meta, {
					selfPid: deps.selfPid,
					selfSessionId: deps.selfSessionId ?? ctx.sessionManager.getSessionId(),
					probe: deps.probe,
				}) !== "adopt"
			)
				continue;
			if (!worktreePath) continue;

			const facts = gatherSubagentDiskFacts(sid, { meta, dir, probe: deps.probe });
			if (!hasTerminalFooter(facts.logLastLine)) continue; // child not provably finished

			// A tree the reap keeps still loses its build output once the branch has
			// landed or is gone (owner ask 2). The tree stays: resuming or inspecting
			// it still works, only the multi-GB target goes.
			const keep = async (outcome: ReapResult["outcome"], detail?: string): Promise<void> => {
				const landed = await buildOutput.dropKeptTarget({ worktreePath, branch: isolationBranch, parentCwd });
				if (landed.keptBecause) debugLog(`reap: ${sid} target/ kept: ${landed.keptBecause}`);
				const joined = [detail, ...landed.notes].filter(Boolean).join("; ");
				results.push({ sid, outcome, worktreePath, ...(joined ? { detail: joined } : {}) });
			};

			if (!fs.existsSync(worktreePath)) {
				// The tree is gone, so nothing is left to remove. Its share of the
				// clone's shared cargo dir is M3's: the dead set below carries every
				// gone namespace path, and the bound's pass prunes them — one
				// implementation, gated where the order puts it, instead of a
				// `cargo clean -p` per dead meta on every reap.
				results.push({ sid, outcome: "removed", worktreePath, detail: "directory already gone" });
				continue;
			}

			// Run git inside the worktree: its parent cwd may itself be gone.
			const status = await git(["status", "--porcelain", "-uall"], worktreePath);
			if (status.exitCode !== 0) {
				debugLog(`reap: ${sid} git status failed: ${status.stderr.trim()}`);
				await keep("kept-git-error", status.stderr.trim());
				continue;
			}
			if (status.stdout.trim().length > 0) {
				debugLog(`reap: ${sid} kept — uncommitted work in ${worktreePath}`);
				updateMetaAt(path.join(dir, `pi-subagent-${sid}.meta.json`), {
					worktreeKept: { reason: "uncommitted work", at: new Date().toISOString() },
				});
				await keep("kept-uncommitted");
				continue;
			}

			const removal = await removeWorktreeTree(
				{ run: deps.run, home: deps.home ?? cargoHomeOverride },
				{
					worktreePath,
					isolationBranch,
					parentHeadCommit: typeof meta.parentHeadCommit === "string" ? meta.parentHeadCommit : null,
					// Empty when the meta predates the field: the removal then runs in the
					// worktree itself, which reaches the same object store.
					parentCwd,
				},
				{
					// Never --force: the cleanliness check above is what makes a plain
					// remove safe, and a race must not delete uncommitted work. No
					// finalCommit either — the work lives on the branch, so it stays.
					force: false,
					finalCommit: null,
					relockReason: `pi-subagent ${sid} (reap failed)`,
				},
			);
			if (!removal.ok) {
				// The shared removal already re-locked a tree it unlocked; nothing to
				// restore. Never `--force`, never rmtree — the next reap retries.
				debugLog(`reap: ${sid} ${removal.stage} failed: ${removal.detail}`);
				await keep(removal.stage === "unlock" ? "kept-unlock-failed" : "kept-remove-failed", removal.detail);
				continue;
			}
			const detail = removal.buildOutput ? describeBuildOutput(removal.buildOutput) : null;
			debugLog(`reap: removed finished worktree ${worktreePath} (${sid})${detail ? ` — ${detail}` : ""}`);
			buildOutput.noteGone(worktreePath, parentCwd);
			results.push({ sid, outcome: "removed", worktreePath, ...(detail ? { detail } : {}) });
		}
	} catch (e) {
		debugLog(`reap: aborted: ${e instanceof Error ? e.message : String(e)}`);
	}

	// The shared dir's bound (owner ask 3), once per session start: measure each
	// clone's dir, prune the dead worktrees' shares of what is over, then one
	// coarse pass per clone. Never throws; a dir still over is reported, not
	// force-cleaned — a full `cargo clean` is the registry rebuild the shared dir
	// exists to avoid.
	for (const line of await buildOutput.enforceBound()) debugLog(line);
	return results;
}
