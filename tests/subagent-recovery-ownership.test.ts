/**
 * Tests for the session_start recovery-scan ownership gate (decision 027).
 *
 * Before 027 the recovery scan adopted EVERY `/tmp/pi-subagent-*.sock` with a
 * matching meta file — including children owned by other, still-live pi
 * processes. The adopted client connections kept the event loop referenced, so
 * `pi -p` hung until a stranger's child finished, and that child's completion
 * was delivered into the wrong session as "[Isolation] Recovered". The scan now
 * adopts only when the spawning process (recorded in meta as `ownerPid` +
 * `ownerStartToken`) is THIS process (session reload/new) or is gone.
 *
 * Coverage:
 *  1. `decideRecoveryAdoption` matrix: live foreign owner → skip; dead owner →
 *     adopt; recycled pid (token mismatch) → adopt; pid alive but token
 *     unreadable / missing / empty → skip (safe direction); same-process owner
 *     → adopt; missing owner field → skip-legacy. Plus `isOwnerAlive`'s
 *     fail-safe on a missing/invalid owner id.
 *  2. Production liveness oracle: `defaultOwnerProbe` (live self, bogus pid,
 *     EPERM→alive vs ESRCH→dead) and `processStartToken` (real token, invalid
 *     pid guards).
 *  3. `buildSpawnMeta` stamps the spawning process's identity — the input the
 *     gate reads (injected owner and default self owner).
 *  4. `recoverOrphanedSubagents` with an injected directory + fake connection:
 *     a dead-owner socket is adopted, the client socket is `unref()`ed, and the
 *     close handler delivers the recovered result; live foreign, legacy, and
 *     malformed metas are skipped without opening a connection; a dead listener
 *     is dropped and its stale sock unlinked; an already-tracked sid is not
 *     re-adopted; the connect path is asserted.
 *  5. The real `session_start` handler is driven end-to-end (real socket server
 *     in an injected temp dir) and adopts a self-owned orphan — pins the
 *     handler→scan wiring, not just the registration.
 *
 * Run: bun test tests/subagent-recovery-ownership.test.ts
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
// W1/W3 backdate a triplet and make a log unreadable. A second specifier
// rather than an addition to the line above: these rows are a pure-addition
// diff (WO-2026-083 prohibition 4), and merging would delete a line.
import { chmodSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import * as net from "node:net";
import * as path from "node:path";
import extension, {
	_testRunning,
	_testSetLiveSessionCtx,
	buildSpawnMeta,
	decideRecoveryAdoption,
	defaultOwnerProbe,
	isOwnerAlive,
	processStartToken,
	reapFinishedWorktrees,
	recoverOrphanedSubagents,
	selfStartToken,
	updateFooter,
	type OwnerProbe,
	type SpawnMetaFields,
} from "../extensions/subagent-async/index.ts";
import { _testSetReaperHome } from "../extensions/lib/checkout-reaper.ts";
import { PI_SUBAGENT_META_DIR_ENV, SUBAGENT_TMP_DIR, subagentMetaDir } from "../extensions/lib/subagent-state.ts";
import { PI_SUBAGENT_CARGO_HOME_ENV, PI_SUBAGENT_WT_ROOT_ENV } from "../extensions/lib/subagent-worktree.ts";
import { UnusableEnvPathError } from "../extensions/lib/env-path.ts";
import { setEnvForRow } from "./helpers/subagent-env.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

const SELF_PID = 999_001;
const SELF_SESSION = "session-self";

/** Probe where `exists` and `startToken` are driven by a pid → token map. */
function probeFrom(map: Map<number, string | null>): OwnerProbe {
	return {
		exists: (pid: number) => map.has(pid),
		startToken: (pid: number) => map.get(pid) ?? null,
	};
}

interface FakeSocket {
	unrefCalls: number;
	destroyed: number;
	unref(): void;
	on(event: string, cb: (...args: any[]) => void): FakeSocket;
	destroy(): void;
	write(): void;
	fire(event: string): void;
}

function makeFakeSocket(): FakeSocket {
	const handlers = new Map<string, Array<(...args: any[]) => void>>();
	const socket: FakeSocket = {
		unrefCalls: 0,
		destroyed: 0,
		unref() { socket.unrefCalls++; },
		on(event, cb) {
			const list = handlers.get(event) ?? [];
			list.push(cb);
			handlers.set(event, list);
			return socket;
		},
		destroy() { socket.destroyed++; },
		write() { /* not used by the scan */ },
		fire(event) { for (const cb of handlers.get(event) ?? []) cb(); },
	};
	return socket;
}

const tempDirs: string[] = [];

afterEach(() => {
	_testSetLiveSessionCtx(null);
	_testRunning.clear();
	// Stop the sleep-guard heartbeat/caffeinate the scan may have started via
	// updateFooter: an empty running set tears them down.
	updateFooter();
	for (const dir of tempDirs.splice(0)) {
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
	}
});

