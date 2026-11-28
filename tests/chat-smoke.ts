// Live smoke against the production chat (WO-2026-107 § Live smoke). Manual:
// not part of `bun test`; it runs real pi processes, makes live LLM calls, and
// needs the owner's chatd running (`systemctl --user start chatd`) against
// chat.sjmcd.me.
//
//   bun run tests/chat-smoke.ts
//
// 1. Two pi RPC sessions with throwaway names exchange a DM: alice asks bob
//    with expectReply, and bob's auto-reply comes back to alice.
// 2. Premise P4: the owner @mentions bob from Element X in #peers, picking bob
//    from the mention list (a pill). Element writes the pill's display name in
//    the body, not `@<peer name>`, so bob's injection can only come from
//    `m.mentions.user_ids`. The script prints whether it arrived.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { FLEET_MODEL, FLEET_PROVIDER } from "../extensions/lib/fleet-model.ts";
import { childEnv, scrubSubagentEnv } from "./helpers/subagent-env.ts";

scrubSubagentEnv();

const WORKDIR = await mkdtemp(join(tmpdir(), "chat-smoke-work-"));
const MODEL = process.env.PI_SMOKE_MODEL ?? `${FLEET_PROVIDER}/${FLEET_MODEL}`;
const TAG = Math.random().toString(36).slice(2, 7);
const ALICE = `smoke-alice-${TAG}`;
const BOB = `smoke-bob-${TAG}`;

interface Child {
	proc: ReturnType<typeof spawn>;
	lines: string[];
}

function spawnPeer(name: string): Child {
	const proc = spawn("pi", ["--mode", "rpc", "--model", MODEL], {
		cwd: WORKDIR,
		env: childEnv({ PI_PEER_NAME: name }),
		stdio: ["pipe", "pipe", "pipe"],
	});
	const child: Child = { proc, lines: [] };
	createInterface({ input: proc.stdout! }).on("line", (line) => child.lines.push(line));
	proc.stderr!.on("data", (d) => process.stderr.write(`[${name}:err] ${d}`));
	return child;
}

const rpc = (child: Child, body: Record<string, unknown>) => child.proc.stdin!.write(`${JSON.stringify(body)}\n`);

function waitFor(child: Child, pred: (e: Record<string, any>) => boolean, what: string, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + timeoutMs;
		const check = () => {
			for (const line of child.lines) {
				try {
					if (pred(JSON.parse(line))) return resolve();
				} catch {}
			}
			if (Date.now() > deadline) reject(new Error(`[${what}] timed out after ${timeoutMs} ms\n${child.lines.slice(-15).join("\n")}`));
			else setTimeout(check, 250);
		};
		check();
	});
}

const injected = (child: Child, prefix: string) => (e: Record<string, any>) =>
	e.type === "message_start" && e.message?.role === "user" && String(e.message?.content?.[0]?.text ?? "").startsWith(prefix);

console.log(`spawning ${ALICE} and ${BOB} (${MODEL})...`);
const alice = spawnPeer(ALICE);
const bob = spawnPeer(BOB);
rpc(alice, { id: "s1", type: "get_state" });
rpc(bob, { id: "s2", type: "get_state" });
await Promise.all([
	waitFor(alice, (e) => e.type === "response" && e.command === "get_state" && e.success, "alice ready", 90_000),
	waitFor(bob, (e) => e.type === "response" && e.command === "get_state" && e.success, "bob ready", 90_000),
]);

rpc(alice, {
	id: "p1",
	type: "prompt",
	message: `Use the chat_send tool to send 'hello from alice' to the peer named '${BOB}' with expectReply true. Use no other tool.`,
});
await waitFor(bob, injected(bob, `[peer:${ALICE}]`), "bob received alice's DM", 120_000);
console.log(`1a. ${BOB} received [peer:${ALICE}] …`);
await waitFor(alice, injected(alice, `[peer:${BOB}]`), "alice received bob's auto-reply", 180_000);
console.log(`1b. ${ALICE} received ${BOB}'s auto-reply`);

console.log(`2. In Element X, in #peers, @mention ${BOB} by picking it from the mention list, then send. Waiting 5 minutes...`);
try {
	await waitFor(bob, injected(bob, "[owner in #peers]"), "owner mention", 300_000);
	console.log("P4 holds: Element X wrote m.mentions.user_ids (the pill's body does not carry @<peer name>).");
} catch {
	console.log("P4 not observed: no owner mention reached bob in 5 minutes. Record it in WO-2026-107 § Premises.");
}

alice.proc.kill("SIGTERM");
bob.proc.kill("SIGTERM");
await rm(WORKDIR, { recursive: true, force: true });
process.exit(0);
