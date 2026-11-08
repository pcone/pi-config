/**
 * WO-2026-094 — a record append lands where it gets committed, or fails loudly.
 *
 * The record's cwd is the tree that will be committed: the isolation worktree when the spawn has
 * one (the harness commits it, then removes it), else the spawner's repo root (whose own commit
 * carries the entry). A record written anywhere else is a change nobody commits — the WO-477/424
 * stray append lost ~44 and ~10 entry headings that way — so the close handler checks, after the
 * commit, that every entry this run wrote is in the tree being merged, and reports a failure that
 * names the record rather than a note.
 *
 * Every row drives the registered `subagent` tool against a temp repo holding the stand-in
 * `scripts/wo_record.py` (tests/helpers/wo-record-stub.ts), which writes into the repo that holds
 * the script — the real tool's `records_core.REPO` — and names the file it wrote. The child is a
 * stand-in `pi` that emits one text-only turn and exits, so the real close handler runs: record
 * writes, preCommitSteps, the close-time check, delivery.
 *
 * Run: bun test tests/work-record-landing.test.ts
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import subagentFactory, { _testSetLiveSessionCtx, metaPath, resolveRunningSession } from "../extensions/subagent-async/index.ts";
import { childEnv, scrubSubagentEnv } from "./helpers/subagent-env.ts";
import { STANDIN_EPILOGUE } from "./helpers/standin-epilogue.ts";
import { WO_RECORD_STUB } from "./helpers/wo-record-stub.ts";

const WO_FILE = "work-orders/WO-2026-001-demo.md";
const WO_ID = "WO-2026-001";
const RECORD_FILE = `work-orders/records/${WO_ID}.md`;
const REPORT = "Done.\n\n**deviations_from_spec:** none";

/** One text-only turn, then exit on the stdin close the harness sends a completed child. The
 *  session file is real so a resumed or recovered run would find a report there too. */
const STANDIN = `
import { appendFileSync, writeFileSync } from "node:fs";
process.stdin.setEncoding("utf8");
let prompted = false;
process.stdin.on("data", (d) => {
	for (const line of String(d).split("\\n")) {
		if (!line.trim()) continue;
		let msg;
		try { msg = JSON.parse(line); } catch { continue; }
		if (msg.type === "get_state") {
			writeFileSync("/tmp/standin-wo094-session.jsonl", JSON.stringify({
				type: "message", id: "a", parentId: null, timestamp: "2026-10-17T10:00:00.000Z",
				message: { role: "assistant", content: [{ type: "text", text: ${JSON.stringify(REPORT)} }] },
			}) + "\\n");
			process.stdout.write(JSON.stringify({
				type: "response", id: msg.id, success: true,
				data: { sessionId: "standin-wo094", sessionFile: "/tmp/standin-wo094-session.jsonl" },
			}) + "\\n");
		}
		if (msg.type === "prompt" && !prompted) {
			prompted = true;
			appendFileSync("/tmp/standin-wo094-prompt.txt", String(msg.message) + "\\n");
			setTimeout(() => {
				process.stdout.write(JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						stopReason: "stop",
						content: [{ type: "text", text: ${JSON.stringify(REPORT)} }],
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
					},
				}) + "\\n");
			}, 50);
		}
	}
});
process.stdin.on("end", () => process.exit(0));
setInterval(() => {}, 1 << 30);
`;

let fixtureRoot = "";
let argv1Before: string | undefined;
let agentDirBefore: string | undefined;
let restoreSubagentEnv: () => void = () => {};
const repos: string[] = [];
const spawned: string[] = [];

beforeAll(() => {
	restoreSubagentEnv = scrubSubagentEnv();
	fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wo-landing-"));
	const fakePi = path.join(fixtureRoot, "stand-in-pi.mjs");
	fs.writeFileSync(fakePi, STANDIN + STANDIN_EPILOGUE);
	argv1Before = process.argv[1];
	process.argv[1] = fakePi;

	const agentsDir = path.join(fixtureRoot, "agent", "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	fs.writeFileSync(
		path.join(agentsDir, "worker.md"),
		"---\nname: worker\ndescription: record-landing fixture\n---\n\nDo the work.\n",
	);
	agentDirBefore = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(fixtureRoot, "agent");
});

