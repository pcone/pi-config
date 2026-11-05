/**
 * Compaction Model Extension
 *
 * Forces `/compact` and auto-compaction to use the fleet model at `:low`
 * effort (decision 022) while keeping every other aspect of compaction
 * identical to the default. Checkpoint compactions are not its business: it
 * yields on the `[CHECKPOINT]` marker so the summary `checkpoint.ts` composed is
 * the one stored (owner 2026-10-31, `decisions/checkpoint/005`).
 *
 * Why force the model: the active session model can be switched mid-session,
 * and compaction should always run on the cheap fleet seat rather than
 * whatever the user is currently driving.
 *
 * Why `:low`: compaction is summarization, not reasoning. The vendor effort
 * audit (decision 022) puts `low`=50 as the real discount tier — "modest
 * accuracy degradation" on a smooth curve — and without an explicit level
 * compaction silently rides the provider default (`high`). Resolution is
 * table-driven from extensions/lib/fleet-model.ts.
 *
 * If the model cannot be resolved or auth fails, falls through to pi's
 * default compaction behavior. A fleet call that fails is reported at `error`:
 * a silent failure is not a summary-ownership policy.
 */

import { compact } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CHECKPOINT_MARKER } from "./lib/checkpoint-marker.ts";
import { FLEET_MODEL, FLEET_MODEL_SPEC, FLEET_PROVIDER } from "./lib/fleet-model.ts";
import { safeNotify } from "./lib/safe-notify.ts";

/**
 * pi 1.4.0's `ProviderHeaders` carries deletion markers (`null`) that pi strips
 * at its own call sites; this one is outside that filter.
 */
function withoutDeletedHeaders(
	headers: Record<string, string | null> | undefined,
): Record<string, string> | undefined {
	return headers
		? Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== null))
		: undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, customInstructions, signal } = event;

		// A checkpoint compaction's summary is the text checkpoint.ts composed
		// (owner 2026-10-31, decisions/checkpoint/005). Yield before resolving a
		// model, so ownership is this predicate and not a fleet call's outcome.
		if (customInstructions?.includes(CHECKPOINT_MARKER)) return;

		const model = ctx.modelRegistry.find(FLEET_PROVIDER, FLEET_MODEL);
		if (!model) {
			safeNotify(
				ctx,
				`Compaction model ${FLEET_MODEL_SPEC} not found — using default compaction`,
				"warning",
			);
			return;
		}

		// Resolve auth for the compaction model
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			safeNotify(ctx, `Compaction auth failed: ${auth.error}`, "warning");
			return;
		}

		try {
			const result = await compact(
				preparation,
				model,
				auth.apiKey,
				withoutDeletedHeaders(auth.headers),
				customInstructions,
				signal,
				"low", // decision 022 effort audit — summarization runs at the discount tier
				undefined, // streamFn: pi's own dispatch (`completeSimple`), as before
				auth.env,
			);

			return { compaction: result };
		} catch (error) {
			if (signal?.aborted) {
				// Silently swallow — user cancelled compaction
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			safeNotify(ctx, `Compaction with ${FLEET_MODEL_SPEC} failed: ${message}`, "error");
			return;
		}
	});
}
