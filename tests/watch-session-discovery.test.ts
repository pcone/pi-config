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
import {
	chmodSync,
	mkdtempSync,
	rmSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSessions } from "../extensions/subagent-async/watch-session-v2.ts";
import { RECENT_WINDOW_MS, discoverSessions as discoverFacts, subagentPaths } from "../extensions/lib/subagent-discovery.ts";
import { listSubagentMetas } from "../extensions/lib/subagent-state.ts";

const MINUTE = 60_000;

interface CjsSession {
	id: string;
	sockPath: string;
	logPath: string;
	status: string;
	word: string | null;
	outcome: string | null;
	mtimeMs: number;
	order: number;
}

/**
 * The `.cjs` viewer installs a process-wide `uncaughtException` handler when it
 * loads (it guards stale-socket `ECONNREFUSED`), so it is required inside the
 * rows that need it rather than at module load, where it would outlive this file
 * and swallow another test file's stray throw.
 */
function cjsViewer(): { discoverSessions: () => CjsSession[] } {
	return require("../extensions/subagent-async/watch-session.cjs");
}

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

	it("a registry entry whose task is not text leaves no meta, and does not throw", () => {
		const f = fixture(18);
		sock(f, 10_000);
		write(f.meta, JSON.stringify({ agentName: "implement", task: 42 }), 10_000);

		// The pre-fold load reached `task.split`, threw into its catch and dropped
		// the entry (base read by inspection: it had no commit-1 row); the fold's
		// mapping must answer the same way rather than crash the viewer.
		const s = listed(18);
		expect(s).toBeDefined();
		expect(s!.meta).toBeUndefined();
	});

	// 0000 is readable to root, so the row cannot build its fixture there.
	it.skipIf(process.getuid?.() === 0)("D11: a log it cannot read is kept, terminal and wordless — not dropped", () => {
		const f = fixture(11);
		const logPath = log(f, logBody(1, "── Completed (1 turns, exit 0) ──"), MINUTE);
		chmodSync(logPath, 0o000);

		// WO-2026-078 Q-A1 "Done, but labelled": the run is shown. v2 dropped
		// this session at the order's base; the fold gives it the `.cjs` answer.
		const s = listed(11);
		expect(s).toBeDefined();
		expect(s!.status).toBe("TERMINAL");
		expect(s!.word).toBeNull();
		expect(s!.outcome).toBeNull();
		expect(s!.turns).toBe(0);
	});
});

// ── The shared function's own boundary ──────────────────────────────────────

/** Fixtures for the lib rows live in their own dir, with a fixed clock. */
const NOW = 1_700_000_000_000;

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "wo082-"));
	dirs.push(dir);
	return dir;
}

/** Write `name` in `dir` aged `ageMs` before the fixed clock. */
function place(dir: string, name: string, content: string, ageMs: number): string {
	const target = join(dir, name);
	writeFileSync(target, content);
	const stamp = (NOW - ageMs) / 1000;
	utimesSync(target, stamp, stamp);
	return target;
}

/** One lib fixture by number, so a row names only the files it needs. */
function placeSession(dir: string, n: number, opts: { sock?: number; log?: [string, number] }): Fixture {
	const f = fixture(n);
	if (opts.sock !== undefined) place(dir, `pi-subagent-${f.id}.sock`, "", opts.sock);
	if (opts.log) place(dir, `pi-subagent-${f.id}.log`, opts.log[0], opts.log[1]);
	return f;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
});

