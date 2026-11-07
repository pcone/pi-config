/**
 * Subagent disk state: the meta registry, 027's owner-liveness gate, and the
 * four-state vocabulary (tfd process-controls R3, owner, 2026-10-19).
 *
 * Dependency-light on purpose: `extensions/checkpoint.ts` reads the registry
 * read-only through this module (R3-1's in-flight section) while
 * `extensions/subagent-async/index.ts` owns spawn-time writes. One classifier
 * serves both, so `subagent_status` and the checkpoint section can never
 * disagree about what "running" means.
 *
 * The owner-liveness block is moved verbatim from subagent-async/index.ts
 * (decision 027) and re-exported there — behaviour unchanged.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** A log silent for this long is no longer evidence of a live child. Same
 *  window as subagent-async's stalled-turn watchdog. */
export const SUBAGENT_STALE_TURN_MS = 5 * 60 * 1000;

// ── Recovery ownership (decision 027) ──────────────────────────────────────
//
// The session_start recovery scan re-attaches to subagent sockets left behind
// by a previous session. Before decision 027 it adopted EVERY socket with a
// matching meta file — including children owned by other, still-live pi
// processes. The adopted client connections kept the event loop referenced, so
// `pi -p` hung until a stranger's child finished, and that child's completion
// was delivered into the wrong session as "[Isolation] Recovered". The scan now
// gates adoption on the spawning process's identity, recorded at spawn:
//
//   ownerPid         the spawning process's pid
//   ownerStartToken  an OS start-time token, so a recycled pid is not mistaken
//                    for the original owner (pid reuse is real: see the peer
//                    note in decision 027)
//
// Adopt only when the owner is THIS process (a previous session in the same
// process — /reload, /new still hold the old socket server open) or the owner
// process is gone. A live FOREIGN owner means the child belongs to another
// session and must be left alone.
//
// Legacy metas (written before 027) carry no owner fields. Ownership cannot be
// established, so they are SKIPPED: adopting a stranger is the bug being fixed,
// while a false "owner alive" only skips a best-effort recovery — the safe
// direction.

export interface OwnerProbe {
	/** True while a process with this pid exists. */
	exists(pid: number): boolean;
	/** OS start-time token for the pid, or null when unavailable. */
	startToken(pid: number): string | null;
}

/** Default real-OS probe. `exists` uses signal 0; EPERM still means alive.
 *  Exported for unit testing. */
export const defaultOwnerProbe: OwnerProbe = {
	exists(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch (e) {
			return (e as NodeJS.ErrnoException)?.code === "EPERM";
		}
	},
	startToken(pid: number): string | null {
		return processStartToken(pid);
	},
};

/**
 * OS start-time token for a pid, used to make pid liveness pid-reuse-safe.
 * Linux: field 22 (`starttime`, clock ticks since boot) from /proc/<pid>/stat.
 * macOS/BSD: `ps -o lstart=` (1s resolution — good enough to separate a reused
 * pid, and the pid must still exist for a match to happen at all). Returns null
 * when the process is gone or the platform cannot report the token. Exported
 * for unit testing.
 */
export function processStartToken(pid: number, platform: string = process.platform): string | null {
	if (!Number.isInteger(pid) || pid <= 0) return null;
	try {
		if (platform === "linux") {
			const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
			const close = stat.lastIndexOf(")");
			if (close < 0) return null;
			// After "pid (comm) " comes field 3 (state). starttime is field 22,
			// i.e. index 19 of the whitespace-split remainder.
			const fields = stat.slice(close + 2).trim().split(/\s+/);
			return fields[19] ?? null;
		}
		const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const token = out.trim();
		return token.length > 0 ? token : null;
	} catch {
		return null;
	}
}

/** Cached start token for THIS process, written into meta at spawn. Exported
 *  for unit testing. */
