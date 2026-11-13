/**
 * A parked `wait` wakes when its child completes — in real processes, through
 * the real loader, from a symlinked spelling of the extension's own path.
 *
 * The shape, all levels real (`pi --mode rpc`, a scripted model, no network):
 *
 *   subject (depth 0)  dispatch probe-mid, then `wait`
 *     probe-mid        dispatch probe-leaf, then `wait`
 *       probe-leaf     answers and exits
 *
 * Both parks must wake: the mid on the leaf's completion, the subject on the
 * mid's.
 *
 * The two arms differ only in how `PI_CODING_AGENT_DIR` spells the directory
 * holding the extension tree:
 *
 *   real — `<root>/real/agent`   the tree's own path
 *   link — `<root>/link/agent`   `link` is a symlink to `real`
 *
 * In the link arm pi's loader hands jiti the entry spelled `/…/link/…`
 * (`dist/core/extensions/loader.js:527`, no realpath) while jiti resolves the
 * entry's relative imports through realpath, so `index.ts`'s cycle re-entry
 * lands on a second module record. The evaluation pi registered is then not the
 * evaluation the close path imports, and the completion is dropped in a process
 * with a live session — the park never wakes. See
 * `docs/investigations/subagent-wait-wake-2026-11.md`.
 *
 * The real arm is the control: same processes, same extension tree, same
 * shape. It wakes in a couple of seconds, so a link-arm failure is the spelling
 * and not a broken chain. The root is realpath'd first, so the arms differ by
 * the symlink this file creates and not by `$TMPDIR`'s own `/var` →
 * `/private/var`.
 *
 * Slow (three processes, ~4-8 s per arm) but off-network and scripted
 * throughout, so it is deterministic apart from machine load.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeSpawnArtifacts } from "./helpers/subagent-lifecycle.ts";
import { childEnv, scrubSubagentEnv } from "./helpers/subagent-env.ts";

const REPO = join(import.meta.dir, "..");
const PI_BIN = process.env.PI_BIN ?? "pi";

/** What the harness injects into a subagent session; the chain stamps its own. */
let restoreEnv: () => void;

beforeAll(() => {
	restoreEnv = scrubSubagentEnv();
});

afterAll(() => {
	restoreEnv();
});

interface ChainResult {
	/** The mid ran the turn its wake-up produces. */
	midWoke: boolean;
	/** The subject ran the turn its wake-up produces. */
	subjectWoke: boolean;
	/** Model calls the subject made: dispatch, `wait`, and one per wake-up. */
	subjectCalls: number;
	/** Every user-role message the subject ended a turn on, in order — the
	 *  wake-up steer arrives here. */
	delivered: string[];
	elapsedMs: number;
	stderr: string;
}

interface FauxCall {
	depth: string;
	call: number;
	text: string;
}

/** One entry per model call across every process in the chain (`PI_FAUX_LOG`).
 *  Per-depth call counts are the only place a child's turns are visible: the
 *  subject's stdout carries its own turns, the mid's carry only the close
 *  handler's footer. */
function readFauxLog(path: string): FauxCall[] {
	let text = "";
	try { text = readFileSync(path, "utf8"); } catch { return []; }
	const calls: FauxCall[] = [];
	for (const line of text.split("\n")) {
		const match = /^depth=(\S+) call=(\d+) repeat=\S+ (\{.*\})$/.exec(line.trim());
		if (!match) continue;
		calls.push({ depth: match[1], call: Number(match[2]), text: match[3] });
	}
	return calls;
}

/** Every `/tmp/pi-subagent-*` meta file, so a run's leftovers can be named. */
function metaFiles(): Set<string> {
	try {
		return new Set(readdirSync("/tmp").filter((name) => name.startsWith("pi-subagent-") && name.endsWith(".meta.json")));
	} catch {
		return new Set();
	}
}

/** Sid from `/tmp/pi-subagent-<sid>.meta.json`. */
const sidOf = (metaName: string) => metaName.slice("pi-subagent-".length, -".meta.json".length);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build one arm's temp tree: the checkout's subagent-async + lib extensions, the
 * scripted provider, two agent fixtures, and a `link` → `real` symlink.
 * Returns the root and the agent dir to point the chain at.
 */
