/**
 * Provider quota/usage for the footer's row-3 slot.
 *
 * One descriptor per provider (`{ provider, endpoint, auth, parse, render }`),
 * one fetch path, one cache slot, one segment renderer. A provider's
 * differences are data: the parts its `parse` returns, the header its `auth`
 * builds, and the optional render-time `prefix` (z.ai's peak multiplier).
 * Adding a provider is a descriptor, not a second fetcher and not a second
 * renderer.
 *
 * Endpoints — undocumented except MiniMax's:
 *   zai          GET https://api.z.ai/api/monitor/usage/quota/limit            (bare key)
 *   minimax      GET https://api.minimax.io/v1/api/openplatform/coding_plan/remains
 *   minimax-cn   GET https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains
 *   opencode-go  GET https://opencode.ai/zen/go/v1/usage
 *
 * Display: used percentage per window with the shared pressure colours (≥85
 * error, ≥60 warning, else success), plus time to reset, plus %-through the
 * window where its length is knowable (owner display spec:
 * decisions/external-tools/006 for Go).
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** The footer theme surface a segment needs. */
export type QuotaTheme = { fg: (color: string, text: string) => string };

/** A stalled usage endpoint must not hold the footer's fetch open. */
export const QUOTA_TIMEOUT_MS = 5000;

/** %-through a window, given the render instant and the window's reset instant. */
export type ThroughFn = (nowMs: number, resetAtMs: number) => number;

/**
 * One piece of the rendered segment.
 *
 * `dropOrder` is the width-ladder priority: 0 is never dropped, and when the
 * segment overflows the highest order goes first. The orders are what the
 * pre-refactor per-provider ladders did — z.ai drops its monthly MCP cap, then
 * the plan tier, and never a token window; Go drops its monthly window, then
 * its weekly one. `tests/footer-quota-characterisation.test.ts` pins both.
 */
export type QuotaPart =
	| { kind: "prefix"; color: string; text: string; dropOrder: 0 }
	| {
			kind: "window";
			label: string;
			usedPct: number;
			resetAtMs?: number;
			throughOf?: ThroughFn;
			dropOrder: number;
	  }
	| { kind: "tier"; text: string; dropOrder: number };

export interface QuotaSnapshot {
	/** The provider whose numbers these are; a stale one never renders. */
	provider: string;
	/** Display order. */
	parts: QuotaPart[];
	/**
	 * What the segment returns when even its first part exceeds the width
	 * budget: "clip" returns that part whole (the footer line-clips it),
	 * "truncate" ellipsises it. Each provider keeps its pre-refactor behaviour.
	 */
	overflow: "clip" | "truncate";
}

/** Render-time reference instants. */
export interface QuotaTime {
	/** Drives the z.ai peak/off-peak prefix. */
	now?: Date;
	/** Drives reset durations and %-through. Defaults to `now`. */
	resetNow?: Date;
}

export type QuotaWarn = (detail: string) => void;

export interface QuotaDescriptor {
	/** pi model provider id — what `ctx.model.provider` reports. */
	provider: string;
	endpoint: string;
	/** Authorization header value: z.ai takes the bare key, the rest Bearer. */
	auth: (key: string) => string;
	/** Endpoint payload → segment parts, or undefined when it carries no quota. */
	parse: (json: unknown, ctx: { now: number; warn: QuotaWarn }) => QuotaPart[] | undefined;
	/** The one renderer. Every descriptor points at it; see `renderQuotaSnapshot`. */
	render: typeof renderQuotaSnapshot;
	/** The segment's overflow policy when even its first part exceeds the width. */
	overflow: QuotaSnapshot["overflow"];
	/** Render-time leading part (z.ai's peak/off-peak multiplier). */
	prefix?: (modelId: string | undefined, now: Date) => { color: string; text: string } | undefined;
	/** Mapping for callers holding the already-normalised token-window shape. */
	fromQuotaData?: (quota: QuotaData) => QuotaPart[];
}

/**
 * Attach provider identity to parsed parts. The one place a snapshot's
 * `provider` is set, so a descriptor cannot hand back another provider's
 * numbers (a MiniMax payload under `minimax-cn` included).
 */
function snapshotFor(descriptor: QuotaDescriptor, parts: QuotaPart[]): QuotaSnapshot {
	return { provider: descriptor.provider, parts, overflow: descriptor.overflow };
}

// ---------------------------------------------------------------------------
// Shared formatting
// ---------------------------------------------------------------------------

