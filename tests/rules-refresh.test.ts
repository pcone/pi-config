/**
 * Rule refresh semantics.
 *
 * Discovery is a snapshot taken at session start, but a session can outlive an
 * edit to a rule it has not injected yet — and a rule fix that only reaches the
 * next process start is a dead fix. So: a rule is re-read from disk when it is
 * injected, and the discovered set is rebuilt on compact (added/removed files
 * appear at a segment boundary). Compact must stay silent — a compact is not a
 * startup.
 *
 * Run: bun test tests/rules-refresh.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import rulesExtension from "../extensions/rules.ts";

let root = "";
let notices: string[] = [];
let startedEvents: any[] = [];
let savedHome: string | undefined;

function createStub(flags: Record<string, unknown> = {}) {
	const handlers = new Map<string, (event: any, ctx?: any) => any>();
	const commands = new Map<string, any>();
	const sent: string[] = [];
	const pi: any = {
		registerFlag: () => {},
		getFlag: (name: string) => flags[name],
		on: (name: string, fn: any) => handlers.set(name, fn),
		registerCommand: (name: string, def: any) => commands.set(name, def),
		sendUserMessage: (text: string) => sent.push(text),
		events: { emit: (name: string, payload: any) => startedEvents.push({ name, payload }) },
	};
	rulesExtension(pi);
	return { pi, handlers, commands, sent };
}

const ctx = () => ({
	cwd: root,
	hasUI: true,
	ui: { notify: (text: string) => notices.push(text), setStatus: () => {}, setWidget: () => {} },
});

function writeRule(name: string, body: string, paths = "**/*.target") {
	const dir = join(root, ".pi", "rules");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${name}.md`);
	writeFileSync(file, `---\npaths:\n  - "${paths}"\n---\n\n# ${name}\n\n${body}\n`);
	return file;
}

/** A path inside the project that the fixture rules match. */
const target = () => {
	const p = join(root, "sub", "file.target");
	mkdirSync(join(root, "sub"), { recursive: true });
	writeFileSync(p, "x");
	return p;
};

/** Run a read of `path` through the tool_result handler; return injected text. */
async function readThrough(handlers: Map<string, any>, path: string): Promise<string> {
	const res = await handlers.get("tool_result")!(
		{ toolName: "read", isError: false, input: { path }, content: [] },
		ctx(),
	);
	if (!res) return "";
	return res.content.map((c: any) => c.text ?? "").join("\n");
}

async function sessionStart(handlers: Map<string, any>) {
	await handlers.get("session_start")!({}, ctx());
}

async function compact(handlers: Map<string, any>) {
	await handlers.get("session_compact")!({}, ctx());
}

describe("manual paths", () => {
	it("/rule serves the body on disk now, not the discovery snapshot", async () => {
		writeRule("a", "OLD BODY");
		const { handlers, commands, sent } = createStub();
		await sessionStart(handlers);

		writeRule("a", "NEW BODY");
		await commands.get("rule").handler("a", ctx());

		expect(sent.join("\n")).toContain("NEW BODY");
		expect(sent.join("\n")).not.toContain("OLD BODY");
	});

	it("/rule refuses a rule whose file no longer loads, and does not consume it", async () => {
		const file = writeRule("a", "BODY");
		const { handlers, commands, sent } = createStub();
		await sessionStart(handlers);
		rmSync(file);

		await commands.get("rule").handler("a", ctx());
		expect(sent.length).toBe(0);
		expect(notices.join("; ")).toContain("no longer loads");

		// Not added to the in-scope set, so restoring the file still injects.
		writeRule("a", "RESTORED");
		expect(await readThrough(handlers, target())).toContain("RESTORED");
	});

	it("/rules reports current line counts and cap markers", async () => {
		writeRule("a", "short");
		const { handlers, commands } = createStub();
		await sessionStart(handlers);

		writeRule("a", "x\n".repeat(160));
		await commands.get("rules").handler("", ctx());

		expect(notices.join("; ")).toContain("near cap");
		// Fresh count, not the snapshot's single-line body.
		expect(notices.join("; ")).toMatch(/\d{3} lines \(near cap\)/);
	});

	it("/rules marks a rule truncated past the cap, with its true line count", async () => {
		writeRule("a", "short");
		const { handlers, commands } = createStub();
		await sessionStart(handlers);

		// Past MAX_RULE_LINES: the marker must be reachable and the count must be
		// the file's real size, not the clamp.
		writeRule("a", "x\n".repeat(260));
		await commands.get("rules").handler("", ctx());

		const out = notices.join("; ");
		const marker = out.match(/(\d+) lines \(truncated\)/);
		expect(marker).not.toBeNull();
		// The real file size, not the cap the body was truncated to (200).
		expect(Number(marker![1])).toBeGreaterThan(200);
		expect(out).not.toContain("near cap");
	});

	it("/rules marks a rule whose file no longer loads", async () => {
		const file = writeRule("a", "BODY");
		const { handlers, commands } = createStub();
		await sessionStart(handlers);
		rmSync(file);

		await commands.get("rules").handler("", ctx());
		expect(notices.join("; ")).toContain("(no longer loads)");
	});
});

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "rules-refresh-"));
	notices = [];
	startedEvents = [];
	// Point HOME at the fixture: discovery always scans the user-level rule
	// directories, and the machine's own ~/.pi/agent/rules must not appear in a
	// listing this suite counts.
	savedHome = process.env.HOME;
	process.env.HOME = join(root, "home");
	mkdirSync(process.env.HOME, { recursive: true });
});

