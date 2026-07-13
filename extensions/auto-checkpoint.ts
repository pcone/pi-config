/**
 * Auto-Checkpoint Extension
 *
 * Monitors context usage per turn and nudges the model (via a context message)
 * to suggest checkpointing when configured thresholds are crossed.
 *
 * The nudge injects a model-visible message at the start of the next agent run
 * (before_agent_start) only when BOTH the turn-count and timer cooldowns have
 * been exceeded since the last nudge.
 *
 * Config:
 *   ~/.pi/agent/auto-checkpoint.json  (global)
 *   .pi/auto-checkpoint.json          (project-local, merged over global)
 *
 * Schema:
 *   {
 *     "defaultThreshold": 0.75,          // fraction of contextWindow (0-1)
 *     "cooldownTurns": 3,                // min turns between nudges
 *     "cooldownMs": 30000,               // min ms between nudges
 *     "prompt": "**Context note:** ...",  // optional, overrides degradation auto-pick
 *     "defaultContextDegradation": true,  // default for models without explicit setting
 *     "models": {
 *       "deepseek/*": { "threshold": 0.8, "cooldownTurns": 5 },
 *       "openai/*":    { "threshold": 0.7 },
 *       "z.ai/glm-5.2": {
 *         "threshold": 0.85,
 *         "contextDegradation": false   // relaxed prompt, no urgency
 *       }
 *     }
 *   }
 *
 * Per-model thresholds: < 1 is a fraction of contextWindow, >= 1 is an absolute
 * token count. Model patterns support * and ? wildcards; first match wins.
 *
 * When contextDegradation is false, the nudge prompt is relaxed — suggesting
 * the model wait for a logical completion point rather than urging a quick
 * checkpoint. When a custom prompt is set explicitly at the model or top level,
 * the degradation flag is ignored.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve as resolvePath } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ModelThresholdConfig {
	/** < 1 → fraction of contextWindow, >= 1 → absolute token count. */
	threshold: number;
	cooldownTurns?: number;
	cooldownMs?: number;
	prompt?: string;
	/**
	 * Whether this model's quality degrades at higher context lengths.
	 * - true (default) → prompt with some urgency: "Quality degrades…"
	 * - false → relaxed prompt: "Handles longer contexts well… no rush"
	 *
	 * Ignored when a custom prompt is set explicitly.
	 */
	contextDegradation?: boolean;
}

interface RawAutoCheckpointConfig {
	defaultThreshold?: number;
	cooldownTurns?: number;
	cooldownMs?: number;
	models?: Record<string, ModelThresholdConfig>;
	prompt?: string;
	defaultContextDegradation?: boolean;
}

