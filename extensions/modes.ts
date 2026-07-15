/**
 * Modes — switches the parent session between "implement" (do work
 * directly) and "orchestrate" (dispatch to subagents).
 *
 * State is per-project: persisted to <cwd>/.pi/mode.json, so each
 * project has its own default. Default when no file exists: implement.
 *
 * Commands:
 *   /mode                  toggle between implement and orchestrate
 *   /mode <implement|orchestrate>   set explicit
 *
 * Current mode is shown in the footer (muted for implement, accent for
 * orchestrate).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Mode = "implement" | "orchestrate";

const MODE_FILE = join(process.cwd(), ".pi", "mode.json");

const MODE_CONTENT: Record<Mode, string> = {
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
research). Handle completion reports: status,
invariant_exhaustiveness calibration, structural_checks, deviations,
notes_for_orchestrator.

You are the conductor. Subagents do the work; you synthesize, verify,
and decide.`,
};

// Subset of ExtensionContext we use — extracted to avoid pulling in the
// full type from pi-coding-agent just for typing a local helper.
type UIContext = {
	ui: {
		setStatus(name: string, text: string): void;
		notify(message: string, level: string): void;
		theme: { fg(name: string, text: string): string };
	};
};

function loadMode(): Mode {
	try {
		if (!existsSync(MODE_FILE)) return "implement";
		const data = JSON.parse(readFileSync(MODE_FILE, "utf-8")) as { mode?: string };
		if (data.mode === "implement" || data.mode === "orchestrate") return data.mode;
		return "implement";
	} catch {
		return "implement";
	}
}

function saveMode(mode: Mode): void {
	try {
		mkdirSync(join(process.cwd(), ".pi"), { recursive: true });
		writeFileSync(MODE_FILE, JSON.stringify({ mode }, null, 2));
	} catch {
		/* persistence is best-effort; falls back to default on next start */
	}
}

function setStatus(ctx: UIContext, mode: Mode): void {
	const color = mode === "implement" ? "muted" : "accent";
	ctx.ui.setStatus("mode", ctx.ui.theme.fg(color, `[${mode}]`));
}

export default function modesExt(pi: ExtensionAPI): void {
	let currentMode: Mode = loadMode();

	// Initial footer status — fires on every session (start + resume).
	pi.on("session_start", async (_event, ctx) => {
		currentMode = loadMode();
		setStatus(ctx, currentMode);
	});

	pi.registerCommand("mode", {
		description: "Toggle or set the session mode (implement / orchestrate)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();

			if (!arg) {
				// No arg → toggle
				const next: Mode = currentMode === "implement" ? "orchestrate" : "implement";
				currentMode = next;
				saveMode(next);
				setStatus(ctx, next);
				ctx.ui.notify(`Mode: ${next}`, "info");
				return;
			}

			if (arg === "implement" || arg === "orchestrate") {
				currentMode = arg;
				saveMode(arg);
				setStatus(ctx, arg);
				ctx.ui.notify(`Mode: ${arg}`, "info");
				return;
			}

			ctx.ui.notify(
				`Current mode: ${currentMode}\nUsage: /mode [implement|orchestrate]`,
				"info",
			);
		},
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		return {
			systemPrompt: event.systemPrompt + "\n\n" + MODE_CONTENT[currentMode],
		};
	});
}
