/**
 * WO-2026-082: session discovery, characterized before the fold.
 *
 * Commit 1 pins v2's `discoverSessions()` as it answers today (D1–D11 of the
 * order's matrix), including D11's current answer: v2 drops a log it cannot
 * read, where the `.cjs` keeps it. Commit 2 folds both viewers onto
 * `extensions/lib/subagent-discovery.ts`, adds the shared-function rows
 * (D1–D10 at the lib boundary, D12–D16) and flips D11 to the `.cjs`
 * disposition. Every row here except D11 passes at both commits unedited.
 *
 * The viewers scan `/tmp`, so the fixtures live there under
 * `pi-subagent-test-wo082-<n>`, ages come from `utimesSync` and every row
 * selects its own id — the same technique `test-viewer.cjs` uses. No row
 * spawns a process.
 *
 * Run: bun test tests/watch-session-discovery.test.ts
 */

import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { discoverSessions } from "../extensions/subagent-async/watch-session-v2.ts";

const MINUTE = 60_000;

interface Fixture {
	id: string;
	sock: string;
	log: string;
	meta: string;
}

const created: string[] = [];

function fixture(n: number): Fixture {
	const id = `test-wo082-${n}`;
	return {
		id,
		sock: `/tmp/pi-subagent-${id}.sock`,
		log: `/tmp/pi-subagent-${id}.log`,
		meta: `/tmp/pi-subagent-${id}.meta.json`,
	};
}

function write(target: string, content: string, ageMs: number): string {
	writeFileSync(target, content);
	created.push(target);
	const stamp = (Date.now() - ageMs) / 1000;
	utimesSync(target, stamp, stamp);
	return target;
}

/** A log body with `turns` turn markers and, when given, a terminal footer. */
function logBody(turns: number, footer?: string): string {
	const lines: string[] = [];
	for (let i = 1; i <= turns; i++) lines.push(`── Turn ${i} ──`, `  turn ${i} text`);
	if (footer) lines.push(footer);
	return lines.join("\n") + "\n";
}

const sock = (f: Fixture, ageMs: number) => write(f.sock, "", ageMs);
const log = (f: Fixture, content: string, ageMs: number) => write(f.log, content, ageMs);

/** The session v2 reports for `n`, or undefined when it is not listed. */
function listed(n: number) {
	const { id } = fixture(n);
	return discoverSessions().find((s) => s.id === id);
}

afterEach(() => {
	for (const p of created.splice(0)) {
		// chmod first: a 000 log is still unlinkable, but a later row must not
		// inherit the mode if the unlink fails.
		try {
			chmodSync(p, 0o644);
		} catch {
			/* already gone */
		}
		try {
			unlinkSync(p);
		} catch {
			/* already gone */
		}
	}
});

describe("v2 session discovery (D1–D11, today's answers)", () => {
	it("D1: a socket with a fresh footered log is RUNNING, whatever the footer says", () => {
		const f = fixture(1);
		sock(f, 10_000);
		log(f, logBody(2, "── Completed (2 turns, exit 0) ──"), 10_000);

		const s = listed(1);
		expect(s).toBeDefined();
		expect(s!.status).toBe("RUNNING");
		expect(s!.turns).toBe(2);
		expect(s!.word).toBeNull();
		expect(s!.outcome).toBeNull();
	});

	it("D2: a socket keeps a stale log listed — the window applies to the log-only arm", () => {
		const f = fixture(2);
		sock(f, 90 * MINUTE);
		log(f, logBody(1, "── Completed (1 turns, exit 0) ──"), 90 * MINUTE);

		const s = listed(2);
		expect(s).toBeDefined();
		expect(s!.status).toBe("RUNNING");
	});

	it("D3: a fresh log-only session reads its footer's word and outcome", () => {
		const f = fixture(3);
		log(f, logBody(3, "── Errored (3 turns, exit 1) ──"), MINUTE);

		const s = listed(3);
		expect(s).toBeDefined();
		expect(s!.status).toBe("TERMINAL");
		expect(s!.word).toBe("Errored");
		expect(s!.outcome).toBe("errored");
		expect(s!.turns).toBe(3);
	});

	it("D4: a log-only session older than the window is not listed", () => {
		const f = fixture(4);
		log(f, logBody(1, "── Completed (1 turns, exit 0) ──"), 31 * MINUTE);

		expect(listed(4)).toBeUndefined();
	});

	it("D5: a fresh footless log is TERMINAL and names no word", () => {
		const f = fixture(5);
		log(f, "── Turn 1 ──\n  text\n", MINUTE);

		const s = listed(5);
		expect(s).toBeDefined();
		expect(s!.status).toBe("TERMINAL");
		expect(s!.word).toBeNull();
		expect(s!.outcome).toBeNull();
	});

	it("D6: an empty log is EMPTY", () => {
		const f = fixture(6);
		log(f, "", MINUTE);

		const s = listed(6);
		expect(s).toBeDefined();
		expect(s!.status).toBe("EMPTY");
		expect(s!.word).toBeNull();
		expect(s!.turns).toBe(0);
	});

	it("D7: a socket with no log is RUNNING, dated by the socket", () => {
		const f = fixture(7);
		const sockPath = sock(f, 10_000);

		const s = listed(7);
		expect(s).toBeDefined();
		expect(s!.status).toBe("RUNNING");
		expect(s!.turns).toBe(0);
		expect(s!.mtimeMs).toBe(statSync(sockPath).mtimeMs);
	});

	it("D8: a registry entry beside the session reaches SessionInfo.meta", () => {
		const f = fixture(8);
		sock(f, 10_000);
		write(
			f.meta,
			JSON.stringify({
				agentName: "implement",
				task: "Implement WO-2026-082: fold discovery\nsecond line",
				model: "some/model",
				startedAt: 1_700_000_000_000,
			}),
			10_000,
		);

		expect(listed(8)!.meta).toEqual({
			agentName: "implement",
			task: "Implement WO-2026-082: fold discovery\nsecond line",
			// The extractor's word boundary stops at the second hyphen.
			workOrderId: "WO-2026",
			subject: "Implement WO-2026-082: fold discovery",
			model: "some/model",
			startedAt: 1_700_000_000_000,
		});
	});

	it("D9: a torn registry entry leaves the session listed with no meta", () => {
		const f = fixture(9);
		sock(f, 10_000);
		write(f.meta, '{"agentName": "implement",', 10_000);

		const s = listed(9);
		expect(s).toBeDefined();
		expect(s!.meta).toBeUndefined();
	});

	it("D10: no registry entry leaves the session listed with no meta", () => {
		const f = fixture(10);
		sock(f, 10_000);

		const s = listed(10);
		expect(s).toBeDefined();
		expect(s!.meta).toBeUndefined();
	});

	it("D11: v2 drops a log it cannot read (base behaviour; commit 2 flips this)", () => {
		const f = fixture(11);
		const logPath = log(f, logBody(1, "── Completed (1 turns, exit 0) ──"), MINUTE);
		chmodSync(logPath, 0o000);

		expect(listed(11)).toBeUndefined();
	});
});
