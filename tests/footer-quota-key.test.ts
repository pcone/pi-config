/**
 * The footer's quota-row key lookup.
 *
 * One thrown `getApiKeyForProvider` used to be memoised as "this provider has no
 * key" for the rest of the process, silently — a transient registry failure
 * blanked the quota row until restart (review 2026-11-06). A throw is a missing
 * reading: warn once, do not memoise, let the 60 s cycle retry.
 *
 * Run: bun test tests/footer-quota-key.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import { quotaKey } from "../extensions/footer-session-id";
import { resetQuotaWarnings } from "../extensions/lib/quota.ts";

/** The memo is process-wide, so every row invents its own provider. */
function freshProvider(): string {
	return `t-w084-${randomUUID()}`;
}

function ctxWith(lookup: (provider: string) => Promise<string | undefined>): any {
	return { modelRegistry: { getApiKeyForProvider: lookup } };
}

describe("quota key lookup", () => {
	let warnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		resetQuotaWarnings();
		warnSpy = spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
		resetQuotaWarnings();
	});

	it("a thrown lookup is not memoised, and warns once", async () => {
		const provider = freshProvider();
		let calls = 0;
		const fc = ctxWith(async () => {
			calls++;
			throw new Error("registry offline");
		});

		expect(await quotaKey(fc, provider)).toBeUndefined();
		expect(await quotaKey(fc, provider)).toBeUndefined();

		// Not memoised as "no key": the second call reaches the registry again.
		expect(calls).toBe(2);

		const lines = warnSpy.mock.calls
			.map((c: unknown[]) => String(c[0]))
			.filter((line: string) => line.includes(provider));
		expect(lines.length).toBe(1);
		expect(lines[0]).toContain("key lookup threw");
		expect(lines[0]).toContain("registry offline");
	});

	it("a resolved key is memoised and never warns", async () => {
		const provider = freshProvider();
		let calls = 0;
		const fc = ctxWith(async () => {
			calls++;
			return "sk-live";
		});

		expect(await quotaKey(fc, provider)).toBe("sk-live");
		expect(await quotaKey(fc, provider)).toBe("sk-live");
		expect(calls).toBe(1);
		expect(warnSpy.mock.calls.length).toBe(0);
	});

	it("a provider with no key memoises that answer, silently", async () => {
		const provider = freshProvider();
		let calls = 0;
		const fc = ctxWith(async () => {
			calls++;
			return undefined;
		});

		expect(await quotaKey(fc, provider)).toBeUndefined();
		expect(await quotaKey(fc, provider)).toBeUndefined();
		expect(calls).toBe(1);
		expect(warnSpy.mock.calls.length).toBe(0);
	});
});
