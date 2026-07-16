/**
 * Modes — switch between "implement" (act directly) and "orchestrate"
 * (dispatch to subagents).
 *
 * Architecture: a static brief in the system prompt (cache-stable) plus
 * full mode instructions injected as a one-shot user-role message at
 * session start, after /mode, and after compaction. Message injection
 * lands at end-of-input (highest attention) and rides the conversation
 * tail cache. /mode invalidates no system-prompt cache.
 *
 * State is per-project (<cwd>/.pi/mode.json) with a global fallback
 * (~/.pi/agent/modes.json) for new sessions in projects that haven't
 * chosen yet.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Mode = "implement" | "orchestrate";

const PROJECT_FILE = join(process.cwd(), ".pi", "mode.json");
const GLOBAL_FILE = join(homedir(), ".pi", "agent", "modes.json");

const MODES_BRIEF = `## Modes

You operate in one of two modes (the user toggles via /mode):
- **implement** (default): act directly in this session — read files, make edits, run commands. You are the operator.
- **orchestrate**: dispatch implementation work to subagents (implement-flash for mechanical / explicit-invariant work, implement-pro for non-trivial feature work, scout-code/scout-web for research) and synthesize their reports. You are the conductor.

The currently-active mode is delivered as a user-role message at session start and after every /mode switch. The most recent such message is authoritative — read it to see which mode you are in.`;

const MODE_FULL: Record<Mode, string> = {
	implement: `## Mode: implement

You are in implementation mode. Do the work directly in this session.
Prefer acting yourself over dispatching to subagents.

You may delegate substantial work (large refactors, multi-file
changes) when warranted, but the default is to act directly. Read
files, make edits, run tests — you are the operator.`,

	orchestrate: `## Mode: orchestrate

You are in orchestration mode. Prefer dispatching implementation work
to subagents. For substantial tasks, generate a work order (load the
work-order-template skill) and dispatch to the appropriate agent
(implement-flash for mechanical work with explicit invariants,
implement-pro for non-trivial feature work, scout-code/scout-web for
research). For trivial changes, use `skip_review: true` on the
`subagent` call and review the diff directly. Handle completion
reports: status, invariant_exhaustiveness calibration,
structural_checks, deviations, notes_for_orchestrator.

You are the conductor. Subagents do the work; you synthesize, verify,
and decide.`,
};

function readModeFile(path: string): Mode | null {
	try {
		if (!existsSync(path)) return null;
		const data = JSON.parse(readFileSync(path, "utf-8")) as { mode?: string };
		return data.mode === "implement" || data.mode === "orchestrate" ? data.mode : null;
	} catch {
		return null;
	}
}

function writeModeFile(path: string, mode: Mode): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ mode }, null, 2));
	} catch {
		/* best-effort */
	}
}

const loadMode = (): Mode => readModeFile(PROJECT_FILE) ?? readModeFile(GLOBAL_FILE) ?? "implement";
const saveMode = (mode: Mode): void => { writeModeFile(PROJECT_FILE, mode); writeModeFile(GLOBAL_FILE, mode); };

export default function modesExt(pi: ExtensionAPI): void {
	let currentMode: Mode = loadMode();
	let pendingInjection: Mode | null = null;

	const setStatus = (
		ctx: { ui: { setStatus(n: string, t: string): void; theme: { fg(c: string, t: string): string } } },
		mode: Mode,
	) => ctx.ui.setStatus("mode", ctx.ui.theme.fg(mode === "implement" ? "muted" : "accent", `[${mode}]`));

	pi.on("session_start", async (_event, ctx) => {
		currentMode = loadMode();
		pendingInjection = currentMode;
		setStatus(ctx, currentMode);
		pi.events.emit("pi-config:startup-summary-item", {
			key: "modes",
			order: 30,
			text: `[Modes] implement, orchestrate. Current: ${currentMode}. /mode to toggle.`,
		});
	});

	// Re-prime after compaction: the prior mode-injection message has been
	// summarized away, leaving the system-prompt brief pointing at nothing.
	pi.on("session_compact", () => { pendingInjection = currentMode; });

	pi.registerCommand("mode", {
		description: "Toggle or set the session mode (implement / orchestrate)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			let next: Mode;

			if (arg === "implement" || arg === "orchestrate") {
				next = arg;
			} else if (arg === "") {
				next = currentMode === "implement" ? "orchestrate" : "implement";
			} else {
				ctx.ui.notify(`Current mode: ${currentMode}\nUsage: /mode [implement|orchestrate]`, "info");
				return;
			}

			if (next === currentMode) return;
			currentMode = next;
			saveMode(next);
			pendingInjection = next;
			setStatus(ctx, next);
			ctx.ui.notify(`Mode: ${next}`, "info");
		},
	});

	pi.on("before_agent_start", async (event) => {
		const out: { systemPrompt?: string; message?: unknown } = {
			systemPrompt: event.systemPrompt + "\n\n" + MODES_BRIEF,
		};
		if (pendingInjection) {
			out.message = {
				customType: "mode-injection",
				content: MODE_FULL[pendingInjection],
				display: false,
				details: { mode: pendingInjection },
			};
			pendingInjection = null;
		}
		return out;
	});
}
