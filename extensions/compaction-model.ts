/**
 * Compaction Model Extension
 *
 * Forces /compact and auto-compaction to use the fleet model (decision 022)
 * while keeping every other aspect of compaction identical to the default.
 * Why force it: the active session model can be switched mid-session, and
 * compaction should always run on the cheap fleet seat rather than whatever
 * the user is currently driving. Resolution is table-driven from
 * extensions/lib/fleet-model.ts; rationale in
 * decisions/subagents/022-openrouter-fleet-v41-flash.md.
 *
 * If the model cannot be resolved or auth fails, falls through to pi's
 * default compaction behavior.
 */

import { compact } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FLEET_MODEL, FLEET_PROVIDER } from "./lib/fleet-model.ts";

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, customInstructions, signal } = event;

		const model = ctx.modelRegistry.find(FLEET_PROVIDER, FLEET_MODEL);
		if (!model) {
			ctx.ui.notify(
				`Compaction model ${FLEET_PROVIDER}/${FLEET_MODEL} not found — using default compaction`,
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
			ctx.ui.notify(`Compaction with ${FLEET_MODEL} failed: ${message}`, "error");
			return;
		}
	});
}