function buildTree(): { root: string; agentDir: string; cwd: string; fauxLog: string } {
	// Realpath'd: the arms must differ by this file's symlink alone.
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-subagent-wake-e2e-")));
	const real = join(root, "real");
	symlinkSync(real, join(root, "link"));
	const cwd = join(real, "cwd");
	const agentDir = join(real, "agent");
	const extensions = join(agentDir, "extensions");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	mkdirSync(extensions, { recursive: true });

	cpSync(join(REPO, "extensions/subagent-async"), join(extensions, "subagent-async"), { recursive: true });
	cpSync(join(REPO, "extensions/lib"), join(extensions, "lib"), { recursive: true });
	cpSync(join(import.meta.dir, "helpers/faux-provider.ts"), join(extensions, "faux-provider.ts"));
	// `typebox` and the `@earendil-works/*` sources resolve from the checkout's
	// modules; the extension files themselves are copies, because a linked
	// extension resolves its own relative imports against the link's path.
	symlinkSync(join(REPO, "node_modules"), join(extensions, "node_modules"));

	for (const name of ["probe-mid", "probe-leaf"]) {
		writeFileSync(
			join(agentDir, "agents", `${name}.md`),
			["---", `name: ${name}`, "description: e2e wait-wake fixture", "model: faux/faux-1", "---", "", "Follow the task exactly.", ""].join("\n"),
		);
	}

	const fauxLog = join(root, "faux.log");
	writeFileSync(fauxLog, "");
	return { root, agentDir, cwd, fauxLog };
}

/**
 * Run the nested chain with `agentDir` spelled as given. Polls for the markers
 * rather than sleeping a fixed interval, so a slow machine costs a longer poll
 * and not a flipped verdict.
 */
interface ChainOptions {
	spelling: "link" | "real";
	/** The subject's `wait` argument; omitted means the no-timer form. */
	waitSeconds?: number;
	/** How long to keep watching after the subject woke, to catch a timer that
	 *  was never cancelled firing late. */
	tailMs?: number;
	deadlineMs?: number;
}

async function runChain(opts: ChainOptions): Promise<ChainResult> {
	const { spelling, waitSeconds, tailMs = 0 } = opts;
	const deadlineMs = opts.deadlineMs ?? 30_000;
	const { root, cwd, fauxLog } = buildTree();
	const metaBefore = metaFiles();
	const started = Date.now();

	const child = spawn(
		PI_BIN,
		["--mode", "rpc", "--model", "faux/faux-1", "--session-id", `e2e-${spelling}-${Date.now()}`, "--tools", "subagent,wait,subagent_status"],
		// Own process group: the chain's grandchildren sit in no other group we
		// can reach, and a leaked `pi` per arm would follow the suite around.
		{
			cwd,
			env: childEnv({
				PI_FAUX_LOG: fauxLog,
				PI_FAUX_SCRIPT_DEPTH_0: JSON.stringify([
					{ call: "subagent", args: { agent: "probe-mid", task: "delegate once", isolate: false, review_policy: "skip" } },
					{ call: "wait", args: waitSeconds === undefined ? {} : { seconds: waitSeconds } },
					{ text: "SUBJECT-WOKE" },
				]),
				PI_FAUX_SCRIPT_DEPTH_1: JSON.stringify([
					{ call: "subagent", args: { agent: "probe-leaf", task: "answer", isolate: false, review_policy: "skip" } },
					{ call: "wait", args: {} },
					{ text: "MID-WOKE" },
				]),
				PI_FAUX_SCRIPT_DEPTH_2: JSON.stringify([{ text: "leaf done" }]),
				PI_CODING_AGENT_DIR: join(root, spelling, "agent"),
				PI_SUBAGENT_ALLOWLIST: "probe-mid,probe-leaf",
				PI_OFFLINE: "1",
			}),
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
		},
	);

	const stderr: string[] = [];
	child.stderr!.on("data", (chunk: Buffer) => {
		stderr.push(chunk.toString());
		if (stderr.length > 200) stderr.shift();
	});

	const delivered: string[] = [];
	let stream = "";
	child.stdout!.on("data", (chunk: Buffer) => {
		stream += chunk.toString();
		let newline: number;
		while ((newline = stream.indexOf("\n")) >= 0) {
			const line = stream.slice(0, newline);
			stream = stream.slice(newline + 1);
			if (!line.trim()) continue;
			let event: any;
			try { event = JSON.parse(line); } catch { continue; }
			if (event.type !== "message_end" || event.message?.role !== "user") continue;
			const text = Array.isArray(event.message.content)
				? event.message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n")
				: String(event.message.content ?? "");
			delivered.push(text);
		}
	});

	child.stdin!.write(JSON.stringify({ id: "p1", type: "prompt", message: "dispatch then wait" }) + "\n");

	// Poll on the markers themselves: a fixed sleep would flip the verdict on a
	// loaded machine.
	const deadline = started + deadlineMs;
	const woke = () => {
		const calls = readFauxLog(fauxLog);
		return {
			midWoke: calls.some((c) => c.depth === "1" && c.text.includes("MID-WOKE")),
			subjectWoke: calls.some((c) => c.depth === "0" && c.text.includes("SUBJECT-WOKE")),
		};
	};
	while (Date.now() < deadline) {
		const { midWoke, subjectWoke } = woke();
		if (midWoke && subjectWoke) break;
		await wait(250);
	}
	const elapsedMs = Date.now() - started;
	const { midWoke, subjectWoke } = woke();
	const subjectCalls = readFauxLog(fauxLog).filter((c) => c.depth === "0").length;

	// Keep watching past the wake-up: a `wait(seconds)` timer that the close
	// handler failed to cancel fires its own steer on top of the completion.
	if (tailMs > 0) await wait(tailMs);

	// Kill the tree, then verify the kill landed: `child.killed` only says a
	// signal was sent, so a `!child.killed` guard never escalates.
	try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
	const exited = await Promise.race([
		new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
		wait(5_000).then(() => false),
	]);
	if (!exited) try { child.kill("SIGKILL"); } catch { /* already gone */ }

	// Everything this run left in the shared registry dir, by sid. Transcripts
	// live under the temp agentDir and go with the root.
	for (const meta of metaFiles()) if (!metaBefore.has(meta)) removeSpawnArtifacts(sidOf(meta));
	rmSync(root, { recursive: true, force: true });

	return { midWoke, subjectWoke, subjectCalls, delivered, elapsedMs, stderr: stderr.join("").slice(-800) };
}