// ── Pure decision matrix ───────────────────────────────────────────────────

describe("decideRecoveryAdoption (decision 027, narrowed by ownership)", () => {
	it("skips a meta with no owner field (legacy, pre-027)", () => {
		expect(decideRecoveryAdoption({ agentName: "x" }, { selfPid: SELF_PID, selfSessionId: SELF_SESSION })).toBe("skip-legacy");
		expect(decideRecoveryAdoption(null, { selfPid: SELF_PID, selfSessionId: SELF_SESSION })).toBe("skip-legacy");
		expect(decideRecoveryAdoption({ ownerPid: 0 }, { selfPid: SELF_PID, selfSessionId: SELF_SESSION })).toBe("skip-legacy");
	});

	it("isOwnerAlive fails safe (true) for a missing owner, matching skip-legacy", () => {
		// A caller that used this predicate alone must not read "no owner" as
		// "owner dead → adopt".
		expect(isOwnerAlive({})).toBe(true);
		expect(isOwnerAlive({ ownerPid: 0 })).toBe(true);
		expect(isOwnerAlive(null)).toBe(true);
	});

	it("adopts a dead owner that is OUR session (the restart case)", () => {
		const meta = { ownerPid: 4242, ownerStartToken: "start-A", parentSessionId: SELF_SESSION };
		expect(decideRecoveryAdoption(meta, { selfPid: SELF_PID, selfSessionId: SELF_SESSION, probe: probeFrom(new Map()) })).toBe("adopt");
	});

	it("skips a dead owner from ANOTHER session — the stranger-adoption bug", () => {
		// Every pi process on the machine reads the same /tmp metas. Owner death
		// says nobody is looking after the child, not that it is ours.
		const meta = { ownerPid: 4242, ownerStartToken: "start-A", parentSessionId: "session-tfd-d" };
		expect(
			decideRecoveryAdoption(meta, { selfPid: SELF_PID, selfSessionId: SELF_SESSION, probe: probeFrom(new Map()) }),
		).toBe("skip-foreign-session");
	});

	it("skips a dead owner with no recorded parent session (unknown provenance)", () => {
		const meta = { ownerPid: 4242, ownerStartToken: "start-A" };
		expect(decideRecoveryAdoption(meta, { selfPid: SELF_PID, selfSessionId: SELF_SESSION, probe: probeFrom(new Map()) })).toBe("skip-legacy");
	});

	it("fails closed when the caller has no session id to compare", () => {
		const meta = { ownerPid: 4242, ownerStartToken: "start-A", parentSessionId: SELF_SESSION };
		expect(decideRecoveryAdoption(meta, { selfPid: SELF_PID, probe: probeFrom(new Map()) })).toBe("skip-legacy");
	});

	it("skips a live FOREIGN owner (stranger's child)", () => {
		const meta = { ownerPid: 4242, ownerStartToken: "start-A", parentSessionId: "session-tfd-d" };
		const probe = probeFrom(new Map([[4242, "start-A"]]));
		expect(decideRecoveryAdoption(meta, { selfPid: SELF_PID, selfSessionId: SELF_SESSION, probe })).toBe("skip-live-owner");
	});

	it("adopts our session's child when the pid was recycled (start token mismatch)", () => {
		const meta = { ownerPid: 4242, ownerStartToken: "start-A", parentSessionId: SELF_SESSION };
		const probe = probeFrom(new Map([[4242, "start-B"]])); // same pid, new process
		expect(decideRecoveryAdoption(meta, { selfPid: SELF_PID, selfSessionId: SELF_SESSION, probe })).toBe("adopt");
		expect(isOwnerAlive(meta, probe)).toBe(false);
	});

	it("treats an unreadable current token as alive → skip (safe direction)", () => {
		const meta = { ownerPid: 4242, ownerStartToken: "start-A", parentSessionId: "session-tfd-d" };
		const probe = probeFrom(new Map([[4242, null]])); // exists, token unknown
		expect(isOwnerAlive(meta, probe)).toBe(true);
		expect(decideRecoveryAdoption(meta, { selfPid: SELF_PID, selfSessionId: SELF_SESSION, probe })).toBe("skip-live-owner");
	});

	it("treats a missing or empty recorded token on a live pid as alive → skip", () => {
		const probe = probeFrom(new Map([[4242, "start-A"]]));
		expect(isOwnerAlive({ ownerPid: 4242 }, probe)).toBe(true);
		expect(isOwnerAlive({ ownerPid: 4242, ownerStartToken: "" }, probe)).toBe(true);
		expect(
			decideRecoveryAdoption(
				{ ownerPid: 4242, ownerStartToken: "", parentSessionId: "session-tfd-d" },
				{ selfPid: SELF_PID, selfSessionId: SELF_SESSION, probe },
			),
		).toBe("skip-live-owner");
	});

	it("adopts a same-process owner (session reload/new keeps the socket server)", () => {
		// pid === self covers a recycled pid in this process too, so ownership
		// needs no parentSessionId here.
		const meta = { ownerPid: SELF_PID, ownerStartToken: "self-token" };
		const probe = probeFrom(new Map([[SELF_PID, "self-token"]]));
		expect(decideRecoveryAdoption(meta, { selfPid: SELF_PID, selfSessionId: SELF_SESSION, probe })).toBe("adopt");
	});
});