let selfStartTokenCache: string | null | undefined;
export function selfStartToken(): string | null {
	if (selfStartTokenCache === undefined) selfStartTokenCache = processStartToken(process.pid);
	return selfStartTokenCache;
}

/**
 * pid-reuse-safe "is the recorded owner still alive?" — pure over the injected
 * probe. The recorded start token must match the current one; a mismatch means
 * the pid was recycled and the original owner is gone. When the pid exists but
 * its current token cannot be read, assume ALIVE: skipping recovery is the safe
 * direction, adopting a stranger is not.
 *
 * A missing/invalid `ownerPid` also returns true — there is no recorded owner
 * to prove gone, so callers that use this predicate alone still fail safe.
 * (The legacy policy itself is `decideRecoveryAdoption`'s "skip-legacy".)
 * Exported for unit testing.
 */
export function isOwnerAlive(
	meta: Record<string, any> | null | undefined,
	probe: OwnerProbe = defaultOwnerProbe,
): boolean {
	const pid = meta?.ownerPid;
	if (!Number.isInteger(pid) || pid <= 0) return true; // no recorded owner → not provably gone
	if (!probe.exists(pid)) return false;
	const current = probe.startToken(pid);
	if (current === null) return true; // exists, token unknown → assume alive
	const recorded = meta?.ownerStartToken;
	if (typeof recorded !== "string" || recorded.length === 0) return true; // cannot disprove
	return current === recorded;
}

export type RecoveryAdoption = "adopt" | "skip-live-owner" | "skip-legacy" | "skip-foreign-session";

/**
 * Decide whether the recovery scan may adopt the socket described by `meta`.
 * Pure and injectable so the adopt/skip matrix is unit-testable without
 * touching /tmp or the real OS.
 *
 * Adoption is proof of ownership, not proof of death. A dead owner says only
 * that nobody is looking after the child; every pi process on the machine can
 * read the same `/tmp` metas, so owner death alone made each session adopt the
 * others' orphans — a tfd implementer's child showed up in a pi-config session's
 * checkpoint summary and its worktree in that session's reap scan. The child
 * carries the spawning session's id (`parentSessionId`), so:
 *
 * - `pid === selfPid`: our own previous session in this process (/reload, /new)
 *   left the socket running. Adopt; the start-token check is pointless here,
 *   because a recycled pid also means the original owner is gone.
 * - recorded `parentSessionId` equals this session's: ours, owner process gone
 *   (a restart, a resumed session). Adopt.
 * - recorded `parentSessionId` names another session: skip. Our process may
 *   legitimately be the same one it ran in.
 * - no recorded `parentSessionId`, or no `selfSessionId` to compare with: skip.
 *   Unknown provenance is not ours to adopt.
 *
 * Exported for unit testing.
 */
export function decideRecoveryAdoption(
	meta: Record<string, any> | null | undefined,
	opts: { selfPid?: number; selfSessionId?: string; probe?: OwnerProbe } = {},
): RecoveryAdoption {
	const pid = meta?.ownerPid;
	if (!Number.isInteger(pid) || pid <= 0) return "skip-legacy";
	if (pid === (opts.selfPid ?? process.pid)) return "adopt";
	const parentSessionId = meta?.parentSessionId;
	if (typeof parentSessionId !== "string" || parentSessionId.length === 0) return "skip-legacy";
	if (opts.selfSessionId === undefined) return "skip-legacy";
	if (parentSessionId === opts.selfSessionId) return "adopt";
	if (isOwnerAlive(meta, opts.probe ?? defaultOwnerProbe)) return "skip-live-owner";
	return "skip-foreign-session";
}

// ── Meta registry scan ─────────────────────────────────────────────────────

export const SUBAGENT_TMP_DIR = "/tmp";

export interface SubagentMetaEntry {
	sid: string;
	meta: Record<string, any>;
}