interface AutoCheckpointConfig {
	defaultThreshold: number;
	cooldownTurns: number;
	cooldownMs: number;
	models: Record<string, ModelThresholdConfig>;
	prompt: string;
	defaultContextDegradation: boolean;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Prompt variants
// ---------------------------------------------------------------------------

/** Used when the model degrades at high context (contextDegradation: true). */
const DEGRADATION_PROMPT =
	"**Context note:** The conversation has reached **{{tokens}}** tokens " +
	"({{percent}}% of {{contextWindow}}). Quality tends to degrade at higher " +
	"context lengths. Consider running the **checkpoint** tool at your next " +
	"natural stopping point to archive progress and continue with fresh context.";

/** Used when the model handles long context well (contextDegradation: false). */
const NO_DEGRADATION_PROMPT =
	"**Context note:** The conversation has reached **{{tokens}}** tokens " +
	"({{percent}}% of {{contextWindow}}). This model handles longer contexts " +
	"well, but keeping context smaller reduces costs. Whenever you reach a " +
	"clean break — finishing the current subtask or answering the current " +
	"question — you can run the **checkpoint** tool to archive progress and " +
	"continue with fresh context. There's no rush.";

const DEFAULT_CONFIG: AutoCheckpointConfig = {
	defaultThreshold: 0.75,
	cooldownTurns: 3,
	cooldownMs: 30_000,
	models: {},
	prompt: DEGRADATION_PROMPT,
	defaultContextDegradation: true,
};

const GLOBAL_CONFIG_PATH = join(homedir(), ".pi", "agent", "auto-checkpoint.json");

// ---------------------------------------------------------------------------
// Glob matching (only * and ?)
// ---------------------------------------------------------------------------

function matchPattern(pattern: string, s: string): boolean {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
	return new RegExp("^" + escaped + "$", "i").test(s);
}

// ---------------------------------------------------------------------------
// Config loading & merging
// ---------------------------------------------------------------------------

function mergeConfig(base: AutoCheckpointConfig, raw: RawAutoCheckpointConfig): AutoCheckpointConfig {
	return {
		...base,
		...raw,
		models: { ...base.models, ...raw.models },
		prompt: raw.prompt ?? base.prompt,
		defaultContextDegradation: raw.defaultContextDegradation ?? base.defaultContextDegradation,
	};
}

async function loadConfig(cwd: string): Promise<AutoCheckpointConfig> {
	let config = { ...DEFAULT_CONFIG };

	try {
		const raw = JSON.parse(await readFile(GLOBAL_CONFIG_PATH, "utf8")) as RawAutoCheckpointConfig;
		config = mergeConfig(config, raw);
	} catch {
		// missing or invalid global config → use defaults
	}

	const projectPath = join(cwd, ".pi", "auto-checkpoint.json");
	try {
		const raw = JSON.parse(await readFile(projectPath, "utf8")) as RawAutoCheckpointConfig;
		config = mergeConfig(config, raw);
	} catch {
		// missing or invalid project config → keep current
	}

	return config;
}

/** Resolve threshold to an absolute token count for the given model. */
function resolveThreshold(modelId: string, contextWindow: number, config: AutoCheckpointConfig): number {
	for (const [pattern, mcfg] of Object.entries(config.models)) {
		if (matchPattern(pattern, modelId)) {
			return mcfg.threshold < 1
				? Math.round(mcfg.threshold * contextWindow)
				: mcfg.threshold;
		}
	}
	return Math.round(config.defaultThreshold * contextWindow);
}

/** Get resolved model-level config for cooldown/prompt overrides. */
function resolveModelConfig(
	modelId: string,
	config: AutoCheckpointConfig,
): {
	cooldownTurns: number;
	cooldownMs: number;
	explicitPrompt: string | null;
	contextDegradation: boolean;
} {
	for (const [pattern, mcfg] of Object.entries(config.models)) {
		if (matchPattern(pattern, modelId)) {
			return {
				cooldownTurns: mcfg.cooldownTurns ?? config.cooldownTurns,
				cooldownMs: mcfg.cooldownMs ?? config.cooldownMs,
				explicitPrompt: mcfg.prompt ?? null,
				contextDegradation: mcfg.contextDegradation ?? config.defaultContextDegradation,
			};
		}
	}
	return {
		cooldownTurns: config.cooldownTurns,
		cooldownMs: config.cooldownMs,
		explicitPrompt: null,
		contextDegradation: config.defaultContextDegradation,
	};
}

// ---------------------------------------------------------------------------
// Nudge state
// ---------------------------------------------------------------------------

interface PendingNudge {
	tokens: number;
	contextWindow: number;
	percent: number;
}

// ---------------------------------------------------------------------------
// Read-region tracking (shared format with checkpoint.ts)
// ---------------------------------------------------------------------------

interface ReadRegion {
	offset: number;
	limit: number; // Number.MAX_SAFE_INTEGER means "read to end"
}

/** Files read this session, keyed by normalized relative-to-cwd path. */
const readRegions = new Map<string, ReadRegion[]>();

function normalizePath(filePath: string, cwd: string): string {
	const absolute = resolvePath(cwd, filePath);
	const rel = relative(cwd, absolute);
	return rel.startsWith("..") ? absolute : rel || ".";
}

function mergeRegions(regions: ReadRegion[]): Array<{ offset: number; endLine: number }> {
	const sorted = regions
		.map((r) => ({ offset: r.offset, endLine: r.offset + r.limit - 1 }))
		.sort((a, b) => a.offset - b.offset);
	const merged: Array<{ offset: number; endLine: number }> = [];
	for (const r of sorted) {
		const prev = merged[merged.length - 1];
		if (prev && r.offset <= prev.endLine + 1) {
			prev.endLine = Math.max(prev.endLine, r.endLine);
		} else {
			merged.push({ ...r });
		}
	}
	return merged;
}

function formatReadRegions(readRegions: Map<string, ReadRegion[]>): string {
	if (readRegions.size === 0) return "";
	const entries: string[] = [];
	for (const [path, regions] of readRegions) {
		const merged = mergeRegions(regions);
		const ranges = merged
			.map((r) => (r.endLine >= Number.MAX_SAFE_INTEGER - 1 ? `L${r.offset}-end` : `L${r.offset}-${r.endLine}`))
			.join(", ");
		const fullFile = merged.length === 1 && merged[0].offset === 1 && merged[0].endLine >= Number.MAX_SAFE_INTEGER - 1;
		entries.push(`- ${path}${fullFile ? " (entire file)" : ` → ${ranges}`}`);
	}
	return (
		`\n\nFiles read this session:\n${entries.join("\n")}` +
		`\n\nWhen checkpointing, use relevantPaths to carry forward files you still need. ` +
		`Skip files you read recently — they're already in the preserved context tail. ` +
		`Use scope: "read" for partial re-injection, scope: "context" for breadcrumb-only references.`
	);
}

// ---------------------------------------------------------------------------
// Nudge state
// ---------------------------------------------------------------------------

const state: {
	config: AutoCheckpointConfig | null;
	modelId: string | null;
	threshold: number;
	turnCounter: number;
	lastNudgedTurn: number;
	lastNudgedMs: number;
	pending: PendingNudge | null;
} = {
	config: null,
	modelId: null,
	threshold: 0,
	turnCounter: 0,
	lastNudgedTurn: -1,
	lastNudgedMs: -1,
	pending: null,
};

function resetState(): void {
	state.modelId = null;
	state.threshold = 0;
	state.turnCounter = 0;
	state.lastNudgedTurn = -1;
	state.lastNudgedMs = -1;
	state.pending = null;
	readRegions.clear();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// --- session_start: load config, reset state for fresh session ---
	pi.on("session_start", async (_event, ctx) => {
		state.config = await loadConfig(ctx.cwd);
		resetState();

		const model = ctx.model;
		if (model && model.id) {
			state.modelId = model.id;
			state.threshold = resolveThreshold(model.id, model.contextWindow ?? 200_000, state.config);
		}
	});

	// --- model_select: recompute threshold, clear nudge state ---
	pi.on("model_select", async (event, _ctx) => {
		if (!state.config) return;

		resetState();
		state.modelId = event.model.id;
		state.threshold = resolveThreshold(event.model.id, event.model.contextWindow ?? 200_000, state.config);
	});

	// --- session_compact: context just got freed → clear nudge state & read tracking ---
	pi.on("session_compact", async () => {
		resetState();
	});

	// --- turn_end: check context usage against threshold ---
	pi.on("turn_end", async (event, ctx) => {
		if (!state.config) return;
		if (!state.modelId) return;
		if (state.threshold <= 0) return;

		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null) return;

		state.turnCounter = event.turnIndex;

		const tokens = usage.tokens;
		const contextWindow = usage.contextWindow;
		const percent = usage.percent ?? Math.round((tokens / contextWindow) * 100);

		// Below threshold → no nudge pending, but don't clear history (threshold
		// zone exit is handled by compaction/model-change/session-start events).
		if (tokens < state.threshold) return;

		// Cooldown: both turn count AND timer must have elapsed.
		const mcfg = resolveModelConfig(state.modelId, state.config);
		const turnsSinceLast = state.turnCounter - state.lastNudgedTurn;
		const msSinceLast = state.lastNudgedMs < 0 ? Number.POSITIVE_INFINITY : Date.now() - state.lastNudgedMs;

		if (turnsSinceLast < mcfg.cooldownTurns || msSinceLast < mcfg.cooldownMs) return;

		// Store values for injection at the next before_agent_start
		state.pending = { tokens, contextWindow, percent };
	});