// ── Spawn-time owner stamp ─────────────────────────────────────────────────
//
// The gate is only as good as the data it reads. If the spawn payload stops
// stamping ownerPid/ownerStartToken, every new meta becomes "legacy" and
// recovery silently stops with a green suite. Pin the writer directly.
describe("buildSpawnMeta (decision 027)", () => {
	const fields: SpawnMetaFields = {
		agentName: "scout-code",
		task: "t",
		cwd: "/x",
		startedAt: 1,
		worktreePath: null,
		isolationBranch: null,
		parentHeadCommit: null,
		parentCwd: "/x",
		tools: [],
		model: "m",
		systemPrompt: undefined,
		allowedSubagents: [],
		excludeTools: [],
	};

	it("stamps ownerPid and ownerStartToken from the injected owner", () => {
		const meta = buildSpawnMeta(fields, { pid: 4321, startToken: "tok-A", sessionId: SELF_SESSION });
		expect(meta.ownerPid).toBe(4321);
		expect(meta.ownerStartToken).toBe("tok-A");
		expect(meta.agentName).toBe("scout-code");
	});

	it("stamps the spawning SESSION, which is what adoption matches on", () => {
		const meta = buildSpawnMeta(fields, { pid: process.pid, startToken: selfStartToken(), sessionId: SELF_SESSION });
		expect(meta.parentSessionId).toBe(SELF_SESSION);
		expect(meta.ownerPid).toBe(process.pid);
		expect(meta.ownerStartToken).toBe(selfStartToken());
	});
});

// ── Production liveness probe ──────────────────────────────────────────────
//
// Every scan test injects a probe, so the real oracle (used by the real
// session_start scan) would otherwise never execute under assertion.
describe("defaultOwnerProbe / processStartToken (decision 027)", () => {
	it("sees this live process and not a bogus pid", () => {
		expect(defaultOwnerProbe.exists(process.pid)).toBe(true);
		expect(defaultOwnerProbe.exists(2_000_000_000)).toBe(false);
	});

	it("treats EPERM as alive and ESRCH as dead", () => {
		const eperm = spyOn(process, "kill").mockImplementation(() => {
			const e: any = new Error("EPERM");
			e.code = "EPERM";
			throw e;
		});
		try {
			expect(defaultOwnerProbe.exists(1234)).toBe(true);
		} finally {
			eperm.mockRestore();
		}
		const esrch = spyOn(process, "kill").mockImplementation(() => {
			const e: any = new Error("ESRCH");
			e.code = "ESRCH";
			throw e;
		});
		try {
			expect(defaultOwnerProbe.exists(1234)).toBe(false);
		} finally {
			esrch.mockRestore();
		}
	});

	it("returns a start token for this process on supported platforms", () => {
		if (process.platform === "darwin" || process.platform === "linux") {
			const token = processStartToken(process.pid);
			expect(typeof token).toBe("string");
			expect((token as string).length).toBeGreaterThan(0);
		}
	});

	it("returns null for invalid pids (guard branch)", () => {
		expect(processStartToken(-1)).toBeNull();
		expect(processStartToken(0)).toBeNull();
		expect(processStartToken(1.5)).toBeNull();
	});
});

// ── Scan integration (injected dir + fake connection) ──────────────────────

function writeTriplet(
	dir: string,
	sid: string,
	meta: Record<string, any>,
	log = "",
): void {
	const base = path.join(dir, `pi-subagent-${sid}`);
	writeFileSync(`${base}.sock`, "");
	writeFileSync(`${base}.meta.json`, JSON.stringify(meta));
	if (log) writeFileSync(`${base}.log`, log);
}

function makeCtx() {
	return {
		cwd: "/tmp",
		sessionManager: { getSessionId: () => "test-parent" },
		ui: { setStatus() {}, notify() {}, setWidget() {}, setEditorComponent() {} },
	};
}

function makePi() {
	const sent: string[] = [];
	return {
		sent,
		pi: {
			events: { emit() {} },
			registerTool() {},
			registerCommand() {},
			on() {},
			sendUserMessage(message: string) { sent.push(message); },
			ui: { setStatus() {}, notify() {}, setWidget() {}, setEditorComponent() {} },
		},
	};
}