// ── Id-query lookup ────────────────────────────────────────────────────────
//
// Handles are shown and typed in four shapes: `subagent-<uuid>`, a bare
// `<uuid>`, or either truncated to an 8+ character tail. One definition of what
// a query means, shared by the tools and the meta lookup, so `/watch`,
// `/attach` and `subagent_resume` cannot drift apart.

/**
 * Strip the display prefix from a session-id query.
 *
 * Matching is a suffix test against the stored full id, so the prefix must go
 * first: `subagent-c3587cc8c12e` was not a suffix of
 * `subagent-ac5fe548-…-c3587cc8c12e` while the bare `c3587cc8c12e` was, and the
 * miss surfaced as "No running subagent found" — read as death, which cost two
 * live worktrees to a peer's force-reap (2026-10-07).
 */
export function normalizeIdQuery(s: string): string {
	return s.replace(/^subagent-/, "");
}

/**
 * True when a stored session id matches a user-supplied query. Both stores key
 * by the full `subagent-<uuid>` handle — the running map directly, and meta
 * files named `pi-subagent-<handle>.meta.json` — so a query matches when it is
 * a suffix of the handle (`-ac5fe548-…-c3587cc8c12e`, a `subagent-`-prefixed
 * tail) or of the handle with that prefix stripped (a bare tail). Surrounding
 * whitespace is ignored; an empty query matches nothing, since every id is a
 * superset of the empty string.
 */
export function idMatchesQuery(storedId: string, query: string): boolean {
	const q = query.trim();
	const needle = normalizeIdQuery(q);
	if (needle.length === 0) return false; // empty query must not match every id
	return storedId.endsWith(q) || normalizeIdQuery(storedId).endsWith(needle);
}

/**
 * Resolve a session id from a full or partial identifier by reading the meta
 * registry. Returns the single match, `null` for none, and throws listing the
 * candidates when a partial id is ambiguous.
 */
export function resolveSubagentMeta(
	sessionId: string,
): { sid: string; meta: Record<string, any> } | null {
	const candidates = listSubagentMetas(SUBAGENT_TMP_DIR).filter((e) => idMatchesQuery(e.sid, sessionId));
	if (candidates.length === 0) return null;
	const [only] = candidates;
	if (candidates.length === 1) return { sid: only.sid, meta: only.meta };

	const ids = candidates.map((c) => c.sid).join(", ");
	throw new Error(
		`Ambiguous partial session id "${sessionId}" matches multiple sessions: ${ids}. ` +
			`Use a longer suffix or the full id.`,
	);
}

/**
 * Every readable `pi-subagent-<sid>.meta.json` in `dir`, restricted to
 * `onlySids` when given. The filter runs on the file name, before the parse:
 * an id nobody asked for costs no read and cannot fail the scan.
 */
