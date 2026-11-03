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

/**
 * The snapshot the footer would hold: built by the real fetch path, so the
 * descriptor's provider tag and overflow policy are the ones under test rather
 * than values the test repeats.
 */
async function snapshotFrom(payload: unknown) {
	expect(normalizeKimiUsage(FIXTURE)).toBeDefined();
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch;
	try {
		const snapshot = await fetchQuotaSnapshot(quotaDescriptorFor("kimi-coding")!, "token-abc", NOW);
		expect(snapshot).toBeDefined();
		return snapshot!;
	} finally {
		globalThis.fetch = realFetch;
	}
}

const snapshotFromFixture = () => snapshotFrom(FIXTURE);

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

	it("does not fall back to the account-wide monthly series", () => {
		// limit_month_total is a different quantity: rendering it under the
		// coding plan's `mo:` label would read as the coding cap.
		expect(
			normalizeKimiUsage({ usages: { limit_month_total: FIXTURE.usages.limit_month_total } }),
		).toBeUndefined();
	});

	it("reads the ratios, not the rounded strings in the limits array", () => {
		// The probe response carries both for the 5h window: a used_ratio of
		// 0.1792 and detail.used "18" of limit "100". A payload where they
		// disagree resolves from the ratio.
		const divergent = {
			limits: [
				{
					window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
					detail: { limit: "100", used: "90", remaining: "10", resetTime: "2026-11-03T04:57:54Z" },
				},
			],
			usages: { limit_5h: { used_ratio: 0.5, reset_time: "2026-11-03T04:57:54Z" } },
		};
		expect(normalizeKimiUsage(divergent)?.rolling?.usedPct).toBe(50);
	});
});

// ---------------------------------------------------------------------------
// Row 8: the segment renders the quota from the fixture, and only for Kimi
// ---------------------------------------------------------------------------

describe("renderQuotaSnapshot for kimi-coding", () => {
	it("renders used percent, time to reset, and monthly pace", async () => {
		expect(renderQuotaSnapshot(await snapshotFromFixture(), "kimi-coding", "k3", 200, marked, at)).toBe(
			"5h:[success:18%] [dim:29m] mo:[success:11%] [dim:thru7%] [dim:27.8d]",
		);
	});

	it("is plain percent, %-through and duration without colour", async () => {
		expect(renderQuotaSnapshot(await snapshotFromFixture(), "kimi-coding", "k3", 200, plain, at)).toBe(
			"5h:18% 29m mo:11% thru7% 27.8d",
		);
	});

	it("renders nothing for every other provider", async () => {
		const snapshot = await snapshotFromFixture();
		for (const provider of ["zai", "minimax", "minimax-cn", "opencode-go", "openrouter", undefined]) {
			expect(renderQuotaSnapshot(snapshot, provider, "k3", 200, marked, at)).toBe("");
		}
	});

	it("renders nothing without a snapshot", () => {
		expect(renderQuotaSnapshot(undefined, "kimi-coding", "k3", 200, marked, at)).toBe("");
	});

	it("drops the monthly window first when the budget is tight", async () => {
		const snapshot = await snapshotFromFixture();
		expect(renderQuotaSnapshot(snapshot, "kimi-coding", "k3", 20, plain, at)).toBe("5h:18% 29m");
	});

	it("ellipsises the first window when even it overflows", async () => {
		// Kimi's last-resort policy is Go's (truncate), not z.ai's (clip).
		const snapshot = await snapshotFromFixture();
		expect(renderQuotaSnapshot(snapshot, "kimi-coding", "k3", 6, plain, at)).toBe(
			"5h:\u001b[0m...\u001b[0m",
		);
	});

	it("uses the shared pressure colours", async () => {
		const hot = {
			usages: {
				limit_5h: { used_ratio: 0.86, reset_time: "2026-11-03T04:57:54Z" },
				limit_month_code: { used_ratio: 0.7, reset_time: "2026-12-01T00:00:00Z" },
			},
		};
		const snapshot = await snapshotFrom(hot);
		expect(renderQuotaSnapshot(snapshot, "kimi-coding", "k3", 200, marked, at)).toBe(
			"5h:[error:86%] [dim:29m] mo:[warning:70%] [dim:thru7%] [dim:27.8d]",
		);
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
		const realWarn = console.warn;
		const warns: string[] = [];
		console.warn = (...args: unknown[]) => {
			warns.push(args.join(" "));
		};
		try {
			expect(await fetchQuotaSnapshot(quotaDescriptorFor("kimi-coding")!, "token-abc", NOW)).toBeUndefined();
			expect(renderQuotaSnapshot(undefined, "kimi-coding", "k3", 200, marked, at)).toBe("");
			expect(warns).toHaveLength(1);
			expect(warns[0]).toContain("response missing");
		} finally {
			console.warn = realWarn;
			globalThis.fetch = realFetch;
		}
	});
});
