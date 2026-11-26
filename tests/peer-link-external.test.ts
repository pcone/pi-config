/**
 * External peers (peer-link/external.ts): registration semantics in the
 * mailbox layer, plus the CLI driven as Claude Code hooks would drive it
 * (real subprocesses against a temp $PI_PEER_MAILBOX).
 *
 * Run: bun test tests/peer-link-external.test.ts
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	EXTERNAL_TTL_MS,
	claimIncoming,
	deliveryDecision,
	listPeers,
	newEnvelope,
	readIncoming,
	sendEnvelope,
	sweepStalePeers,
	writeHeartbeat,
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
		expect(again.out).toBe(""); // nothing pending → no context

		expect(run(["hook", "session-end"], hookJson("SessionEnd")).code).toBe(0);
		expect(listPeers(dir).some((p) => p.name === SELF)).toBe(false);
	}, 120_000);

	it("a prompt claims its mail: an Escape-aborted prompt does not re-emit it", () => {
		run(["hook", "session-start"], hookJson("SessionStart"));
		sendEnvelope(dir, newEnvelope("bug-triage", SELF, "mail lost to Escape"));

		const first = run(["hook", "prompt"], hookJson("UserPromptSubmit"));
		expect(first.out).toContain("mail lost to Escape");
		// Escape: the turn is aborted. The mail is gone, and the next prompt shows nothing.
		const second = run(["hook", "prompt"], hookJson("UserPromptSubmit"));
		expect(second.out).toBe("");
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
