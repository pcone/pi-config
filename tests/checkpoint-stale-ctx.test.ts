/**
 * A stale extension context must not turn an archive into an extension error.
 *
 * pi reloads extensions across a session; a handler can then hold a `ctx` whose
 * `ui.notify` throws ("stale extension context"). Both notify sites that report
 * an archive outcome are therefore best-effort: the sibling path at the
 * checkpoint callback guards each notify with its own `try`/`catch`, because the
 * archive is already written and compaction is the thing the user is waiting on.
 *
 * The auto-compaction branch guarded neither: the success notify sat inside the
 * try whose catch's "Archive failed" notify was itself unguarded, so a throwing
 * `ui.notify` escaped the handler and surfaced as an extension error instead of
 * a notification (pi-config#12).
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import checkpointExtension from "../extensions/checkpoint";

const dirs: string[] = [];

function harness(notify: (message: string, level: string) => void) {
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	checkpointExtension({
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerTool: () => {},
		registerCommand: () => {},
		sendUserMessage: () => {},
	} as any);
	return handlers;
}

function ctxFor(cwd: string, notify: (message: string, level: string) => void) {
	return {
		cwd,
		getContextUsage: () => ({ tokens: 1, contextWindow: 200_000, percent: 0 }),
		ui: { notify },
		sessionManager: {
			getEntries: () => [],
			getSessionId: () => "stale-ctx-session",
			getCwd: () => cwd,
		},
		compact: () => {},
	};
}

/** A non-marker event: the auto-archive branch, not the checkpoint tool's. */
const autoEvent = (cwd: string) => ({
	type: "session_before_compact" as const,
	cwd,
	preparation: { firstKeptEntryId: "entry-42", tokensBefore: 1 },
	branchEntries: [],
	customInstructions: undefined,
	reason: "manual" as const,
	willRetry: false,
});

afterAll(async () => {
	for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("checkpoint extension: stale ctx during auto-archive", () => {
	it("does not throw out of session_before_compact when ui.notify throws", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "ckpt-stale-"));
		dirs.push(cwd);
		const handlers = harness(() => {});
		const ctx = ctxFor(cwd, () => {
			throw new Error("stale extension context");
		});

		await expect(handlers.get("session_before_compact")!({ ...autoEvent(cwd), type: "session_before_compact" }, ctx)).resolves.toBeUndefined();
	}, 30_000);

	it("control: a working ctx still gets the archive notification", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "ckpt-live-"));
		dirs.push(cwd);
		const seen: Array<{ message: string; level: string }> = [];
		const handlers = harness(() => {});
		const ctx = ctxFor(cwd, (message: string, level: string) => seen.push({ message, level }));

		await handlers.get("session_before_compact")!({ ...autoEvent(cwd), type: "session_before_compact" }, ctx);
		expect(seen.length).toBe(1);
		expect(seen[0].message).toContain("Archived session for grepping");
		expect(seen[0].level).toBe("info");
	}, 30_000);
});