export function listSubagentMetas(dir: string = SUBAGENT_TMP_DIR, onlySids?: ReadonlySet<string>): SubagentMetaEntry[] {
	let files: string[];
	try {
		files = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const entries: SubagentMetaEntry[] = [];
	for (const f of files) {
		if (!f.startsWith("pi-subagent-") || !f.endsWith(".meta.json")) continue;
		const sid = f.slice("pi-subagent-".length, -".meta.json".length);
		if (!sid) continue;
		if (onlySids && !onlySids.has(sid)) continue;
		try {
			const meta = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
			if (meta && typeof meta === "object") entries.push({ sid, meta });
		} catch {
			/* torn or malformed meta — not a session we can classify */
		}
	}
	return entries;
}

// ── Four-state vocabulary (R3-3) ───────────────────────────────────────────

/**
 * `dead/unmatched` is one bucket with two named causes: `unmatched` when the
 * child cannot be attributed (no meta, or a pre-027 meta with no owner), `dead`
 * when a recorded owner is gone and no session file was left behind.
 */
export type SubagentState = "running" | "complete" | "orphaned" | "dead" | "unmatched";

export interface SubagentDiskFacts {
	meta: Record<string, any> | null;
	/** Tracked in this process's running map. */
	attached: boolean;
	sockExists: boolean;
	/** Last non-empty line of the spawn log, or null when there is no log. */
	logLastLine: string | null;
	logMtimeMs: number | null;
	sessionFileExists: boolean;
	hasRecordedOwner: boolean;
	/** undefined when no owner was recorded. */
	ownerAlive: boolean | undefined;
	now: number;
}

export interface SubagentStateReading {
	state: SubagentState;
	/** The evidence read, in a sentence the status text can quote verbatim. */
	evidence: string;
}

// ── Terminal-outcome vocabulary (WO-2026-078) ──────────────────────────────

/**
 * How a subagent run ended. One vocabulary, three renderings: the word in the
 * delivered message prefix, the word in the log footer, and the word the status
 * reader matches in that footer. `finished` is the only success member.
 */
export type SubagentOutcome = "finished" | "errored" | "overflowed" | "aborted" | "killed";

/** The delivered-prefix word and the log-footer word per outcome. */
export const OUTCOME_WORD: Record<SubagentOutcome, { prefix: string; footer: string }> = {
	finished: { prefix: "finished", footer: "Completed" },
	errored: { prefix: "errored", footer: "Errored" },
	overflowed: { prefix: "overflowed", footer: "Overflowed" },
	aborted: { prefix: "aborted", footer: "Aborted" },
	killed: { prefix: "killed", footer: "Killed" },
};

/**
 * A run that ended with no terminal assistant turn to classify: the process
 * exited (0 / non-zero) and the footer records only that. These two words carry
 * no outcome of their own — `Exited` reads as `finished`, `Stopped` as
 * `aborted` — and keep the spellings they had before this vocabulary existed.
 */
export const EXITED_FOOTER_WORD = "Exited";
export const STOPPED_FOOTER_WORD = "Stopped";

/** Every terminal footer word. The regexes below are built from it, so the
 *  words a footer writes and the words a reader accepts are one list. */
const FOOTER_WORDS = [...Object.values(OUTCOME_WORD).map((w) => w.footer), EXITED_FOOTER_WORD, STOPPED_FOOTER_WORD];

const COMPLETED_FOOTER_RE = new RegExp(`──\\s*${OUTCOME_WORD.finished.footer}\\s*\\(`);
const TERMINAL_FOOTER_RE = new RegExp(`──\\s*(${FOOTER_WORDS.join("|")})\\s*\\(`);

/**
 * True when the log's last non-empty line is a terminal footer — the child-side
 * evidence that the run is over (`── <word> (…) ──`, one of `FOOTER_WORDS`).
 * The status vocabulary and the reap both key on this one predicate.
 *
 * Deliberately looser than `parseTerminalFooter`: this answers "is the run
 * over", so a torn or hand-written footer line still counts as terminal, while
 * the parser additionally demands the turn and exit counts it returns.
 */
export function hasTerminalFooter(logLastLine: string | null): boolean {
	return logLastLine !== null && TERMINAL_FOOTER_RE.test(logLastLine);
}

const OUTCOME_BY_FOOTER_WORD = new Map<string, SubagentOutcome>(
	Object.entries(OUTCOME_WORD).map(([outcome, words]) => [words.footer, outcome] as [string, SubagentOutcome]),
);

/**
 * The outcome a terminal footer word names — the inverse of the vocabulary the
 * footer writes. Null for `Exited`/`Stopped`, which record only that the
 * process exited: those words have no outcome of their own, so the exit code
 * the same footer carries decides (exactly as it does for a live run). Throws
 * on a word no footer writes.
 */
export function outcomeFromFooterWord(word: string): SubagentOutcome | null {
	if (word === EXITED_FOOTER_WORD || word === STOPPED_FOOTER_WORD) return null;
	const outcome = OUTCOME_BY_FOOTER_WORD.get(word);
	if (!outcome) {
		throw new Error(`outcomeFromFooterWord: "${word}" is not a terminal footer word (${FOOTER_WORDS.join(", ")})`);
	}
	return outcome;
}

/** The turn count at which a run is killed for exceeding its turn budget.
 *  Shared with the viewers through `outcomeFromExitCode`, so the cap that
 *  decides a kill is the same number the classifier reads. */
export const MAX_TURNS_HARD = 500;

/**
 * The outcome the process exit code names: no exit code at all means the
 * process did not exit — it was terminated — so that is not a finished run.
 * Below the hard turn cap a non-zero exit is an abort the parent must not read
 * as success; the turn-limit stop carries its own `Killed` footer word and
 * never reaches this rule.
 */
export function outcomeFromExitCode(exitCode: number | null, turns: number): SubagentOutcome {
	if (exitCode === null) return "aborted";
	return exitCode !== 0 && turns < MAX_TURNS_HARD ? "aborted" : "finished";
}

/**
 * Outcomes of pi's non-normal `StopReason`s. `pending` and `deferred` are its
 * not-yet-settled reasons, so a turn that reached the terminal path in either
 * never delivered its answer. `stop` and `toolUse` are normal ends and are
 * deliberately absent: they fall to the exit code instead.
 */
const OUTCOME_BY_STOP_REASON: Record<string, SubagentOutcome | undefined> = {
	length: "overflowed",
	error: "errored",
	aborted: "aborted",
	pending: "aborted",
	deferred: "aborted",
};

/**
 * The outcome a terminal assistant turn's `stopReason` names, or null when the
 * reason is a normal end (`stop`, `toolUse`) — then the process exit code
 * decides. A reason the vocabulary does not name is not a completed turn, so it
 * reads `aborted`; `classifyOutcome`'s caller names such a reason in the
 * delivered result so a new pi reason is visible until it gets its own word.
 */
export function stopReasonOutcome(reason: string): SubagentOutcome | null {
	if (reason === "stop" || reason === "toolUse") return null;
	return OUTCOME_BY_STOP_REASON[reason] ?? "aborted";
}

/** True when the vocabulary names this stop reason. */
export function isKnownStopReason(reason: string): boolean {
	return reason === "stop" || reason === "toolUse" || OUTCOME_BY_STOP_REASON[reason] !== undefined;
}

/** A parsed terminal footer line: the word it wrote and the counts it recorded. */
export interface TerminalFooter {
	word: string;
	turns: number;
	/** Null when the footer recorded `exit ?` (the process left no exit code). */
	exitCode: number | null;
}

const TERMINAL_FOOTER_LINE_RE = new RegExp(
	`──\\s*(${FOOTER_WORDS.join("|")})\\s*\\((\\d+) turns, exit (\\d+|\\?)\\)`,
);

/** Parse a line as a terminal footer, or null when it is not one. */
export function parseTerminalFooter(line: string): TerminalFooter | null {
	const m = TERMINAL_FOOTER_LINE_RE.exec(line);
	if (!m) return null;
	return { word: m[1], turns: Number(m[2]), exitCode: m[3] === "?" ? null : Number(m[3]) };
}

/**
 * The log's terminal footer: the last line that parses as one. A log carries
 * one terminal footer; scanning backwards finds it without assuming it is the
 * very last line. Null when the log carries no footer (a torn log).
 */
export function readTerminalFooter(log: string): TerminalFooter | null {
	const lines = log.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const footer = parseTerminalFooter(lines[i]);
		if (footer) return footer;
	}
	return null;
}

