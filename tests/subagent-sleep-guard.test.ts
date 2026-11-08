/**
 * WO-2026-095 characterisation row: decision 015's stage-2 silence kill, through
 * the `subagent` tool boundary. The section had no row at its boundary before
 * the split — the timer, its disabled state and the kill it dispatches were
 * pinned only by extensions/subagent-async/test-progress-kill-timeout.cjs, a
 * standalone mirror of the code. This drives the real `armSilenceTimer` →
 * `fireSilenceKill` → `dispatchKillSignals("progress-timeout")` chain against a
 * stand-in child that never emits activity.
 *
 * The stand-in answers `get_state` and then stays silent, so the child is alive
 * but produces no activity signal. Nothing here asserts the heartbeat's sleep
 * discount (needs a real ~10s suspension to observe); the mirror file keeps that
 * arithmetic.
 *
 * Run: bun test tests/subagent-sleep-guard.test.ts
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import subagentFactory, {
	_testRunning,
	_testSetLiveSessionCtx,
	metaPath,
	resolveRunningSession,
} from "../extensions/subagent-async/index.ts";
import { scrubSubagentEnv } from "./helpers/subagent-env.ts";
import { STANDIN_EPILOGUE } from "./helpers/standin-epilogue.ts";

type RunningSubagent = NonNullable<ReturnType<typeof resolveRunningSession>>;

/** A live child that emits no decision-015 activity: it answers get_state and
 *  holds the pipe open. */
const SILENT_STANDIN = `
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
	for (const line of String(d).split("\\n")) {
		if (!line.trim()) continue;
		let msg;
		try { msg = JSON.parse(line); } catch { continue; }
		if (msg && msg.type === "get_state") {
			process.stdout.write(JSON.stringify({
				type: "response", id: msg.id, success: true,
				data: { sessionId: "standin-silent", sessionFile: "/tmp/standin-silent.jsonl" },
			}) + "\\n");
		}
	}
});
process.stdin.on("end", () => process.exit(0));
setInterval(() => {}, 1 << 30);
`;

const PROGRESS_MARKER = "[Killed via progress-timeout — process terminated, work in this subagent is lost]";

let fixtureRoot: string;
let argv1Before: string | undefined;
let agentDirBefore: string | undefined;
let restoreSubagentEnv: () => void = () => {};

beforeAll(() => {
	restoreSubagentEnv = scrubSubagentEnv();
	fixtureRoot = mkdtempSync(join(tmpdir(), "pi-sleep-guard-"));
	const fakePi = join(fixtureRoot, "stand-in-pi.mjs");
	writeFileSync(fakePi, SILENT_STANDIN + STANDIN_EPILOGUE);
	argv1Before = process.argv[1];
	process.argv[1] = fakePi;

	const agentsDir = join(fixtureRoot, "agent", "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(
		join(agentsDir, "scout-code.md"),
		"---\nname: scout-code\ndescription: test fixture\n---\n\nReport findings.\n",
	);
	agentDirBefore = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(fixtureRoot, "agent");
});

afterAll(() => {
	restoreSubagentEnv();
	if (argv1Before !== undefined) process.argv[1] = argv1Before;
	if (agentDirBefore === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = agentDirBefore;
	rmSync(fixtureRoot, { recursive: true, force: true });
});

interface Child {
	sid: string;
	rs: RunningSubagent;
	ctx: any;
	delivered: string[];
}

const children: Child[] = [];

function createPiStub() {
	const tools = new Map<string, any>();
	const delivered: string[] = [];
	const pi: any = {
		events: { emit: () => {} },
		registerTool: (def: any) => tools.set(def.name, def),
		registerCommand: () => {},
		on: () => {},
		sendUserMessage: (text: string) => delivered.push(text),
		ui: { setStatus: () => {}, notify: () => {}, setWidget: () => {} },
	};
	return { pi, tools, delivered };
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (check()) return true;
		await new Promise((r) => setTimeout(r, 20));
	}
	return check();
}

async function spawnSilent(extra: Record<string, unknown>): Promise<Child> {
	const cwd = mkdtempSync(join(tmpdir(), "pi-sleep-guard-case-"));
	const { pi, tools, delivered } = createPiStub();
	subagentFactory(pi);
	const ctx: any = {
		cwd,
		ui: { setStatus: () => {}, notify: () => {}, setWidget: () => {}, clearStatus: () => {} },
		getModel: () => undefined,
		sessionManager: { getBranch: () => [], getEntries: () => [], getSessionId: () => "sess-sleep-guard" },
	};
	_testSetLiveSessionCtx(ctx);

	const res = await tools.get("subagent").execute(
		"tc",
		{ agent: "scout-code", task: "stay silent", cwd, isolate: false, review_policy: "skip", ...extra },
		undefined,
		undefined,
		ctx,
	);
	const match = /session: (subagent-[0-9a-f-]+)/.exec(res.content[0].text as string);
	if (!match) throw new Error(`spawn did not return a session id:\n${res.content[0].text}`);
	const sid = match[1];
	const rs = resolveRunningSession(sid);
	if (!rs) throw new Error(`no in-memory record for ${sid}`);
	const child: Child = { sid, rs, ctx, delivered };
	children.push(child);
	return child;
}

afterEach(async () => {
	_testSetLiveSessionCtx(undefined);
	for (const child of children.splice(0)) {
		const rs = resolveRunningSession(child.sid);
		if (rs) {
			if (rs.staleTimer) clearTimeout(rs.staleTimer);
			if (rs.silenceTimer) clearTimeout(rs.silenceTimer);
			try { rs.proc?.kill("SIGKILL"); } catch { /* already gone */ }
		}
		await waitFor(() => !resolveRunningSession(child.sid), 5000);
		for (const f of [metaPath(child.sid), `/tmp/pi-subagent-${child.sid}.log`, `/tmp/pi-subagent-${child.sid}.sock`]) {
			try { rmSync(f, { force: true }); } catch { /* best-effort */ }
		}
	}
	_testRunning.clear();
});

describe("decision 015 stage-2 silence kill, through the subagent tool", () => {
	it("silenceTimeoutMs: 0 disables stage 2 — a silent child survives its silence budget", async () => {
		const child = await spawnSilent({ silenceTimeoutMs: 0 });

		// Three times the budget the enabled row below uses, with no kill.
		await new Promise((r) => setTimeout(r, 600));

		expect(child.rs.killedExplicitly).toBe(false);
		expect(child.rs.silenceTimer).toBeNull();
		expect(resolveRunningSession(child.sid)).not.toBeNull();
		expect(child.delivered.join("\n")).not.toContain(PROGRESS_MARKER);
	}, 20_000);

	it("a silent child is killed through the progress-timeout dispatch, with its marker delivered", async () => {
		// The just-woke guard defers the first arm by one heartbeat interval when
		// no heartbeat has run yet in this process, so the deadline is generous;
		// the budget itself is 40ms.
		const child = await spawnSilent({ silenceTimeoutMs: 40 });

		const killed = await waitFor(() => child.rs.killedExplicitly, 15_000);
		expect(killed).toBe(true);
		expect(child.rs.killedVia).toBe("progress-timeout");

		const delivered = await waitFor(() => child.delivered.length > 0, 10_000);
		expect(delivered).toBe(true);
		expect(child.delivered.join("\n")).toContain(PROGRESS_MARKER);
	}, 30_000);
});
