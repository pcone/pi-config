/**
 * Kimi Code (`kimi-coding`) usage in the footer's quota slot
 * (WO-2026-065, decision external-tools/008).
 *
 * The endpoint is undocumented and was probed on 2026-11-03 with the box's
 * configured auth (OAuth subscription token; `KIMI_API_KEY` takes the same
 * `Authorization: Bearer` header):
 *
 *   GET https://api.kimi.com/coding/v1/usages
 *   → {"limits":[{"window":{"duration":300,"timeUnit":"TIME_UNIT_MINUTE"},
 *                 "detail":{"limit":"100","used":"18","remaining":"82",
 *                           "resetTime":"2026-11-03T04:57:54.427337Z"}}],
 *      "usages":{"limit_5h":{"used_ratio":0.1792,"reset_time":"2026-11-03T04:57:54Z"},
 *                "limit_month_total":{"used_ratio":0.1079,"reset_time":"2026-12-01T00:00:00Z"},
 *                "limit_month_code":{"used_ratio":0.1079,"reset_time":"2026-12-01T00:00:00Z"}}}
 *
 * The fixture below is that response verbatim. No live endpoint is contacted:
 * the render rows read the parsed snapshot, and the failure row stubs fetch.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import {
	QUOTA_DESCRIPTORS,
	fetchQuotaSnapshot,
	normalizeKimiUsage,
	quotaDescriptorFor,
	renderQuotaSnapshot,
	resetQuotaWarnings,
} from "../extensions/footer-session-id";

/** Theme stub that wraps text in markers, so colour choices are part of the golden. */
const marked = { fg: (color: string, text: string) => `[${color}:${text}]` };
/** Passthrough theme: visible width == string length. */
const plain = { fg: (_color: string, text: string) => text };

/** The probe response, verbatim. */
const FIXTURE = {
	limits: [
		{
			window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
			detail: {
				limit: "100",
				used: "18",
				remaining: "82",
				resetTime: "2026-11-03T04:57:54.427337Z",
			},
		},
	],
	usages: {
		limit_5h: { used_ratio: 0.1792, reset_time: "2026-11-03T04:57:54Z" },
		limit_month_total: { used_ratio: 0.1079, reset_time: "2026-12-01T00:00:00Z" },
		limit_month_code: { used_ratio: 0.1079, reset_time: "2026-12-01T00:00:00Z" },
	},
};

/** Render instant: 2026-11-03T04:28:45Z, the probe's clock. */
const NOW = Date.parse("2026-11-03T04:28:45Z");

function snapshotFromFixture() {
	const usage = normalizeKimiUsage(FIXTURE);
	expect(usage).toBeDefined();
	// Parse through the descriptor so the row tests the registered provider,
	// not a hand-built snapshot.
	const descriptor = quotaDescriptorFor("kimi-coding");
	expect(descriptor).toBeDefined();
	const parts = descriptor!.parse(FIXTURE, { now: NOW, warn: () => {} });
	expect(parts).toBeDefined();
	return { provider: descriptor!.provider, parts: parts!, overflow: descriptor!.overflow };
}

const at = { now: new Date(NOW), resetNow: new Date(NOW) };

// ---------------------------------------------------------------------------
// Provider registration
// ---------------------------------------------------------------------------

describe("kimi-coding descriptor", () => {
	it("is registered beside the other quota providers", () => {
		expect(QUOTA_DESCRIPTORS.map((d) => d.provider)).toEqual([
			"zai",
			"minimax",
			"minimax-cn",
			"opencode-go",
			"kimi-coding",
		]);
		expect(quotaDescriptorFor("kimi-coding")?.endpoint).toBe(
			"https://api.kimi.com/coding/v1/usages",
		);
	});

	it("sends the configured auth as a Bearer token", () => {
		expect(quotaDescriptorFor("kimi-coding")!.auth("token-abc")).toBe("Bearer token-abc");
	});
});

// ---------------------------------------------------------------------------
// normalizeKimiUsage
// ---------------------------------------------------------------------------