/**
 * The outcome a parsed footer names: its word, or — for `Exited`/`Stopped`,
 * which record only that the process exited — the exit code and turn count.
 */
export function outcomeFromFooter(footer: TerminalFooter): SubagentOutcome {
	return outcomeFromFooterWord(footer.word) ?? outcomeFromExitCode(footer.exitCode, footer.turns);
}

/**
 * Pure classifier over observed facts. Order matters: an attached child is
 * running; a completion footer is terminal; a socket with a live owner or a
 * freshly written log is running; a session file without a completion line is
 * orphaned-resumable; otherwise nothing attributable remains.
 */
export function readSubagentState(f: SubagentDiskFacts): SubagentStateReading {
	if (f.attached) return { state: "running", evidence: "attached to this session's tracker" };
	if (!f.meta) return { state: "unmatched", evidence: "no registry entry (meta file) matches the id" };

	const footered = f.logLastLine ? TERMINAL_FOOTER_RE.exec(f.logLastLine) : null;
	if (f.logLastLine && COMPLETED_FOOTER_RE.test(f.logLastLine)) {
		return { state: "complete", evidence: "the log ends with the `── Completed …` footer" };
	}
	if (footered) {
		return f.sessionFileExists
			? { state: "orphaned", evidence: `the log ends with the \`── ${footered[1]} …\` footer and a session file exists` }
			: { state: "dead", evidence: `the log ends with the \`── ${footered[1]} …\` footer and no session file was captured` };
	}
	if (f.sockExists && f.ownerAlive === true) {
		return { state: "running", evidence: `a socket file exists and its recorded owner (pid ${f.meta.ownerPid}) is still running` };
	}
	if (f.logMtimeMs !== null && f.now - f.logMtimeMs < SUBAGENT_STALE_TURN_MS) {
		const age = Math.max(0, Math.round((f.now - f.logMtimeMs) / 1000));
		return { state: "running", evidence: `the log was written ${age}s ago` };
	}
	if (f.sessionFileExists) {
		return { state: "orphaned", evidence: "no completion line, and a session file exists (resumable)" };
	}
	if (!f.hasRecordedOwner) {
		return { state: "unmatched", evidence: "no completion line, and no owner process was recorded" };
	}
	if (f.ownerAlive === false) {
		return { state: "dead", evidence: `no completion line, no session file, and its recorded owner process (pid ${f.meta.ownerPid}) is gone` };
	}
	return {
		state: "unmatched",
		evidence: `no completion line, no session file, and its recorded owner process (pid ${f.meta.ownerPid}) is still running`,
	};
}

