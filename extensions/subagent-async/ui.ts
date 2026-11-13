/**
 * The TUI surface: the live log viewer, the attach editor and its stream widget,
 * and the status footer. No lifecycle — everything here renders or routes what
 * the spawn and recovery paths already decided.
 *
 * Split out of `index.ts` by WO-2026-095. `detach()` stays in `index.ts`: it
 * assigns the attach state the entry point owns, and a module cannot assign an
 * imported binding.
 */

import { CustomEditor, type UsageStats } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { appendRunningLogLine, buildPromptPayload, rpcSend } from "./rpc.ts";
import { reconcileSleepGuards } from "./sleep-guard.ts";
import {
	attachCtx,
	attachedSessionId,
	debugLog,
	detach,
	liveSessionCtx,
	running,
	type RunningSubagent,
} from "./index.ts";

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}


// ── Live Log Viewer TUI Component ────────────────────────────────────────

export class LogViewer {
	constructor(
		private lines: string[],
		private agentName: string,
		private sessionId: string,
		private getStats: () => UsageStats,
		private maxHeight: number = 15,
	) {}

	/* TUI state */
	private lastLineCount = 0;
	private lastStatsSnapshot = "";
	private cachedWidth?: number;
	private cachedLines?: string[];

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		const statsSnapshot = JSON.stringify(this.getStats());
		// Skip cache if lines and stats haven't changed
		if (this.cachedLines && this.cachedWidth === width && this.lastLineCount === this.lines.length && this.lastStatsSnapshot === statsSnapshot) {
			return this.cachedLines;
		}
		this.lastLineCount = this.lines.length;
		this.lastStatsSnapshot = statsSnapshot;

		// Build stats line
		const stats = this.getStats();
		const statsParts: string[] = [];
		if (stats.input) statsParts.push(`↑${formatTokens(stats.input)}`);
		if (stats.output) statsParts.push(`↓${formatTokens(stats.output)}`);
		if (stats.cacheRead) statsParts.push(`R${formatTokens(stats.cacheRead)}`);
		if (stats.cacheWrite) statsParts.push(`W${formatTokens(stats.cacheWrite)}`);
		if ((stats.cacheRead > 0 || stats.cacheWrite > 0) && stats.latestCacheHitRate !== undefined) {
			statsParts.push(`CH${stats.latestCacheHitRate.toFixed(1)}%`);
		}
		if (stats.cost) statsParts.push(`$${stats.cost.toFixed(3)}`);
		const statsLine = statsParts.length > 0 ? ` ${statsParts.join(" ")}` : "";

		const tail = this.lines.slice(-this.maxHeight);
		this.cachedLines = [
			truncateToWidth(`▸ Subagent: ${this.agentName}  |  ${this.sessionId}`, width),
			truncateToWidth(statsLine, width),
			...tail.map((l) => truncateToWidth(` ${l}`, width - 1)),
		];
		this.cachedWidth = width;
		return this.cachedLines;
	}
}

// ── Attach Editor ───────────────────────────────────────────────────────────

/**
 * Custom editor that intercepts submit to route user input to an attached
 * async subagent. Escape detaches; all other keys pass through to the
 * default editor (ctrl+d/exit, model switching, paste, autocomplete, etc.).
 */
export class AttachEditor extends CustomEditor {
	handleInput(data: string): void {
		// Escape → detach (restore default editor, clear widget, clear state)
		if (matchesKey(data, Key.escape)) {
			if (attachCtx()) detach();
			return;
		}

		// Submit interception: route user text to the attached subagent
		if (this.keybindings.matches(data, "tui.input.submit") && !this.isShowingAutocomplete()) {
			const text = this.getExpandedText().trim();
			if (!text) return; // no-op on empty/whitespace submit

			this.setText(""); // clear the editor

			const id = attachedSessionId();
			if (!id) {
				// No target — shouldn't happen if editor is installed, but be safe
				debugLog("attach: submit with no attachedSessionId");
				return;
			}

			const rs = running.get(id);
			if (!rs || !rs.stdin || rs.stdin.destroyed) {
				// Session is gone — append a visible error line to the stream
				if (rs) {
					appendRunningLogLine(rs, "\x1b[31m[Session no longer accepting input — detach with Escape]\x1b[0m");
				}
				debugLog("attach: submit with no valid target (rs=" + !!rs + ")");
				return;
			}

			// Send the user's message to the child's RPC stdin
			rpcSend(rs.stdin, buildPromptPayload(text));

			// Log the user's message into the stream view so it appears inline
			appendRunningLogLine(rs, "\x1b[36m› " + text + "\x1b[0m");

			return; // consumed — do NOT pass to super (would send to parent)
		}

		// Everything else → normal editor behavior (ctrl+d/exit, model
		// switching, paste, autocomplete navigation, all editing keys)
		super.handleInput(data);
	}
}

// ── Attach widget ───────────────────────────────────────────────────────────

/**
 * Lightweight viewer for the attached session's log stream.
 * Resolves the target dynamically from `attachedSessionId` on each render
 * so target-switching and auto-detach work without re-installing the widget.
 * Delegates rendering to the existing `LogViewer` class.
 */
export class AttachLogViewer {
	private viewer: LogViewer | null = null;
	private viewerId: string | null = null;

	invalidate(): void {
		this.viewer?.invalidate();
	}

	render(width: number): string[] {
		const id = attachedSessionId();
		if (!id) return [];
		const rs = running.get(id);
		if (!rs) return [truncateToWidth("(session ended)", width)];

		// Rebuild the inner LogViewer when the target changes
		if (this.viewerId !== id) {
			this.viewer = new LogViewer(rs.logLines, rs.agentName, rs.sessionId, () => rs.usageStats);
			this.viewerId = id;
		}

		const lines = this.viewer.render(width);
		// Prepend a clear header so it's visually distinct from /watch
		return [
			truncateToWidth(`\x1b[36m▸ ATTACHED: ${rs.agentName} | ${rs.sessionId}\x1b[0m`, width),
			...lines,
		];
	}
}


// ── Footer ─────────────────────────────────────────────────────────────────

/** Update the subagent footer on the LIVE session. Post-turn async callers
 *  (socket data handlers, child close handlers) may run after the spawning
 *  session ended, when the captured spawn-time ctx is invalidated — so this
 *  reads the live-session ctx and no-ops when there is none. Exported as an
 *  @internal test hook. */
export function updateFooter(): void {
	reconcileSleepGuards();
	// No live session → nothing to render on. Deliberately not a try/catch:
	// an explicit liveness check, per
	// decisions/subagents/026-subagent-events-after-session-disposal.md.
	const ctx = liveSessionCtx();
	if (!ctx) return;
	if (running.size === 0) {
		ctx.ui.setStatus("subagent-async", undefined);
		return;
	}
	const parts: string[] = [];
	for (const rs of running.values()) {
		parts.push(`${rs.agentName} (${rs.progress.turns}t)`);
	}
	ctx.ui.setStatus("subagent-async", `subagents: ${parts.join(", ")}`);
}

/** Notify the parent that an attached subagent ended. Post-turn async path —
 *  the child can outlive the session that spawned it, so this notifies only
 *  while a live session ctx exists (mirrors `updateFooter`/`deliverResult`).
 *  The captured spawn-time ctx is never used here. Exported as an @internal
 *  test hook. */
export function notifyChildDetached(rs: RunningSubagent): void {
	const ctx = liveSessionCtx();
	if (!ctx) return;
	ctx.ui.notify(`Subagent ${rs.sessionId.slice(-8)} ended — detached.`, "info");
}
