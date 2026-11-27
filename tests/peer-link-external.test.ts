/**
 * External peers (peer-link/external.ts): registration semantics in the
 * mailbox layer, plus the CLI driven as Claude Code hooks would drive it
 * (real subprocesses against a temp $PI_PEER_MAILBOX).
 *
 * Run: bun test tests/peer-link-external.test.ts
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	EXTERNAL_TTL_MS,
	broadcastTargets,
	claimIncoming,
	deliveryDecision,
	inboxDir,
	listPeers,
	newEnvelope,
	readIncoming,
	removeHeartbeat,
	removeWatchRecord,
	sendEnvelope,
	sweepStalePeers,
	writeHeartbeat,
	writeWait,
	writeWatchRecord,
} from "../extensions/peer-link/mailbox";
import { renderMail } from "../extensions/peer-link/external";
import { childEnv, scrubSubagentEnv } from "./helpers/subagent-env.ts";

const CLI = join(import.meta.dir, "..", "extensions", "peer-link", "external.ts");
const SID = "0b1c2d3e-aaaa-bbbb-cccc-111122223333";
const SELF = `claude-${SID}`;

// The rows spawn the CLI, so both halves of the idiom are needed: the scrub
// keeps the harness's injected PI_SUBAGENT_* out of this process, and childEnv()
// hands the live env (not bun's startup snapshot) to each spawn
// (tests/helpers/subagent-env.ts).
let restoreSubagentEnv: () => void = () => {};

beforeAll(() => {
	restoreSubagentEnv = scrubSubagentEnv();
});

afterAll(() => {
	restoreSubagentEnv();
});

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "peer-external-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function run(args: string[], stdin = "", timeout?: number): { code: number; out: string; err: string } {
	const p = Bun.spawnSync(["bun", CLI, ...args], {
		stdin: new TextEncoder().encode(stdin),
		env: childEnv({ PI_PEER_MAILBOX: dir }),
		timeout,
	});
	return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

const hookJson = (event: string) => JSON.stringify({ session_id: SID, cwd: "/w", hook_event_name: event });

describe("external peers in the mailbox layer", () => {
	it("are listed but never online, and outlive the pi sweep window", () => {
		const now = Date.now();
		writeHeartbeat(dir, { name: "ext", ts: now - 10 * 60_000, external: true });
		writeHeartbeat(dir, { name: "pi-old", ts: now - 10 * 60_000 });
		sweepStalePeers(dir, now);
		const peers = listPeers(dir, now);
		expect(peers.map((p) => p.name)).toEqual(["ext"]);
		expect(peers[0].online).toBe(false);
		sweepStalePeers(dir, now + EXTERNAL_TTL_MS);
		expect(listPeers(dir)).toEqual([]);
	});

	it("accept queued delivery, but fail requireOnline", () => {
		const listed = [{ name: "ext", online: false, external: true }];
		expect(deliveryDecision("ext", listed, false)).toEqual({ ok: true, online: false, external: true });
		const r = deliveryDecision("ext", listed, true);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("external");
	});

	it("renders mail oldest first, with a reply prompt when asked", () => {
		const a = { ...newEnvelope("bob", SELF, "second", true), sentAt: 2 };
		const b = { ...newEnvelope("bob", SELF, "first"), sentAt: 1 };
		const text = renderMail(SELF, [a, b]);
		expect(text.indexOf("first")).toBeLessThan(text.indexOf("second"));
		expect(text).toContain(`send --from ${SELF} bob`);
	});

	it("claimIncoming hands each envelope to one reader; a rejected envelope stays", () => {
		sendEnvelope(dir, newEnvelope("bob", SELF, "a"));
		sendEnvelope(dir, newEnvelope("bob", SELF, "b"));
		sendEnvelope(dir, newEnvelope("bob", SELF, "c"));
		expect(claimIncoming(dir, SELF, (e) => e.text !== "c").map((e) => e.text).sort()).toEqual(["a", "b"]);
		expect(readIncoming(dir, SELF).map((e) => e.text)).toEqual(["c"]);
		expect(claimIncoming(dir, SELF, () => false)).toEqual([]);
		expect(claimIncoming(dir, SELF).map((e) => e.text)).toEqual(["c"]);
		expect(claimIncoming(dir, SELF)).toEqual([]);
	});
});

describe("external.ts CLI (as Claude Code hooks run it)", () => {
	it("registers, receives a pi send, delivers on prompt once, and unregisters", () => {
		const start = run(["hook", "session-start"], hookJson("SessionStart"));
		expect(start.code).toBe(0);
		expect(JSON.parse(start.out).hookSpecificOutput.additionalContext).toContain(SELF);
		const me = listPeers(dir).find((p) => p.name === SELF);
		expect(me?.external).toBe(true);

		// A pi peer's send passes the delivery gate because the external is listed.
		const d = deliveryDecision(SELF, listPeers(dir), false);
		expect(d.ok).toBe(true);
		sendEnvelope(dir, newEnvelope("bug-triage", SELF, "issue #42 filed"));

		const prompt = run(["hook", "prompt"], hookJson("UserPromptSubmit"));
		expect(prompt.code).toBe(0);
		const ctx = JSON.parse(prompt.out).hookSpecificOutput;
		expect(ctx.hookEventName).toBe("UserPromptSubmit");
		expect(ctx.additionalContext).toContain("[peer:bug-triage] issue #42 filed");
		expect(readIncoming(dir, SELF)).toEqual([]); // claimed by the prompt

		const again = run(["hook", "prompt"], hookJson("UserPromptSubmit"));
		expect(again.code).toBe(0);
		// Nothing pending, no watch live: no mail, but the watch nudge (decision external-tools/014 § Watch liveness).
		expect(again.out).toContain("no watch is running");
		expect(again.out).not.toContain("peer-link mail for");

		expect(run(["hook", "session-end"], hookJson("SessionEnd")).code).toBe(0);
		expect(listPeers(dir).some((p) => p.name === SELF)).toBe(false);
	}, 120_000);

	it("a prompt claims its mail: an Escape-aborted prompt does not re-emit it", () => {
		run(["hook", "session-start"], hookJson("SessionStart"));
		sendEnvelope(dir, newEnvelope("bug-triage", SELF, "mail lost to Escape"));

		const first = run(["hook", "prompt"], hookJson("UserPromptSubmit"));
		expect(first.out).toContain("mail lost to Escape");
		// Escape: the turn is aborted. The mail is gone, and the next prompt shows no mail (only the watch nudge).
		const second = run(["hook", "prompt"], hookJson("UserPromptSubmit"));
		expect(second.out).not.toContain("mail lost to Escape");
		expect(second.out).toContain("no watch is running");
		expect(readIncoming(dir, SELF)).toEqual([]);
	}, 120_000);

	it("a prompt claims only what it shows; mid-turn arrivals wait for the next prompt", () => {
		run(["hook", "session-start"], hookJson("SessionStart"));
		sendEnvelope(dir, newEnvelope("bug-triage", SELF, "seen by the turn"));
		const prompt = run(["hook", "prompt"], hookJson("UserPromptSubmit"));
		expect(prompt.out).toContain("seen by the turn");
		sendEnvelope(dir, newEnvelope("bug-triage", SELF, "arrived mid-turn"));

		const next = run(["hook", "prompt"], hookJson("UserPromptSubmit"));
		expect(next.out).toContain("arrived mid-turn");
		expect(next.out).not.toContain("seen by the turn");
	}, 120_000);

	it("the Stop hook is gone: hook stop fails as an unknown event", () => {
		run(["hook", "session-start"], hookJson("SessionStart"));
		const r = run(["hook", "stop"], hookJson("Stop"));
		expect(r.code).toBe(1);
		expect(r.err).toContain('unknown hook event "stop"');
	}, 120_000);

	it("sends to a listed pi peer, from stdin, with --reply", () => {
		run(["hook", "session-start"], hookJson("SessionStart"));
		writeHeartbeat(dir, { name: "bug-triage", ts: Date.now() });
		const r = run(["send", "--from", SELF, "--reply", "bug-triage", "-"], "repro: x\nwhere: y\n");
		expect(r.code).toBe(0);
		expect(r.out).toContain("online");
		const [env] = readIncoming(dir, "bug-triage");
		expect(env).toMatchObject({ from: SELF, to: "bug-triage", text: "repro: x\nwhere: y", expectReply: true });
		expect(typeof env.sentAt).toBe("number");
	}, 120_000);

	it("fails loud: unlisted target, unregistered sender, requireOnline to an offline peer", () => {
		run(["hook", "session-start"], hookJson("SessionStart"));
		const unlisted = run(["send", "--from", SELF, "nobody", "hi"]);
		expect(unlisted.code).toBe(1);
		expect(unlisted.err).toContain("not listed");
		expect(existsSync(join(dir, "nobody"))).toBe(false);

		writeHeartbeat(dir, { name: "bug-triage", ts: Date.now() });
		expect(run(["send", "--from", "claude-forged", "bug-triage", "hi"]).err).toContain(
			"not a registered external peer",
		);

		writeHeartbeat(dir, { name: "bug-triage", ts: Date.now() - 5 * 60_000 });
		const offline = run(["send", "--from", SELF, "--require-online", "bug-triage", "hi"]);
		expect(offline.code).toBe(1);
		expect(readIncoming(dir, "bug-triage")).toEqual([]);
	}, 120_000);
});

describe("send --wait (reply-wait, decision 012)", () => {
	const PI = "bug-triage";

	function spawnWaiter(args: string[]): Bun.Subprocess {
		return Bun.spawn(["bun", CLI, ...args], {
			stdout: "pipe",
			stderr: "pipe",
			env: childEnv({ PI_PEER_MAILBOX: dir }),
		});
	}

	async function finish(proc: Bun.Subprocess): Promise<{ code: number; out: string; err: string }> {
		const [code, out, err] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		return { code, out, err };
	}

	// Waits until the wait's own send has landed in the target's inbox, so the
	// wait has started polling before the test sends its reply.
	async function untilWaiterSent(): Promise<void> {
		const until = Date.now() + 10_000;
		while (readIncoming(dir, PI).length === 0) {
			if (Date.now() > until) throw new Error("the wait's send never reached the target inbox");
			await Bun.sleep(50);
		}
	}

	function killIfRunning(proc: Bun.Subprocess): void {
		if (proc.exitCode === null) proc.kill();
	}

	it("a reply from the target ends the wait: exit 0, printed, and claimed from the inbox", async () => {
		run(["hook", "session-start"], hookJson("SessionStart"));
		writeHeartbeat(dir, { name: PI, ts: Date.now() });
		const waiter = spawnWaiter(["send", "--from", SELF, "--wait", "1", PI, "hi"]);
		try {
			await untilWaiterSent();
			sendEnvelope(dir, newEnvelope(PI, SELF, "the answer"));
			const r = await finish(waiter);
			expect(r.code).toBe(0);
			expect(r.out).toContain("the answer");
			expect(readIncoming(dir, SELF)).toEqual([]);
		} finally {
			killIfRunning(waiter);
		}
	}, 20_000);

	it("mail from the target sent before the send does not end the wait", () => {
		run(["hook", "session-start"], hookJson("SessionStart"));
		writeHeartbeat(dir, { name: PI, ts: Date.now() });
		sendEnvelope(dir, { ...newEnvelope(PI, SELF, "old news"), sentAt: Date.now() - 60_000 });
		const r = run(["send", "--from", SELF, "--wait", "0.03", PI, "hi"]);
		expect(r.code).toBe(4);
		expect(r.out).toContain(`no reply from ${PI}`);
		expect(r.out).not.toContain("old news");
	}, 120_000);

	it("the target going offline ends the wait with exit 3", async () => {
		run(["hook", "session-start"], hookJson("SessionStart"));
		writeHeartbeat(dir, { name: PI, ts: Date.now() });
		const waiter = spawnWaiter(["send", "--from", SELF, "--wait", "1", PI, "hi"]);
		try {
			await untilWaiterSent();
			writeHeartbeat(dir, { name: PI, ts: Date.now() - 5 * 60_000 });
			const r = await finish(waiter);
			expect(r.code).toBe(3);
			expect(r.out).toContain(`peer ${PI} is no longer online`);
		} finally {
			killIfRunning(waiter);
		}
	}, 20_000);

	it("--wait implies --require-online: an offline target fails before sending", () => {
		run(["hook", "session-start"], hookJson("SessionStart"));
		writeHeartbeat(dir, { name: PI, ts: Date.now() - 5 * 60_000 });
		const r = run(["send", "--from", SELF, "--wait", "1", PI, "hi"]);
		expect(r.code).toBe(1);
		expect(r.err).toContain("requireOnline is set");
		expect(readIncoming(dir, PI)).toEqual([]);
	}, 120_000);

	it("a reply-wait claims what it prints: the next prompt hook does not show it again", async () => {
		run(["hook", "session-start"], hookJson("SessionStart"));
		writeHeartbeat(dir, { name: PI, ts: Date.now() });
		const waiter = spawnWaiter(["send", "--from", SELF, "--wait", "1", PI, "hi"]);
		try {
			await untilWaiterSent();
			sendEnvelope(dir, newEnvelope(PI, SELF, "reply during the turn"));
			const r = await finish(waiter);
			expect(r.code).toBe(0);
			expect(r.out).toContain("reply during the turn");
		} finally {
			killIfRunning(waiter);
		}

		const next = run(["hook", "prompt"], hookJson("UserPromptSubmit"));
		expect(next.code).toBe(0);
		expect(next.out).not.toContain("reply during the turn");
		expect(readIncoming(dir, SELF)).toEqual([]);
	}, 20_000);

	it("--wait rejects a non-positive or non-numeric value before sending", () => {
		run(["hook", "session-start"], hookJson("SessionStart"));
		writeHeartbeat(dir, { name: PI, ts: Date.now() });
		for (const bad of ["0", "x", "-1"]) {
			const r = run(["send", "--from", SELF, "--wait", bad, PI, "hi"], "", 10_000);
			expect(r.code).toBe(1);
			expect(r.err).toContain("--wait needs a positive number of minutes");
		}
		expect(readIncoming(dir, PI)).toEqual([]);
	}, 120_000);

	it("list shows a pi peer's session log path, else its cwd", () => {
		writeHeartbeat(dir, { name: PI, ts: Date.now(), cwd: "/w", sessionFile: "/s/bug-triage.jsonl" });
		writeHeartbeat(dir, { name: "no-log", ts: Date.now(), cwd: "/w/other" });
		const out = run(["list"]).out;
		expect(out).toContain(`${PI} (online) — /s/bug-triage.jsonl`);
		expect(out).toContain("no-log (online) — /w/other");
	}, 120_000);

	it("a check-in names the target's session log", () => {
		run(["hook", "session-start"], hookJson("SessionStart"));
		writeHeartbeat(dir, { name: PI, ts: Date.now(), sessionFile: "/s/bug-triage.jsonl" });
		const r = run(["send", "--from", SELF, "--wait", "0.03", PI, "hi"]);
		expect(r.code).toBe(4);
		expect(r.out).toContain("Session log: /s/bug-triage.jsonl");
	}, 120_000);
});

describe("several recipients, broadcast flag, and the watch (decision external-tools/014)", () => {
	const BOB = "bob";
	const CAROL = "carol";
	const watchFile = () => join(dir, "_state", `${SELF}.watch.json`);

	function spawnCli(args: string[], extraEnv: Record<string, string> = {}): Bun.Subprocess {
		return Bun.spawn(["bun", CLI, ...args], {
			stdout: "pipe",
			stderr: "pipe",
			env: childEnv({ PI_PEER_MAILBOX: dir, ...extraEnv }),
		});
	}

	async function finish(proc: Bun.Subprocess): Promise<{ code: number; out: string; err: string }> {
		const [code, out, err] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		return { code, out, err };
	}

	function killIfRunning(proc: Bun.Subprocess): void {
		if (proc.exitCode === null) proc.kill();
	}

	// The watch records its pid before its first poll.
	async function untilWatchStarted(): Promise<void> {
		const until = Date.now() + 10_000;
		while (!existsSync(watchFile())) {
			if (Date.now() > until) throw new Error("the watch never recorded its pid");
			await Bun.sleep(50);
		}
	}

	function registerSelf(): void {
		expect(run(["hook", "session-start"], hookJson("SessionStart")).code).toBe(0);
	}

	it("broadcastTargets: online pi peers and external peers, never self or offline peers", () => {
		const peers = [
			{ name: "a", online: true },
			{ name: "b", online: false },
			{ name: "c", online: false, external: true },
			{ name: SELF, online: false, external: true },
		];
		expect(broadcastTargets(peers, SELF, false).map((p) => p.name)).toEqual(["a", "c"]);
	});

	it("broadcastTargets with requireOnline keeps online pi peers only", () => {
		const peers = [
			{ name: "a", online: true },
			{ name: "b", online: false },
			{ name: "c", online: false, external: true },
			{ name: SELF, online: true, external: true },
		];
		expect(broadcastTargets(peers, SELF, true).map((p) => p.name)).toEqual(["a"]);
	});

	it("renderMail marks a broadcast", () => {
		const text = renderMail(SELF, [{ ...newEnvelope(BOB, SELF, "hi"), broadcast: true }]);
		expect(text).toContain("[peer:bob] (broadcast) hi");
	});

	it("send * and a comma list flag every copy as a broadcast; a single name does not", () => {
		registerSelf();
		writeHeartbeat(dir, { name: BOB, ts: Date.now() });
		writeHeartbeat(dir, { name: CAROL, ts: Date.now() });
		writeHeartbeat(dir, { name: "claude-other", ts: Date.now(), external: true });
		writeHeartbeat(dir, { name: "gone", ts: Date.now() - 5 * 60_000 });

		expect(run(["send", "--from", SELF, "*", "all hands"]).code).toBe(0);
		expect(run(["send", "--from", SELF, `${BOB},${CAROL}`, "two"]).code).toBe(0);
		expect(run(["send", "--from", SELF, BOB, "direct"]).code).toBe(0);

		const flagOf = (name: string, text: string) => readIncoming(dir, name).find((e) => e.text === text)?.broadcast;
		expect(flagOf(BOB, "all hands")).toBe(true);
		expect(flagOf(CAROL, "all hands")).toBe(true);
		expect(flagOf("claude-other", "all hands")).toBe(true);
		expect(flagOf(BOB, "two")).toBe(true);
		expect(flagOf(CAROL, "two")).toBe(true);
		expect(flagOf(BOB, "direct")).toBe(false);
		expect(readIncoming(dir, "gone")).toEqual([]);
		expect(readIncoming(dir, SELF)).toEqual([]);
	}, 120_000);

	it("--wait with a list or * is rejected before anything is sent", () => {
		registerSelf();
		writeHeartbeat(dir, { name: BOB, ts: Date.now() });
		writeHeartbeat(dir, { name: CAROL, ts: Date.now() });
		for (const to of [`${BOB},${CAROL}`, "*"]) {
			const r = run(["send", "--from", SELF, "--wait", "1", to, "hi"], "", 10_000);
			expect(r.code).toBe(1);
			expect(r.err).toContain("--wait takes one recipient");
		}
		expect(readIncoming(dir, BOB)).toEqual([]);
		expect(readIncoming(dir, CAROL)).toEqual([]);
	}, 60_000);

	it("a list with one unlisted name fails before any copy is sent", () => {
		registerSelf();
		writeHeartbeat(dir, { name: BOB, ts: Date.now() });
		const r = run(["send", "--from", SELF, `${BOB},nobody`, "hi"]);
		expect(r.code).toBe(1);
		expect(r.err).toContain("not listed");
		expect(readIncoming(dir, BOB)).toEqual([]);
	}, 120_000);

	it("* with no target besides self fails loud", () => {
		registerSelf();
		const r = run(["send", "--from", SELF, "*", "hi"]);
		expect(r.code).toBe(1);
		expect(r.err).toContain("* has no targets");
	}, 120_000);

	it("a broadcast alone does not wake the watch; it stays in the inbox", async () => {
		registerSelf();
		const watcher = spawnCli(["watch", "--from", SELF]);
		try {
			await untilWatchStarted();
			sendEnvelope(dir, newEnvelope(BOB, SELF, "fyi", false, undefined, "steer", true));
			await Bun.sleep(2500);
			expect(watcher.exitCode).toBeNull();
			expect(readIncoming(dir, SELF).map((e) => e.text)).toEqual(["fyi"]);
		} finally {
			killIfRunning(watcher);
		}
	}, 20_000);

	it("a direct envelope wakes the watch: exit 0 with the mail and the pending broadcasts, then the record is gone", async () => {
		registerSelf();
		const watcher = spawnCli(["watch", "--from", SELF]);
		try {
			await untilWatchStarted();
			sendEnvelope(dir, newEnvelope(BOB, SELF, "fyi", false, undefined, "steer", true));
			sendEnvelope(dir, newEnvelope(CAROL, SELF, "direct ask"));
			const r = await finish(watcher);
			expect(r.code).toBe(0);
			expect(r.out).toContain("[peer:bob] (broadcast) fyi");
			expect(r.out).toContain("[peer:carol] direct ask");
			expect(r.out).toContain("handle the mail above");
			expect(readIncoming(dir, SELF)).toEqual([]);
			expect(existsSync(watchFile())).toBe(false);
		} finally {
			killIfRunning(watcher);
		}
	}, 20_000);

	it("a live reply-wait owns its reply: the watch does not claim it", async () => {
		registerSelf();
		writeWait(dir, SELF, { to: BOB, sentAt: Date.now() - 1000, pid: process.pid });
		const watcher = spawnCli(["watch", "--from", SELF]);
		try {
			await untilWatchStarted();
			sendEnvelope(dir, newEnvelope(BOB, SELF, "the answer"));
			await Bun.sleep(2500);
			expect(watcher.exitCode).toBeNull();
			expect(readIncoming(dir, SELF).map((e) => e.text)).toEqual(["the answer"]);
		} finally {
			killIfRunning(watcher);
			removeWatchRecord(dir, SELF);
		}
	}, 20_000);

	it("a reply-wait's reply goes to the waiter, not to a running watch", async () => {
		registerSelf();
		writeHeartbeat(dir, { name: BOB, ts: Date.now() });
		const watcher = spawnCli(["watch", "--from", SELF]);
		const waiter = spawnCli(["send", "--from", SELF, "--wait", "1", BOB, "hi"]);
		try {
			await untilWatchStarted();
			const until = Date.now() + 10_000;
			while (readIncoming(dir, BOB).length === 0) {
				if (Date.now() > until) throw new Error("the wait's send never reached bob");
				await Bun.sleep(50);
			}
			sendEnvelope(dir, newEnvelope(BOB, SELF, "the answer"));
			const w = await finish(waiter);
			expect(w.code).toBe(0);
			expect(w.out).toContain("the answer");
			expect(watcher.exitCode).toBeNull();
		} finally {
			killIfRunning(waiter);
			killIfRunning(watcher);
		}
	}, 20_000);

	it("a prompt hook skips a reply a live reply-wait owns; once the wait ends, the next prompt shows it", () => {
		registerSelf();
		const waitFile = writeWait(dir, SELF, { to: BOB, sentAt: Date.now() - 1000, pid: process.pid });
		sendEnvelope(dir, newEnvelope(BOB, SELF, "waited for"));
		const during = run(["hook", "prompt"], hookJson("UserPromptSubmit"));
		expect(during.out).not.toContain("waited for");
		expect(readIncoming(dir, SELF).map((e) => e.text)).toEqual(["waited for"]);

		rmSync(waitFile);
		const after = run(["hook", "prompt"], hookJson("UserPromptSubmit"));
		expect(after.out).toContain("waited for");
	}, 20_000);

	it("a wait record whose pid is dead is ignored and removed", () => {
		registerSelf();
		const deadPid = Bun.spawnSync(["true"], { env: childEnv() }).pid;
		const staleFile = writeWait(dir, SELF, { to: BOB, sentAt: Date.now() - 1000, pid: deadPid });
		sendEnvelope(dir, newEnvelope(BOB, SELF, "not owned"));
		const r = run(["hook", "prompt"], hookJson("UserPromptSubmit"));
		expect(r.out).toContain("not owned");
		expect(existsSync(staleFile)).toBe(false);
	}, 120_000);

	it("a second watch for the same session is refused, names the live pid, and leaves the first's record", async () => {
		registerSelf();
		const first = spawnCli(["watch", "--from", SELF]);
		try {
			await untilWatchStarted();
			const second = run(["watch", "--from", SELF], "", 10_000);
			expect(second.code).toBe(2);
			expect(second.err).toContain(`pid ${first.pid}`);
			expect(existsSync(watchFile())).toBe(true);
		} finally {
			killIfRunning(first);
		}
	}, 20_000);

	it("a watch exits 3 when its registration is gone", async () => {
		registerSelf();
		const watcher = spawnCli(["watch", "--from", SELF]);
		try {
			await untilWatchStarted();
			removeHeartbeat(dir, SELF);
			const r = await finish(watcher);
			expect(r.code).toBe(3);
			expect(r.out).toContain("no longer registered");
			expect(existsSync(watchFile())).toBe(false);
		} finally {
			killIfRunning(watcher);
		}
	}, 20_000);

	it("the prompt hook nudges a watch when mail arrives and none is live, not when one is", () => {
		registerSelf();
		sendEnvelope(dir, newEnvelope(BOB, SELF, "first"));
		const none = run(["hook", "prompt"], hookJson("UserPromptSubmit"));
		expect(none.out).toContain("no watch is running");
		expect(none.out).toContain(`watch --from ${SELF}`);

		writeWatchRecord(dir, SELF, { pid: process.pid, startedAt: Date.now() });
		sendEnvelope(dir, newEnvelope(BOB, SELF, "second"));
		const live = run(["hook", "prompt"], hookJson("UserPromptSubmit"));
		expect(live.out).toContain("second");
		expect(live.out).not.toContain("no watch is running");
		removeWatchRecord(dir, SELF);
	}, 120_000);

	it("an envelope without a broadcast flag is reported as unreadable, not delivered", () => {
		registerSelf();
		const bad = join(inboxDir(dir, SELF), "bob-old.json");
		writeFileSync(
			bad,
			JSON.stringify({ id: "old", from: BOB, to: SELF, text: "no flag here", expectReply: false, sentAt: Date.now() }),
		);
		const r = run(["hook", "prompt"], hookJson("UserPromptSubmit"));
		expect(r.out).not.toContain("no flag here");
		expect(r.out).toContain(`1 unreadable envelope(s) left in ${inboxDir(dir, SELF)}`);
		expect(existsSync(bad)).toBe(true);
	}, 120_000);

	it("the watch refreshes the registration on its interval and keeps the cwd", async () => {
		registerSelf();
		const before = listPeers(dir).find((p) => p.name === SELF)?.ts ?? 0;
		const watcher = spawnCli(["watch", "--from", SELF], { PI_PEER_WATCH_REFRESH_MS: "100" });
		try {
			await untilWatchStarted();
			const until = Date.now() + 10_000;
			let me = listPeers(dir).find((p) => p.name === SELF);
			while (!me || me.ts <= before) {
				if (Date.now() > until) throw new Error("the watch never refreshed the registration");
				await Bun.sleep(50);
				me = listPeers(dir).find((p) => p.name === SELF);
			}
			expect(me.cwd).toBe("/w");
			expect(me.external).toBe(true);
		} finally {
			killIfRunning(watcher);
		}
	}, 20_000);

	it("the watch refreshes no more often than its interval", async () => {
		registerSelf();
		const before = listPeers(dir).find((p) => p.name === SELF)?.ts ?? 0;
		const watcher = spawnCli(["watch", "--from", SELF], { PI_PEER_WATCH_REFRESH_MS: "60000" });
		try {
			await untilWatchStarted();
			const until = Date.now() + 10_000;
			let first = listPeers(dir).find((p) => p.name === SELF)?.ts ?? 0;
			while (first <= before) {
				if (Date.now() > until) throw new Error("the watch never refreshed the registration");
				await Bun.sleep(50);
				first = listPeers(dir).find((p) => p.name === SELF)?.ts ?? 0;
			}
			// Several polls pass inside the 60 s interval: the timestamp must not move.
			await Bun.sleep(2500);
			expect(listPeers(dir).find((p) => p.name === SELF)?.ts).toBe(first);
			expect(watcher.exitCode).toBeNull();
		} finally {
			killIfRunning(watcher);
		}
	}, 20_000);

	it("the watch exits 3 with one line once its parent process is gone", async () => {
		registerSelf();
		const out = join(dir, "watch.out");
		const record = join(dir, "_state", `${SELF}.watch.json`);
		// The intermediate shell starts the watch, waits for its record (written after it
		// read its parent), prints the watch's pid, and exits. The watch is then reparented.
		const script = [
			`bun ${CLI} watch --from ${SELF} > ${out} 2>&1 &`,
			"W=$!",
			`i=0; while [ ! -f ${record} ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done`,
			'echo "$W"',
		].join("\n");
		const sh = Bun.spawn(["sh", "-c", script], {
			stdout: "pipe",
			stderr: "pipe",
			env: childEnv({ PI_PEER_MAILBOX: dir }),
		});
		const pid = Number((await new Response(sh.stdout).text()).trim());
		expect(await sh.exited).toBe(0);
		try {
			const until = Date.now() + 10_000;
			while (existsSync(record)) {
				if (Date.now() > until) throw new Error("the orphaned watch did not exit");
				await Bun.sleep(100);
			}
			expect(readFileSync(out, "utf8")).toContain("parent process is gone");
		} finally {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// already exited
			}
		}
	}, 30_000);

	it("send --require-online * reaches online pi peers only; with none online it fails", () => {
		registerSelf();
		writeHeartbeat(dir, { name: BOB, ts: Date.now() });
		writeHeartbeat(dir, { name: "claude-other", ts: Date.now(), external: true });
		const ok = run(["send", "--from", SELF, "--require-online", "*", "only online"]);
		expect(ok.code).toBe(0);
		expect(readIncoming(dir, BOB).map((e) => e.text)).toEqual(["only online"]);
		expect(readIncoming(dir, "claude-other")).toEqual([]);

		writeHeartbeat(dir, { name: BOB, ts: Date.now() - 5 * 60_000 });
		const none = run(["send", "--from", SELF, "--require-online", "*", "nobody online"]);
		expect(none.code).toBe(1);
		expect(none.err).toContain("no online pi peer");
		expect(readIncoming(dir, "claude-other")).toEqual([]);
	}, 120_000);
});

describe("watch nudge and atomic envelope writes (decision external-tools/014)", () => {
	it("a prompt with no mail and a live watch emits nothing", () => {
		registerSelfNudge();
		writeWatchRecord(dir, SELF, { pid: process.pid, startedAt: Date.now() });
		const r = run(["hook", "prompt"], hookJson("UserPromptSubmit"));
		expect(r.code).toBe(0);
		expect(r.out).toBe("");
		removeWatchRecord(dir, SELF);
	}, 120_000);

	it("an in-progress temp envelope is not read, and sendEnvelope leaves no temp file behind", () => {
		registerSelfNudge();
		const inbox = inboxDir(dir, SELF);
		writeFileSync(
			join(inbox, ".bob-half.tmp"),
			JSON.stringify({ id: "half", from: "bob", to: SELF, text: "still writing", expectReply: false, sentAt: Date.now(), broadcast: false }),
		);
		const r = run(["hook", "prompt"], hookJson("UserPromptSubmit"));
		expect(r.out).not.toContain("still writing");
		expect(r.out).not.toContain("unreadable");
		expect(existsSync(join(inbox, ".bob-half.tmp"))).toBe(true);

		sendEnvelope(dir, newEnvelope("bob", SELF, "whole"));
		expect(readdirSync(inbox).filter((f) => f.startsWith("."))).toEqual([".bob-half.tmp"]);
	}, 120_000);

	function registerSelfNudge(): void {
		expect(run(["hook", "session-start"], hookJson("SessionStart")).code).toBe(0);
	}
});
