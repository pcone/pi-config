/**
 * The run's final text (WO-2026-102).
 *
 * `getFinalOutput` is one function behind four readers: the work-order record gate
 * (`spawn.ts`), a reviewer's recorded output (`records.ts`), the stopped text and the
 * delivered text (`sleep-guard.ts`). It returns the **last** assistant message's text
 * and nothing else. A child that ends on a tool-only message wrote no report; an
 * earlier mid-work line is not one — tfd's WO-2026-510 and WO-2026-513 were recorded
 * from a 60-character "Committing the green work first…".
 *
 * Run: bun test tests/final-output.test.ts
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	completeWorkRecord,
	getFinalOutput,
	getLastProgressText,
	openRecordContext,
	readSessionExchange,
	_testSetLiveSessionCtx,
} from "../extensions/subagent-async/index.ts";
import {
	deliverCloseResult,
	deliverResult,
	type RunningSubagent,
} from "../extensions/subagent-async/sleep-guard.ts";
import { WO_RECORD_STUB } from "./helpers/wo-record-stub.ts";

const tmpDirs: string[] = [];
const tmpFiles: string[] = [];
const WO_ID = "WO-2026-001";

afterEach(() => {
	for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
	for (const f of tmpFiles.splice(0)) fs.rmSync(f, { force: true });
});

const assistant = (content: any[]) => ({ role: "assistant", content });
const text = (t: string) => ({ type: "text", text: t });

describe("getFinalOutput — the final message, or nothing", () => {
	it("a tool-only final message yields \"\", not the earlier mid-work line", () => {
		const messages = [
			assistant([text("Committing the green work first, then I'll write the record.")]),
			assistant([{ type: "thinking" }, { type: "toolCall", name: "bash" }]),
		];
		expect(getFinalOutput(messages)).toBe("");
	});

	it("two text messages: the last one, not the first", () => {
		expect(getFinalOutput([assistant([text("first")]), assistant([text("second")])])).toBe("second");
	});

	it("joins the last message's text parts in order", () => {
		const messages = [assistant([text("one"), { type: "thinking" }, text("two")])];
		expect(getFinalOutput(messages)).toBe("one\ntwo");
	});

	it("a last message of text plus a tool call is progress, not a report", () => {
		// A child killed during a tool call ends on exactly this shape (stopReason toolUse).
		// Its text is mid-work: passing it as the report is the WO-2026-510 failure in a
		// narrower form (owner ruling 2026-11-19).
		const messages = [assistant([text("Now I'll run the suite."), { type: "toolCall", name: "bash" }])];
		expect(getFinalOutput(messages)).toBe("");
		expect(getLastProgressText(messages)).toBe("Now I'll run the suite.");
	});

	it("no assistant message at all yields \"\"", () => {
		expect(getFinalOutput([{ role: "user", content: "task" }])).toBe("");
	});

	it("strips a bare session_id trailer, as the old reader did", () => {
		expect(getFinalOutput([assistant([text("done\n[session_id:subagent-abc]")])])).toBe("done");
	});
});

describe("the record gate reads a reportless implementer as reportless", () => {
	function makeRepo(): string {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "final-output-"));
		tmpDirs.push(root);
		fs.mkdirSync(path.join(root, "work-orders", "records"), { recursive: true });
		fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
		fs.writeFileSync(path.join(root, "scripts", "wo_record.py"), WO_RECORD_STUB);
		fs.writeFileSync(
			path.join(root, "work-orders", "records", `${WO_ID}.md`),
			`---\ntitle: "${WO_ID}"\ntype: wo-record\nwork_order: work-orders/${WO_ID}-demo.md\nstatus: open\n---\n`,
		);
		fs.writeFileSync(path.join(root, "work-orders", `${WO_ID}-demo.md`), "# demo\n");
		return root;
	}

	it("a child ending on a tool-only message records the no-report note, not a missing-field failure", () => {
		const root = makeRepo();
		const messages = [
			assistant([text("Committing the green work first, then I'll write the record.")]),
			assistant([{ type: "thinking" }, { type: "toolCall", name: "bash" }]),
		];
		const { notes, failures } = completeWorkRecord(
			openRecordContext({ cwd: root, woId: WO_ID }),
			`subagent-reportless-${Math.random().toString(16).slice(2, 8)}`,
			() => getFinalOutput(messages),
		);
		expect(notes).toEqual(["work-order record: completion not written: implementer has no final report"]);
		expect(failures).toEqual([]);
	});
});

describe("the readers that take the same text stay honest", () => {
	it("a reviewer session ending tool-only yields an empty output, not an earlier line", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "final-output-session-"));
		tmpDirs.push(root);
		const file = path.join(root, "session.jsonl");
		const lines = [
			{ type: "message", message: { role: "user", content: "Review the code." } },
			{ type: "message", message: { role: "assistant", content: [text("Looking at the diff first.")] } },
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read" }] } },
		];
		fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
		expect(readSessionExchange(file)).toEqual({ task: "Review the code.", output: "" });
	});

	it("a reportless child's delivery names the earlier line as progress, never as a report", () => {
		const sent: string[] = [];
		_testSetLiveSessionCtx({ ui: { notify: () => {} }, sendUserMessage: (m: string) => sent.push(m) });
		const pi = { sendUserMessage: (m: string) => sent.push(m), appendEntry: () => {} } as any;
		try {
			const rs = {
				sessionId: "subagent-reportless",
				agentName: "implement",
				task: "Do the thing",
				messages: [
					assistant([text("Committing the green work first, then I'll write the record.")]),
					assistant([{ type: "toolCall", name: "bash" }]),
				],
				progress: { turns: 1, filesRead: new Set(), filesModified: new Set(), errors: [], toolCalls: 0 },
				stderrLines: [],
				isDone: false,
				killedExplicitly: false,
				killedVia: null,
				logPath: "/tmp/none.log",
			} as unknown as RunningSubagent;
			deliverResult(pi, rs, 0);
			expect(sent).toHaveLength(1);
			expect(sent[0]).toContain(
				"no final message; last progress: Committing the green work first, then I'll write the record.",
			);
			expect(sent[0]).not.toContain("(no output)");
		} finally {
			_testSetLiveSessionCtx(null);
		}
	});

	it("a stopped child's stop text labels the progress line the same way delivery does", () => {
		const resolved: string[] = [];
		const rs = {
			sessionId: "subagent-stopped",
			agentName: "implement",
			task: "Do the thing",
			messages: [
				assistant([text("Committing the green work first, then I'll write the record.")]),
				assistant([{ type: "toolCall", name: "bash" }]),
			],
			progress: { turns: 1, filesRead: new Set(), filesModified: new Set(), errors: [], toolCalls: 1 },
			stderrLines: [],
			isDone: false,
			killedExplicitly: false,
			killedVia: null,
			logPath: "/tmp/none.log",
			resolveOnStop: (t?: string) => resolved.push(t ?? ""),
		} as unknown as RunningSubagent;
		deliverCloseResult({ sendUserMessage: () => {} } as any, rs, 0, "");
		expect(resolved).toHaveLength(1);
		expect(resolved[0]).toBe(
			"no final message; last progress: Committing the green work first, then I'll write the record.",
		);
	});

	it("a child that produced no text at all delivers that, not a blank", () => {
		const sent: string[] = [];
		_testSetLiveSessionCtx({ ui: { notify: () => {} }, sendUserMessage: (m: string) => sent.push(m) });
		const pi = { sendUserMessage: (m: string) => sent.push(m), appendEntry: () => {} } as any;
		try {
			const rs = {
				sessionId: "subagent-silent",
				agentName: "implement",
				task: "Do the thing",
				messages: [assistant([{ type: "toolCall", name: "bash" }])],
				progress: { turns: 1, filesRead: new Set(), filesModified: new Set(), errors: [], toolCalls: 1 },
				stderrLines: [],
				isDone: false,
				killedExplicitly: false,
				killedVia: null,
				logPath: "/tmp/none.log",
			} as unknown as RunningSubagent;
			deliverResult(pi, rs, 0);
			expect(sent[0]).toContain("no final message; no progress text");
		} finally {
			_testSetLiveSessionCtx(null);
		}
	});
});
