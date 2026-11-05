/**
 * Tests for bin/heavy, the machine-wide heavy-job slot (WO-2026-079).
 *
 * One test per row of the work order:
 *   1. one slot serialises two runs; the second names the holder
 *   2. SIGKILL of the holder frees the slot at once
 *   3. a nested call under HEAVY_SLOT_HELD does not wait
 *   4. exit status and stdout pass through
 *   5. HEAVY_SLOTS=2 lets two run at once
 *
 * Each test sets HOME to a fresh temp dir, so slot files under ~/.cache never
 * touch the real machine-wide slots.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HEAVY = join(import.meta.dir, "..", "bin", "heavy");
const TIMEOUT = 30_000;

let home: string;
let slotDir: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "heavy-test-"));
	slotDir = join(home, ".cache", "heavy-slots");
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

/** Spawn `heavy -- <args>` with a hermetic env; extra vars override the inherited ones. */
function heavy(args: string[], extra: Record<string, string> = {}) {
	const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home };
	delete env.HEAVY_SLOT_HELD;
	delete env.HEAVY_SLOTS;
	Object.assign(env, extra);
	return Bun.spawn(["python3", "-I", HEAVY, "--", ...args], {
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > end) throw new Error("waitFor timed out");
		await Bun.sleep(50);
	}
}

/** Read up to the first newline, leaving the rest of the stream unread. */
async function readFirstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	while (!buf.includes("\n")) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
	}
	reader.releaseLock();
	return buf.split("\n")[0];
}

const infoPath = (i: number) => join(slotDir, `slot-${i}.info`);

describe("bin/heavy", () => {
	it(
		"row 1: one slot serialises two runs, and the second names the holder",
		async () => {
			const t0 = Date.now();
			const first = heavy(["sleep", "2"], { HEAVY_SLOTS: "1" });
			await waitFor(() => existsSync(infoPath(0)));
			const second = heavy(["sleep", "2"], { HEAVY_SLOTS: "1" });

			expect(await first.exited).toBe(0);
			expect(await second.exited).toBe(0);
			expect(Date.now() - t0).toBeGreaterThanOrEqual(4000);

			const err = await new Response(second.stderr).text();
			expect(err).toContain("heavy: waiting for slot 0, held by pid");
			expect(err).toContain("sleep 2");
		},
		TIMEOUT,
	);

	it(
		"row 2: SIGKILL of the holder frees the slot at once",
		async () => {
			// exec makes the printed pid the sleep itself, so the test can reap it.
			const holder = heavy(["sh", "-c", "echo $$; exec sleep 60"], { HEAVY_SLOTS: "1" });
			const childPid = Number(await readFirstLine(holder.stdout));
			try {
				await waitFor(() => existsSync(infoPath(0)));
				const holderPid = JSON.parse(readFileSync(infoPath(0), "utf8")).pid;
				process.kill(holderPid, "SIGKILL");
				await holder.exited;

				const t0 = Date.now();
				const next = heavy(["true"], { HEAVY_SLOTS: "1" });
				expect(await next.exited).toBe(0);
				expect(Date.now() - t0).toBeLessThan(5000);
			} finally {
				try {
					process.kill(childPid, "SIGKILL");
				} catch {
					// already gone
				}
			}
		},
		TIMEOUT,
	);

	it(
		"row 3: a nested call under HEAVY_SLOT_HELD does not wait",
		async () => {
			const holder = heavy(["sleep", "5"], { HEAVY_SLOTS: "1" });
			let holderDone = false;
			holder.exited.then(() => {
				holderDone = true;
			});
			await waitFor(() => existsSync(infoPath(0)));

			const nested = heavy(["echo", "nested"], { HEAVY_SLOT_HELD: "0", HEAVY_SLOTS: "1" });
			expect(await nested.exited).toBe(0);
			expect(holderDone).toBe(false);
			expect(await new Response(nested.stdout).text()).toBe("nested\n");

			expect(await holder.exited).toBe(0);
		},
		TIMEOUT,
	);

	it(
		"row 4: exit status and stdout pass through",
		async () => {
			const run = heavy(["sh", "-c", "echo out; exit 7"]);
			const out = await new Response(run.stdout).text();
			const err = await new Response(run.stderr).text();
			expect(await run.exited).toBe(7);
			expect(out).toBe("out\n");
			expect(err).toBe("");
		},
		TIMEOUT,
	);

	it(
		"row 5: HEAVY_SLOTS=2 lets two run at once",
		async () => {
			const t0 = Date.now();
			const a = heavy(["sleep", "2"], { HEAVY_SLOTS: "2" });
			const b = heavy(["sleep", "2"], { HEAVY_SLOTS: "2" });
			expect(await a.exited).toBe(0);
			expect(await b.exited).toBe(0);
			// Serial runs take at least 4 s; concurrent runs take about 2 s.
			expect(Date.now() - t0).toBeLessThan(3500);
		},
		TIMEOUT,
	);
});