/** Last `bytes` of a file as text, or null when it cannot be read. */
function readTail(file: string, bytes = 16 * 1024): string | null {
	try {
		const fd = fs.openSync(file, "r");
		try {
			const size = fs.fstatSync(fd).size;
			const start = Math.max(0, size - bytes);
			const buf = Buffer.alloc(Math.min(bytes, size));
			if (buf.length === 0) return "";
			fs.readSync(fd, buf, 0, buf.length, start);
			return buf.toString("utf-8");
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return null;
	}
}

/** Last non-empty line of a text blob, or null. */
export function lastNonEmptyLine(text: string | null): string | null {
	if (text === null) return null;
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const t = lines[i].trim();
		if (t) return t;
	}
	return null;
}

/** Gather the disk facts for `sid`. Read-only; never throws. */
export function gatherSubagentDiskFacts(
	sid: string,
	opts: {
		meta: Record<string, any> | null;
		dir?: string;
		attached?: boolean;
		probe?: OwnerProbe;
		now?: number;
	},
): SubagentDiskFacts {
	const dir = opts.dir ?? SUBAGENT_TMP_DIR;
	const meta = opts.meta;
	const sockPath = path.join(dir, `pi-subagent-${sid}.sock`);
	const logPath = path.join(dir, `pi-subagent-${sid}.log`);
	const hasRecordedOwner = Number.isInteger(meta?.ownerPid) && (meta?.ownerPid as number) > 0;
	const sessionFile = typeof meta?.sessionFile === "string" ? meta.sessionFile : null;

	let logMtimeMs: number | null = null;
	try {
		logMtimeMs = fs.statSync(logPath).mtimeMs;
	} catch {
		/* no log */
	}

	return {
		meta,
		attached: opts.attached ?? false,
		sockExists: fs.existsSync(sockPath),
		logLastLine: lastNonEmptyLine(readTail(logPath)),
		logMtimeMs,
		sessionFileExists: sessionFile !== null && fs.existsSync(sessionFile),
		hasRecordedOwner,
		ownerAlive: hasRecordedOwner ? isOwnerAlive(meta, opts.probe ?? defaultOwnerProbe) : undefined,
		now: opts.now ?? Date.now(),
	};
}