afterEach(() => {
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	rmSync(root, { recursive: true, force: true });
});

describe("rule refresh", () => {
	it("injects the body on disk now, not the body discovered at session start", async () => {
		writeRule("a", "OLD BODY");
		const { handlers } = createStub();
		await sessionStart(handlers);

		writeRule("a", "NEW BODY");
		const text = await readThrough(handlers, target());

		expect(text).toContain("NEW BODY");
		expect(text).not.toContain("OLD BODY");
	});

	it("honours a paths change made after discovery", async () => {
		writeRule("a", "BODY", "**/*.other");
		const { handlers } = createStub();
		await sessionStart(handlers);

		writeRule("a", "BODY", "**/*.target");
		expect(await readThrough(handlers, target())).toContain("BODY");
	});

	it("does not inject a rule file deleted after discovery, and says so once", async () => {
		const file = writeRule("gone", "BODY");
		const { handlers } = createStub();
		await sessionStart(handlers);
		rmSync(file);

		const warned: string[] = [];
		const orig = console.warn;
		console.warn = (...args: any[]) => warned.push(args.join(" "));
		try {
			expect(await readThrough(handlers, target())).not.toContain("BODY");
			await readThrough(handlers, target());
		} finally {
			console.warn = orig;
		}

		expect(warned.filter((w) => w.includes("gone")).length).toBe(1);
	});

	it("re-injects only once per segment (in-scope set unchanged)", async () => {
		writeRule("a", "BODY");
		const { handlers } = createStub();
		await sessionStart(handlers);

		expect(await readThrough(handlers, target())).toContain("BODY");
		expect(await readThrough(handlers, target())).toBe("");
	});

	it("picks up a rule file added mid-session on compact, not before", async () => {
		const { handlers } = createStub();
		await sessionStart(handlers);
		writeRule("late", "LATE BODY");

		expect(await readThrough(handlers, target())).toBe("");

		await compact(handlers);
		expect(await readThrough(handlers, target())).toContain("LATE BODY");
	});

	it("drops a rule file removed mid-session at the next compact", async () => {
		const file = writeRule("zombie", "BODY");
		const { handlers, commands } = createStub();
		await sessionStart(handlers);

		notices.length = 0;
		await commands.get("rules").handler("", ctx());
		expect(notices.join("; ")).toMatch(/Rules \(1\)/);
		rmSync(file);
		await compact(handlers);
		notices.length = 0;
		await commands.get("rules").handler("", ctx());

		// A rebuild drops it; a merge would still list it (and warn on the next
		// touch as "no longer loads") — the set is rebuilt, not merged.
		const listing = notices.join("; ");
		expect(listing).toContain("No rules found");
		expect(listing).not.toContain("zombie");
	});

	it("stays silent on compact: a new warning goes to the console, not the UI", async () => {
		writeRule("a", "BODY");
		const { handlers } = createStub();
		await sessionStart(handlers);
		const afterStart = notices.length;

		// A rule that warns (no paths) appears mid-session: rediscovery warns on
		// the console, never through the UI — a compact is not a startup.
		writeFileSync(
			join(root, ".pi", "rules", "loose.md"),
			"---\ndescription: loose\n---\n\n# loose\n\nBODY\n",
		);
		const warned: string[] = [];
		const origWarn = console.warn;
		console.warn = (...args: any[]) => warned.push(args.join(" "));
		try {
			await compact(handlers);
		} finally {
			console.warn = origWarn;
		}

		expect(notices.length).toBe(afterStart);
		expect(warned.join("\n")).toContain('Rule "loose"');
	});

	it("re-injects after compact so the new segment carries the rule again", async () => {
		writeRule("a", "BODY");
		const { handlers } = createStub();
		await sessionStart(handlers);
		expect(await readThrough(handlers, target())).toContain("BODY");

		await compact(handlers);
		expect(await readThrough(handlers, target())).toContain("BODY");
	});

	it("stays silent on compact: no second startup summary", async () => {
		writeRule("a", "BODY");
		const { handlers } = createStub();
		await sessionStart(handlers);
		const afterStart = startedEvents.length;

		await compact(handlers);
		expect(startedEvents.length).toBe(afterStart);
	});
});

describe("--rule explicit path (single file)", () => {
	it("does not throw in session_start when the rule warns, and reports the warning", async () => {
		const file = join(root, "loose.md");
		// No paths and not manual-only → loadRule pushes a warning. Before the
		// fix this path called loadRule() with no warnings array and threw
		// during discovery, i.e. at session start.
		writeFileSync(file, "---\ndescription: loose\n---\n\n# loose\n\nBODY\n");

		const { handlers } = createStub({ "no-rules": true, rule: file });
		await sessionStart(handlers);

		expect(notices.join("; ")).toContain("never triggers");
		const summary = startedEvents.find((e) => e.payload?.key === "rules");
		expect(summary?.payload.text).toContain("loose");
	});
});