describe("the shared discovery (D1–D11 at the lib boundary)", () => {
	it("D1: a socket with a fresh footered log is running, and its footer is parsed", () => {
		const dir = tempDir();
		placeSession(dir, 1, { sock: 10_000, log: [logBody(2, "── Completed (2 turns, exit 0) ──"), 10_000] });

		const found = discoverFacts({ dir, now: NOW });
		// A session with both files is one session: the log arm must not re-emit it.
		expect(found.length).toBe(1);
		const [s] = found;
		expect(s.running).toBe(true);
		expect(s.turns).toBe(2);
		expect(s.footer).toEqual({ word: "Completed", turns: 2, exitCode: 0 });
		expect(s.sockPath).toBe(join(dir, "pi-subagent-test-wo082-1.sock"));
		expect(s.logPath).toBe(join(dir, "pi-subagent-test-wo082-1.log"));
	});

	it("D2: a socket outside the window is still running", () => {
		const dir = tempDir();
		placeSession(dir, 2, { sock: 90 * MINUTE, log: [logBody(1, "── Completed (1 turns, exit 0) ──"), 90 * MINUTE] });

		const found = discoverFacts({ dir, now: NOW });
		expect(found.length).toBe(1);
		expect(found[0].running).toBe(true);
		expect(found[0].id).toBe("test-wo082-2");
	});

	it("D3: a fresh log-only session reports its footer, not a rendered word", () => {
		const dir = tempDir();
		placeSession(dir, 3, { log: [logBody(3, "── Errored (3 turns, exit 1) ──"), MINUTE] });

		const [s] = discoverFacts({ dir, now: NOW });
		expect(s.running).toBe(false);
		expect(s.turns).toBe(3);
		expect(s.footer).toEqual({ word: "Errored", turns: 3, exitCode: 1 });
	});

	it("D4: a log-only session past the window is skipped", () => {
		const dir = tempDir();
		placeSession(dir, 4, { log: [logBody(1, "── Completed (1 turns, exit 0) ──"), RECENT_WINDOW_MS + MINUTE] });

		expect(discoverFacts({ dir, now: NOW })).toEqual([]);
	});

	it("D5: a footless log keeps its content and carries no footer", () => {
		const dir = tempDir();
		const body = "── Turn 1 ──\n  text\n";
		placeSession(dir, 5, { log: [body, MINUTE] });

		const [s] = discoverFacts({ dir, now: NOW });
		expect(s.content).toBe(body);
		expect(s.footer).toBeNull();
		expect(s.turns).toBe(1);
	});

	it("D6: an empty log is the empty string, with no footer", () => {
		const dir = tempDir();
		placeSession(dir, 6, { log: ["", MINUTE] });

		const [s] = discoverFacts({ dir, now: NOW });
		expect(s.content).toBe("");
		expect(s.footer).toBeNull();
		expect(s.turns).toBe(0);
	});

	it("D7: a socket with no log is running, dated by the socket", () => {
		const dir = tempDir();
		const f = placeSession(dir, 7, { sock: 10_000 });

		const [s] = discoverFacts({ dir, now: NOW });
		expect(s.running).toBe(true);
		expect(s.content).toBeNull();
		expect(s.turns).toBe(0);
		expect(s.mtimeMs).toBe(statSync(join(dir, `pi-subagent-${f.id}.sock`)).mtimeMs);
	});

	it("D8: a parsed registry entry rides along as the raw object", () => {
		const dir = tempDir();
		const f = placeSession(dir, 8, { sock: 10_000 });
		const raw = { agentName: "implement", task: "DO the thing", model: "m", startedAt: 7 };
		place(dir, `pi-subagent-${f.id}.meta.json`, JSON.stringify(raw), 10_000);

		const [s] = discoverFacts({ dir, now: NOW });
		expect(s.meta).toEqual(raw);
	});

	it("D9: a torn registry entry leaves the session listed with no meta", () => {
		const dir = tempDir();
		const f = placeSession(dir, 9, { sock: 10_000 });
		place(dir, `pi-subagent-${f.id}.meta.json`, '{"agentName": "implement",', 10_000);

		const [s] = discoverFacts({ dir, now: NOW });
		expect(s).toBeDefined();
		expect(s.meta).toBeUndefined();
	});

	it("D10: no registry entry leaves the session listed with no meta", () => {
		const dir = tempDir();
		placeSession(dir, 10, { sock: 10_000 });

		const [s] = discoverFacts({ dir, now: NOW });
		expect(s).toBeDefined();
		expect(s.meta).toBeUndefined();
	});

	// 0000 is readable to root, so the row cannot build its fixture there.
	it.skipIf(process.getuid?.() === 0)("D11: a statable unreadable log is kept with no content, footer or turns", () => {
		const dir = tempDir();
		const f = placeSession(dir, 11, { log: [logBody(1, "── Completed (1 turns, exit 0) ──"), MINUTE] });
		chmodSync(join(dir, `pi-subagent-${f.id}.log`), 0o000);

		const [s] = discoverFacts({ dir, now: NOW });
		expect(s).toBeDefined();
		expect(s.running).toBe(false);
		expect(s.content).toBeNull();
		expect(s.footer).toBeNull();
		expect(s.turns).toBe(0);
	});

	it("a 20-minute-old log is listed and a 40-minute-old one is not", () => {
		const dir = tempDir();
		placeSession(dir, 19, { log: [logBody(1), 20 * MINUTE] });
		placeSession(dir, 25, { log: [logBody(1), 40 * MINUTE] });

		// Fixed ages, never `RECENT_WINDOW_MS` arithmetic: the window's 30 minutes
		// is the value under test, so it must not move with the constant.
		expect(discoverFacts({ dir, now: NOW }).map((s) => s.id)).toEqual(["test-wo082-19"]);
	});

	it("an unreadable dir yields no sessions and does not throw", () => {
		expect(discoverFacts({ dir: join(tempDir(), "missing"), now: NOW })).toEqual([]);
	});

	it("D13: `dir` confines the scan to that directory", () => {
		const dir = tempDir();
		const other = tempDir();
		placeSession(dir, 13, { sock: 10_000 });
		placeSession(other, 14, { sock: 10_000 });

		const ids = discoverFacts({ dir, now: NOW }).map((s) => s.id);
		expect(ids).toEqual(["test-wo082-13"]);
	});

	it("D14: `now` decides the window, not the wall clock", () => {
		const dir = tempDir();
		const f = placeSession(dir, 15, { log: [logBody(1), 31 * MINUTE] });
		const mtimeMs = statSync(join(dir, `pi-subagent-${f.id}.log`)).mtimeMs;

		expect(discoverFacts({ dir, now: NOW }).map((s) => s.id)).toEqual([]);
		expect(discoverFacts({ dir, now: mtimeMs + RECENT_WINDOW_MS }).map((s) => s.id)).toEqual(["test-wo082-15"]);
	});
});

