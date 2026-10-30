/**
 * Session trim — move a session's pre-compaction prefix out of the live JSONL.
 *
 * pi keeps every parsed entry for the process's life and the session file is
 * append-only, so a 24 h session reaches ~100 MB of history the model never sees
 * again (docs/investigations/pi-memory-2026-10.md). `/trim` rewrites the live file
 * down to the header, the retained tail of the latest compaction and everything
 * after it, and moves the prefix to `<session>.history<N>`.
 *
 *   /trim   trim the current session now
 *
 * Auto-trims after a compaction once the file passes TRIM_THRESHOLD_BYTES. The
 * cut comes from pi's own `buildContextEntries()`, so pi keeps owning the
 * compaction rule; the trimmed file sends the same context as the untrimmed one.
 *
 * The in-process heap does not shrink — the entries are already parsed and
 * `sessionManager` is read-only. The saving lands on the next start.
 */

import { existsSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
	SessionHeader,
} from "@earendil-works/pi-coding-agent";

/** Trim once the live file passes this; below it a load costs <25 MB. */
export const TRIM_THRESHOLD_BYTES = 8 * 1024 * 1024;

/** Marker entry recording what a trim moved out, so a later process can cite the archive. */
export const TRIM_MARKER = "session-trim";

export interface TrimPlan {
	/** First kept entry in file order. */
	keepFrom: string;
	dropped: SessionEntry[];
	kept: SessionEntry[];
	/** Dropped state re-rooted at the head of the kept chain (model, thinking, name). */
	carried: SessionEntry[];
	droppedBytes: number;
}

export interface TrimReport {
	sessionFile: string;
	archiveFile: string;
	droppedEntries: number;
	keptEntries: number;
	droppedBytes: number;
	bytesBefore: number;
	bytesAfter: number;
}

const lineBytes = (entry: SessionEntry): number => JSON.stringify(entry).length + 1;

const mb = (bytes: number): string => `${(bytes / 1048576).toFixed(1)} MB`;

/**
 * Split the session at the earliest entry the model still sees.
 *
 * `contextEntries` must be `sessionManager.buildContextEntries()`: everything
 * before its first entry in file order is already unreachable for the model, so
 * pi's compaction rule stays the single definition of "dead history".
 */
export function planTrim(
	body: SessionEntry[],
	contextEntries: SessionEntry[],
): TrimPlan | null {
	const position = new Map(body.map((entry, index) => [entry.id, index]));
	let cut = body.length;
	for (const entry of contextEntries) {
		const at = position.get(entry.id);
		if (at === undefined) {
			throw new Error(`session-trim: context entry ${entry.id} is not in the session`);
		}
		if (at < cut) cut = at;
	}
	if (cut === 0) return null;

	const dropped = body.slice(0, cut);
	const kept = body.slice(cut);
	const carried: SessionEntry[] = [];

	// State that lives outside the kept region and would otherwise vanish. `model_change`
	// and `thinking_level_change` are read from the leaf path (`getSessionContextSettings`),
	// so a kept entry on another branch does not stand in for one; `session_info` is read
	// from the whole file (`getSessionName`), so any kept one wins.
	const carry = (type: SessionEntry["type"], alreadyLive: boolean): void => {
		if (alreadyLive) return;
		const last = [...dropped].reverse().find((entry) => entry.type === type);
		if (last) carried.push({ ...last, parentId: null } as SessionEntry);
	};
	carry("model_change", contextEntries.some((entry) => entry.type === "model_change"));
	carry(
		"thinking_level_change",
		contextEntries.some((entry) => entry.type === "thinking_level_change"),
	);
	carry("session_info", kept.some((entry) => entry.type === "session_info"));

	for (let i = 1; i < carried.length; i++) carried[i].parentId = carried[i - 1].id;
	kept[0] = { ...kept[0], parentId: carried.length ? carried[carried.length - 1].id : null };

	// Idempotence: after a trim the only entries before the cut are the carried ones.
	// Re-cutting them would rewrite identical bytes and add an archive per compaction.
	const carriedIds = new Set(carried.map((entry) => entry.id));
	if (dropped.every((entry) => carriedIds.has(entry.id))) return null;

	return {
		keepFrom: kept[0].id,
		dropped,
		kept,
		carried,
		droppedBytes: dropped.reduce((n, entry) => n + lineBytes(entry), 0),
	};
}

/** `<session>.history1`, `.history2`, … — never `.jsonl`, which `SessionManager.list()` would pick up. */
export function nextArchivePath(sessionFile: string): string {
	const dir = dirname(sessionFile);
	const base = basename(sessionFile);
	for (let n = 1; ; n++) {
		const candidate = join(dir, `${base}.history${n}`);
		if (!existsSync(candidate)) return candidate;
	}
}

