#!/usr/bin/env -S npx tsx
/**
 * watch-session v2 — multi-pane live viewer for async subagents, built on
 * `@earendil-works/pi-tui`. The original .cjs (hand-rolled ANSI) and .ts
 * (single-pane pi-tui) viewers stay alongside this file for reference.
 *
 * Usage:
 *   npx tsx watch-session-v2.ts                    # picker if active sessions exist
 *   npx tsx watch-session-v2.ts <session-id>       # single pane for that session
 *   npx tsx watch-session-v2.ts -r | --recent      # 3 panes, top 3 active
 *   npx tsx watch-session-v2.ts -p | --picker      # force picker, no fallback
 *
 * Keys (in viewer):
 *   q / esc                quit
 *   t                      toggle thinking lines
 *   c                      toggle auto-cycle
 *   r                      re-scan /tmp/pi-subagent-* and repopulate
 *   g                      scroll focused pane to bottom
 *   tab / shift+tab        cycle focus between panes
 *   1..9                   set pane count to N (panes above N close)
 *   ! @ # $ % & * (        swap focused pane to a different session
 *   wheel on a pane        scroll that pane
 *   click on a pane        focus that pane
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as readline from "node:readline";
import {
	Container,
	type Component,
	Focusable,
	Key,
	matchesKey,
	ProcessTerminal,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	truncateToWidth,
	TUI,
} from "@earendil-works/pi-tui";

// ── Constants ───────────────────────────────────────────────────────────────

const RECENT_WINDOW_MS = 30 * 60 * 1000;
const COMPLETION_RE = /^── (Completed|Exited|Stopped) \((\d+) turns, exit (-?\d+|null)\)/;
const MOUSE_SGR_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;
const MAX_PANES = 9;
const POLL_INTERVAL_MS = 1000;
const PANE_CYCLE_KEYS = ["!", "@", "#", "$", "%", "^", "&", "*", "("] as const;

// ── ANSI helpers (we run outside pi, so no theme injection) ────────────────

const RESET = "\x1b[0m";
const INVERSE_ON = "\x1b[7m";
const INVERSE_OFF = "\x1b[27m";
const DIM_ON = "\x1b[2m";
const DIM_OFF = "\x1b[22m";
const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";

const S = {
	reset: (s: string) => `${RESET}${s}`,
	inverse: (s: string) => `${INVERSE_ON}${s}${INVERSE_OFF}`,
	bold: (s: string) => `${BOLD}${s}${BOLD_OFF}`,
	dim: (s: string) => `${DIM_ON}${s}${DIM_OFF}`,
	muted: (s: string) => `\x1b[2;37m${s}${RESET}`,
	accent: (s: string) => `\x1b[1;36m${s}${RESET}`,
	success: (s: string) => `\x1b[1;32m${s}${RESET}`,
	error: (s: string) => `\x1b[1;31m${s}${RESET}`,
	warning: (s: string) => `\x1b[33m${s}${RESET}`,
	border: (s: string) => `\x1b[2m${s}${RESET}`,
};

// ── Pure utilities ──────────────────────────────────────────────────────────

export function plainLen(s: string): number {
	let len = 0;
	let inEscape = false;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (inEscape) {
			if (ch === "\x1b") {
				len++;
				inEscape = false;
				continue;
			}
			if (ch && /[A-Za-z]/.test(ch)) inEscape = false;
			continue;
		}
		if (ch === "\x1b" && s[i + 1] === "[") {
			inEscape = true;
			i++;
			continue;
		}
		len++;
	}
	return len;
}

function padRight(s: string, width: number): string {
	const len = plainLen(s);
	if (len >= width) return s;
	return s + " ".repeat(width - len);
}

function timeAgo(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	return `${Math.floor(m / 60)}h ago`;
}

// ── Session discovery ───────────────────────────────────────────────────────

export type SessionStatus = "RUNNING" | "COMPLETED" | "STOPPED" | "EMPTY";

export interface SessionInfo {
	id: string;
	sockPath: string;
	logPath: string;
	status: SessionStatus;
	mtimeMs: number;
	turns: number;
}

export function discoverSessions(): SessionInfo[] {
	const sessions: SessionInfo[] = [];
	let sockFiles: string[] = [];
	let logFiles: string[] = [];
	try {
		sockFiles = fs.readdirSync("/tmp").filter((f) => f.startsWith("pi-subagent-") && f.endsWith(".sock"));
	} catch {}
	try {
		logFiles = fs.readdirSync("/tmp").filter((f) => f.startsWith("pi-subagent-") && f.endsWith(".log"));
	} catch {}

	const assignedLogPath = (id: string) => `/tmp/pi-subagent-${id}.log`;

	for (const f of sockFiles) {
		const id = f.slice("pi-subagent-".length, -".sock".length);
		const sockPath = `/tmp/${f}`;
		const logPath = assignedLogPath(id);
		let mtime = 0;
		try { mtime = fs.statSync(sockPath).mtimeMs; } catch {}
		try { mtime = Math.max(mtime, fs.statSync(logPath).mtimeMs); } catch {}
		const turns = countTurns(logPath);
		sessions.push({ id, sockPath, logPath, status: "RUNNING", mtimeMs: mtime, turns });
	}

	for (const f of logFiles) {
		const id = f.slice("pi-subagent-".length, -".log".length);
		const logPath = `/tmp/${f}`;
		if (sessions.some((s) => s.id === id)) continue;
		let stat: fs.Stats | null = null;
		try { stat = fs.statSync(logPath); } catch { continue; }
		if (Date.now() - stat.mtimeMs > RECENT_WINDOW_MS) continue;
		let content = "";
		try { content = fs.readFileSync(logPath, "utf8"); } catch { continue; }
		const status: SessionStatus = content.includes("── Completed")
			? "COMPLETED"
			: content.includes("── Exited") || content.includes("── Stopped")
				? "STOPPED"
				: content.trim().length === 0 ? "EMPTY" : "STOPPED";
		sessions.push({ id, sockPath: logPath.replace(/\.log$/, ".sock"), logPath, status, mtimeMs: stat.mtimeMs, turns: countTurns(logPath) });
	}

	sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return sessions;
}

function countTurns(file: string): number {
	try {
		const content = fs.readFileSync(file, "utf8");
		return (content.match(/── Turn \d+ ──/g) || []).length;
	} catch {
		return 0;
	}
}

function resolveSockPath(id: string): string {
	if (id.startsWith("/")) return id;
	const clean = id.startsWith("subagent-") ? id : `subagent-${id}`;
	return `/tmp/pi-subagent-${clean}.sock`;
}

// ── Live pane data ──────────────────────────────────────────────────────────

interface PaneData {
	lines: string[];
	done: boolean;
	exitCode: number;
	turns: number;
	connected: boolean;
	connectedAt: number;
	missing: boolean;
}

function openSessionSocket(
	id: string,
	onLine: (line: string) => void,
	onStatus: (state: "open" | "close" | "error") => void,
): { close: () => void } {
	const sockPath = resolveSockPath(id);
	const socket = net.createConnection(sockPath);
	const rl = readline.createInterface({ input: socket, crlfDelay: Infinity });
	rl.on("line", (line: string) => onLine(line));
	socket.once("connect", () => onStatus("open"));
	socket.on("close", () => onStatus("close"));
	socket.on("error", () => onStatus("error"));
	return {
		close: () => {
			try { socket.destroy(); } catch {}
		},
	};
}

// ── Layout (shared rows/cols + dynamic body height per pane) ────────────────

class Layout {
	rows: number;
	cols: number;
	paneCount = 1;

	constructor() {
		this.rows = process.stdout.rows || 24;
		this.cols = process.stdout.columns || 80;
	}

	resize(cols: number, rows: number): void {
		this.cols = cols;
		this.rows = rows;
	}

	bodyHeight(): number {
		// 1 line per pane header + (N-1) separators + 1 global footer
		const overhead = this.paneCount * 1 + Math.max(0, this.paneCount - 1) + 1;
		return Math.max(3, Math.floor((this.rows - overhead) / Math.max(1, this.paneCount)));
	}

	paneRowRanges(): Array<{ start: number; end: number }> {
		const ranges: Array<{ start: number; end: number }> = [];
		let row = 0;
		for (let i = 0; i < this.paneCount; i++) {
			const h = this.bodyHeight() + 1; // body + header
			ranges.push({ start: row, end: row + h - 1 });
			row += h + (i < this.paneCount - 1 ? 1 : 0); // +separator
		}
		return ranges;
	}
}

// ── ScrollBody — scrolling log view for one pane ─────────────────────────────

class ScrollBody implements Component {
	private cachedWidth = -1;
	private cachedLineCount = -1;
	private cachedLines: string[] | undefined;
	private scrollOffset = 0;
	userScrolled = false;

	constructor(
		private dataRef: () => PaneData,
		private getShowThinking: () => boolean,
		private getBodyHeight: () => number,
	) {}

	invalidate(): void {
		this.cachedWidth = -1;
		this.cachedLines = undefined;
	}

	scrollBy(delta: number): void {
		const filtered = this.filteredLines(this.dataRef().lines);
		const max = Math.max(0, filtered.length - this.getBodyHeight());
		const next = Math.max(0, Math.min(this.scrollOffset + delta, max));
		this.scrollOffset = next;
		this.userScrolled = next < max;
		this.invalidate();
	}

	scrollToBottom(): void {
		const filtered = this.filteredLines(this.dataRef().lines);
		this.scrollOffset = Math.max(0, filtered.length - this.getBodyHeight());
		this.userScrolled = false;
		this.invalidate();
	}

	private filteredLines(lines: string[]): string[] {
		return this.getShowThinking() ? lines : lines.filter((l) => !l.includes("[thinking]"));
	}

	render(width: number): string[] {
		const data = this.dataRef();
		const bodyH = this.getBodyHeight();
		if (this.cachedLines && this.cachedWidth === width && this.cachedLineCount === data.lines.length) {
			return this.cachedLines;
		}
		const filtered = this.filteredLines(data.lines);
		const maxScroll = Math.max(0, filtered.length - bodyH);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
		if (!this.userScrolled) this.scrollOffset = maxScroll;
		const start = this.scrollOffset;
		const visible = filtered.slice(start, start + bodyH);
		const out: string[] = [];
		for (let i = 0; i < bodyH; i++) {
			const raw = i < visible.length ? visible[i] : "";
			const cleaned = raw.replace(/^ {0,2}/, "");
			const text = truncateToWidth(" " + cleaned, width);
			out.push(data.done ? S.dim(text) : text);
		}
		this.cachedWidth = width;
		this.cachedLineCount = data.lines.length;
		this.cachedLines = out;
		return out;
	}
}

// ── Pane — one Container[Text header, ScrollBody] ────────────────────────────

class Pane extends Container implements Focusable {
	readonly id: string;
	readonly data: PaneData;
	readonly body: ScrollBody;
	private headerText: Text;
	private layout: Layout;
	private closeSocket: () => void = () => {};
	focused: boolean;
	showThinking = true;

	constructor(id: string, layout: Layout, focused = false) {
		super();
		this.id = id;
		this.layout = layout;
		this.focused = focused;

		this.data = {
			lines: [],
			done: false,
			exitCode: 0,
			turns: 0,
			connected: false,
			connectedAt: 0,
			missing: false,
		};

		this.headerText = new Text("", 0, 0);
		this.body = new ScrollBody(
			() => this.data,
			() => this.showThinking,
			() => this.layout.bodyHeight(),
		);

		this.addChild(this.headerText);
		this.addChild(this.body);

		this.connect();
	}

	private connect(): void {
		const conn = openSessionSocket(
			this.id,
			(line) => this.pushLine(line),
			(state) => this.setStatus(state),
		);
		this.closeSocket = conn.close;
	}

	retarget(newId: string): void {
		this.closeSocket();
		this.id = newId;
		this.data.lines = [];
		this.data.done = false;
		this.data.exitCode = 0;
		this.data.turns = 0;
		this.data.connected = false;
		this.data.connectedAt = 0;
		this.data.missing = false;
		this.body.invalidate();
		this.invalidate();
		this.connect();
	}

	close(): void {
		this.closeSocket();
	}

	private pushLine(line: string): void {
		this.data.lines.push(line);
		const m = line.match(COMPLETION_RE);
		if (m) {
			this.data.done = true;
			this.data.exitCode = m[3] === "null" ? 0 : parseInt(m[3], 10);
			this.data.turns = parseInt(m[2], 10);
		}
		this.body.invalidate();
	}

	private setStatus(state: "open" | "close" | "error"): void {
		if (state === "open") {
			this.data.connected = true;
			this.data.connectedAt = Date.now();
		} else if (state === "error") {
			this.data.missing = true;
		} else {
			this.data.connected = false;
		}
		this.invalidate();
	}

	setShowThinking(value: boolean): void {
		if (this.showThinking === value) return;
		this.showThinking = value;
		this.body.invalidate();
	}

	shortId(): string {
		return this.id.startsWith("subagent-") ? this.id.slice(9, 17) : this.id.slice(0, 8);
	}

	render(width: number): string[] {
		// Build the pane header per-frame
		const elapsed = this.data.connectedAt
			? Math.round((Date.now() - this.data.connectedAt) / 1000)
			: -1;
		const status = this.data.done
			? this.data.exitCode === 0
				? S.success("COMPLETED")
				: S.error(`EXIT ${this.data.exitCode}`)
			: this.data.connected
				? S.accent(`${Math.floor(elapsed / 60)}m ${elapsed % 60}s`)
				: S.muted(this.data.missing ? "missing" : "connecting");
		const idShort = this.shortId();
		const turns = this.data.turns > 0 ? ` ${S.dim("|")} ${this.data.turns}t` : "";
		const focusMark = this.focused ? ` ${S.accent("●")}` : "";
		const bg = this.focused ? INVERSE_ON : "";
		const bgOff = this.focused ? INVERSE_OFF : "";
		const line = `${bg} ${idShort}  ${S.dim("|")}  ${status}${turns}${focusMark} ${bgOff}`;
		this.headerText.setText(padRight(line, width));
		return super.render(width);
	}
}

// ── MultiPaneViewer — Container holding N Panes + a footer ──────────────────

class MultiPaneViewer extends Container {
	readonly layout = new Layout();
	panes: Pane[] = [];
	focused = false;
	private focusedIdx = 0;
	private footer: Text;
	private newSessionAlert = false;
	private knownRunningIds = new Set<string>();
	private autoCycleEnabled = false;
	private getShowThinkingForFooter: () => boolean = () => true;

	constructor() {
		super();
		this.footer = new Text("", 0, 0);
		this.addChild(this.footer);
		this.layout.paneCount = 0;
	}

	resize(cols: number, rows: number): void {
		this.layout.resize(cols, rows);
		this.invalidate();
		for (const p of this.panes) p.invalidate();
	}

	addPane(id: string, focused = false): Pane {
		const pane = new Pane(id, this.layout, focused);
		// Insert before footer
		this.children.splice(this.children.length - 1, 0, pane);
		this.panes.push(pane);
		this.layout.paneCount = this.panes.length;
		this.knownRunningIds.add(id);
		this.invalidate();
		return pane;
	}

	removePane(idx: number): void {
		if (idx < 0 || idx >= this.panes.length) return;
		const p = this.panes[idx];
		p.close();
		this.panes.splice(idx, 1);
		const ci = this.children.indexOf(p);
		if (ci >= 0) this.children.splice(ci, 1);
		this.layout.paneCount = this.panes.length;
		this.focusedIdx = Math.min(this.focusedIdx, Math.max(0, this.panes.length - 1));
		this.invalidate();
	}

	setFocused(idx: number): void {
		for (let i = 0; i < this.panes.length; i++) this.panes[i].focused = i === idx;
		this.focused = true;
		this.focusedIdx = idx;
		this.invalidate();
	}

	focusedPane(): Pane | undefined {
		return this.panes[this.focusedIdx];
	}

	focusNext(): void { this.setFocused((this.focusedIdx + 1) % Math.max(1, this.panes.length)); }
	focusPrev(): void { this.setFocused((this.focusedIdx - 1 + this.panes.length) % Math.max(1, this.panes.length)); }

	resizePanes(n: number, pickFresh: () => string | null): void {
		n = Math.max(1, Math.min(n, MAX_PANES));
		while (this.panes.length < n) {
			const id = pickFresh();
			if (!id) break;
			this.addPane(id, this.panes.length === 0);
		}
		while (this.panes.length > n) {
			this.removePane(this.panes.length - 1);
		}
		this.layout.paneCount = this.panes.length;
		this.invalidate();
	}

	cyclePane(idx: number, pickFresh: () => string | null): boolean {
		const pane = this.panes[idx];
		if (!pane) return false;
		const id = pickFresh();
		if (!id) return false;
		this.knownRunningIds.add(id);
		pane.retarget(id);
		this.invalidate();
		return true;
	}

	autoCycleTick(pickFresh: () => string | null): void {
		let changed = false;
		for (const p of this.panes) {
			if (p.data.done) {
				const id = pickFresh();
				if (id) {
					this.knownRunningIds.add(id);
					p.retarget(id);
					changed = true;
				}
			}
		}
		const current = new Set(discoverSessions().filter((s) => s.status === "RUNNING").map((s) => s.id));
		for (const id of current) {
			if (!this.knownRunningIds.has(id)) {
				this.newSessionAlert = true;
				this.knownRunningIds.add(id);
			}
		}
		if (changed) this.invalidate();
	}

	consumeAlert(): boolean {
		const a = this.newSessionAlert;
		this.newSessionAlert = false;
		return a;
	}

	toggleAutoCycle(): boolean {
		this.autoCycleEnabled = !this.autoCycleEnabled;
		return this.autoCycleEnabled;
	}

	setShowThinkingEverywhere(value: boolean): void {
		this.getShowThinkingForFooter = () => value;
		for (const p of this.panes) {
			// Force toggle to actually change state
			p.setShowThinking(p.getShowThinkingValue() !== value ? value : p.getShowThinkingValue());
		}
		this.invalidate();
	}

	render(width: number): string[] {
		// Render each pane with separator gaps
		const out: string[] = [];
		for (let i = 0; i < this.panes.length; i++) {
			out.push(...this.panes[i].render(width));
			if (i < this.panes.length - 1) {
				out.push(S.border("─".repeat(Math.max(1, width))));
			}
		}
		// Footer
		const t = this.layout;
		const think = `${S.muted("[t]")} thinking`;
		const cycle = this.autoCycleEnabled
			? `${S.muted("[c]")} ${S.accent("cycle")}`
			: `${S.muted("[c]")} cycle`;
		const refresh = `${S.muted("[r]")} refresh`;
		const split = `${S.muted(`[1-${Math.max(1, this.panes.length)}]`)} panes`;
		const focusTip = `${S.muted("[tab]")} focus`;
		const bottom = `${S.muted("[g]")} bottom ${S.muted("[q]")} quit`;
		const swapTip = `${S.muted("[!]")} swap`;
		const alert = this.newSessionAlert ? ` ${S.warning("⚡ NEW")} ` : "";
		const hint = ` ${think}  ${cycle}  ${refresh}  ${split}  ${focusTip}  ${swapTip}  ${bottom}${alert} `;
		this.footer.setText(S.inverse(padRight(hint, width)));
		out.push(...this.footer.render(width));
		return out;
	}
}

// ── Picker — SelectList-based session selector ──────────────────────────────

interface PickerResult {
	component: Component;
}

function buildPicker(sessions: SessionInfo[], onSelect: (s: SessionInfo) => void, onCancel: () => void): PickerResult {
	const now = Date.now();
	const items: SelectItem[] = sessions.map((s) => ({
		value: s.id,
		label: `${s.id.startsWith("subagent-") ? s.id.slice(9, 17) : s.id.slice(0, 8)}  ${S.muted("[" + s.status + "]")}`,
		description: `${s.turns}t  ·  ${timeAgo(now - s.mtimeMs)}`,
	}));

	const container = new Container();
	container.addChild(new Text(S.accent(`Pick a session (${items.length})`), 1, 0));
	container.addChild(new Spacer(1));

	const list = new SelectList(items, Math.min(items.length, 10), {
		selectedPrefix: (t) => S.accent(t),
		selectedText: (t) => S.accent(t),
		description: (t) => S.muted(t),
		scrollInfo: (t) => S.dim(t),
		noMatch: (t) => S.warning(t),
	});
	list.onSelect = (item) => {
		const found = sessions.find((s) => s.id === item.value);
		if (found) onSelect(found);
	};
	list.onCancel = () => onCancel();
	container.addChild(list);
	container.addChild(new Spacer(1));
	container.addChild(new Text(S.dim("↑↓ navigate • enter select • esc cancel"), 1, 0));

	return {
		component: {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				list.handleInput?.(data);
			},
		},
	};
}

// ── Main: viewer lifecycle ──────────────────────────────────────────────────

type Args = { sid: string | null; flagRecent: boolean; flagPicker: boolean };

function parseArgs(argv: string[]): Args {
	let sid: string | null = null;
	let flagRecent = false;
	let flagPicker = false;
	for (const a of argv.slice(2)) {
		if (a === "-r" || a === "--recent") { flagRecent = true; continue; }
		if (a === "-p" || a === "--picker") { flagPicker = true; continue; }
		if (a === "-h" || a === "--help") { printHelp(); process.exit(0); }
		if (a.startsWith("-")) continue;
		sid = a;
	}
	return { sid, flagRecent, flagPicker };
}

function printHelp(): void {
	const help = [
		"watch-session v2 — multi-pane live viewer",
		"",
		"Usage:",
		"  npx tsx watch-session-v2.ts                       # most recent active session",
		"  npx tsx watch-session-v2.ts <session-id>          # single pane for that session",
		"  npx tsx watch-session-v2.ts -r | --recent         # 3 panes, top 3 active",
		"  npx tsx watch-session-v2.ts -p | --picker         # picker overlay for any active session",
		"",
		"See file header for key bindings.",
	].join("\n");
	process.stdout.write(help + "\n");
}

async function runViewer(initialIds: string[], withPicker: boolean): Promise<void> {
	const viewer = new MultiPaneViewer();
	viewer.setShowThinkingEverywhere(true);

	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal);
	tui.addChild(viewer);

	// Seed pane count for layout
	viewer.layout.paneCount = withPicker ? 1 : Math.max(1, initialIds.length);
	for (const id of initialIds.slice(0, MAX_PANES)) {
		viewer.addPane(id);
	}
	if (viewer.panes.length > 0) viewer.setFocused(0);

	const pickFresh = (): string | null => {
		const sessions = discoverSessions();
		const assigned = new Set(viewer.panes.map((p) => p.id));
		const candidate = sessions.find((s) => s.status === "RUNNING" && !assigned.has(s.id));
		return candidate?.id ?? null;
	};

	// Picker overlay (closes itself when a session is chosen)
	let pickerHandle: { hide: () => void } | null = null;
	if (withPicker) {
		const sessions = discoverSessions();
		if (sessions.length === 0) {
			process.stderr.write("No sessions found.\n");
			process.exit(1);
		}
		const listComponent = buildPicker(
			sessions,
			(session) => {
				pickerHandle?.hide();
				pickerHandle = null;
				while (viewer.panes.length > 0) viewer.removePane(viewer.panes.length - 1);
				viewer.addPane(session.id, true);
				tui.requestRender();
			},
			() => {
				pickerHandle?.hide();
				pickerHandle = null;
				tui.requestRender();
			},
		);
		pickerHandle = tui.showOverlay(listComponent.component, { anchor: "center" }) as unknown as { hide: () => void };
	}

	// Cleanup state — defined up-front so the input listener can call it
	let exiting = false;
	let removeInput: () => void = () => {};
	const tickHandles: NodeJS.Timeout[] = [];
	const cleanupAndExit = (code: number): void => {
		if (exiting) return;
		exiting = true;
		for (const t of tickHandles) clearInterval(t);
		removeInput();
		for (const p of viewer.panes) p.close();
		try { tui.stop(); } catch {}
		process.stdout.write(`\x1b[?25h\x1b[?1049l${RESET}\n`);
		process.exit(code);
	};

	process.on("SIGINT", () => cleanupAndExit(0));
	process.on("SIGTERM", () => cleanupAndExit(0));
	process.stdin.on("close", () => cleanupAndExit(0));
	process.on("exit", () => {
		process.stdout.write(`\x1b[?25h\x1b[?1049l${RESET}`);
	});

	tui.start();
	tui.requestRender();

	// ── Input ────────────────────────────────────────────────────────
	removeInput = tui.addInputListener((data: string) => {
		// Mouse SGR first
		const mm = data.match(MOUSE_SGR_RE);
		if (mm) {
			const button = parseInt(mm[1], 10);
			const row = parseInt(mm[3], 10);
			const ranges = viewer.layout.paneRowRanges();
			let target = viewer.panes.findIndex((_, i) => row >= ranges[i].start && row <= ranges[i].end);
			if (target < 0) target = (viewer as unknown as { focusedIdx: number }).focusedIdx;
			if (button === 64) {
				viewer.panes[target]?.body.scrollBy(-3);
				tui.requestRender();
				return { consume: true };
			}
			if (button === 65) {
				viewer.panes[target]?.body.scrollBy(3);
				tui.requestRender();
				return { consume: true };
			}
			if (button === 0 && mm[4] === "M") {
				viewer.setFocused(target);
				tui.requestRender();
				return { consume: true };
			}
			return undefined;
		}

		// Quit
		if (matchesKey(data, "q") || matchesKey(data, Key.escape)) {
			cleanupAndExit(0);
			return { consume: true };
		}
		// Tab / shift+tab
		if (matchesKey(data, "tab")) {
			viewer.focusNext();
			tui.requestRender();
			return { consume: true };
		}
		if (matchesKey(data, Key.shift("tab"))) {
			viewer.focusPrev();
			tui.requestRender();
			return { consume: true };
		}
		// Toggle thinking: 't'
		if (data === "t") {
			const next = !(viewer.panes[0]?.showThinking ?? true);
			viewer.setShowThinkingEverywhere(next);
			tui.requestRender();
			return { consume: true };
		}
		// Auto-cycle toggle: 'c'
		if (data === "c") {
			viewer.toggleAutoCycle();
			tui.requestRender();
			return { consume: true };
		}
		// Refresh: 'r'
		if (data === "r") {
			viewer.resizePanes(viewer.panes.length, pickFresh);
			tui.requestRender();
			return { consume: true };
		}
		// Scroll to bottom: 'g'
		if (data === "g") {
			viewer.focusedPane()?.body.scrollToBottom();
			tui.requestRender();
			return { consume: true };
		}
		// Pane-count digits 1..9
		if (/^[1-9]$/.test(data)) {
			viewer.resizePanes(parseInt(data, 10), pickFresh);
			tui.requestRender();
			return { consume: true };
		}
		// Cycle pane key
		for (let i = 0; i < PANE_CYCLE_KEYS.length; i++) {
			if (data === PANE_CYCLE_KEYS[i]) {
				viewer.cyclePane(i, pickFresh);
				tui.requestRender();
				return { consume: true };
			}
		}
		return undefined;
	});

	// ── Ticks ────────────────────────────────────────────────────────
	tickHandles.push(setInterval(() => {
		if (viewer.consumeAlert()) tui.requestRender();
		for (const p of viewer.panes) p.invalidate();
		tui.requestRender();
	}, POLL_INTERVAL_MS));

	tickHandles.push(setInterval(() => {
		viewer.autoCycleTick(pickFresh);
	}, 5000));
}

function main(): void {
	const { sid, flagRecent, flagPicker } = parseArgs(process.argv);
	const sessions = discoverSessions();

	if (flagRecent) {
		const top = sessions.filter((s) => s.status === "RUNNING").slice(0, 3);
		if (top.length === 0) {
			process.stderr.write("No running subagent sessions found.\n");
			process.exit(1);
		}
		void runViewer(top.map((s) => s.id), false);
		return;
	}

	if (sid) {
		void runViewer([sid], false);
		return;
	}

	if (flagPicker) {
		void runViewer([], true);
		return;
	}

	const running = sessions.filter((s) => s.status === "RUNNING");
	if (running.length === 0) {
		process.stderr.write("No running subagent sessions found.\n");
		process.exit(1);
	}
	void runViewer([running[0].id], false);
}

main();