// ── `socketsOnly` and the meta-map filter (WO-2026-086) ─────────────────────
//
// Recovery acts on sockets only, so `socketsOnly` drops the log-only arm and
// the registry scan is limited to the ids the call reports. The absence of a
// read is not observable here — the lib has no read seam — so X1 pins the
// reported list and the arm skip in the source is its evidence.
describe("discovery reads only what its caller uses (X1–X5)", () => {
	it("X1: `socketsOnly` reports sockets only — a fresh log with no sock is not listed", () => {
		const dir = tempDir();
		placeSession(dir, 30, { sock: 10_000, log: [logBody(1), 10_000] });
		placeSession(dir, 31, { log: [logBody(2, "── Completed (2 turns, exit 0) ──"), MINUTE] });

		const found = discoverFacts({ dir, now: NOW, socketsOnly: true });
		expect(found.map((s) => s.id)).toEqual(["test-wo082-30"]);
		expect(found.find((s) => s.id === "test-wo082-31")).toBeUndefined();
	});

	it("X2: `socketsOnly` keeps a socket's turns, read from its log", () => {
		const dir = tempDir();
		placeSession(dir, 32, { sock: 10_000, log: [logBody(3, "── Completed (3 turns, exit 0) ──"), 10_000] });

		// The turns are the recovery tracker's baseline: skipping the log-only arm
		// must not zero them.
		const [s] = discoverFacts({ dir, now: NOW, socketsOnly: true });
		expect(s.turns).toBe(3);
	});

	// 0000 is readable to root, so the row cannot build its fixture there.
	it.skipIf(process.getuid?.() === 0)("X3: `socketsOnly` keeps a socket whose log cannot be read, at zero turns", () => {
		const dir = tempDir();
		const f = placeSession(dir, 33, { sock: 10_000, log: [logBody(1, "── Completed (1 turns, exit 0) ──"), 10_000] });
		chmodSync(join(dir, `pi-subagent-${f.id}.log`), 0o000);

		const [s] = discoverFacts({ dir, now: NOW, socketsOnly: true });
		expect(s).toBeDefined();
		expect(s.running).toBe(true);
		expect(s.turns).toBe(0);
		expect(s.content).toBeNull();
		expect(s.footer).toBeNull();
	});

	it("X4: `listSubagentMetas` returns only the asked ids, and an unasked malformed meta cannot throw", () => {
		const dir = tempDir();
		const a = fixture(34);
		const b = fixture(35);
		const c = fixture(36);
		place(dir, `pi-subagent-${a.id}.meta.json`, JSON.stringify({ agentName: "a" }), 10_000);
		// `b`'s meta is valid and out of the set: that is what tells a filtered
		// scan from an unfiltered one, since a malformed meta is already swallowed
		// by the parse's catch either way.
		place(dir, `pi-subagent-${b.id}.meta.json`, JSON.stringify({ agentName: "b" }), 10_000);
		place(dir, `pi-subagent-${c.id}.meta.json`, '{"agentName":', 10_000);

		expect(listSubagentMetas(dir, new Set([a.id]))).toEqual([{ sid: a.id, meta: { agentName: "a" } }]);
	});

	it("X5: no options keeps the log-only arm, with its content, footer and turns", () => {
		const dir = tempDir();
		const body = logBody(2, "── Completed (2 turns, exit 0) ──");
		placeSession(dir, 37, { log: [body, MINUTE] });

		const [s] = discoverFacts({ dir, now: NOW });
		expect(s.id).toBe("test-wo082-37");
		expect(s.running).toBe(false);
		expect(s.content).toBe(body);
		expect(s.footer).toEqual({ word: "Completed", turns: 2, exitCode: 0 });
		expect(s.turns).toBe(2);
	});
});

