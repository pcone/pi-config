/**
 * Session discovery: the one scan of the tmp dir for subagent sessions.
 *
 * A single session looked up by (partial) id is `resolveSubagentMeta` in
 * `subagent-state.ts`, next to the registry scan it reads.
 *
 * Both watch viewers (`.cjs` and v2) scan the tmp dir, apply the same
 * freshness window, build the same `pi-subagent-<id>.{sock,log}` paths and
 * read the same registry for metadata (WO-2026-082). The tmp dir and the
 * registry load live in `subagent-state.ts`; this module is the scan on top
 * of them, and the id→path rule beside it.
 *
 * Discovery reports facts, never a screen's vocabulary: `running`, `mtimeMs`,
 * `turns`, the log's content, its parsed footer and the raw registry object.
 * Which word a viewer prints, whether a finished run reads `TERMINAL` or
 * `STOPPED`, and the picker's 1-based `order` stay in the viewers.
 *
 * Read-only and never throwing, like the rest of the lib: an unreadable dir
 * yields no sessions, an unreadable log yields `content: null`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	SUBAGENT_TMP_DIR,
	listSubagentMetas,
	readTerminalFooter,
	type TerminalFooter,
} from "./subagent-state.ts";

/** A log-only session older than this is skipped; a socket is always listed. */
export const RECENT_WINDOW_MS = 30 * 60 * 1000;

const FILE_PREFIX = "pi-subagent-";
const TURN_LINE_RE = /── Turn \d+ ──/g;

/**
 * The `pi-subagent-<id>` paths for a *user-supplied* `id` — the viewers' argv
 * rule, which accepts a full id, a short suffix or a full path. A `/`-prefixed
 * `id` is the sock path itself, with the log path derived by extension swap; a
 * bare `id` gains the `subagent-` prefix when it lacks it.
 *
 * Discovery does not use this: an id read from a directory entry is already
 * exact, and prefixing it again would look for the wrong file.
 */
export function subagentPaths(id: string, dir: string = SUBAGENT_TMP_DIR): { sockPath: string; logPath: string } {
	if (id.startsWith("/")) return { sockPath: id, logPath: id.replace(/\.sock$/, ".log") };
	const clean = id.startsWith("subagent-") ? id : `subagent-${id}`;
	const base = path.join(dir, `${FILE_PREFIX}${clean}`);
	return { sockPath: `${base}.sock`, logPath: `${base}.log` };
}

export interface DiscoveredSession {
	id: string;
	sockPath: string;
	logPath: string;
	/** A `.sock` file exists — the session is live whatever the log's age. */
	running: boolean;
	/** Max of the sock and log mtimes when running; the log's mtime otherwise. */
	mtimeMs: number;
	/** `── Turn n ──` occurrences in the log. 0 when the log is unreadable. */
	turns: number;
	/** The log's text, or null when it could not be read. */
	content: string | null;
	/** The terminal footer `content` carries, or null. */
	footer: TerminalFooter | null;
	/** The raw registry entry beside the session, when one parsed. */
	meta?: Record<string, any>;
}

interface LogReading {
	content: string | null;
	footer: TerminalFooter | null;
	turns: number;
}

/** One read per log: the footer and the turn count come from the same text. */
function readLog(logPath: string): LogReading {
	let content: string;
	try {
		content = fs.readFileSync(logPath, "utf8");
	} catch {
		// Statable but unreadable: the session stays, its content does not.
		return { content: null, footer: null, turns: 0 };
	}
	return {
		content,
		footer: readTerminalFooter(content),
		turns: (content.match(TURN_LINE_RE) || []).length,
	};
}

/**
 * Every subagent session in `dir` — sockets first, then log-only sessions
 * inside the window — sorted by `mtimeMs` descending. `dir` and `now` are the
 * seam the rows use to run against a temp dir and a fixed clock.
 *
 * `socketsOnly` omits the log-only arm: a caller that can only act on a socket
 * (recovery) reads no recent log left with no socket beside it. The registry
 * scan is limited to the ids this call reports either way, so a meta for a
 * session nobody asked for is never parsed.
 */
export function discoverSessions(
	opts: { dir?: string; now?: number; socketsOnly?: boolean } = {},
): DiscoveredSession[] {
	const dir = opts.dir ?? SUBAGENT_TMP_DIR;
	const now = opts.now ?? Date.now();

	let files: string[];
	try {
		files = fs.readdirSync(dir);
	} catch {
		return [];
	}

	const sockNames: string[] = [];
	const logNames: string[] = [];
	for (const name of files) {
		if (!name.startsWith(FILE_PREFIX)) continue;
		if (name.endsWith(".sock")) sockNames.push(name);
		else if (name.endsWith(".log")) logNames.push(name);
	}

	const metas = new Map<string, Record<string, any>>();

	const sessions: DiscoveredSession[] = [];
	const seen = new Set<string>();

	for (const name of sockNames) {
		const id = name.slice(FILE_PREFIX.length, -".sock".length);
		if (!id) continue;
		seen.add(id);
		const sockPath = path.join(dir, name);
		const logPath = sockPath.replace(/\.sock$/, ".log");
		let mtimeMs = 0;
		try {
			mtimeMs = fs.statSync(logPath).mtimeMs;
		} catch {
			/* sock with no log yet */
		}
		try {
			mtimeMs = Math.max(mtimeMs, fs.statSync(sockPath).mtimeMs);
		} catch {
			/* vanished between readdir and stat — the log's mtime still dates it */
		}
		const reading = readLog(logPath);
		sessions.push({
			id,
			sockPath,
			logPath,
			running: true,
			mtimeMs,
			turns: reading.turns,
			content: reading.content,
			footer: reading.footer,
		});
	}

	if (!opts.socketsOnly) {
		for (const name of logNames) {
			const id = name.slice(FILE_PREFIX.length, -".log".length);
			if (!id || seen.has(id)) continue;
			const logPath = path.join(dir, name);
			const sockPath = logPath.replace(/\.log$/, ".sock");
			let mtimeMs: number;
			try {
				mtimeMs = fs.statSync(logPath).mtimeMs;
			} catch {
				continue;
			}
			if (now - mtimeMs > RECENT_WINDOW_MS) continue;
			const reading = readLog(logPath);
			sessions.push({
				id,
				sockPath,
				logPath,
				running: false,
				mtimeMs,
				turns: reading.turns,
				content: reading.content,
				footer: reading.footer,
			});
		}
	}

	for (const entry of listSubagentMetas(dir, new Set(sessions.map((s) => s.id)))) metas.set(entry.sid, entry.meta);
	for (const s of sessions) s.meta = metas.get(s.id);

	sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return sessions;
}