describe("normalizeKimiUsage", () => {
	it("reads the 5h window and the monthly coding series", () => {
		expect(normalizeKimiUsage(FIXTURE)).toEqual({
			rolling: { usedPct: 18, resetsAtMs: Date.parse("2026-11-03T04:57:54Z") },
			monthly: { usedPct: 11, resetsAtMs: Date.parse("2026-12-01T00:00:00Z") },
		});
	});

	it("keeps whichever window is present", () => {
		expect(normalizeKimiUsage({ usages: { limit_5h: FIXTURE.usages.limit_5h } })).toEqual({
			rolling: { usedPct: 18, resetsAtMs: Date.parse("2026-11-03T04:57:54Z") },
		});
		expect(
			normalizeKimiUsage({ usages: { limit_month_code: FIXTURE.usages.limit_month_code } }),
		).toEqual({ monthly: { usedPct: 11, resetsAtMs: Date.parse("2026-12-01T00:00:00Z") } });
	});

	it("skips a window with no ratio or an unparseable reset", () => {
		expect(
			normalizeKimiUsage({ usages: { limit_5h: { used_ratio: "0.1", reset_time: "2026-11-03T04:57:54Z" } } }),
		).toBeUndefined();
		expect(
			normalizeKimiUsage({ usages: { limit_5h: { used_ratio: 0.1, reset_time: "not-a-date" } } }),
		).toBeUndefined();
	});

	it("nothing usable → undefined", () => {
		expect(normalizeKimiUsage({})).toBeUndefined();
		expect(normalizeKimiUsage(null)).toBeUndefined();
		expect(normalizeKimiUsage({ usages: {} })).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Row 8: the segment renders the quota from the fixture, and only for Kimi
// ---------------------------------------------------------------------------

describe("renderQuotaSnapshot for kimi-coding", () => {
	it("renders used percent, time to reset, and monthly pace", () => {
		expect(renderQuotaSnapshot(snapshotFromFixture(), "kimi-coding", "k3", 200, marked, at)).toBe(
			"5h:[success:18%] [dim:29m] mo:[success:11%] [dim:thru7%] [dim:27.8d]",
		);
	});

	it("is plain percent, %-through and duration without colour", () => {
		expect(renderQuotaSnapshot(snapshotFromFixture(), "kimi-coding", "k3", 200, plain, at)).toBe(
			"5h:18% 29m mo:11% thru7% 27.8d",
		);
	});

	it("renders nothing for every other provider", () => {
		const snapshot = snapshotFromFixture();
		for (const provider of ["zai", "minimax", "minimax-cn", "opencode-go", "openrouter", undefined]) {
			expect(renderQuotaSnapshot(snapshot, provider, "k3", 200, marked, at)).toBe("");
		}
	});

	it("renders nothing without a snapshot", () => {
		expect(renderQuotaSnapshot(undefined, "kimi-coding", "k3", 200, marked, at)).toBe("");
	});

	it("drops the monthly window first when the budget is tight", () => {
		const snapshot = snapshotFromFixture();
		expect(renderQuotaSnapshot(snapshot, "kimi-coding", "k3", 20, plain, at)).toBe("5h:18% 29m");
	});
});

// ---------------------------------------------------------------------------
// Row 9: a failed fetch warns once and renders nothing
// ---------------------------------------------------------------------------

describe("a failed Kimi fetch", () => {
	const realFetch = globalThis.fetch;
	beforeEach(() => {
		resetQuotaWarnings();
		globalThis.fetch = realFetch;
	});

	it("warns once across two failures and yields no snapshot", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			return new Response("nope", { status: 403 });
		}) as unknown as typeof fetch;
		const warns: string[] = [];
		const realWarn = console.warn;
		console.warn = (...args: unknown[]) => {
			warns.push(args.join(" "));
		};
		try {
			const descriptor = quotaDescriptorFor("kimi-coding")!;
			expect(await fetchQuotaSnapshot(descriptor, "token-abc", NOW)).toBeUndefined();
			expect(await fetchQuotaSnapshot(descriptor, "token-abc", NOW)).toBeUndefined();
			expect(calls).toBe(2);
			expect(warns).toHaveLength(1);
			expect(warns[0]).toContain("kimi-coding quota: fetch failed: HTTP 403");
		} finally {
			console.warn = realWarn;
			globalThis.fetch = realFetch;
		}
	});

	it("parses the fixture through the real fetch path", async () => {
		let authorization: string | undefined;
		globalThis.fetch = (async (_url: string, init?: RequestInit) => {
			authorization = (init?.headers as Record<string, string>)?.Authorization;
			return new Response(JSON.stringify(FIXTURE), { status: 200 });
		}) as unknown as typeof fetch;
		try {
			const snapshot = await fetchQuotaSnapshot(quotaDescriptorFor("kimi-coding")!, "token-abc", NOW);
			expect(authorization).toBe("Bearer token-abc");
			expect(snapshot?.provider).toBe("kimi-coding");
			expect(renderQuotaSnapshot(snapshot, "kimi-coding", "k3", 200, plain, at)).toBe(
				"5h:18% 29m mo:11% thru7% 27.8d",
			);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	it("renders nothing when the payload carries no quota", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
		try {
			expect(await fetchQuotaSnapshot(quotaDescriptorFor("kimi-coding")!, "token-abc", NOW)).toBeUndefined();
			expect(renderQuotaSnapshot(undefined, "kimi-coding", "k3", 200, marked, at)).toBe("");
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});