afterAll(() => {
	restoreSubagentEnv();
	if (argv1Before !== undefined) process.argv[1] = argv1Before;
	if (agentDirBefore === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = agentDirBefore;
	fs.rmSync(fixtureRoot, { recursive: true, force: true });
	for (const f of ["/tmp/standin-wo094-session.jsonl", "/tmp/standin-wo094-prompt.txt"]) {
		try { fs.rmSync(f, { force: true }); } catch { /* best-effort */ }
	}
});

afterEach(async () => {
	for (const sid of spawned.splice(0)) {
		const rs = resolveRunningSession(sid);
		if (rs) {
			if (rs.staleTimer) clearTimeout(rs.staleTimer);
			if (rs.silenceTimer) clearTimeout(rs.silenceTimer);
			try { rs.proc?.kill("SIGKILL"); } catch { /* already gone */ }
			const deadline = Date.now() + 10_000;
			while (resolveRunningSession(sid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
		}
		for (const f of [metaPath(sid), `/tmp/pi-subagent-${sid}.log`, `/tmp/pi-subagent-${sid}.sock`]) {
			try { fs.rmSync(f, { force: true }); } catch { /* best-effort */ }
		}
	}
	for (const repo of repos.splice(0)) {
		// A tree the close handler did not reach (a failed row) is still a real worktree.
		try {
			const list = git(repo, ["worktree", "list", "--porcelain"]);
			for (const line of list.split("\n").filter((l) => l.startsWith("worktree ") && l !== `worktree ${repo}`)) {
				const tree = line.slice("worktree ".length);
				git(repo, ["worktree", "unlock", tree]);
				git(repo, ["worktree", "remove", "--force", tree]);
			}
			for (const line of git(repo, ["branch", "--list", "pi-subagent-*"]).split("\n")) {
				const branch = line.replace(/^\*?\s*/, "").trim();
				if (branch) git(repo, ["branch", "-D", branch]);
			}
		} catch { /* repo already gone */ }
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

const GIT_ENV = () => childEnv({
	GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
});

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], env: GIT_ENV() }).trim();
}

function gitQuiet(cwd: string, args: string[]): string {
	try {
		return git(cwd, args);
	} catch {
		return "";
	}
}

/** A temp repo with the WO file committed — a worktree needs a HEAD to branch from.
 *  `ignoreRecords` makes the records directory invisible to a commit, the shape in which a record
 *  cannot reach the tree that gets committed. */
function makeRepo({ script = true, ignoreRecords = false } = {}): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "wo-landing-repo-"));
	repos.push(root);
	git(root, ["init", "-q", "-b", "main"]);
	fs.mkdirSync(path.join(root, "work-orders"));
	fs.writeFileSync(path.join(root, WO_FILE), `# ${WO_ID} — demo\n\nbody\n`);
	if (ignoreRecords) fs.writeFileSync(path.join(root, ".gitignore"), "work-orders/records/\n");
	if (script) {
		fs.mkdirSync(path.join(root, "scripts"));
		fs.writeFileSync(path.join(root, "scripts/wo_record.py"), WO_RECORD_STUB);
	}
	git(root, ["add", "-A"]);
	git(root, ["commit", "-q", "-m", "base"]);
	return root;
}

function piStub() {
	const sent: string[] = [];
	const tools = new Map<string, any>();
	const pi: any = {
		events: { emit: () => {} },
		registerTool: (def: any) => tools.set(def.name, def),
		registerCommand: () => {},
		on: () => {},
		sendUserMessage: (text: string) => sent.push(text),
		ui: { setStatus: () => {}, notify: () => {}, setWidget: () => {}, clearStatus: () => {} },
	};
	return { pi, tools, sent };
}