	// --- tool_execution_end: track read regions for nudge file hints ---
	pi.on("tool_execution_end", (event, ctx) => {
		if (event.toolName !== "read" || event.isError) return;
		const path: string | undefined = event.args?.path;
		if (!path) return;
		const offset: number = event.args?.offset ?? 1;
		const limit: number = event.args?.limit ?? Number.MAX_SAFE_INTEGER;

		const key = normalizePath(path, ctx.cwd);
		const regions = readRegions.get(key) ?? [];
		regions.push({ offset, limit });
		readRegions.set(key, regions);
	});

	// --- before_agent_start: inject the nudge message if one is pending ---
	pi.on("before_agent_start", async (_event, ctx) => {
		if (!state.pending) return;
		if (!state.config) return;

		const { tokens, contextWindow, percent } = state.pending;

		const mcfg = resolveModelConfig(state.modelId ?? ctx.model?.id ?? "", state.config);

		// Pick the right built-in prompt based on degradation flag, unless an
		// explicit prompt was configured (takes precedence).
		const promptTemplate = mcfg.explicitPrompt
			?? (mcfg.contextDegradation ? DEGRADATION_PROMPT : NO_DEGRADATION_PROMPT);

		let content = promptTemplate
			.replace(/\{\{tokens\}\}/g, tokens.toLocaleString())
			.replace(/\{\{percent\}\}/g, percent.toFixed(1))
			.replace(/\{\{contextWindow\}\}/g, contextWindow.toLocaleString());

		// Append tracked read regions so the model can make informed
		// relevantPaths decisions when calling the checkpoint tool.
		content += formatReadRegions(readRegions);

		state.lastNudgedTurn = state.turnCounter;
		state.lastNudgedMs = Date.now();
		state.pending = null;

		return {
			message: {
				customType: "auto-checkpoint",
				content,
				display: false,
			},
		};
	});

