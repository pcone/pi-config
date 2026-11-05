/**
 * watch-session — External TUI viewer for async subagent sessions.
 *
 * Connects to a subagent's Unix socket and renders a live dashboard
 * using pi's TUI engine. Run from another terminal alongside pi.
 *
 * Usage:  npx tsx watch-session.ts <session-id>
 * Example: npx tsx watch-session.ts subagent-abc123
 */

import { createConnection } from "node:net";
import * as readline from "node:readline";
import {
	ProcessTerminal,
	TuiMainScreen,
	type TUI,
	Container,
	Text,
	Spacer,
	Key,
	matchesKey,
	truncateToWidth,
} from "@earendil-works/pi-tui";

import {
	STOPPED_FOOTER_WORD,
	outcomeFromFooter,
	parseTerminalFooter,
	type SubagentOutcome,
	type TerminalFooter,
} from "../lib/subagent-state.ts";

const sid = process.argv[2];
if (!sid) {
	console.error("Usage: npx tsx watch-session.ts <session-id>");
	process.exit(1);
}

// Resolve session ID — accepts full ID, short suffix, or full path
const sockPath = sid.startsWith("/")
	? sid
	: `/tmp/pi-subagent-${sid.startsWith("subagent-") ? sid : `subagent-${sid}`}.sock`;

// ── Component ───────────────────────────────────────────────────────────────

class SessionViewer {
	private lines: string[] = [];
	private done = false;
	private exitCode: number | null = null;
	private turns = 0;
	private word: string | null = null;
	private outcome: SubagentOutcome | null = null;
	private _cachedLines?: string[];
	private _cachedWidth = -1;
	private _cachedLineCount = -1;

	pushLine(text: string) {
		this.lines.push(text);
	}

	/** Record the terminal footer the log wrote, or null when the socket closed
	 *  with no footer — then the run still reads terminal but names no word. */
	setDone(footer: TerminalFooter | null) {
		this.done = true;
		this.word = footer ? footer.word : null;
		this.outcome = footer ? outcomeFromFooter(footer) : null;
		this.exitCode = footer ? footer.exitCode : null;
		this.turns = footer ? footer.turns : this.turns;
	}

	invalidate() {
		this._cachedWidth = -1;
		this._cachedLines = undefined;
	}

	handleInput(data: string) {
		if (matchesKey(data, "q") || matchesKey(data, Key.escape)) {
			process.exit(0);
		}
	}

	render(width: number): string[] {
		// Cache: skip if nothing changed
		if (this._cachedLines && this._cachedWidth === width && this._cachedLineCount === this.lines.length) {
			return this._cachedLines;
		}
		this._cachedWidth = width;
		this._cachedLineCount = this.lines.length;

		const out: string[] = [];

		// Header bar (inverse video)
		const status = this.done ? (this.word ?? STOPPED_FOOTER_WORD) : "running";
		const turnsStr = this.turns > 0 ? `  |  Turns: ${this.turns}` : "";
		out.push(
			"\x1b[7m" +
				truncateToWidth(
					`  Subagent Session: ${sid}  |  ${status}${turnsStr}`,
					width,
				) +
				"\x1b[27m",
		);

		// Body — show last N lines that fit in remaining terminal height
		const headerRows = 1;
		const footerRows = 1;
		const termHeight = process.stdout.rows || 24;
		const bodyRows = Math.max(5, termHeight - headerRows - footerRows - 2);

		// Pad empty lines at top if needed
		const visible = this.lines.slice(-bodyRows);
		for (let i = visible.length; i < bodyRows; i++) {
			out.push("");
		}

		for (const line of visible) {
			// Strip leading whitespace from log lines (they come pre-indented)
			const cleaned = line.replace(/^ {0,2}/, "");
			out.push(truncateToWidth(` ${cleaned}`, width));
		}

		// Footer
		const footerText = this.done ? "  [done] q to quit  |  auto-exit in 30s" : "  q to quit  |  auto-scrolling";
		out.push("\x1b[7m" + truncateToWidth(footerText, width) + "\x1b[27m");

		this._cachedLines = out;
		return out;
	}
}

// ── Connect & run ───────────────────────────────────────────────────────────

const viewer = new SessionViewer();
const terminal = new ProcessTerminal();
// TuiMainScreen leaves the log in the terminal's scrollback so it survives exit; TuiAltScreen owns the viewport and restores the main buffer (pi-tui README).
const tui: TUI = new TuiMainScreen(terminal);

// Add viewer as child component (TUI renders all children vertically)
(tui as any).addChild(viewer);
tui.setFocus(viewer);
tui.start();

// Periodically refresh for elapsed time in header / auto-scroll
const tick = setInterval(() => {
	viewer.invalidate();
	tui.requestRender();
}, 1000);

// Connect to socket
const socket = createConnection(sockPath, () => {
	const rl = readline.createInterface({ input: socket, crlfDelay: Infinity });

	rl.on("line", (line: string) => {
		viewer.pushLine(line);

		// The footer is the log's own line; its ANSI prefix is why the pattern is
		// unanchored.
		const footer = parseTerminalFooter(line);
		if (footer) viewer.setDone(footer);

		viewer.invalidate();
		tui.requestRender();
	});

	socket.on("close", () => {
		clearInterval(tick);
		if (!viewer["done"]) viewer.setDone(null);
		viewer.invalidate();
		tui.requestRender();

		// Keep TUI alive for review, then auto-exit
		setTimeout(() => {
			tui.stop();
			process.exit(0);
		}, 30_000);
	});
});

socket.on("error", (err: NodeJS.ErrnoException) => {
	if (err.code === "ENOENT") {
		console.error(`No subagent session found for: ${sid}`);
		console.error(`Socket path: ${sockPath}`);
	} else {
		console.error(`Connection error: ${err.message}`);
	}
	process.exit(1);
});

// Clean exit
process.on("SIGINT", () => {
	tui.stop();
	process.exit(0);
});
process.on("SIGTERM", () => {
	tui.stop();
	process.exit(0);
});
