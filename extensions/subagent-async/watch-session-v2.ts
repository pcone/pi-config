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
	Box,
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
	Markdown,
	type MarkdownTheme,
} from "@earendil-works/pi-tui";
import {
	getMarkdownTheme,
	Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";

/** Background color token names (duplicated from pi internals — not exported). */
type ThemeBg = "selectedBg" | "userMessageBg" | "customMessageBg" | "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Constants ───────────────────────────────────────────────────────────────

// ── Constants ───────────────────────────────────────────────────────────────

const RECENT_WINDOW_MS = 30 * 60 * 1000;
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

// ── Theme bootstrap (mirror the user's active pi theme) ─────────────────────────
// We run as a standalone script, so we can't inherit pi's runtime theme. The
// nearest alternative is: read ~/.pi/agent/settings.json to find the theme
// name, locate the JSON file in standard spots, parse it, resolve vars,
// construct a Theme instance, and install it on the same global key pi uses
// internally — so getMarkdownTheme() and the global `theme` proxy resolve.
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
const FG_KEYS: ThemeColor[] = [
	"accent", "border", "borderAccent", "borderMuted", "success", "error", "warning",
	"muted", "dim", "text", "thinkingText", "userMessageText", "customMessageText",
	"customMessageLabel", "toolTitle", "toolOutput",
	"mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder",
	"mdQuote", "mdQuoteBorder", "mdHr", "mdListBullet",
	"toolDiffAdded", "toolDiffRemoved", "toolDiffContext",
	"syntaxComment", "syntaxKeyword", "syntaxFunction", "syntaxVariable",
	"syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation",
	"thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh",
	"thinkingXhigh", "thinkingMax", "bashMode",
];
const BG_KEYS: ThemeBg[] = ["selectedBg", "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg"];

function resolveVars(colors: Record<string, any>, vars: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(colors)) {
		if (typeof v === "string" && v.startsWith("#")) out[k] = v;
		else if (typeof v === "string" && vars[v]) out[k] = vars[v];
		else if (typeof v === "number") out[k] = v;
		else out[k] = "";
	}
	return out;
}

function bootstrapPiTheme(): Theme | null {
	const settingsPaths = [
		join(homedir(), ".pi", "agent", "settings.json"),
		join(homedir(), ".pi", "agent", "settings.local.json"),
	];
	const themeSearchDirs = [
		join(homedir(), ".pi", "agent", "themes"),
		"/Users/scott/Developer/pi-config/themes",
	];

	let themeName = "dark";
	for (const sp of settingsPaths) {
		try {
			const j = JSON.parse(fs.readFileSync(sp, "utf8"));
			if (typeof j.theme === "string" && j.theme) {
				themeName = j.theme;
				break;
			}
		} catch { /* skip */ }
	}

	for (const dir of themeSearchDirs) {
		const candidate = join(dir, `${themeName}.json`);
		if (fs.existsSync(candidate)) {
			try {
				const raw = JSON.parse(fs.readFileSync(candidate, "utf8"));
				const vars = raw.vars ?? {};
				const resolved = resolveVars(raw.colors ?? {}, vars);
				const fgColors = Object.fromEntries(FG_KEYS.map((k) => [k, resolved[k] ?? ""])) as Record<ThemeColor, string | number>;
				const bgColors = Object.fromEntries(BG_KEYS.map((k) => [k, resolved[k] ?? ""])) as Record<ThemeBg, string | number>;
				const theme = new Theme(fgColors, bgColors, "truecolor", { name: raw.name ?? themeName, sourcePath: candidate });
				(globalThis as any)[THEME_KEY] = theme;
				return theme;
			} catch { /* fall through */ }
		}
	}
	return null;
}

const PI_THEME = bootstrapPiTheme();
const HAS_THEME = PI_THEME !== null;

/** Themed style helpers — use theme tokens when a theme is loaded, otherwise
 *  fall back to the static Catppuccin-like palette above. */
