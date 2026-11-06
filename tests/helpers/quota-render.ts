/**
 * The pre-refactor quota entry points, rebuilt as test glue.
 *
 * `renderQuotaSegment` and `renderGoUsageSegment` were deleted from
 * `extensions/lib/quota.ts` (WO-2026-089) because no production code called
 * them: the footer renders through `quotaDescriptorFor(provider)?.render(...)`,
 * fed by `fetchQuotaSnapshot` → `descriptor.parse` → `snapshotFor`, so the
 * already-normalised payloads these take never exist in production. The
 * assembly they performed is still what the rows need, so it lives here.
 *
 * The behaviour is reproduced from the deleted bodies, not re-derived:
 * `fromQuotaData` / `goParts` are the same conversions production's parse
 * functions use, and the snapshot literal mirrors the private `snapshotFor`.
 */
import {
	goParts,
	quotaDescriptorFor,
	renderQuotaSnapshot,
	type GoUsage,
	type QuotaData,
	type QuotaPart,
	type QuotaSnapshot,
	type QuotaTheme,
} from "../../extensions/lib/quota.ts";

/** The snapshot shape `snapshotFor` builds: provider tag plus the descriptor's overflow policy. */
function snapshotOf(provider: string, parts: QuotaPart[], overflow: QuotaSnapshot["overflow"]): QuotaSnapshot {
	return { provider, parts, overflow };
}

/**
 * Render the token-window shape. `now` drives the z.ai peak/off-peak prefix
 * only — reset durations come from the real clock, as they always have.
 */
export function renderQuotaSegment(
	quota: QuotaData | undefined,
	modelProvider: string | undefined,
	modelId: string | undefined,
	width: number,
	theme: QuotaTheme,
	now?: Date,
): string {
	if (!quota) return "";
	const descriptor = quotaDescriptorFor(modelProvider);
	const parts = descriptor?.fromQuotaData?.(quota);
	if (!descriptor || !parts) return "";
	return renderQuotaSnapshot(
		snapshotOf(descriptor.provider, parts, descriptor.overflow),
		modelProvider,
		modelId,
		width,
		theme,
		{ now: now ?? new Date(), resetNow: new Date() },
	);
}

/**
 * Render the OpenCode Go window shape.
 *
 * Provider gating is the renderer's `snapshot.provider !== provider` guard, as
 * in production; the deleted function's own `modelProvider !== "opencode-go"`
 * check was that gate a second time.
 */
export function renderGoUsageSegment(
	usage: GoUsage | undefined,
	modelProvider: string | undefined,
	width: number,
	theme: QuotaTheme,
	now?: number,
): string {
	if (!usage) return "";
	const descriptor = quotaDescriptorFor("opencode-go")!;
	const at = new Date(now ?? Date.now());
	return renderQuotaSnapshot(
		snapshotOf(descriptor.provider, goParts(usage), descriptor.overflow),
		modelProvider,
		undefined,
		width,
		theme,
		{ now: at, resetNow: at },
	);
}