describe("recoverOrphanedSubagents (decision 027)", () => {
	it("adopts a dead-owner orphan, unrefs the client, and delivers on close", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pi-recovery-"));
		tempDirs.push(dir);
		const sid = "subagent-dead-owner";
		writeTriplet(
			dir,
			sid,
			{
				agentName: "scout-code",
				task: "t",
				cwd: dir,
				ownerPid: 4242,
				ownerStartToken: "gone",
				parentSessionId: SELF_SESSION,
				parentSessionId: SELF_SESSION,
			},
			"── Turn 1 ──\nresult text\n── Completed (1 turns, exit 0) ──\n",
		);

		const { pi, sent } = makePi();
		_testSetLiveSessionCtx(makeCtx());
		const sockets: FakeSocket[] = [];
		const connectPaths: string[] = [];
		recoverOrphanedSubagents(pi as any, makeCtx(), {
			dir,
			selfPid: SELF_PID,
			selfSessionId: SELF_SESSION,
			probe: probeFrom(new Map()), // owner gone
			connect: (p) => {
				connectPaths.push(p);
				const s = makeFakeSocket();
				sockets.push(s);
				return s as any;
			},
		});

		expect(sockets.length).toBe(1);
		expect(connectPaths).toEqual([path.join(dir, `pi-subagent-${sid}.sock`)]);
		expect(sockets[0].unrefCalls).toBe(1);
		expect(_testRunning.has(sid)).toBe(true);

		// Simulate the recovered socket reaching a live connection then closing
		// (the orphan finished): the close path must deliver the recovered result.
		sockets[0].fire("connect");
		sockets[0].fire("close");
		expect(sent.length).toBe(1);
		expect(sent[0]).toContain("[Isolation] Recovered from previous session.");
		expect(_testRunning.has(sid)).toBe(false);
	});

	// R4 (decision 043): the recovered-session close path's reporter is already
	// gone, so it cannot refuse — the one disclosed gate exemption ("the report
	// it carries never passed a live gate"). Pin the exemption: the meta's own
	// systemPrompt declares `owner_asks`, which makes this recovered child
	// `ownerAsksRequired` (index.ts's recovered `RunningSubagent`), and its
	// report is malformed — yet the close still delivers. Wiring the gate into
	// this path would drop every recovered delivery silently, because a
	// recovered child's messages never reach this process (`messages: []` →
	// "missing `owner_asks`"). The refusing half — the same report through the
	// live close handler — is pinned in tests/subagent-owner-asks-gate.test.ts.
	it("delivers a recovered result whose report declares owner_asks (the R4 exemption for a dead reporter)", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pi-recovery-"));
		tempDirs.push(dir);
		const sid = "subagent-recovered-owner-asks";
		writeTriplet(
			dir,
			sid,
			{
				agentName: "implement",
				task: "t",
				cwd: dir,
				ownerPid: 4242,
				ownerStartToken: "gone",
				parentSessionId: SELF_SESSION,
				systemPrompt: "## Completion report\n\n**owner_asks:** none, or `<file>#<id>` row ids\n",
			},
			"── Turn 1 ──\n**status:** complete\n\n**owner_asks:** merge it already, no row\n── Completed (1 turns, exit 0) ──\n",
		);

		const { pi, sent } = makePi();
		_testSetLiveSessionCtx(makeCtx());
		const sockets: FakeSocket[] = [];
		recoverOrphanedSubagents(pi as any, makeCtx(), {
			dir,
			selfPid: SELF_PID,
			selfSessionId: SELF_SESSION,
			probe: probeFrom(new Map()), // owner gone → adopt
			connect: () => {
				const s = makeFakeSocket();
				sockets.push(s);
				return s as any;
			},
		});

		expect(sockets.length).toBe(1);
		sockets[0].fire("connect");
		sockets[0].fire("close");

		// Delivered, not refused: the recovered path cannot steer a dead reporter.
		expect(sent.length).toBe(1);
		expect(sent[0]).toContain("[Isolation] Recovered from previous session.");
		expect(sent[0]).toContain(`session: ${sid}`);
		expect(_testRunning.has(sid)).toBe(false);
	});

	it("skips a live foreign owner without opening a connection", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pi-recovery-"));
		tempDirs.push(dir);
		writeTriplet(dir, "subagent-foreign", {
			agentName: "scout-code",
			task: "t",
			ownerPid: 4242,
			ownerStartToken: "alive",
		});

		let connectCalls = 0;
		recoverOrphanedSubagents(makePi().pi as any, makeCtx(), {
			dir,
			selfPid: SELF_PID,
			selfSessionId: SELF_SESSION,
			probe: probeFrom(new Map([[4242, "alive"]])), // foreign owner alive
			connect: () => { connectCalls++; return makeFakeSocket() as any; },
		});

		expect(connectCalls).toBe(0);
		expect(_testRunning.size).toBe(0);
	});

	it("skips a legacy meta (no owner field) without opening a connection", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pi-recovery-"));
		tempDirs.push(dir);
		writeTriplet(dir, "subagent-legacy", { agentName: "scout-code", task: "t" });

		let connectCalls = 0;
		recoverOrphanedSubagents(makePi().pi as any, makeCtx(), {
			dir,
			selfPid: SELF_PID,
			selfSessionId: SELF_SESSION,
			connect: () => { connectCalls++; return makeFakeSocket() as any; },
		});

		expect(connectCalls).toBe(0);
		expect(_testRunning.size).toBe(0);
	});

	it("adopts a same-process orphan (reload path) and unrefs it", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pi-recovery-"));
		tempDirs.push(dir);
		const sid = "subagent-same-proc";
		writeTriplet(dir, sid, {
			agentName: "scout-code",
			task: "t",
			ownerPid: SELF_PID,
			ownerStartToken: "self",
		});

		const sockets: FakeSocket[] = [];
		recoverOrphanedSubagents(makePi().pi as any, makeCtx(), {
			dir,
			selfPid: SELF_PID,
			selfSessionId: SELF_SESSION,
			probe: probeFrom(new Map([[SELF_PID, "self"]])),
			connect: () => { const s = makeFakeSocket(); sockets.push(s); return s as any; },
		});

		expect(sockets.length).toBe(1);
		expect(sockets[0].unrefCalls).toBe(1);
		expect(_testRunning.has(sid)).toBe(true);
	});

	it("drops a dead-owner orphan whose listener is gone (best-effort limit)", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pi-recovery-"));
		tempDirs.push(dir);
		const sid = "subagent-dead-socket";
		writeTriplet(dir, sid, {
			agentName: "scout-code",
			task: "t",
			ownerPid: 4242,
			ownerStartToken: "gone",
			parentSessionId: SELF_SESSION,
		});

		const sockets: FakeSocket[] = [];
		recoverOrphanedSubagents(makePi().pi as any, makeCtx(), {
			dir,
			selfPid: SELF_PID,
			selfSessionId: SELF_SESSION,
			probe: probeFrom(new Map()),
			connect: () => { const s = makeFakeSocket(); sockets.push(s); return s as any; },
		});
		expect(_testRunning.has(sid)).toBe(true);

		// ECONNREFUSED: the owner died and its socket server died with it. The
		// scan classifies the owner as adoptable but cannot track a dead socket,
		// so it unlinks the stale sock file and drops the entry.
		sockets[0].fire("error");
		expect(_testRunning.has(sid)).toBe(false);
		expect(existsSync(path.join(dir, `pi-subagent-${sid}.sock`))).toBe(false);
	});

	it("skips a malformed meta file (JSON parse branch)", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pi-recovery-"));
		tempDirs.push(dir);
		const base = path.join(dir, "pi-subagent-subagent-broken");
		writeFileSync(`${base}.sock`, "");
		writeFileSync(`${base}.meta.json`, "{not json");

		let connectCalls = 0;
		recoverOrphanedSubagents(makePi().pi as any, makeCtx(), {
			dir,
			selfPid: SELF_PID,
			selfSessionId: SELF_SESSION,
			connect: () => { connectCalls++; return makeFakeSocket() as any; },
		});

		expect(connectCalls).toBe(0);
		expect(_testRunning.size).toBe(0);
	});

	it("does not re-adopt a sid already tracked in the running map", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pi-recovery-"));
		tempDirs.push(dir);
		const sid = "subagent-already-tracked";
		writeTriplet(dir, sid, { agentName: "scout-code", task: "t", ownerPid: SELF_PID, ownerStartToken: "self" });
		_testRunning.set(sid, {} as any);

		let connectCalls = 0;
		recoverOrphanedSubagents(makePi().pi as any, makeCtx(), {
			dir,
			selfPid: SELF_PID,
			selfSessionId: SELF_SESSION,
			probe: probeFrom(new Map([[SELF_PID, "self"]])),
			connect: () => { connectCalls++; return makeFakeSocket() as any; },
		});

		expect(connectCalls).toBe(0);
	});

	it("the real session_start handler runs the recovery scan (wiring)", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pi-wiring-"));
		tempDirs.push(dir);
		const sid = "subagent-wiring";
		const sockPath = path.join(dir, `pi-subagent-${sid}.sock`);
		const server = net.createServer((s) => s.unref());
		await new Promise<void>((resolve) => server.listen(sockPath, resolve));
		server.unref();
		writeFileSync(path.join(dir, `pi-subagent-${sid}.meta.json`), JSON.stringify({
			agentName: "scout-code", task: "t", cwd: dir, ownerPid: process.pid, ownerStartToken: null,
		}));
		writeFileSync(path.join(dir, `pi-subagent-${sid}.log`), "");

		const handlers = new Map<string, Function>();
		const pi: any = {
			events: { emit() {} },
			registerTool() {},
			registerCommand() {},
			on(event: string, cb: Function) { handlers.set(event, cb); },
			sendUserMessage() {},
			ui: {},
		};
		extension(pi);
		// WO-2026-099: the scan's dir is process-wide, not a per-file setter. This
		// row drives the real handler, so it is one of the few that must set it.
		const restore = setEnvForRow(PI_SUBAGENT_META_DIR_ENV, dir);
		// The same handler runs WO-2026-092's checkout reaper. Pin its home, or
		// the row walks (and may reap) the box's own `~/Developer/wt`.
		const home = mkdtempSync(path.join(tmpdir(), "pi-wiring-home-"));
		tempDirs.push(home);
		_testSetReaperHome(home);
		try {
			await handlers.get("session_start")!({ type: "session_start", reason: "reload" }, makeCtx());
			// Reaching the scan at all (and adopting the self-owned socket) proves
			// the handler is wired to recoverOrphanedSubagents — deleting that call
			// leaves only the registration assertion, which cannot catch it.
			expect(_testRunning.has(sid)).toBe(true);
		} finally {
			for (const rs of [..._testRunning.values()]) {
				for (const s of [...rs.sockClients]) { try { s.destroy(); } catch { /* best-effort */ } }
			}
			_testRunning.clear();
			_testSetReaperHome(undefined);
			restore();
			server.close();
		}
	});
});