// ── In-flight listing (R3-1) ───────────────────────────────────────────────

/**
 * @internal test hook — the registry directory the in-flight scan reads
 * (default /tmp). One override for every reader, so a test that fabricates
 * children cannot have one reader see the fabricated set and another see the
 * real registry.
 */
let inflightScanDirOverride: string | undefined;
export function _testSetInflightScanDir(dir: string | undefined): void {
	inflightScanDirOverride = dir;
}

export interface InFlightSubagent {
	sid: string;
	agentName: string | null;
	branch: string | null;
	worktreePath: string | null;
	state: SubagentState;
	evidence: string;
	/** Present for orphaned children: the call that resumes the session. */
	resumeCall: string | null;
	/** Spawn time recorded in the meta, or null when the meta carries none. */
	startedAt: number | null;
}

/** `subagent_resume({ session_id: "<sid>", task: "<what it was doing>" })`. */
export function resumeCallFor(sid: string, meta: Record<string, any> | null): string {
	const raw = typeof meta?.task === "string" ? meta.task : "";
	const task = raw.replace(/\s+/g, " ").trim();
	const clipped = task.length > 120 ? `${task.slice(0, 117)}…` : task;
	const quoted = clipped.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	return `subagent_resume({ session_id: "${sid}", task: "${quoted || "continue the work"}" })`;
}

/**
 * The live children this process can act on: adoption per 027's gate (same
 * process owner, or owner gone — a live foreign owner's child is another
 * session's business, a legacy meta is unattributable) AND a state of running
 * or orphaned. Completed and dead children are not in flight.
 */
export function listInFlightSubagents(
	opts: { dir?: string; selfPid?: number; selfSessionId?: string; probe?: OwnerProbe; now?: number } = {},
): InFlightSubagent[] {
	const dir = opts.dir ?? inflightScanDirOverride ?? SUBAGENT_TMP_DIR;
	const out: InFlightSubagent[] = [];
	for (const { sid, meta } of listSubagentMetas(dir)) {
		if (
			decideRecoveryAdoption(meta, {
				selfPid: opts.selfPid,
				selfSessionId: opts.selfSessionId,
				probe: opts.probe,
			}) !== "adopt"
		)
			continue;
		const reading = readSubagentState(
			gatherSubagentDiskFacts(sid, { meta, dir, probe: opts.probe, now: opts.now }),
		);
		if (reading.state !== "running" && reading.state !== "orphaned") continue;
		out.push({
			sid,
			agentName: typeof meta.agentName === "string" ? meta.agentName : null,
			branch: typeof meta.isolationBranch === "string" ? meta.isolationBranch : null,
			worktreePath: typeof meta.worktreePath === "string" ? meta.worktreePath : null,
			state: reading.state,
			evidence: reading.evidence,
			resumeCall: reading.state === "orphaned" ? resumeCallFor(sid, meta) : null,
			startedAt: typeof meta.startedAt === "number" ? meta.startedAt : null,
		});
	}
	return out;
}

// ── Turn cap and stall tripwire (decision 046) ─────────────────────────────
//
// A dispatch carries a turn budget: at the cap the child gets one wind-down
// steer, then a flat grace in turns, then the harness kills it through the one
// kill dispatch. A second, advisory arm watches the child's branch and steers
// once when a long stretch of turns produced no commit. It never kills.
//
// Both arms are decided here, purely, from the state the event site assembles;
// the site executes the action and re-derives nothing. The cap number never
// reaches the child (owner ruling 2026-11-07, "hide it"): the wind-down text
// lives at the call site and carries no number.