describe("a parked wait wakes when its child completes", () => {
	it("1: nested parks wake at both levels, with the extension loaded from a symlinked spelling", async () => {
		const result = await runChain({ spelling: "link" });
		const why = `after ${result.elapsedMs}ms\n${result.stderr}`;
		expect(result.midWoke, `the mid's wait never woke — its child's completion was dropped. ${why}`).toBe(true);
		expect(result.subjectWoke, `the subject's wait never woke. ${why}`).toBe(true);
	}, 90_000);

	it("2: control — the same shape from the extension tree's own spelling wakes at both levels", async () => {
		const result = await runChain({ spelling: "real" });
		const why = `after ${result.elapsedMs}ms\n${result.stderr}`;
		expect(result.midWoke, `the mid's wait never woke. ${why}`).toBe(true);
		expect(result.subjectWoke, `the subject's wait never woke. ${why}`).toBe(true);
	}, 90_000);

	it("3: one completion is one delivery, and no timer steer follows it", async () => {
		// `wait(5)`: the child completes long before the timer would fire, so the
		// wake-up can only be the close handler's. A duplicate delivery shows as
		// a second completion message; watching six more seconds after the wake-up
		// catches a timer steer on top of the completion. The cancel itself is
		// pinned in `tests/subagent-session-lifetime.test.ts` rows 8-10 — with the
		// only child gone, the timer callback's own `running.size === 0` guard
		// skips its steer either way, so no end-to-end row can see the cancel.
		const result = await runChain({ spelling: "link", waitSeconds: 5, tailMs: 6_000 });
		const why = `delivered:\n${result.delivered.join("\n---\n")}\n${result.stderr}`;

		const completions = result.delivered.filter((m) => m.includes("[Subagent probe-mid finished]"));
		expect(completions.length, `one completion, one delivery. ${why}`).toBe(1);
		const timerSteers = result.delivered.filter((m) => m.includes("[wait timer]"));
		expect(timerSteers, `the completion did not cancel the wait timer. ${why}`).toEqual([]);
		// Three model calls: dispatch, `wait`, and the single turn the delivery
		// creates. The fixture's log marks a fourth as a repeat of an exhausted
		// script, which is what a second delivery would be.
		expect(result.subjectCalls, `the subject ran ${result.subjectCalls} turns for one completion. ${why}`).toBe(3);
	}, 120_000);
});