describe("the id→path rule (D15)", () => {
	it("a bare id gains the `subagent-` prefix once, a prefixed one keeps it", () => {
		expect(subagentPaths("abc")).toEqual({
			sockPath: "/tmp/pi-subagent-subagent-abc.sock",
			logPath: "/tmp/pi-subagent-subagent-abc.log",
		});
		expect(subagentPaths("subagent-abc")).toEqual({
			sockPath: "/tmp/pi-subagent-subagent-abc.sock",
			logPath: "/tmp/pi-subagent-subagent-abc.log",
		});
	});

	it("a `/`-prefixed id is the sock path itself, its log derived by extension swap", () => {
		expect(subagentPaths("/tmp/x.sock")).toEqual({ sockPath: "/tmp/x.sock", logPath: "/tmp/x.log" });
		expect(subagentPaths("/tmp/x")).toEqual({ sockPath: "/tmp/x", logPath: "/tmp/x" });
	});

	it("`dir` replaces the tmp dir for a bare id", () => {
		expect(subagentPaths("abc", "/var/tmp")).toEqual({
			sockPath: "/var/tmp/pi-subagent-subagent-abc.sock",
			logPath: "/var/tmp/pi-subagent-subagent-abc.log",
		});
	});
});

describe("both viewers over one fixture (D12, D16)", () => {
	it("D12: the same session reaches both viewers with the same facts", () => {
		const f = fixture(12);
		log(f, logBody(3, "── Errored (3 turns, exit 1) ──"), MINUTE);

		const v2 = listed(12)!;
		const cjs = cjsViewer().discoverSessions().find((s) => s.id === "test-wo082-12")!;
		expect(cjs).toBeDefined();
		expect(cjs.id).toBe(v2.id);
		expect(cjs.mtimeMs).toBe(v2.mtimeMs);
		expect(cjs.word).toBe(v2.word);
		expect(cjs.word).toBe("Errored");
		expect(cjs.outcome).toBe(v2.outcome);
		expect(cjs.outcome).toBe("errored");
		// The vocabularies stay apart: only the views render them.
		expect(v2.status).toBe("TERMINAL");
		expect(cjs.status).toBe("ERRORED");
	});

	it("D16: both viewers list the newer session first, and the .cjs numbers the list", () => {
		const older = fixture(16);
		const newer = fixture(17);
		sock(older, 60_000);
		sock(newer, 10_000);

		const v2 = discoverSessions();
		const v2Newer = v2.findIndex((s) => s.id === newer.id);
		const v2Older = v2.findIndex((s) => s.id === older.id);
		// Presence first: `-1 < n` would hold for a session the viewer dropped.
		expect(v2Newer).toBeGreaterThanOrEqual(0);
		expect(v2Older).toBeGreaterThanOrEqual(0);
		expect(v2Newer).toBeLessThan(v2Older);

		const cjs = cjsViewer().discoverSessions();
		const newerEntry = cjs.find((s) => s.id === newer.id);
		const olderEntry = cjs.find((s) => s.id === older.id);
		expect(Boolean(newerEntry)).toBe(true);
		expect(Boolean(olderEntry)).toBe(true);
		expect(newerEntry!.order).toBeLessThan(olderEntry!.order);
		// 1-based and dense over the mtime sort.
		cjs.forEach((s, i) => expect(s.order).toBe(i + 1));
	});
});