/** Spawn through the real tool and wait for the close handler's delivery. */
async function spawnAndClose(root: string, isolate: boolean) {
	const { pi, tools, sent } = piStub();
	subagentFactory(pi);
	const ctx: any = {
		cwd: root,
		ui: { setStatus: () => {}, notify: () => {}, setWidget: () => {}, clearStatus: () => {} },
		getModel: () => undefined,
		sessionManager: { getBranch: () => [], getEntries: () => [], getSessionId: () => "session-wo-094" },
	};
	// Delivery is skipped when no live session ctx is set, and the close handler's record work is
	// what these rows read; the hook mirrors the session_start lifecycle.
	_testSetLiveSessionCtx(ctx);
	const res = await tools.get("subagent").execute("tc", {
		agent: "worker", task: "Do the work.", cwd: root, isolate, review_policy: "skip", workOrderPath: WO_FILE,
	}, undefined, undefined, ctx);
	const match = /session: (subagent-[0-9a-f-]+)/.exec(String(res.content[0].text));
	if (!match) throw new Error(`spawn returned no session id:\n${res.content[0].text}`);
	const sid = match[1];
	spawned.push(sid);

	const deadline = Date.now() + 30_000;
	while (sent.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
	expect(sent.length).toBeGreaterThan(0);
	const meta = JSON.parse(fs.readFileSync(metaPath(sid), "utf-8"));
	return { sid, sent: sent.join("\n"), spawnText: String(res.content[0].text), meta, tools, ctx };
}

/** The record file's content at a branch tip, or "" when the branch does not carry it. */
function committedRecord(root: string, branch: string): string {
	return gitQuiet(root, ["show", `${branch}:${RECORD_FILE}`]);
}

describe("R1 — an isolated spawn's record is in the branch's committed tree", () => {
	it("writes the dispatch and the completion into the worktree, which the harness commits", async () => {
		const root = makeRepo();
		const { sid, sent, meta } = await spawnAndClose(root, true);

		expect(meta.worktreePath).toBeTruthy();
		expect(meta.workRecord).toEqual({ cwd: meta.worktreePath, woId: WO_ID });

		const onBranch = committedRecord(root, meta.isolationBranch);
		expect(onBranch).toContain("## dispatch");
		expect(onBranch).toContain(`implementer: ${sid}`);
		expect(onBranch).toContain("## completion");
		// The parent checkout never saw it: the append went to the tree that commits.
		expect(fs.existsSync(path.join(root, RECORD_FILE))).toBe(false);
		expect(sent).not.toContain("RECORD FAILURE");
	}, 120_000);
});

describe("R2 — a non-isolated spawn's record lands in the parent cwd", () => {
	it("writes it there, as a change the parent's own commit carries", async () => {
		const root = makeRepo();
		const { sid, sent, meta } = await spawnAndClose(root, false);

		expect(meta.worktreePath).toBeNull();
		expect(meta.workRecord).toEqual({ cwd: root, woId: WO_ID });
		const record = fs.readFileSync(path.join(root, RECORD_FILE), "utf-8");
		expect(record).toContain("## dispatch");
		expect(record).toContain(`implementer: ${sid}`);
		expect(record).toContain("## completion");
		// Tracked by the parent's repo as a pending change — the tree that gets committed.
		expect(git(root, ["status", "--porcelain", "-uall"])).toContain(`?? ${RECORD_FILE}`);
		expect(sent).not.toContain("RECORD FAILURE");
	}, 120_000);
});

describe("R3 — a record the commit does not carry is caught", () => {
	it("fails the close-time check and names the record and its state", async () => {
		// The observed bug's class: the append lands where the commit never reaches — the WO-477/424
		// stray append — and removing the worktree then destroys it. `git diff --quiet HEAD`
		// answers 0 for a path no commit holds, so this read as committed and nothing was reported.
		const root = makeRepo({ ignoreRecords: true });
		const { sent, meta } = await spawnAndClose(root, true);

		expect(meta.worktreePath).toBeTruthy();
		expect(sent).toContain("RECORD FAILURE");
		expect(sent).toContain(`${path.join(meta.worktreePath, RECORD_FILE)} is not committed in ${meta.worktreePath}`);
		// The parent's copy is not the stray one here: the record was written into the tree that
		// commits, and that tree's commit still does not carry it.
		expect(fs.existsSync(path.join(root, RECORD_FILE))).toBe(false);
		expect(committedRecord(root, meta.isolationBranch)).toBe("");
	}, 120_000);
});

describe("R4 — an entry missing at close fails the same way", () => {
	it("catches an append that no-ops, naming the entry and reporting it on the status surface", async () => {
		const root = makeRepo();
		// The tool's own no-op: it reports the entry as already recorded and writes nothing.
		fs.writeFileSync(path.join(root, "noop-on"), "completion");
		const { sid, sent, tools, ctx } = await spawnAndClose(root, true);

		expect(sent).toContain("RECORD FAILURE");
		expect(sent).toContain("missing completion(implementer=");
		// The close-time check can only run after the session left the running map, so the failure
		// is carried by the meta and a later status query reads it there (WO-2026-094 M3).
		const status = await tools.get("subagent_status").execute("ts", { session_id: sid }, undefined, undefined, ctx);
		expect(String(status.content[0].text)).toContain("RECORD FAILURE: record");
		expect(String(status.content[0].text)).toContain("missing completion(implementer=");
	}, 120_000);
});

describe("R4b — a record the harness cannot read is a failure, not a crash", () => {
	it("delivers the result with the failure named, after the work is committed", async () => {
		const root = makeRepo();
		// A summary whose entry list is not an entry list: the shape must fail, and it must fail
		// inside the close handler rather than throwing out of it.
		fs.writeFileSync(path.join(root, "summary-shape"), "entries-not-array");
		const { sent } = await spawnAndClose(root, true);

		expect(sent).toContain("RECORD FAILURE");
		expect(sent).toContain("not read, nothing written: summary carries no entries array");
		expect(sent).toContain("not readable in");
	}, 120_000);
});

describe("R6 — a dispatch append that failed survives the close", () => {
	it("is delivered with the result and stays on the status surface", async () => {
		const root = makeRepo();
		// The stub refuses the dispatch write, so this run has no record to complete: the spawn's
		// own result text is the only other place the failure appeared, and it is one shot
		// (WO-2026-094 round 3 — the same "downgraded to a note" class, one leg over).
		fs.writeFileSync(path.join(root, "fail-on"), "dispatch");
		const { sid, sent, meta, tools, ctx } = await spawnAndClose(root, false);

		expect(meta.workRecord).toBeUndefined();
		expect(sent).toContain("RECORD FAILURE: work-order record not written: stub refused dispatch");
		// The session has left the running map, so the meta is the only carrier a status query has.
		const status = await tools.get("subagent_status").execute("ts", { session_id: sid }, undefined, undefined, ctx);
		expect(String(status.content[0].text))
			.toContain("RECORD FAILURE: work-order record not written: stub refused dispatch");
	}, 120_000);
});

describe("R5 — a repo without wo_record.py gets no record and no failure", () => {
	it("spawns and delivers with neither", async () => {
		const root = makeRepo({ script: false });
		const { sent, spawnText, meta } = await spawnAndClose(root, false);

		expect(meta.workRecord).toBeUndefined();
		// Neither surface reports one: the spawn result and the delivered close message.
		expect(spawnText).not.toContain("RECORD FAILURE");
		expect(sent).not.toContain("RECORD FAILURE");
		expect(sent).not.toContain("work-order record");
		expect(fs.existsSync(path.join(root, RECORD_FILE))).toBe(false);
	}, 120_000);
});