/** Percentage with the shared pressure-colour thresholds (≥85 error, ≥60 warning). */
function colorUsedPct(theme: QuotaTheme, usedPct: number): string {
	const pct = `${usedPct}%`;
	if (usedPct >= 85) return theme.fg("error", pct);
	if (usedPct >= 60) return theme.fg("warning", pct);
	return theme.fg("success", pct);
}

/**
 * Compact duration until a reset from a Unix-ms timestamp.
 * Returns "" when the timestamp is missing or already past — a past reset is
 * replaced by the next poll, never rendered as "0m".
 *   <1h → "47m",   <1d → "4.9h",   ≥1d → "6.5d"
 */
export function formatResetDuration(nextResetTime: number | undefined, nowMs: number): string {
	if (!nextResetTime) return "";
	const deltaMs = nextResetTime - nowMs;
	if (deltaMs <= 0) return "";
	const mins = deltaMs / 60000;
	if (mins < 60) return `${Math.round(mins)}m`;
	const hrs = mins / 60;
	if (hrs < 24) return `${hrs.toFixed(1)}h`;
	return `${(hrs / 24).toFixed(1)}d`;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** %-through the current 7d window (start = resetsAt − 7d). Clamped to 0..100. */
export function weeklyThroughPercent(now: number, resetsAtMs: number): number {
	const start = resetsAtMs - WEEK_MS;
	return Math.max(0, Math.min(100, ((now - start) / WEEK_MS) * 100));
}

/** %-through the current billing-month window (start = resetsAt minus one
 * calendar month). Clamped to 0..100. */
export function monthlyThroughPercent(now: number, resetsAtMs: number): number {
	const start = new Date(resetsAtMs);
	start.setMonth(start.getMonth() - 1);
	const startMs = start.getTime();
	const len = resetsAtMs - startMs;
	if (!(len > 0)) return 0;
	return Math.max(0, Math.min(100, ((now - startMs) / len) * 100));
}

function formatPart(part: QuotaPart, theme: QuotaTheme, resetNowMs: number): string {
	switch (part.kind) {
		case "prefix":
			return theme.fg(part.color, part.text);
		case "tier":
			return theme.fg("dim", `· ${part.text}`);
		case "window": {
			const bits = [`${part.label}:${colorUsedPct(theme, part.usedPct)}`];
			if (part.throughOf && part.resetAtMs !== undefined) {
				bits.push(theme.fg("dim", `thru${Math.round(part.throughOf(resetNowMs, part.resetAtMs))}%`));
			}
			const reset = formatResetDuration(part.resetAtMs, resetNowMs);
			if (reset) bits.push(theme.fg("dim", reset));
			return bits.join(" ");
		}
	}
}

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

/**
 * Render a snapshot as the footer's quota segment.
 *
 * Gated twice: the provider must have a descriptor, and the snapshot must
 * carry that same provider — so a cached z.ai snapshot can never render under
 * a model that switched to Go.
 */
export function renderQuotaSnapshot(
	snapshot: QuotaSnapshot | undefined,
	provider: string | undefined,
	modelId: string | undefined,
	width: number,
	theme: QuotaTheme,
	time?: QuotaTime,
): string {
	if (!snapshot || !provider || snapshot.provider !== provider) return "";
	const descriptor = quotaDescriptorFor(provider);
	if (!descriptor) return "";

	// No windows means nothing to say — a provider with no quota in its payload
	// renders nothing, and that includes its own prefix.
	if (snapshot.parts.length === 0) return "";

	const resetNowMs = (time?.resetNow ?? time?.now ?? new Date()).getTime();
	const prefix = descriptor.prefix?.(modelId, time?.now ?? time?.resetNow ?? new Date());
	const parts: QuotaPart[] = prefix
		? [{ kind: "prefix", ...prefix, dropOrder: 0 }, ...snapshot.parts]
		: snapshot.parts;

	const text = (live: QuotaPart[]) =>
		live.map((part) => formatPart(part, theme, resetNowMs)).join(" ");

	let live = parts;
	while (visibleWidth(text(live)) > width) {
		let dropIndex = -1;
		let dropOrder = 0;
		for (let i = 0; i < live.length; i++) {
			const order = live[i]!.dropOrder;
			if (order > 0 && order >= dropOrder) {
				dropOrder = order;
				dropIndex = i;
			}
		}
		if (dropIndex < 0) break;
		live = live.filter((_, i) => i !== dropIndex);
	}

	const segment = text(live);
	if (visibleWidth(segment) <= width) return segment;
	const first = formatPart(parts[0]!, theme, resetNowMs);
	return snapshot.overflow === "truncate"
		? truncateToWidth(first, width, theme.fg("dim", "..."))
		: first;
}

// ---------------------------------------------------------------------------
// Token-window shape (z.ai, MiniMax): unit 3 = 5h, 6 = 7d, 5 = monthly MCP cap
// ---------------------------------------------------------------------------

export interface QuotaLimitItem {
	type: string;
	unit: number;
	percentage: number;
	usage: number;
	currentValue: number;
	nextResetTime?: number;
}

export interface QuotaData {
	level: string;
	limits: QuotaLimitItem[];
}

/** Window label per payload unit. */
const QUOTA_LABELS: Record<number, string> = {
	3: "5h",
	6: "7d",
	5: "MCP",
};

/**
 * Parts for a token-window payload.
 *
 * A payload with no renderable window yields no parts at all — no `5h`/`7d`
 * and no `MCP` means nothing to say, tier included (pre-refactor behaviour,
 * pinned by the characterisation suite).
 */
function tokenWindowParts(quota: QuotaData): QuotaPart[] {
	const parts: QuotaPart[] = [];
	for (const unit of [3, 6] as const) {
		const entry = quota.limits.find((l) => l.unit === unit);
		if (!entry) continue;
		parts.push({
			kind: "window",
			label: QUOTA_LABELS[unit] ?? `u${unit}`,
			usedPct: entry.percentage,
			resetAtMs: entry.nextResetTime,
			dropOrder: 0,
		});
	}
	const mcp = quota.limits.find((l) => l.unit === 5);
	if (mcp && mcp.currentValue > 0) {
		parts.push({ kind: "window", label: "MCP", usedPct: mcp.percentage, dropOrder: 2 });
	}
	if (parts.length === 0) return [];
	const tier = quota.level.toLowerCase();
	if (tier) parts.push({ kind: "tier", text: tier, dropOrder: 1 });
	return parts;
}

/**
 * Determine the z.ai peak/off-peak quota multiplier for a model.
 * Peak hours: 14:00–18:00 Beijing time (Asia/Shanghai, UTC+8). Off-peak: 2×
 * (1× promo through 2026-09-30; hard-coded 2× until then).
 */
export function getZaiMultiplier(modelId: string | undefined, now?: Date): 3 | 2 | undefined {
	if (!modelId) return undefined;
	const lower = modelId.toLowerCase();
	if (!lower.includes("glm-5.2") && !lower.includes("glm-5-turbo")) return undefined;

	const beijing = new Date(
		(now ?? new Date()).toLocaleString("en-US", { timeZone: "Asia/Shanghai" }),
	);
	const hour = beijing.getHours();

	if (hour >= 14 && hour < 18) return 3;
	return 2;
}

function zaiPrefix(modelId: string | undefined, now: Date): { color: string; text: string } | undefined {
	const mult = getZaiMultiplier(modelId, now);
	if (mult === 3) return { color: "warning", text: "3\u00d7" };
	if (mult === 2) return { color: "dim", text: "2\u00d7" };
	return undefined;
}

interface ZaiPayload {
	code?: number;
	data?: { level?: string; limits?: QuotaLimitItem[] };
	success?: boolean;
}

interface MinimaxPayload {
	model_remains?: Array<{
		model_name?: string;
		current_interval_remaining_percent?: number;
		current_weekly_remaining_percent?: number;
		remains_time?: number;
		weekly_remains_time?: number;
		current_interval_status?: number;
	}>;
	base_resp?: { status_code?: number; status_msg?: string };
}

/**
 * One descriptor per token-window provider. z.ai and the two MiniMax hosts
 * differ only in endpoint and payload parser; the shared shape — gating,
 * ladder, tier, overflow policy — is built here once, so a third host is one
 * line in the table.
 */
function tokenWindowDescriptor(
	provider: string,
	endpoint: string,
	auth: (key: string) => string,
	parse: (json: unknown, ctx: { now: number; warn: QuotaWarn }) => QuotaPart[] | undefined,
	prefix?: QuotaDescriptor["prefix"],
): QuotaDescriptor {
	return {
		provider,
		endpoint,
		auth,
		parse,
		render: renderQuotaSnapshot,
		overflow: "clip",
		prefix,
		fromQuotaData: tokenWindowParts,
	};
}

// ---------------------------------------------------------------------------
// OpenCode Go shape: three plan windows, %-through on weekly and monthly
// ---------------------------------------------------------------------------

export type GoUsageWindow = { percent: number; resetsAtMs: number };
export type GoUsage = {
	rolling?: GoUsageWindow;
	weekly?: GoUsageWindow;
	monthly?: GoUsageWindow;
};

/** Normalize the /zen/go/v1/usage payload. Windows missing a percent or a
 * parseable resetsAt are skipped; nothing usable → undefined. */
export function normalizeGoUsage(json: unknown): GoUsage | undefined {
	const root = (json as { usage?: Record<string, unknown> })?.usage;
	if (!root || typeof root !== "object") return undefined;
	const out: GoUsage = {};
	for (const key of ["rolling", "weekly", "monthly"] as const) {
		const w = root[key] as { percent?: unknown; resetsAt?: unknown } | undefined;
		if (!w || typeof w.percent !== "number" || typeof w.resetsAt !== "string") continue;
		const ms = Date.parse(w.resetsAt);
		if (!Number.isFinite(ms)) continue;
		out[key] = { percent: Math.round(w.percent), resetsAtMs: ms };
	}
	return out.rolling || out.weekly || out.monthly ? out : undefined;
}

const GO_PROVIDER = "opencode-go";

/** Go's three windows as segments — the display spec is decisions/external-tools/006:
 *  rolling percent + time left; weekly and monthly percent + %-through + time left. */
function goParts(usage: GoUsage): QuotaPart[] {
	const parts: QuotaPart[] = [];
	if (usage.rolling) {
		parts.push({
			kind: "window",
			label: "5h",
			usedPct: usage.rolling.percent,
			resetAtMs: usage.rolling.resetsAtMs,
			dropOrder: 0,
		});
	}
	if (usage.weekly) {
		parts.push({
			kind: "window",
			label: "7d",
			usedPct: usage.weekly.percent,
			resetAtMs: usage.weekly.resetsAtMs,
			throughOf: weeklyThroughPercent,
			dropOrder: 1,
		});
	}
	if (usage.monthly) {
		parts.push({
			kind: "window",
			label: "mo",
			usedPct: usage.monthly.percent,
			resetAtMs: usage.monthly.resetsAtMs,
			throughOf: monthlyThroughPercent,
			dropOrder: 2,
		});
	}
	return parts;
}

// ---------------------------------------------------------------------------
// The descriptor table
// ---------------------------------------------------------------------------

const MINIMAX_ENDPOINTS: Record<string, string> = {
	minimax: "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
	"minimax-cn": "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains",
};

const bearer = (key: string) => `Bearer ${key}`;
const bare = (key: string) => key;

/** z.ai: quota/limit carries `data.limits`; a pay-as-you-go key carries none,
 * which renders nothing. No key-prefix heuristic — the response is the authority. */
function zaiParts(json: unknown, { warn }: { now: number; warn: QuotaWarn }): QuotaPart[] | undefined {
	const payload = json as ZaiPayload;
	if (!payload?.data?.limits || payload.success === false) {
		warn("response missing limits field");
		return undefined;
	}
	return tokenWindowParts({ level: payload.data.level ?? "unknown", limits: payload.data.limits });
}

/**
 * MiniMax: documented in platform.minimax.io/docs/token-plan/faq ("Method 2:
 * Use the API Endpoint"). Prefers the "general" (text-model) bucket and
 * normalizes remaining percentages to used. Status 1 normal / 2 exhausted /
 * 3 unlimited; only the notable states surface as the tier.
 */
function minimaxParts(json: unknown, { now, warn }: { now: number; warn: QuotaWarn }): QuotaPart[] | undefined {
	const payload = json as MinimaxPayload;
	if (payload?.base_resp?.status_code !== 0) {
		warn(`API error ${payload?.base_resp?.status_code} ${payload?.base_resp?.status_msg ?? ""}`.trim());
		return undefined;
	}
	const buckets = payload.model_remains;
	if (!buckets || buckets.length === 0) {
		warn("response has no model_remains");
		return undefined;
	}
	const bucket = buckets.find((b) => b.model_name === "general") ?? buckets[0];
	if (!bucket) return undefined;
	const fivePct = bucket.current_interval_remaining_percent;
	const weeklyPct = bucket.current_weekly_remaining_percent;
	if (typeof fivePct !== "number" || typeof weeklyPct !== "number") {
		warn("response missing percentage fields");
		return undefined;
	}
	const parts: QuotaPart[] = [
		{
			kind: "window",
			label: "5h",
			usedPct: Math.max(0, Math.min(100, 100 - fivePct)),
			resetAtMs: typeof bucket.remains_time === "number" ? now + bucket.remains_time : undefined,
			dropOrder: 0,
		},
		{
			kind: "window",
			label: "7d",
			usedPct: Math.max(0, Math.min(100, 100 - weeklyPct)),
			resetAtMs:
				typeof bucket.weekly_remains_time === "number" ? now + bucket.weekly_remains_time : undefined,
			dropOrder: 0,
		},
	];
	const tier =
		bucket.current_interval_status === 2
			? "exhausted"
			: bucket.current_interval_status === 3
				? "unlimited"
				: "";
	if (tier) parts.push({ kind: "tier", text: tier, dropOrder: 1 });
	return parts;
}

const goDescriptor: QuotaDescriptor = {
	provider: GO_PROVIDER,
	endpoint: "https://opencode.ai/zen/go/v1/usage",
	auth: bearer,
	parse: (json, { warn }) => {
		const usage = normalizeGoUsage(json);
		if (!usage) {
			warn("response missing usage windows");
			return undefined;
		}
		return goParts(usage);
	},
	render: renderQuotaSnapshot,
	overflow: "truncate",
};

export const QUOTA_DESCRIPTORS: readonly QuotaDescriptor[] = [
	tokenWindowDescriptor("zai", "https://api.z.ai/api/monitor/usage/quota/limit", bare, zaiParts, zaiPrefix),
	tokenWindowDescriptor("minimax", MINIMAX_ENDPOINTS.minimax!, bearer, minimaxParts),
	tokenWindowDescriptor("minimax-cn", MINIMAX_ENDPOINTS["minimax-cn"]!, bearer, minimaxParts),
	goDescriptor,
];

const BY_PROVIDER = new Map(QUOTA_DESCRIPTORS.map((d) => [d.provider, d]));

export function quotaDescriptorFor(provider: string | undefined): QuotaDescriptor | undefined {
	return provider ? BY_PROVIDER.get(provider) : undefined;
}

// ---------------------------------------------------------------------------
// The fetch path
// ---------------------------------------------------------------------------

/** Providers already warned this process, so a dead endpoint warns once. */
const warned = new Set<string>();

/** Clear the warn-once memory (footer dispose, tests). */
export function resetQuotaWarnings(): void {
	warned.clear();
}

function warnOnce(provider: string, detail: string): void {
	if (warned.has(provider)) return;
	warned.add(provider);
	console.warn(`[footer-session-id] ${provider} quota: ${detail}`);
}

/**
 * Fetch and parse one provider's quota. Returns undefined on any failure —
 * the caller keeps whatever it had cached, so a transient HTTP error does not
 * blank the footer. Every failure warns once per provider per process.
 */
export async function fetchQuotaSnapshot(
	descriptor: QuotaDescriptor,
	apiKey: string,
	now: number = Date.now(),
): Promise<QuotaSnapshot | undefined> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), QUOTA_TIMEOUT_MS);
	const warn: QuotaWarn = (detail) => warnOnce(descriptor.provider, detail);
	try {
		const res = await fetch(descriptor.endpoint, {
			headers: { Authorization: descriptor.auth(apiKey) },
			signal: controller.signal,
		});
		if (!res.ok) {
			warn(`fetch failed: HTTP ${res.status}`);
			return undefined;
		}
		const parts = descriptor.parse(await res.json(), { now, warn });
		return parts ? snapshotFor(descriptor, parts) : undefined;
	} catch (err: unknown) {
		warn(`fetch error: ${err instanceof Error ? err.message : String(err)}`);
		return undefined;
	} finally {
		clearTimeout(timeoutId);
	}
}

// ---------------------------------------------------------------------------
// Pre-refactor entry points
//
// Callers holding an already-normalised payload keep these signatures. Both
// delegate to `renderQuotaSnapshot`, so their bytes are the shared renderer's
// by construction; the characterisation suite pins them.
// ---------------------------------------------------------------------------

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
	return renderQuotaSnapshot(snapshotFor(descriptor, parts), modelProvider, modelId, width, theme, {
		now: now ?? new Date(),
		resetNow: new Date(),
	});
}

/** Render the OpenCode Go window shape. */
export function renderGoUsageSegment(
	usage: GoUsage | undefined,
	modelProvider: string | undefined,
	width: number,
	theme: QuotaTheme,
	now?: number,
): string {
	if (!usage || modelProvider !== GO_PROVIDER) return "";
	const at = new Date(now ?? Date.now());
	return renderQuotaSnapshot(snapshotFor(goDescriptor, goParts(usage)), modelProvider, undefined, width, theme, {
		now: at,
		resetNow: at,
	});
}
