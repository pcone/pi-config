/**
 * Compaction Model Extension
 *
 * Forces /compact and auto-compaction to use the minimax/MiniMax-M3 model
 * while keeping every other aspect of compaction identical to the default.
 *
 * If the M3 model cannot be resolved or auth fails, falls through to pi's
 * default compaction behavior.
 */

import { compact } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const COMPACTION_PROVIDER = "minimax";
const COMPACTION_MODEL_ID = "MiniMax-M3";

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
