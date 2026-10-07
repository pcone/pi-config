/**
 * Resume pre-check: a session's *stored* cwd is what pi validates when it opens
 * the session file, and in rpc mode a missing one exits the child with code 1
 * before its first turn (interactive mode offers a choice; rpc cannot). The
 * pre-check turns that silent 0-turn death into a message naming the workaround.
 *
 * Run: bun test tests/subagent-resume-cwd.test.ts
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import subagentFactory, {
	metaPath,
	readSessionCwd,
	validateResumeMeta,
	writeMetaJson,
} from "../extensions/subagent-async/index.ts";

const dirs: string[] = [];
const filesToClean: string[] = [];
let n = 0;

function trackCleanup(handle: string): void {
	filesToClean.push(metaPath(handle));
}

function fixture(lines: string): string {
	n += 1;
	const dir = mkdtempSync(join(tmpdir(), "resume-cwd-"));
	dirs.push(dir);
	const file = join(dir, `session-${n}.jsonl`);
	writeFileSync(file, lines);
	return file;
}

afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	for (const f of filesToClean.splice(0)) {
		try {
			if (existsSync(f)) unlinkSync(f);
		} catch {
			// best-effort cleanup
		}
	}
});

const header = (cwd: unknown, extra = "") =>
	`{"type":"session","version":3,"id":"abc"${cwd === undefined ? "" : `,"cwd":${JSON.stringify(cwd)}`}}${extra}\n{"type":"model_change"}\n`;

describe("readSessionCwd", () => {
	it("reads the cwd from the session header", () => {
		expect(readSessionCwd(fixture(header("/Users/someone/project")))).toBe(
			"/Users/someone/project",
		);
	});

	it("returns null when the header has no cwd", () => {
		expect(readSessionCwd(fixture(header(undefined)))).toBeNull();
	});

	it("returns null for an empty-string cwd", () => {
		expect(readSessionCwd(fixture(header("")))).toBeNull();
	});

	it("returns null for a whitespace-only or non-string cwd", () => {
		expect(readSessionCwd(fixture(header("   ")))).toBeNull();
		expect(readSessionCwd(fixture(header(123)))).toBeNull();
	});

	it("returns null for a line 1 pi would not accept as the header", () => {
		// pi scans past lines it does not recognize and then falls back to its own
		// cwd (session-manager: parseSessionHeaderCandidate + `?? process.cwd()`),
		// so these must skip the pre-check rather than refuse on their cwd value.
		const notAHeader = (obj: unknown) => fixture(`${JSON.stringify(obj)}\n`);
		expect(readSessionCwd(notAHeader({ type: "model_change", cwd: "/gone" }))).toBeNull();
		expect(readSessionCwd(notAHeader({ type: "session", id: 123, cwd: "/gone" }))).toBeNull();
		expect(readSessionCwd(notAHeader({ id: "abc", cwd: "/gone" }))).toBeNull();
	});

	it("returns null for a missing file or malformed first line", () => {
		expect(readSessionCwd(join(tmpdir(), "does-not-exist-anywhere.jsonl"))).toBeNull();
		expect(readSessionCwd(fixture("not json at all\n"))).toBeNull();
	});

	it("reads only the header of a large transcript", () => {
		const file = fixture(header("/Users/someone/project", "\n" + "x".repeat(200_000)));
		expect(readSessionCwd(file)).toBe("/Users/someone/project");
	});
});

describe("validateResumeMeta — stored cwd", () => {
	const withSessionFile = (file: string) => ({ sessionFile: file, agentName: "implement" });

	it("refuses when the recorded cwd no longer exists, naming the workaround", () => {
		const missing = join(tmpdir(), "pi-resume-cwd-gone-12345");
		const file = fixture(header(missing));

		const result = validateResumeMeta(withSessionFile(file), "subagent-abc123abc123");
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.isError).toBe(true);
		expect(result.error).toContain(missing);
		expect(result.error).toContain("Cannot resume: the session's recorded working directory no longer exists");
		expect(result.error).toContain("recorded cwd:");
		expect(result.error).toContain("mkdir -p");
		expect(result.error).toContain("ln -s");
		expect(result.error).toContain("rpc mode has no prompt");
	});

	it("passes when the recorded cwd exists", () => {
		const dir = mkdtempSync(join(tmpdir(), "resume-cwd-live-"));
		dirs.push(dir);
		const file = fixture(header(dir));
		expect(validateResumeMeta(withSessionFile(file), "sid")).toEqual({ ok: true });
	});

	it("passes when the session file records no cwd (nothing to validate)", () => {
		expect(validateResumeMeta(withSessionFile(fixture(header(undefined))), "sid")).toEqual({
			ok: true,
		});
	});

	it("does not refuse on a header shape pi itself ignores", () => {
		const file = fixture(`${JSON.stringify({ type: "model_change", cwd: "/gone" })}\n`);
		expect(validateResumeMeta(withSessionFile(file), "sid")).toEqual({ ok: true });
	});

	it("still reports the pre-existing failures first", () => {
		const missingFile = validateResumeMeta({ sessionFile: join(tmpdir(), "nope.jsonl") }, "sid");
		expect(missingFile.ok).toBe(false);
		if (missingFile.ok) throw new Error("unreachable");
		expect(missingFile.error).toContain("no longer exists");

		const noFile = validateResumeMeta({ agentName: "implement" }, "sid");
		expect(noFile.ok).toBe(false);
		if (noFile.ok) throw new Error("unreachable");
		expect(noFile.error).toContain("Session file not captured");

		const noMeta = validateResumeMeta(null, "sid");
		expect(noMeta.ok).toBe(false);
		if (noMeta.ok) throw new Error("unreachable");
		expect(noMeta.error).toContain("No prior session found");
	});
});

// ── Tool boundary ───────────────────────────────────────────────────────────
// The refusal is the whole product of this change and it returns before any
// spawn; driving the registered tool is the only seam that proves the caller
// sees it (unit coverage of the validator cannot catch an unwired call site).

function createPiStub() {
	const tools = new Map<string, any>();
	const pi: any = {
		events: { emit: () => {} },
		registerTool: (def: any) => tools.set(def.name, def),
		registerCommand: () => {},
		on: () => {},
		sendUserMessage: () => {},
		ui: { setStatus: () => {}, notify: () => {}, setWidget: () => {} },
	};
	return { pi, tools };
}

describe("subagent_resume tool boundary", () => {
	it("refuses a missing recorded cwd before spawning, with the workaround", async () => {
		const { pi, tools } = createPiStub();
		subagentFactory(pi);
		const resume = tools.get("subagent_resume");
		expect(resume).toBeDefined();

		const sid = `subagent-${randomUUID()}`;
		const missing = join(tmpdir(), "pi-resume-cwd-gone-tool-98765");
		const sessionFile = fixture(header(missing));
		trackCleanup(sid);
		writeMetaJson(sid, { sessionFile, agentName: "implement" });

		const res = await resume.execute(
			"tc",
			{ session_id: sid, task: "continue" },
			undefined,
			undefined,
			{ cwd: dirs[0] },
		);

		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("Cannot resume");
		expect(res.content[0].text).toContain(missing);
		expect(res.content[0].text).toContain("mkdir -p");
	});

	it("reports an unknown session id through the tool", async () => {
		const { pi, tools } = createPiStub();
		subagentFactory(pi);

		const res = await tools.get("subagent_resume").execute(
			"tc",
			{ session_id: `subagent-${randomUUID()}`, task: "continue" },
			undefined,
			undefined,
			{ cwd: tmpdir() },
		);

		expect(res.content[0].text).toContain("No prior session found");
	});
});