/**
 * Rewrite `sessionFile` down to the kept region and return what moved.
 *
 * Synchronous on purpose: pi persists with `appendFileSync`, so a synchronous
 * rewrite cannot interleave with an append from this process. No other pi process
 * may be writing the file — session files are unlocked (session-manager uses
 * proper-lockfile for auth, settings and trust only).
 */
export function writeTrim(
	sessionFile: string,
	header: SessionHeader,
	plan: TrimPlan,
): TrimReport {
	const bytesBefore = statSync(sessionFile).size;
	const archiveFile = nextArchivePath(sessionFile);
	writeFileSync(archiveFile, plan.dropped.map((entry) => `${JSON.stringify(entry)}\n`).join(""), {
		flag: "wx",
	});
	const trimmed = [header, ...plan.carried, ...plan.kept]
		.map((entry) => `${JSON.stringify(entry)}\n`)
		.join("");
	const tmp = `${sessionFile}.trim-${process.pid}`;
	writeFileSync(tmp, trimmed);
	renameSync(tmp, sessionFile);
	return {
		sessionFile,
		archiveFile,
		droppedEntries: plan.dropped.length,
		keptEntries: plan.kept.length,
		droppedBytes: plan.droppedBytes,
		bytesBefore,
		bytesAfter: statSync(sessionFile).size,
	};
}

/** Whether a rewind target only exists in an archive this extension wrote. */
export function treeNavigationBlocked(
	entries: SessionEntry[],
	targetId: string,
): { archive?: string } | null {
	if (entries.some((entry) => entry.id === targetId)) return null;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== TRIM_MARKER) continue;
		const data = entry.data as { archiveFile?: string } | undefined;
		return { archive: data?.archiveFile };
	}
	return null;
}

export default function (pi: ExtensionAPI) {
	function trim(ctx: ExtensionContext): TrimReport | null {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile || !existsSync(sessionFile)) return null;
		const header = ctx.sessionManager.getHeader();
		if (!header) return null;
		const plan = planTrim(ctx.sessionManager.getEntries(), ctx.sessionManager.buildContextEntries());
		if (!plan) return null;
		const report = writeTrim(sessionFile, header, plan);
		pi.appendEntry(TRIM_MARKER, {
			archiveFile: report.archiveFile,
			droppedBytes: report.droppedBytes,
			droppedEntries: report.droppedEntries,
		});
		return report;
	}

	pi.registerEntryRenderer<{ archiveFile: string; droppedBytes: number; droppedEntries: number }>(
		TRIM_MARKER,
		(entry, _options, theme) => {
			const { archiveFile, droppedBytes, droppedEntries } = entry.data ?? {
				archiveFile: "",
				droppedBytes: 0,
				droppedEntries: 0,
			};
			return new Text(
				`trimmed ${mb(droppedBytes)} of pre-compaction history (${droppedEntries.toLocaleString()} entries) → ${basename(archiveFile)}`,
				1,
				1,
				(text) => theme.fg("muted", text),
			);
		},
	);

	pi.registerCommand("trim", {
		description: "Move pre-compaction history out of the live session file",
		handler: async (_args, ctx) => {
			if (!ctx.sessionManager.getSessionFile()) {
				ctx.ui.notify("Ephemeral session (--no-session): nothing to trim", "warning");
				return;
			}
			const report = trim(ctx);
			if (!report) {
				ctx.ui.notify(
					"Nothing to trim: the live context still reaches the first entry (compact first)",
					"info",
				);
				return;
			}
			ctx.ui.notify(
				`Trimmed ${mb(report.bytesBefore - report.bytesAfter)} (${report.droppedEntries.toLocaleString()} entries) → ${basename(report.archiveFile)}; memory drops on next start`,
				"info",
			);
		},
	});

	pi.on("session_compact", async (_event, ctx) => {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile || !existsSync(sessionFile)) return;
		if (statSync(sessionFile).size < TRIM_THRESHOLD_BYTES) return;
		try {
			const report = trim(ctx);
			if (report && ctx.hasUI) {
				ctx.ui.notify(
					`Trimmed ${mb(report.bytesBefore - report.bytesAfter)} of pre-compaction history → ${basename(report.archiveFile)}`,
					"info",
				);
			}
		} catch (error) {
			// A failed trim must not break the compaction that triggered it.
			if (ctx.hasUI) {
				ctx.ui.notify(`Session trim failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		}
	});

	pi.on("session_before_tree", async (event, ctx) => {
		const blocked = treeNavigationBlocked(
			ctx.sessionManager.getEntries(),
			event.preparation.targetId,
		);
		if (!blocked) return;
		ctx.ui.notify(
			`That point was trimmed out of the session${blocked.archive ? ` — history is in ${basename(blocked.archive)}` : ""}`,
			"warning",
		);
		return { cancel: true };
	});
}