// ── Discovery fold (WO-2026-083) ───────────────────────────────────────────
//
// `recoverOrphanedSubagents` takes its sock list, its meta and its turn count
// from `discoverSessions()`. These rows pin the ANSWERS the fold must keep, not
// the mechanism: each one passes against the pre-fold scan too, which is what
// makes a red row during the fold a behaviour change rather than a test edit.
describe("recoverOrphanedSubagents — discovery fold (WO-2026-083)", () => {
	const THREE_HOURS = (3 * 60 * 60 * 1000) / 1000;

	/** Age a whole `.sock`/`.log`/`.meta.json` triplet, in seconds since epoch. */
	function backdateTriplet(dir: string, sid: string, seconds: number): void {
		for (const ext of [".sock", ".log", ".meta.json"]) {
			utimesSync(path.join(dir, `pi-subagent-${sid}${ext}`), seconds, seconds);
		}
	}

	// W1: the lib's RECENT_WINDOW_MS is a VIEWER display rule — a log older than
	// 30 minutes is not worth a picker row. Recovery is the opposite: an orphaned
	// socket from three hours ago still needs its child tracked or its stale file
	// unlinked. The lib's sock arm already ignores the window; this row stops a
	// later "just reuse the viewer's filtered list" from quietly dropping old
	// orphans.
	it("W1: adopts a three-hour-old socket and reads its turns — the 30-minute viewer window never applies to recovery", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pi-recovery-"));
		tempDirs.push(dir);
		const sid = "subagent-old-orphan";
		writeTriplet(
			dir,
			sid,
			{
				agentName: "scout-code",
				task: "t",
				cwd: dir,
				ownerPid: 4242,
				ownerStartToken: "gone",
				parentSessionId: SELF_SESSION,
			},
			"── Turn 1 ──\nfirst\n── Turn 2 ──\nsecond\n── Completed (2 turns, exit 0) ──\n",
		);
		backdateTriplet(dir, sid, Date.now() / 1000 - THREE_HOURS);

		const sockets: FakeSocket[] = [];
		const connectPaths: string[] = [];
		recoverOrphanedSubagents(makePi().pi as any, makeCtx(), {
			dir,
			selfPid: SELF_PID,
			selfSessionId: SELF_SESSION,
			probe: probeFrom(new Map()), // owner process gone, session is ours
			connect: (p) => {
				connectPaths.push(p);
				const s = makeFakeSocket();
				sockets.push(s);
				return s as any;
			},
		});

		expect(sockets.length).toBe(1);
		expect(connectPaths).toEqual([path.join(dir, `pi-subagent-${sid}.sock`)]);
		expect(_testRunning.has(sid)).toBe(true);
		expect(_testRunning.get(sid)!.progress.turns).toBe(2);
	});

	// W2: a socket with no readable meta is unattributable. Base skipped it
	// before opening anything and left the file alone (only a failed `connect`
	// unlinks). The folded path sees `meta: undefined` and the predicate's
	// "skip-legacy" reaches the same outcome — but by a different route, so the
	// explicit skip stays and neither half may regress.
	it("W2: a socket with no meta file opens no connection and keeps the sock file", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pi-recovery-"));
		tempDirs.push(dir);
		const base = path.join(dir, "pi-subagent-subagent-no-meta");
		writeFileSync(`${base}.sock`, "");
		writeFileSync(`${base}.log`, "── Turn 1 ──\n");

		let connectCalls = 0;
		recoverOrphanedSubagents(makePi().pi as any, makeCtx(), {
			dir,
			selfPid: SELF_PID,
			selfSessionId: SELF_SESSION,
			connect: () => {
				connectCalls++;
				return makeFakeSocket() as any;
			},
		});

		expect(connectCalls).toBe(0);
		expect(_testRunning.size).toBe(0);
		expect(existsSync(`${base}.sock`)).toBe(true);
	});

	// W3: an unreadable log is a missing reading, not a missing session. Base's
	// `catch` left `turns` at 0 and adopted; the lib reports `content: null` and
	// `turns: 0` for the same file, so the fold must not dereference `content`.
	it("W3: a socket whose log cannot be read is adopted with zero turns and no throw", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pi-recovery-"));
		tempDirs.push(dir);
		const sid = "subagent-unreadable-log";
		writeTriplet(
			dir,
			sid,
			{
				agentName: "scout-code",
				task: "t",
				cwd: dir,
				ownerPid: 4242,
				ownerStartToken: "gone",
				parentSessionId: SELF_SESSION,
			},
			"── Turn 1 ──\nfirst\n── Turn 2 ──\nsecond\n",
		);
		chmodSync(path.join(dir, `pi-subagent-${sid}.log`), 0o000);

		const sockets: FakeSocket[] = [];
		expect(() =>
			recoverOrphanedSubagents(makePi().pi as any, makeCtx(), {
				dir,
				selfPid: SELF_PID,
				selfSessionId: SELF_SESSION,
				probe: probeFrom(new Map()),
				connect: () => {
					const s = makeFakeSocket();
					sockets.push(s);
					return s as any;
				},
			}),
		).not.toThrow();

		expect(sockets.length).toBe(1);
		expect(_testRunning.get(sid)!.progress.turns).toBe(0);
	});

	// W4: a session with a log and no socket is a FINISHED run, not an orphan —
	// however fresh its log is. Recovery scans sockets; the log-only arm of the
	// lib exists for the viewers' picker and must not become an adoption source.
	it("W4: a fresh log with no socket is not adopted", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pi-recovery-"));
		tempDirs.push(dir);
		const sid = "subagent-log-only";
		writeFileSync(path.join(dir, `pi-subagent-${sid}.log`), "── Turn 1 ──\nfirst\n── Completed (1 turns, exit 0) ──\n");
		writeFileSync(
			path.join(dir, `pi-subagent-${sid}.meta.json`),
			JSON.stringify({
				agentName: "scout-code",
				task: "t",
				cwd: dir,
				ownerPid: 4242,
				ownerStartToken: "gone",
				parentSessionId: SELF_SESSION,
			}),
		);

		let connectCalls = 0;
		recoverOrphanedSubagents(makePi().pi as any, makeCtx(), {
			dir,
			selfPid: SELF_PID,
			selfSessionId: SELF_SESSION,
			probe: probeFrom(new Map()), // adoptable if it were ever offered
			connect: () => {
				connectCalls++;
				return makeFakeSocket() as any;
			},
		});

		expect(connectCalls).toBe(0);
		expect(_testRunning.size).toBe(0);
	});
});