	// --- /checkpoint-status command: show current config & context ---
	pi.registerCommand("checkpoint-status", {
		description: "Show auto-checkpoint configuration and current context usage.",
		async handler(_args, ctx) {
			const model = ctx.model;
			const modelId = model?.id ?? "no-model";

			const lines: string[] = [
				"─── Auto-Checkpoint ───",
				`model: ${modelId}`,
			];

			if (state.config) {
				// Calculate effective threshold
				const effectiveThreshold =
					state.threshold > 0
						? state.threshold
						: resolveThreshold(modelId, model?.contextWindow ?? 200_000, state.config);

				const mcfg = resolveModelConfig(modelId, state.config);
				lines.push(`threshold: ${effectiveThreshold.toLocaleString()} tokens`);
				lines.push(`cooldown: ${mcfg.cooldownTurns} turns / ${(mcfg.cooldownMs / 1000).toFixed(0)}s`);
				lines.push(`context degradation: ${mcfg.contextDegradation}`);

				const usage = ctx.getContextUsage();
				if (usage && usage.tokens !== null) {
					const pct = usage.percent ?? Math.round((usage.tokens / usage.contextWindow) * 100);
					lines.push(`context: ${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} (${pct}%)`);
					if (usage.tokens >= effectiveThreshold) {
						lines.push(`status: ${state.pending ? "nudge pending" : "above threshold (cooldown)"}`);
					} else {
						lines.push("status: below threshold");
					}
				} else {
					lines.push("context: unknown");
				}
			} else {
				lines.push("config: not loaded");
			}

			lines.push(`last nudge: turn ${state.lastNudgedTurn} at ${state.lastNudgedMs > 0 ? new Date(state.lastNudgedMs).toLocaleTimeString() : "never"}`);

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
