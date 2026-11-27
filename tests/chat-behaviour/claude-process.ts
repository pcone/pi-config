/**
 * A stand-in Claude Code process for the Claude-peer rows.
 *
 * A hook or a Bash-tool command of a Claude session runs below the session's
 * `claude` process, and the CLI names that process as the session's (WO-2026-107
 * premise P3: the nearest ancestor whose command is `claude`). The stand-in is a
 * bun script named `claude`, so its comm is `claude`, and every CLI call of one
 * session is its child. It runs commands sent to it over a Unix socket and
 * reports each exit; killing it is the Claude session exiting.
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliResult, Running } from "./bus.ts";

const RUNNER = String.raw`
const [sock, cli] = process.argv.slice(2);
const net = require("node:net");
const fs = require("node:fs");
const children = new Map();
const server = net.createServer((conn) => {
	let buf = "";
	conn.on("data", (d) => {
		buf += d;
		let i;
		while ((i = buf.indexOf("\n")) >= 0) {
			const req = JSON.parse(buf.slice(0, i));
			buf = buf.slice(i + 1);
			if (req.op === "kill") {
				children.get(req.id)?.kill(req.signal ?? "SIGTERM");
				continue;
			}
			const child = Bun.spawn(["bun", cli, ...req.args], {
				stdin: new TextEncoder().encode(req.stdin ?? ""),
				stdout: Bun.file(req.out),
				stderr: Bun.file(req.err),
				env: { ...process.env, ...(req.env ?? {}) },
			});
			children.set(req.id, child);
			conn.write(JSON.stringify({ id: req.id, pid: child.pid }) + "\n");
			child.exited.then((code) => {
				children.delete(req.id);
				conn.write(JSON.stringify({ id: req.id, code }) + "\n");
			});
		}
	});
});
server.listen(sock, () => console.log("ready"));
`;

let seq = 0;

/** A run's output; empty once the row's reset removed the stand-in's directory. */
function readIfThere(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw err;
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export class ClaudeProcess {
	readonly dir: string;
	readonly proc: Bun.Subprocess;
	private conn: Promise<import("node:net").Socket>;
	private pending = new Map<number, { pid?: (pid: number) => void; done: (code: number) => void }>();
	private closed = false;

	private constructor(dir: string, proc: Bun.Subprocess, conn: Promise<import("node:net").Socket>) {
		this.dir = dir;
		this.proc = proc;
		this.conn = conn;
	}

	get pid(): number {
		return this.proc.pid;
	}

	/** Start one stand-in `claude` that runs `bun <cli> …` with `env`. */
	static async start(cli: string, env: NodeJS.ProcessEnv): Promise<ClaudeProcess> {
		const dir = mkdtempSync(join(tmpdir(), "claude-standin-"));
		const script = join(dir, "claude");
		writeFileSync(script, `#!${process.execPath}\n${RUNNER}`);
		chmodSync(script, 0o755);
		const sock = join(dir, "runner.sock");
		const proc = Bun.spawn([script, sock, cli], { env, stdout: "pipe", stderr: "inherit", stdin: "ignore" });
		const reader = proc.stdout.getReader();
		const first = await reader.read();
		if (!new TextDecoder().decode(first.value).includes("ready")) throw new Error("claude stand-in did not start");
		reader.releaseLock();
		const net = await import("node:net");
		const conn = new Promise<import("node:net").Socket>((resolve, reject) => {
			const s = net.createConnection(sock, () => resolve(s));
			s.on("error", reject);
		});
		const cp = new ClaudeProcess(dir, proc, conn);
		const socket = await conn;
		let buf = "";
		socket.on("data", (d) => {
			buf += d;
			let i;
			while ((i = buf.indexOf("\n")) >= 0) {
				const msg = JSON.parse(buf.slice(0, i)) as { id: number; pid?: number; code?: number };
				buf = buf.slice(i + 1);
				const p = cp.pending.get(msg.id);
				if (!p) continue;
				if (msg.pid !== undefined) p.pid?.(msg.pid);
				if (msg.code !== undefined) {
					cp.pending.delete(msg.id);
					p.done(msg.code);
				}
			}
		});
		socket.on("close", () => {
			cp.closed = true;
			for (const p of cp.pending.values()) p.done(-1);
			cp.pending.clear();
		});
		return cp;
	}

	/** Run `bun <cli> …args` as a child of this process. */
	spawn(args: string[], stdin = "", env: Record<string, string> = {}): Running {
		if (this.closed) throw new Error("the claude stand-in has exited");
		const id = ++seq;
		const out = join(this.dir, `${id}.out`);
		const err = join(this.dir, `${id}.err`);
		writeFileSync(out, "");
		writeFileSync(err, "");
		let resolvePid!: (pid: number) => void;
		const pid = new Promise<number>((r) => (resolvePid = r));
		const exited = new Promise<CliResult>((resolve) => {
			this.pending.set(id, {
				pid: resolvePid,
				done: (code) => resolve({ code, out: readIfThere(out), err: readIfThere(err) }),
			});
		});
		void this.conn.then((s) => s.write(`${JSON.stringify({ op: "run", id, args, stdin, out, err, env })}\n`));
		return {
			exited,
			gone: async () => {
				const p = await pid;
				const deadline = Date.now() + 60_000;
				while (alive(p)) {
					if (Date.now() > deadline) throw new Error(`pid ${p} (${args.join(" ")}) still running after 60 s`);
					await Bun.sleep(50);
				}
				return { out: readIfThere(out), err: readIfThere(err) };
			},
			kill: () => {
				void this.conn.then((s) => {
					if (!this.closed) s.write(`${JSON.stringify({ op: "kill", id })}\n`);
				});
			},
		};
	}

	/** Run to completion. Synchronous callers use `runSync`. */
	async run(args: string[], stdin = "", env: Record<string, string> = {}): Promise<CliResult> {
		return this.spawn(args, stdin, env).exited;
	}

	/** The Claude Code process exits. Its children are left running, reparented. */
	async exit(): Promise<void> {
		this.proc.kill("SIGKILL");
		await this.proc.exited;
	}

	dispose(): void {
		if (this.proc.exitCode === null) this.proc.kill("SIGKILL");
		rmSync(this.dir, { recursive: true, force: true });
	}
}