function tok(token: ThemeColor, fallback: (s: string) => string): (s: string) => string {
	if (HAS_THEME && PI_THEME) {
		try {
			return (s) => PI_THEME.fg(token, s);
		} catch { /* missing token — use fallback */ }
	}
	return fallback;
}

const TS = {
	inverse: S.inverse,
	bold: S.bold,
	reset: S.reset,
	muted: tok("muted", S.muted),
	dim: tok("dim", S.dim),
	accent: tok("accent", S.accent),
	success: tok("success", S.success),
	error: tok("error", S.error),
	warning: tok("warning", S.warning),
	border: tok("border", S.border),
	// markdown
	mdHeading: tok("mdHeading", S.accent),
	mdCode: tok("mdCode", S.accent),
	mdCodeBlock: tok("mdCodeBlock", S.dim),
	mdLink: tok("mdLink", S.accent),
	// tool
	toolTitle: tok("toolTitle", S.accent),
	toolPending: tok("toolTitle", S.accent),
	toolOutput: tok("toolOutput", S.muted),
	toolSuccess: tok("success", S.success),
	toolError: tok("error", S.error),
	// thinking — use a calmer level than thinkingXhigh
	thinking: tok("thinkingMedium", S.dim),
	// turn boundary — muted accent (turn headers are a pi extension concept)
	turnHdr: tok("muted", (s) => `${DIM_ON}\x1b[36m${s}${RESET}`),
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

/** Return `s` with all ANSI escape sequences removed. */
function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
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

// ── Entries — typed log blocks (markdown, tool, thinking, headers) ─────────────────────

let _mdTheme: MarkdownTheme | undefined;
function getMdTheme(): MarkdownTheme {
	if (!_mdTheme) _mdTheme = getMarkdownTheme();
	return _mdTheme;
}

interface Entry {
	lineCount(width: number): number;
	render(width: number): string[];
	invalidate(): void;
}

/** A single styled line of text (header, turn boundary, completion footer). */
class TextEntry implements Entry {
	private cached?: { width: number; lines: string[] };
	constructor(private text: string, private style: (s: string) => string = (s) => s) {}
	lineCount(_width: number): number { return 1; }
	render(width: number): string[] {
		if (this.cached && this.cached.width === width) return this.cached.lines;
		this.cached = { width, lines: [truncateToWidth(this.style(this.text), width)] };
		return this.cached.lines;
	}
	invalidate() { this.cached = undefined; }
}

/** Multi-line assistant text rendered as markdown (bold, code, headings, lists).
 *  Matches pi's AssistantMessageComponent: paddingX=1 (outputPad), paddingY=0. */
class AssistantEntry implements Entry {
	private rawText = "";
	private md: Markdown;
	private cached?: { width: number; lines: string[] };
	constructor() {
		this.md = new Markdown("", 1, 0, getMdTheme());
	}
	append(rawLine: string): void {
		// The parent extension prefixes each assistant text line with "  ".
		const cleaned = stripAnsi(rawLine).replace(/^  /, "");
		this.rawText = this.rawText ? `${this.rawText}\n${cleaned}` : cleaned;
		this.md.setText(this.rawText);
		this.cached = undefined;
	}
	lineCount(width: number): number { return this.render(width).length; }
	render(width: number): string[] {
		if (this.cached && this.cached.width === width) return this.cached.lines;
		const lines = this.md.render(width);
		this.cached = { width, lines };
		return lines;
	}
	invalidate() { this.cached = undefined; this.md.invalidate(); }
}

/** Thinking block — matches pi's AssistantMessageComponent thinking render:
 *  Markdown with `thinkingText` color override and 1-col left padding. */
class ThinkingEntry implements Entry {
	private rawText = "";
	private md: Markdown;
	private cached?: { width: number; lines: string[] };
	constructor() {
		this.md = new Markdown("", 1, 0, getMdTheme(), {
			color: (text) => PI_THEME ? PI_THEME.fg("thinkingText", text) : text,
			italic: true,
		});
	}
	append(rawLine: string): void {
		const cleaned = stripAnsi(rawLine).replace(/^\s*\[thinking\] ?/, "").trim();
		this.rawText = this.rawText ? `${this.rawText}\n${cleaned}` : cleaned;
		this.md.setText(this.rawText);
		this.cached = undefined;
	}
	lineCount(width: number): number { return this.render(width).length; }
	render(width: number): string[] {
		if (this.cached && this.cached.width === width) return this.cached.lines;
		const lines = this.md.render(width);
		this.cached = { width, lines };
		return lines;
	}
	invalidate() { this.cached = undefined; this.md.invalidate(); }
}

/**
 * Tool call — matches pi's ToolExecutionComponent: a Box with `toolPendingBg` /
 * `toolSuccessBg` / `toolErrorBg` background containing the call summary
 * (toolTitle color, bold) and result text (toolOutput color). Status icon
 * (◌/✓/✗) prefixes the call. paddingX=1, paddingY=1 to match pi's framing.
 */
class ToolEntry implements Entry {
	private summary: string;
	private status: "pending" | "success" | "error" = "pending";
	private resultLines: string[] = [];
	private cached?: { width: number; lines: string[] };
	private box: Box;
	private contentText: Text;

	constructor(summary: string) {
		this.summary = summary;
		this.contentText = new Text("", 0, 0);
		this.box = new Box(1, 1, (s) => PI_THEME ? PI_THEME.bg("toolPendingBg", s) : s);
		this.box.addChild(this.contentText);
		this.refreshContent();
	}

	private refreshContent(): void {
		const icon = this.status === "success" ? "✓" : this.status === "error" ? "✗" : "◌";
		const iconColor = this.status === "success" ? TS.success : this.status === "error" ? TS.error : TS.toolPending;
		const header = `${iconColor(TS.bold(icon))} ${TS.toolPending(TS.bold(this.summary))}`;
		const resultText = this.resultLines.join("\n");
		this.contentText.setText(
			resultText ? `${header}\n${TS.toolOutput(resultText)}` : header,
		);
	}

	setStatus(s: "success" | "error"): void {
		this.status = s;
		const token: ThemeBg = s === "error" ? "toolErrorBg" : "toolSuccessBg";
		this.box.setBgFn((t) => PI_THEME ? PI_THEME.bg(token, t) : t);
		this.refreshContent();
		this.cached = undefined;
	}

	getStatus(): "pending" | "success" | "error" { return this.status; }

	appendResult(rawLine: string): void {
		const cleaned = stripAnsi(rawLine).replace(/^\s*[─✖]\s*/, "");
		this.resultLines.push(cleaned);
		this.refreshContent();
		this.cached = undefined;
	}

	lineCount(width: number): number { return this.render(width).length; }

	render(width: number): string[] {
		if (this.cached && this.cached.width === width) return this.cached.lines;
		const lines = this.box.render(width);
		this.cached = { width, lines };
		return lines;
	}

	invalidate() { this.cached = undefined; this.box.invalidate(); }
}

// ── EntryBuffer — ordered list of entries with windowed render ──────────────────────

class EntryBuffer implements Component {
	private entries: Entry[] = [];
	private cachedLineCount?: { width: number; total: number };

	constructor(private getShowThinking: () => boolean) {}

	add(entry: Entry): void {
		this.entries.push(entry);
		this.cachedLineCount = undefined;
	}

	clear(): void {
		this.entries = [];
		this.cachedLineCount = undefined;
	}

	get count(): number { return this.entries.length; }

	lineCount(width: number): number {
		if (this.cachedLineCount && this.cachedLineCount.width === width) return this.cachedLineCount.total;
		let total = 0;
		for (const e of this.entries) total += e.lineCount(width);
		this.cachedLineCount = { width, total };
		return total;
	}

	render(width: number, scrollOffset: number, bodyH: number): string[] {
		const out: string[] = [];
		let cursor = 0;
		let remaining = bodyH;
		let i = 0;

		// Skip entries that are fully above the window
		while (i < this.entries.length && remaining > 0) {
			const e = this.entries[i];
			// Skip thinking entries when toggle is off
			if (!this.getShowThinking() && e instanceof ThinkingEntry) { i++; continue; }
			const h = e.lineCount(width);
			if (cursor + h <= scrollOffset) { cursor += h; i++; continue; }
			if (cursor >= scrollOffset + bodyH) break;
			const startInEntry = Math.max(0, scrollOffset - cursor);
			const take = Math.min(h - startInEntry, remaining);
			if (take > 0) {
				const lines = e.render(width);
				out.push(...lines.slice(startInEntry, startInEntry + take));
				remaining -= take;
			}
			cursor += h;
			i++;
		}

		while (out.length < bodyH) out.push("");
		return out;
	}

	invalidate(): void {
		this.cachedLineCount = undefined;
		for (const e of this.entries) e.invalidate();
	}
}

// ── ScrollBody — scrolling log view for one pane (now EntryBuffer-driven) ───────────────────

class ScrollBody implements Component {
	private cached?: { width: number; scroll: number; bodyH: number; lines: string[] };
	scrollOffset = 0;
	userScrolled = false;
	buffer: EntryBuffer;

	constructor(
		private dataRef: () => PaneData,
		getShowThinking: () => boolean,
		private getBodyHeight: () => number,
	) {
		this.buffer = new EntryBuffer(getShowThinking);
	}

	invalidate(): void {
		this.cached = undefined;
	}

	scrollBy(delta: number): void {
		const width = process.stdout.columns || 80;
		const total = this.buffer.lineCount(width);
		const max = Math.max(0, total - this.getBodyHeight());
		const next = Math.max(0, Math.min(this.scrollOffset + delta, max));
		this.scrollOffset = next;
		this.userScrolled = next < max;
		this.invalidate();
	}

	scrollToBottom(): void {
		const width = process.stdout.columns || 80;
		const total = this.buffer.lineCount(width);
		this.scrollOffset = Math.max(0, total - this.getBodyHeight());
		this.userScrolled = false;
		this.invalidate();
	}

	render(width: number): string[] {
		const bodyH = this.getBodyHeight();
		const data = this.dataRef();

		if (this.cached && this.cached.width === width && this.cached.scroll === this.scrollOffset && this.cached.bodyH === bodyH) {
			return this.cached.lines;
		}

		const total = this.buffer.lineCount(width);
		const maxScroll = Math.max(0, total - bodyH);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
		if (!this.userScrolled) this.scrollOffset = maxScroll;

		const lines = this.buffer.render(width, this.scrollOffset, bodyH);
		const out = data.done ? lines.map((l) => TS.dim(l)) : lines;
		this.cached = { width, scroll: this.scrollOffset, bodyH, lines: out };
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
	private currentAssistant?: AssistantEntry;
	private currentThinking?: ThinkingEntry;
	private lastTool?: ToolEntry;

	constructor(id: string, layout: Layout, focused = false) {
		super();
		this.id = id;
		this.layout = layout;
		this.focused = focused;

		this.data = {
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
		this.body.buffer.clear();
		this.currentAssistant = undefined;
		this.currentThinking = undefined;
		this.lastTool = undefined;
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

	private pushLine(raw: string): void {
		const plain = stripAnsi(raw);
		const trimmed = plain.replace(/^\s+/, "");

		// Turn boundary
		const turnMatch = trimmed.match(/^──\s*Turn\s+(\d+)\s*──/);
		if (turnMatch) {
			this.flushAssistant();
			this.flushThinking();
			this.lastTool = undefined;
			this.body.buffer.add(new TextEntry(trimmed, TS.turnHdr));
			this.body.invalidate();
			return;
		}

		// Completion footer
		const doneMatch = trimmed.match(/^──\s*(Completed|Exited|Stopped)\b/);
		if (doneMatch) {
			this.flushAssistant();
			this.flushThinking();
			this.lastTool = undefined;
			const style = doneMatch[1] === "Completed" ? TS.success : TS.error;
			this.body.buffer.add(new TextEntry(trimmed, style));
			this.data.done = true;
			const m = trimmed.match(/(\d+)\s+turns,\s+exit\s+(-?\d+|null)/);
			if (m) {
				this.data.turns = parseInt(m[1], 10);
				this.data.exitCode = m[2] === "null" ? 0 : parseInt(m[2], 10);
			}
			this.body.invalidate();
			return;
		}

		// Tool start
		if (trimmed.startsWith("▸ ")) {
			this.flushAssistant();
			this.flushThinking();
			const summary = trimmed.slice(2);
			const entry = new ToolEntry(summary);
			this.body.buffer.add(entry);
			this.lastTool = entry;
			this.body.invalidate();
			return;
		}

		// Tool error
		if (trimmed.startsWith("✖ ")) {
			this.flushAssistant();
			this.flushThinking();
			const summary = trimmed.slice(2);
			const entry = new ToolEntry(summary);
			entry.setStatus("error");
			this.body.buffer.add(entry);
			this.lastTool = entry;
			this.body.invalidate();
			return;
		}

		// Tool result line (─ single dash + space, NOT ──)
		if (trimmed.startsWith("─ ") && !trimmed.startsWith("──")) {
			if (this.lastTool) {
				if (this.lastTool.getStatus() === "pending") this.lastTool.setStatus("success");
				this.lastTool.appendResult(raw);
			} else {
				// Orphan result line; treat as assistant text
				this.flushThinking();
				if (!this.currentAssistant) {
					this.currentAssistant = new AssistantEntry();
					this.body.buffer.add(this.currentAssistant);
				}
				this.currentAssistant.append(raw);
			}
			this.body.invalidate();
			return;
		}

		// Thinking block
		if (trimmed.startsWith("[thinking]")) {
			this.flushAssistant();
			if (!this.currentThinking) {
				this.currentThinking = new ThinkingEntry();
				this.body.buffer.add(this.currentThinking);
			}
			this.currentThinking.append(raw);
			this.body.invalidate();
			return;
		}

		// Header lines (Agent:/Task:/Session:/CWD:)
		if (/^(Agent:|Task:|Session:|CWD:)/.test(trimmed)) {
			this.flushAssistant();
			this.flushThinking();
			this.lastTool = undefined;
			this.body.buffer.add(new TextEntry(trimmed, TS.muted));
			this.body.invalidate();
			return;
		}

		// Default: assistant text
		this.flushThinking();
		this.lastTool = undefined;
		if (!this.currentAssistant) {
			this.currentAssistant = new AssistantEntry();
			this.body.buffer.add(this.currentAssistant);
		}
		this.currentAssistant.append(raw);
		this.body.invalidate();
	}

	private flushAssistant(): void { this.currentAssistant = undefined; }
	private flushThinking(): void { this.currentThinking = undefined; }

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
				? TS.success("COMPLETED")
				: TS.error(`EXIT ${this.data.exitCode}`)
			: this.data.connected
				? TS.accent(`${Math.floor(elapsed / 60)}m ${elapsed % 60}s`)
				: TS.muted(this.data.missing ? "missing" : "connecting");
		const idShort = this.shortId();
		const turns = this.data.turns > 0 ? ` ${TS.dim("|")} ${this.data.turns}t` : "";
		const focusMark = this.focused ? ` ${TS.accent("●")}` : "";
		const bg = this.focused ? INVERSE_ON : "";
		const bgOff = this.focused ? INVERSE_OFF : "";
		const line = `${bg} ${idShort}  ${TS.dim("|")}  ${status}${turns}${focusMark} ${bgOff}`;
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
			p.setShowThinking(value);
		}
		this.invalidate();
	}

	render(width: number): string[] {
		// Render each pane with separator gaps
		const out: string[] = [];
		for (let i = 0; i < this.panes.length; i++) {
			out.push(...this.panes[i].render(width));
			if (i < this.panes.length - 1) {
				out.push(TS.border("─".repeat(Math.max(1, width))));
			}
		}
		// Footer
		const t = this.layout;
		const think = `${TS.muted("[t]")} thinking`;
		const cycle = this.autoCycleEnabled
			? `${TS.muted("[c]")} ${TS.accent("cycle")}`
			: `${TS.muted("[c]")} cycle`;
		const refresh = `${TS.muted("[r]")} refresh`;
		const split = `${TS.muted(`[1-${Math.max(1, this.panes.length)}]`)} panes`;
		const focusTip = `${TS.muted("[tab]")} focus`;
		const bottom = `${TS.muted("[g]")} bottom ${TS.muted("[q]")} quit`;
		const swapTip = `${TS.muted("[!]")} swap`;
		const alert = this.newSessionAlert ? ` ${TS.warning("⚡ NEW")} ` : "";
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
		label: `${s.id.startsWith("subagent-") ? s.id.slice(9, 17) : s.id.slice(0, 8)}  ${TS.muted("[" + s.status + "]")}`,
		description: `${s.turns}t  ·  ${timeAgo(now - s.mtimeMs)}`,
	}));

	const container = new Container();
	container.addChild(new Text(TS.accent(`Pick a session (${items.length})`), 1, 0));
	container.addChild(new Spacer(1));

	const list = new SelectList(items, Math.min(items.length, 10), {
		selectedPrefix: (t) => TS.accent(t),
		selectedText: (t) => TS.accent(t),
		description: (t) => TS.muted(t),
		scrollInfo: (t) => TS.dim(t),
		noMatch: (t) => TS.warning(t),
	});
	list.onSelect = (item) => {
		const found = sessions.find((s) => s.id === item.value);
		if (found) onSelect(found);
	};
	list.onCancel = () => onCancel();
	container.addChild(list);
	container.addChild(new Spacer(1));
	container.addChild(new Text(TS.dim("↑↓ navigate • enter select • esc cancel"), 1, 0));

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
		process.stdout.off("resize", onStdoutResize);
		removeInput();
		for (const p of viewer.panes) p.close();
		try { tui.stop(); } catch {}
		process.stdout.write(`\x1b[?25h\x1b[?1049l\x1b[?1000l\x1b[?1006l${RESET}\n`);
		process.exit(code);
	};

	process.on("SIGINT", () => cleanupAndExit(0));
	process.on("SIGTERM", () => cleanupAndExit(0));
	process.stdin.on("close", () => cleanupAndExit(0));
	process.on("exit", () => {
		process.stdout.write(`\x1b[?25h\x1b[?1049l\x1b[?1000l\x1b[?1006l${RESET}`);
	});

	tui.start();

	// Enable mouse reporting (SGR mode). TUI.start() does a `[c` reset that
	// clears these, so we set them up afterwards.
	process.stdout.write(`\x1b[?1000h\x1b[?1006h`);

	// Resize handler — tui.start wires the terminal onResize to requestRender,
	// but the layout also needs updated rows/cols for bodyHeight() to recompute.
	const onStdoutResize = () => {
		viewer.resize(process.stdout.columns || 80, process.stdout.rows || 24);
		tui.requestRender();
	};
	process.stdout.on("resize", onStdoutResize);
	onStdoutResize(); // initial sync
	tui.requestRender();

	// ── Input ────────────────────────────────────────────────────────
	removeInput = tui.addInputListener((data: string) => {
		// Mouse SGR first. Row is 1-indexed; paneRowRanges() is 0-indexed.
		const mm = data.match(MOUSE_SGR_RE);
		if (mm) {
			const button = parseInt(mm[1], 10);
			const row1 = parseInt(mm[3], 10);
			const row0 = row1 - 1;
			const ranges = viewer.layout.paneRowRanges();
			let target = viewer.panes.findIndex((_, i) => row0 >= ranges[i].start && row0 <= ranges[i].end);
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
			return { consume: true }; // also swallow stray mouse moves
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