// ── The metas dir is process-wide, not a per-file hook (WO-2026-099) ────────
//
// The scan reads `/tmp` unless something says otherwise, and `/tmp` holds every
// pi process's live `pi-subagent-*` files. A per-file setter made the redirect a
// list of files that remembered. `PI_SUBAGENT_META_DIR` is set once by
// `tests/preload-subagent-roots.ts`, so a file that never thinks about it cannot
// reach the box's registry.
describe("the metas dir is process-wide (WO-2026-099)", () => {
	/** Register the extension for real and keep the handlers it captured. */
	function register(): Map<string, Function> {
		const handlers = new Map<string, Function>();
		const pi: any = {
			events: { emit() {} },
			registerTool() {},
			registerCommand() {},
			on(event: string, cb: Function) { handlers.set(event, cb); },
			sendUserMessage() {},
			ui: {},
		};
		extension(pi);
		return handlers;
	}

	it("resolves to the run's dir with no per-file setup", () => {
		const run = process.env[PI_SUBAGENT_META_DIR_ENV];
		expect(run).toBeDefined();
		expect(subagentMetaDir()).toBe(run!);
		expect(path.isAbsolute(subagentMetaDir())).toBe(true);
		// The run's temp dir, not the box's live registry.
		expect(subagentMetaDir()).not.toBe(SUBAGENT_TMP_DIR);
	});

	it("unset, it is still `/tmp` — 027's production path", () => {
		const restore = setEnvForRow(PI_SUBAGENT_META_DIR_ENV, undefined);
		try {
			expect(subagentMetaDir()).toBe("/tmp");
			expect(SUBAGENT_TMP_DIR).toBe("/tmp");
		} finally {
			restore();
		}
	});

	it("a set-but-unusable value throws, naming the variable and the value", () => {
		for (const bad of ["", "relative/meta"]) {
			const restore = setEnvForRow(PI_SUBAGENT_META_DIR_ENV, bad);
			try {
				const message = `${PI_SUBAGENT_META_DIR_ENV} must be an absolute path, got ${JSON.stringify(bad)}`;
				expect(() => subagentMetaDir()).toThrow(UnusableEnvPathError);
				expect(() => subagentMetaDir()).toThrow(message);
				// The scan refuses before its swallow-all `try`: resolution is hoisted,
				// so the rule is pinned here and the catch cannot reach it.
				expect(() => recoverOrphanedSubagents(makePi().pi as any, makeCtx(), { selfPid: SELF_PID })).toThrow(message);
			} finally {
				restore();
			}
		}
	});

	it("the real session_start handler lets the refusal through", async () => {
		const restore = setEnvForRow(PI_SUBAGENT_META_DIR_ENV, "relative/meta");
		try {
			const handlers = register();
			await expect(
				handlers.get("session_start")!({ type: "session_start", reason: "reload" }, makeCtx()),
			).rejects.toThrow(`${PI_SUBAGENT_META_DIR_ENV} must be an absolute path`);
		} finally {
			restore();
		}
	});

	it("the real session_start handler refuses a bad worktree base too", async () => {
		// The base cannot ride on `wtRoots()`: it passes an explicit home, so it
		// never reads the override, and the chain's one ambient read —
		// `disposeWorktreeBuildOutput` deriving the clone name — sits inside
		// `removeWorktreeTree`'s best-effort catch, which turns a bad root into a
		// reported prune problem. A bad override would prune nothing and say nothing
		// about it, so the handler reads the base in its own frame (decision 052).
		const restore = setEnvForRow(PI_SUBAGENT_WT_ROOT_ENV, "relative/wt");
		// Only a parent session runs the reaper block, and this process is a child.
		const restoreDepth = setEnvForRow("PI_SUBAGENT_DEPTH", undefined);
		try {
			const handlers = register();
			await expect(
				handlers.get("session_start")!({ type: "session_start", reason: "reload" }, makeCtx()),
			).rejects.toThrow(`${PI_SUBAGENT_WT_ROOT_ENV} must be an absolute path, got "relative/wt"`);
		} finally {
			restoreDepth();
			restore();
		}
	});

	it("the real session_start handler refuses a bad cargo home too", async () => {
		// The reap chain below is not awaited, so a throw from inside it is an
		// unhandled rejection rather than a failed start. The handler reads the
		// cargo home in its own frame for that reason (decision 052).
		const restore = setEnvForRow(PI_SUBAGENT_CARGO_HOME_ENV, "relative/cargo");
		// Only a parent session runs the reaper block, and this process is a child.
		const restoreDepth = setEnvForRow("PI_SUBAGENT_DEPTH", undefined);
		try {
			const handlers = register();
			await expect(
				handlers.get("session_start")!({ type: "session_start", reason: "reload" }, makeCtx()),
			).rejects.toThrow(`${PI_SUBAGENT_CARGO_HOME_ENV} must be an absolute path`);
		} finally {
			restoreDepth();
			restore();
		}
	});

	it("a reap with no `dir` reads the override — the resolved path, never `/tmp`", async () => {
		// A dir that cannot be listed: the reap's own resolution answers it, and
		// the report names the path it resolved. `selfPid: -1` with a session id no
		// meta carries means no meta is adoptable, so nothing is judged either way.
		const missing = path.join(mkdtempSync(path.join(tmpdir(), "pi-nodir-parent-")), "not-there");
		tempDirs.push(path.dirname(missing));
		const cargoHome = mkdtempSync(path.join(tmpdir(), "pi-cargo-home-"));
		tempDirs.push(cargoHome);
		const restore = setEnvForRow(PI_SUBAGENT_META_DIR_ENV, missing);
		try {
			const causes: string[] = [];
			const results = await reapFinishedWorktrees({} as any, makeCtx(), {
				selfPid: -1,
				selfSessionId: "wo-099-no-such-session",
				home: cargoHome,
				onScopeFailed: ({ error }) => { causes.push(error); },
			});
			expect(results).toEqual([]);
			expect(causes).toEqual([`unlistable metas dir ${missing}`]);
		} finally {
			restore();
		}
	});
});
