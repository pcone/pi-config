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
async function runChain(spelling: "link" | "real", deadlineMs = 30_000): Promise<ChainResult> {
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
					{ call: "wait", args: {} },
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
	child.stdout!.resume();

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

	return { midWoke, subjectWoke, subjectCalls, elapsedMs, stderr: stderr.join("").slice(-800) };
}

describe("a parked wait wakes when its child completes", () => {
	it("1: nested parks wake at both levels, with the extension loaded from a symlinked spelling", async () => {
		const result = await runChain("link");
		const why = `after ${result.elapsedMs}ms\n${result.stderr}`;
		expect(result.midWoke, `the mid's wait never woke — its child's completion was dropped. ${why}`).toBe(true);
		expect(result.subjectWoke, `the subject's wait never woke. ${why}`).toBe(true);
	}, 90_000);

	it("2: control — the same shape from the extension tree's own spelling wakes at both levels", async () => {
		const result = await runChain("real");
		const why = `after ${result.elapsedMs}ms\n${result.stderr}`;
		expect(result.midWoke, `the mid's wait never woke. ${why}`).toBe(true);
		expect(result.subjectWoke, `the subject's wait never woke. ${why}`).toBe(true);
	}, 90_000);

	it("3: one completion is one wake-up — the subject runs no turn the delivery did not create", async () => {
		// Three model calls: dispatch, `wait`, and the turn the wake-up creates.
		// A duplicate delivery (close handler + turn cap + worktree path all call
		// `sendUserMessage`) runs a fourth, on a script already exhausted — which
		// is what the fixture's `repeat` flag names.
		const result = await runChain("link");
		expect(result.subjectCalls, `the subject ran ${result.subjectCalls} turns for one completion`).toBe(3);
	}, 90_000);
});
