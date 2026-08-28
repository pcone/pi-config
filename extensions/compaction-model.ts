/**
 * Compaction Model Extension
 *
 * Forces /compact and auto-compaction to use the fleet flash seat (per
 * decision 020) while keeping every other aspect of compaction identical to
 * the default. The seat defaults to `zai/glm-5.3-flash`; a credit-low period
 * flips the WHOLE seat — compaction included — via `/fleet-model deepseek`
 * (override file `~/.pi/fleet-model.json`, zero file edits). Resolution is
 * table-driven from extensions/lib/fleet-model.ts; detail lives in
 * decisions/subagents/020-fleet-glm-53-flash-single-tier.md.
 *
 * If the model cannot be resolved or auth fails, falls through to pi's
 * default compaction behavior.
 */

import { compact } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveFlashSeat } from "./lib/fleet-model.ts";

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, customInstructions, signal } = event;

		// Resolve the dedicated compaction model (rides the fleet flash seat).
		const seat = resolveFlashSeat();
		const model = ctx.modelRegistry.find(seat.provider, seat.model);
		if (!model) {
			ctx.ui.notify(
				`Compaction model ${seat.provider}/${seat.model} not found — using default compaction`,
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
			ctx.ui.notify(`Compaction with ${seat.model} failed: ${message}`, "error");
			return;
		}
	});
}