/** Assistant turns a dispatch may run when its spawn names no cap. */
export const TURN_CAP_DEFAULT = 150;

/** Turns between the wind-down and the kill. Flat, and counted on the same
 *  `message_end` path as the turns themselves, so no timer is involved. */
export const TURN_CAP_GRACE = 10;

/** Commit-free turns before the advisory stall steer. */
export const STALL_TURNS = 30;

/** What the event site does about a turn. `kill` means the run is being
 *  stopped: the site returns and leaves delivery to the close handler. */
export type TurnAction =
	| { kind: "none" }
	| { kind: "wind-down" }
	| { kind: "kill" }
	| { kind: "stall-steer" };

/** The commit-observation counters of the stall arm. */
export interface StallObservation {
	/** Turns observed without a new commit on the child's branch. */
	stallTurns: number;
	/** The advisory steer was already delivered for the current stall. */
	stallSteered: boolean;
}

/** Everything the turn decision rests on — the caller supplies all of it. */
export interface TurnCapState extends StallObservation {
	/** Turns used by this logical dispatch, carried over on resume. */
	turns: number;
	/** Resolved cap in turns; `Infinity` when the cap is disabled. */
	cap: number;
	/** The wind-down was injected and the grace is running. */
	capTripped: boolean;
	/** This turn observed a new commit on the child's branch. */
	commitChanged: boolean;
}

/**
 * Resolve a spawn's `turn_cap` into the number the decision compares against.
 *
 * `undefined` takes the default. `0` or negative disables the cap (precedent:
 * `silenceTimeoutMs`, decision 015). Above `MAX_TURNS_HARD` is rejected rather
 * than clamped: the global hard kill would fire first, so accepting the number
 * would make the cap a lie about what stopped the run (decision 046).
 */
export function resolveTurnCap(raw: number | undefined): number {
	if (raw !== undefined && raw > MAX_TURNS_HARD) {
		throw new Error(
			`turn_cap ${raw} is above the ${MAX_TURNS_HARD}-turn hard limit — the hard kill would fire first. ` +
				`Pass a cap at or below ${MAX_TURNS_HARD}, or 0 to disable the cap.`,
		);
	}
	if (raw === undefined) return TURN_CAP_DEFAULT;
	if (raw <= 0) return Infinity;
	if (Number.isNaN(raw)) {
		throw new Error(`turn_cap ${raw} is not a turn count — pass a number, or 0 to disable the cap.`);
	}
	return raw;
}

/**
 * The turn's cap and stall decision. Pure: every input is in `state`, and the
 * caller performs whatever the returned action names.
 *
 * The cap arm outranks the stall arm, so a run at its cap gets the wind-down
 * and never a second advisory message (U8). Grace is measured from the cap, so
 * the kill lands at `cap + TURN_CAP_GRACE` regardless of which turn tripped it.
 */
export function decideTurnAction(state: TurnCapState): TurnAction {
	if (state.turns >= state.cap) {
		if (!state.capTripped) return { kind: "wind-down" };
		return state.turns >= state.cap + TURN_CAP_GRACE ? { kind: "kill" } : { kind: "none" };
	}
	// A new commit ends the stall, so the turn that observed one cannot steer on
	// it — the counter and the steer flag were reset by `nextStallState`.
	if (!state.commitChanged && !state.stallSteered && state.stallTurns >= STALL_TURNS) {
		return { kind: "stall-steer" };
	}
	return { kind: "none" };
}

/**
 * Fold one turn's commit observation into the stall counters. A new commit ends
 * the stall: the counter and the steer flag both clear, so a long healthy run
 * gets one message per stall at most. Pure.
 */
export function nextStallState(prior: StallObservation, commitChanged: boolean): StallObservation {
	if (commitChanged) return { stallTurns: 0, stallSteered: false };
	return { stallTurns: prior.stallTurns + 1, stallSteered: prior.stallSteered };
}
