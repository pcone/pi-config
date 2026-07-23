/**
 * Compaction Model Extension
 *
 * Forces /compact and auto-compaction to use DeepSeek V4 Flash (via OpenRouter)
 * while keeping every other aspect of compaction identical to the default.
 *
 * Why V4 Flash: compaction is a one-shot, uncached-heavy workload, so the
 * *prompt* price dominates — V4 Flash ($0.094/M) is ~3x cheaper than the
 * previous MiniMax-M3 ($0.30/M) with comparable summarization ability and
 * the same 1M context. See decisions/subagents/008-orchestrator-compaction-models.md
 *
 * If the model cannot be resolved or auth fails, falls through to pi's
 * default compaction behavior.
 */

import { compact } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const COMPACTION_PROVIDER = "openrouter";
const COMPACTION_MODEL_ID = "deepseek/deepseek-v4-flash";

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, customInstructions, signal } = event;

		// Resolve the dedicated compaction model
		const model = ctx.modelRegistry.find(COMPACTION_PROVIDER, COMPACTION_MODEL_ID);
		if (!model) {
			ctx.ui.notify(
				`Compaction model ${COMPACTION_PROVIDER}/${COMPACTION_MODEL_ID} not found — using default compaction`,
				"warning",
			);
			return;
		}

		// Resolve auth for the compaction model
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			ctx.ui.notify(`Compaction auth failed: ${auth.error}`, "warning");
			return;
		}

		try {
			const result = await compact(
				preparation,
				model,
				auth.apiKey,
				auth.headers,
				customInstructions,
				signal,
			);

			return { compaction: result };
		} catch (error) {
			if (signal?.aborted) {
				// Silently swallow — user cancelled compaction
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Compaction with ${COMPACTION_MODEL_ID} failed: ${message}`, "error");
			return;
		}
	});
}
