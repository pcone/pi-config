/**
 * Modes — switch between "implement" (act directly), "orchestrate"
 * (dispatch to subagents), and "plan" (super-orchestrator — own a roadmap
 * doc, dispatch orchestrator-subagents).
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

type Mode = "implement" | "orchestrate" | "plan";

/** Pure helper: the 3-way mode cycle. Unit-testable. */
export function nextMode(current: Mode): Mode {
	if (current === "implement") return "orchestrate";
	if (current === "orchestrate") return "plan";
	return "implement";
}

/** Pure helper: mode guard. Accepts exactly the three mode strings (case-sensitive, no whitespace). */
export function isValidMode(s: string): s is Mode {
	return s === "implement" || s === "orchestrate" || s === "plan";
}

const PROJECT_FILE = join(process.cwd(), ".pi", "mode.json");
const GLOBAL_FILE = join(homedir(), ".pi", "agent", "modes.json");

const MODES_BRIEF = `## Modes

You operate in one of three modes (the user sets or cycles via /mode):
- **implement** (default): act directly in this session — read files, make edits, run commands. You are the operator.
- **orchestrate**: dispatch implementation work to subagents (implement-flash for mechanical / explicit-invariant work, implement-pro for non-trivial feature work, scout-code/scout-web for research) and synthesize their reports. You are the conductor.
- **plan**: act as super-orchestrator — own a roadmap doc, dispatch \`orchestrator\`-subagents one per item, reconcile after each; you never implement directly.

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
research). For trivial changes, pass \`review_policy: "skip"\` on the \`subagent\` call
(or include \`**review_policy**: skip\` in the work order) and review the
diff directly. Handle completion reports: status, invariant_exhaustiveness
calibration, structural_checks, deviations, notes_for_orchestrator.

You are the conductor. Subagents do the work; you synthesize, verify,
and decide.

## Context hygiene

Occasional investigation, thinking, or experimentation loops you do
yourself burn context that won't matter once the task moves on.
Manage it:

- **Plans go in a todo doc, not in chat.** Use \`todo\` \`setDoc\`
  (e.g. \`tmp/TODO.md\`) and write the full plan there.
- **Keep the in-pi todo list accurate** — one-line summaries
  referencing the doc, marked \`in_progress\` / \`done\` as work moves.
- **Checkpoint after every context-heavy loop or subtask lands.**
  Summary must be rich enough to resume from cold: what was decided,
  what's next, which files/identifiers matter next.`,

	plan: `## Mode: plan

You are in plan mode (super-orchestration). You are the
super-orchestrator (SO). You own a canonical roadmap doc and dispatch
\`orchestrator\`-subagents (the \`orchestrator\` agent), one per roadmap
item, in parallel where items are independent.

You do NOT implement. You never edit code or run implementer work
yourself. Your value is a clean planning context — if you implement,
you lose it. Your job is to maintain the roadmap, dispatch
orchestrators, reconcile after every item, and keep the big picture
coherent.

## Roadmap ownership + reconcile rule

Maintain the roadmap doc (the contract is defined in \`## Super-orchestration\`
in APPEND_SYSTEM). After every orchestrator-subagent completes an item,
reconcile the doc against merged reality:
- Mark the item done with its commit hash.
- Reorder remaining items if dependencies have shifted.
- Catch cross-item dependencies the orchestrator flagged.

This is a hard step, not optional. Doc/reality drift is the failure
mode this role was created to prevent.

## Dispatch

Dispatch one \`orchestrator\` agent per roadmap item via \`subagent\`.
Hand it three things: (a) the item spec (one line + a pointer to any
design/spec doc), (b) a pointer to the roadmap doc, (c) the resolved
policy (decisions that apply to all items — never re-litigated).

The orchestrator designs in detail, dispatches implementers, gates
their reviews, merges, and returns a completion report. You do not
micro-manage it — trust its gate, but mechanically verify the evidence
before accepting \`complete\`.

## Reframes via /attach

When an orchestrator-subagent surfaces a design reframe — a question
that re-opens the design and needs genuine multi-turn conversation
with the user, not a single structured fork — use \`/attach <id>\` to
let the user converse with the orchestrator directly. The
orchestrator's conclusions land in the roadmap doc; \`/detach\` returns
you here, and you read the updated doc. Your context stays clean.

Distinguish the two cases:
- **Tweak** = a single structured fork ("options A/B/C, which?").
  Relay handles it — you pass the options to the user, relay the
  answer back. No attach needed.
- **Reframe** = a multi-turn design conversation where the user must
  probe the orchestrator's understanding and iterate. Relay fails;
  attach is required.

## Context hygiene

Occasional investigation, thinking, or experimentation loops you do
yourself burn context that won't matter once the task moves on.
Manage it:

- **Plans go in a todo doc, not in chat.** Use \`todo\` \`setDoc\`
  (e.g. \`tmp/TODO.md\`) and write the full plan there.
- **Keep the in-pi todo list accurate** — one-line summaries
  referencing the doc, marked \`in_progress\` / \`done\` as work moves.
- **Checkpoint after every orchestrator item lands.** Summary must be
  rich enough to resume from cold: what was decided, what's next,
  which roadmap items are done / in-progress / blocked.`,
};

function readModeFile(path: string): Mode | null {
	try {
		if (!existsSync(path)) return null;
		const data = JSON.parse(readFileSync(path, "utf-8")) as { mode?: string };
		const mode = data.mode ?? "";
		return isValidMode(mode) ? mode : null;
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
	) => ctx.ui.setStatus("mode", ctx.ui.theme.fg(mode === "implement" ? "muted" : mode === "plan" ? "success" : "accent", `[${mode}]`));

	pi.on("session_start", async (_event, ctx) => {
		currentMode = loadMode();
		pendingInjection = currentMode;
		setStatus(ctx, currentMode);
		pi.events.emit("pi-config:startup-summary-item", {
			key: "modes",
			order: 30,
			text: `[Modes] implement, orchestrate, plan. Current: ${currentMode}. /mode to cycle or /mode <name>.`,
		});
	});

	// Re-prime after compaction: the prior mode-injection message has been
	// summarized away, leaving the system-prompt brief pointing at nothing.
	pi.on("session_compact", () => { pendingInjection = currentMode; });

	pi.registerCommand("mode", {
		description: "Set or cycle the session mode (implement / orchestrate / plan)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			let next: Mode;

			if (isValidMode(arg)) {
				next = arg;
			} else if (arg === "") {
				next = nextMode(currentMode);
			} else {
				ctx.ui.notify(`Current mode: ${currentMode}\nUsage: /mode [implement|orchestrate|plan]`, "info");
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
		// Subagent sessions inherit the parent's mode setting from disk
		// (e.g. ~/.pi/agent/modes.json), which causes them to receive the
		// orchestrator's "you are the conductor" prompt and try to dispatch
		// work to other subagents — wrong for a session that IS the worker.
		// The subagent harness sets PI_IS_SUBAGENT=1 on every spawn; check
		// it and skip both the brief and the mode-injection message for
		// subagent sessions. The agent's own system prompt (e.g. implement-
		// flash.md) carries the role-specific instructions.
		if (process.env.PI_IS_SUBAGENT === "1") return {};

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
