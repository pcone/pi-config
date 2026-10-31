/**
 * A stale extension context must not turn an archive outcome into an extension error.
 *
 * pi reloads extensions across a session; a handler can then hold a `ctx` whose
 * `ui.notify` throws ("stale extension context"). Every notify in the checkpoint
 * extension is best-effort and goes through `safeNotify`
 * (`extensions/lib/safe-notify.ts`): the archive is already written, and
 * compaction is the thing the user is waiting on.
 *
 * Before the fix the auto-compaction branch guarded neither notify — the success
 * notify's catch and its own "Archive failed" notify were both bare — so a
 * throwing `ui.notify` escaped `session_before_compact` and surfaced as an
 * extension error instead of a notification (pi-config#12).
 *
 * Both archive outcomes are driven here: success and failure. A row that only
 * drives success cannot see a guard removed from the failure path, and a row
 * that only asserts "did not throw" cannot see the branch over-guarded (which
 * would silently swallow the user-visible warning).
 */
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import checkpointExtension from "../extensions/checkpoint";

// Generous: each row shells out to git (`captureGitBinding`, 2 s timeout) and
// writes an archive. A wedge there is bounded by the git timeout, so no separate
// hang witness is armed here — unlike the shim-driven rows in
// `tests/checkpoint-meta.test.ts:29-31`.
const ROW_TIMEOUT_MS = 30_000;

const dirs: string[] = [];

/** pi dispatches every handler for an event, so accumulate rather than `set`. */
function handlersFor(event: string): Array<(event: any, ctx: any) => unknown> {
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	checkpointExtension({
		on: (name: string, handler: any) => {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerTool: () => {},
		registerCommand: () => {},
		sendUserMessage: () => {},
	} as any);
	return handlers.get(event)!;
}

type Notify = (message: string, level: string) => void;

function ctxFor(cwd: string, notify: Notify, opts: { failArchive?: boolean } = {}) {
	return {
		cwd,
		hasUI: true,
		getContextUsage: () => ({ tokens: 1, contextWindow: 200_000, percent: 0 }),
		ui: { notify },
		sessionManager: {
			// The archive reads the session through this call, so a throw here is a
			// real archive failure — no module stubbing involved.
			getEntries: () => {
				if (opts.failArchive) throw new Error("session entries unavailable");
				return [];
			},
			getSessionId: () => "stale-ctx-session",
			getCwd: () => cwd,
		},
		compact: () => {},
	};
}

/** A non-marker event: the auto-archive branch, not the checkpoint tool's. */
const autoEvent = () => ({
	type: "session_before_compact" as const,
	preparation: { firstKeptEntryId: "entry-42", tokensBefore: 1 },
	branchEntries: [],
	customInstructions: undefined,
	reason: "manual" as const,
	willRetry: false,
	signal: new AbortController().signal,
});

async function runAutoBranch(cwd: string, ctx: unknown): Promise<void> {
	for (const handler of handlersFor("session_before_compact")) await handler(autoEvent(), ctx);
}

/**
 * Await without caring about the handler's return value: the bug is an escape,
 * not a shape. `toBeUndefined` on the resolution would red a legitimate future
 * `return { compaction }` for a reason unrelated to the bug.
 */
async function expectNoEscape(promise: Promise<unknown>): Promise<void> {
	// Rejection is encoded as a string, not carried through: a handler rejecting
	// with `undefined` would otherwise read as a resolution.
	expect(await promise.then(() => "resolved", (err: unknown) => `rejected: ${String(err)}`))
		.toBe("resolved");
}

const throwingNotify: Notify = () => {
	throw new Error("stale extension context");
};

function tempDir(prefix: string): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix));
}

afterAll(async () => {
	for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("checkpoint extension: stale ctx during auto-archive", () => {
	it("does not throw out of session_before_compact when ui.notify throws", async () => {
		const cwd = await tempDir("ckpt-stale-");
		dirs.push(cwd);

		await expectNoEscape(runAutoBranch(cwd, ctxFor(cwd, throwingNotify)));
	}, ROW_TIMEOUT_MS);

	it("control: a working ctx still gets the archive notification for a real archive", async () => {
		const cwd = await tempDir("ckpt-live-");
		dirs.push(cwd);
		const seen: Array<{ message: string; level: string }> = [];

		await runAutoBranch(cwd, ctxFor(cwd, (message, level) => seen.push({ message, level })));

		expect(seen.length).toBe(1);
		expect(seen[0].message).toContain("Archived session for grepping");
		expect(seen[0].level).toBe("info");

		// The row must not pass by skipping the archive: the path it names exists.
		const archivePath = seen[0].message.replace(/^.*grepping: /, "");
		expect(existsSync(archivePath)).toBe(true);
		const written = await readdir(join(cwd, ".pi", "checkpoints"));
		expect(written.some((f) => f.endsWith(".jsonl"))).toBe(true);
		expect(written.some((f) => f.endsWith(".meta.json"))).toBe(true);
	}, ROW_TIMEOUT_MS);

	it("does not throw when the archive fails and ui.notify throws", async () => {
		const cwd = await tempDir("ckpt-stale-fail-");
		dirs.push(cwd);

		await expectNoEscape(runAutoBranch(cwd, ctxFor(cwd, throwingNotify, { failArchive: true })));
	}, ROW_TIMEOUT_MS);

	it("still reports an archive failure to a live ctx, once, as a warning", async () => {
		const cwd = await tempDir("ckpt-live-fail-");
		dirs.push(cwd);
		const seen: Array<{ message: string; level: string }> = [];

		await runAutoBranch(
			cwd,
			ctxFor(cwd, (message, level) => seen.push({ message, level }), { failArchive: true }),
		);

		expect(seen.length).toBe(1);
		expect(seen[0].message).toContain("Archive failed (compaction continues)");
		// The underlying cause travels with the warning, not just the prefix.
		expect(seen[0].message).toContain("session entries unavailable");
		expect(seen[0].level).toBe("warning");
	}, ROW_TIMEOUT_MS);

	it("swallows a stale ctx whose `ui` getter throws, not only a throwing notify", async () => {
		// pi's real stale mechanism is the getter itself (`assertActive()` in
		// `runner.js:613-637`); a helper that read `ctx.ui` outside its `try` would
		// pass every other row here.
		const cwd = await tempDir("ckpt-stale-getter-");
		dirs.push(cwd);
		const live = ctxFor(cwd, () => {});
		const stale: Record<string, unknown> = {
			...Object.fromEntries(Object.entries(live).filter(([k]) => k !== "ui")),
		};
		Object.defineProperty(stale, "ui", {
			get() {
				throw new Error("This extension ctx is stale after session replacement or reload");
			},
		});

		await expectNoEscape(runAutoBranch(cwd, stale));
	}, ROW_TIMEOUT_MS);

	it("a notify that throws after delivering still reports success, not a false archive failure", async () => {
		// A success notify that throws once (then works) must not be misreported as
		// an archive failure: the archive did succeed.
		const cwd = await tempDir("ckpt-live-flaky-");
		dirs.push(cwd);
		const seen: Array<{ message: string; level: string }> = [];
		let calls = 0;

		await runAutoBranch(
			cwd,
			ctxFor(cwd, (message, level) => {
				if (calls++ === 0) throw new Error("transient");
				seen.push({ message, level });
			}),
		);

		expect(seen.length).toBe(0);
	}, ROW_TIMEOUT_MS);
});
