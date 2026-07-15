/**
 * Async Subagent Extension — Non-blocking subagent execution via RPC mode.
 *
 * Subagents run in background pi processes using RPC mode. The parent
 * remains interactive and can check progress, steer, or stop subagents
 * at any time. Results are delivered as injected user messages.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { truncateToWidth } from "@earendil-works/pi-tui";

// ── Constants ───────────────────────────────────────────────────────────────

const MAX_TURNS_HARD = 500;
const STOP_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const HARD_KILL_DELAY_MS = 5000;
const STARTUP_SUMMARY_EVENT = "pi-config:startup-summary-item";

// ── Progress tracking ───────────────────────────────────────────────────────

interface SubagentProgress {
	turns: number;
	filesRead: Set<string>;
	filesModified: Set<string>;
	lastActions: string[]; // last 5 tool calls, newest last
	errors: string[];
	currentActivity: string;
}

interface RunningSubagent {
	proc: ChildProcess;
	sessionId: string;
	agentName: string;
	task: string;
	cwd: string;
	startedAt: number;
	progress: SubagentProgress;
	messages: any[]; // accumulated messages for final output
	stdin: NodeJS.WritableStream | null;
	resolveOnStop: ((finalMessage?: string) => void) | null; // set by stop tool
	isDone: boolean;
	logPath: string;   // live human-readable event log
	logLines: string[];     // in-memory buffer for live TUI widget
	watchHandle: any;       // setWidget handle for live updates
	sockPath: string;       // Unix socket path for external viewers
	sockServer: net.Server; // socket server
	sockClients: Set<net.Socket>; // connected viewers
	// Worktree isolation
	worktreePath: string | null;
	isolationBranch: string | null;
	parentHeadCommit: string | null;
	parentCwd: string;
}

const running = new Map<string, RunningSubagent>();
// Active wait: resolves when timer fires OR subagent completes
let activeWait: { timer: NodeJS.Timeout } | null = null;

function newProgress(): SubagentProgress {
	return {
		turns: 0,
		filesRead: new Set(),
		filesModified: new Set(),
		lastActions: [],
		errors: [],
		currentActivity: "starting...",
	};
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Run a git command and collect output. */
function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return new Promise((resolve) => {
		const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
		proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
		proc.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
		proc.on("error", () => resolve({ stdout, stderr, exitCode: 1 }));
	});
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

// ── Worktree isolation ────────────────────────────────────────────────────

/** Create an isolated git worktree on a branch off the parent HEAD (or optional baseRef).
 *  Returns null if the cwd is not a git repo or worktree creation fails. */
async function createWorktree(
	parentCwd: string,
	sessionId: string,
	baseRef?: string,
): Promise<{ worktreePath: string; branchName: string; parentHeadCommit: string } | null> {
	try {
		const topLevel = await git(["rev-parse", "--show-toplevel"], parentCwd);
		if (topLevel.exitCode !== 0) return null;

		// Resolve the base commit — use provided ref (branch/tag/commit) or HEAD
		const baseCommitRef = baseRef || "HEAD";
		const headResult = await git(["rev-parse", baseCommitRef], parentCwd);
		if (headResult.exitCode !== 0) return null;
		const parentHeadCommit = headResult.stdout.trim();

		const suffix = sessionId.slice(-12);
		const branchName = `pi-subagent-${suffix}`;
		const worktreePath = path.join(os.tmpdir(), `pi-subagent-wt-${suffix}`);

		// Remove stale leftovers from a previous run with the same session id
		try { await git(["worktree", "remove", "--force", worktreePath], parentCwd); } catch { /* */ }
		try { await git(["branch", "-D", branchName], parentCwd); } catch { /* */ }

		const wtResult = await git(
			["worktree", "add", worktreePath, "-b", branchName, parentHeadCommit],
			parentCwd,
		);
		if (wtResult.exitCode !== 0) return null;

		return { worktreePath, branchName, parentHeadCommit };
	} catch {
		return null;
	}
}

/** Clean up a worktree after subagent completion. Auto-commits uncommitted
 *  changes, removes the worktree directory, and keeps the branch for review.
 *  If the branch has no commits beyond the parent HEAD it is deleted.
 *  Returns a status note for the delivered result. */
async function cleanupWorktree(rs: RunningSubagent): Promise<string> {
	const notes: string[] = [];
	const { worktreePath, isolationBranch, parentHeadCommit, parentCwd } = rs;
	if (!worktreePath || !isolationBranch || !parentHeadCommit) return "";

	try {
		// Stage and commit any uncommitted changes in the worktree
		await git(["add", "-A"], worktreePath);
		const diffResult = await git(["diff", "--cached", "--quiet"], worktreePath);
		if (diffResult.exitCode !== 0) {
			const commitMsg = `subagent(${rs.agentName}): ${rs.task.slice(0, 72)}`;
			await git(["commit", "-m", commitMsg], worktreePath);
			notes.push(`Uncommitted changes auto-committed to \`${isolationBranch}\`.`);
		}

		// Check whether the branch has diverged from the parent HEAD
		const finalHead = await git(["rev-parse", "HEAD"], worktreePath);
		const finalCommit = finalHead.stdout.trim();

		// Remove the worktree directory (branch ref stays in the repo)
		await git(["worktree", "remove", "--force", worktreePath], parentCwd);

		if (finalCommit === parentHeadCommit) {
			// No changes — delete the useless branch
			await git(["branch", "-D", isolationBranch], parentCwd);
			notes.push("No changes made — worktree cleaned up.");
		} else {
			notes.push(`Changes preserved on branch \`${isolationBranch}\`.`);
			notes.push(`Merge with: \`git merge ${isolationBranch}\``);
		}
	} catch (e: any) {
		notes.push(`Worktree cleanup error: ${e.message || e}`);
		// Best-effort: force-remove the worktree directory
		try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch { /* */ }
	}

	return notes.length > 0 ? `\n\n[Isolation] ${notes.join(" ")}` : "";
}

async function writeTempFile(name: string, content: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-async-subagent-"));
	const safeName = name.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await fs.promises.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

function getFinalOutput(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") {
					return part.text.replace(/^\s*\[session_id:[^\]]*\]\s*$/gim, "").trimEnd();
				}
			}
		}
	}
	return "";
}

function extractFilesFromArgs(toolName: string, args: Record<string, any>): { read?: string; write?: string } {
	const result: { read?: string; write?: string } = {};
	const filePath = args.file_path || args.path;
	if (!filePath) return result;

	switch (toolName) {
		case "read":
			result.read = filePath;
			break;
		case "write":
		case "edit":
			result.write = filePath;
			break;
	}
	return result;
}

function formatProgress(rs: RunningSubagent): string {
	const p = rs.progress;
	const elapsed = Math.round((Date.now() - rs.startedAt) / 1000);
	const mins = Math.floor(elapsed / 60);
	const secs = elapsed % 60;
	return [
		`Agent: ${rs.agentName}`,
		`Session: ${rs.sessionId}`,
		`Turns: ${p.turns}`,
		`Elapsed: ${mins}m ${secs}s`,
		`Activity: ${p.currentActivity}`,
		p.filesRead.size > 0 ? `Files read: ${p.filesRead.size}` : null,
		p.filesModified.size > 0 ? `Files modified: ${p.filesModified.size}` : null,
		p.errors.length > 0 ? `Errors: ${p.errors.length}` : null,
	]
		.filter(Boolean)
		.join(" | ");
}

// ── RPC communication ──────────────────────────────────────────────────────

function rpcSend(stdin: NodeJS.WritableStream | null, command: Record<string, any>): void {
	if (!stdin || stdin.destroyed) return;
	stdin.write(JSON.stringify(command) + "\n");
}

interface RpcEvent {
	type: string;
	id?: string;
	message?: any;
	message_end?: any;
}

// ── Spawn & manage ──────────────────────────────────────────────────────────

async function spawnSubagent(
	pi: ExtensionAPI,
	ctx: any,
	agent: AgentConfig,
	task: string,
	cwd: string,
	sessionId: string,
	parentModel: string | undefined,
	inheritParentModel: boolean,
	worktreePath: string | null,
	isolationBranch: string | null,
	parentHeadCommit: string | null,
	parentCwdForCleanup: string,
): Promise<RunningSubagent> {
	const effectiveModel = inheritParentModel ? parentModel : (agent.model ?? "deepseek/deepseek-v4-flash");

	// RPC mode auto-creates sessions — never pass --session for async subagents.
	// Steering happens via stdin to the running process, not by restarting.
	const args: string[] = ["--mode", "rpc"];
	if (effectiveModel) args.push("--model", effectiveModel);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
	if (agent.excludeTools && agent.excludeTools.length > 0) {
		args.push("--exclude-tools", agent.excludeTools.join(","));
	}

	let tmpDir: string | null = null;
	let tmpPath: string | null = null;
	if (agent.systemPrompt.trim()) {
		const tmp = await writeTempFile(agent.name, agent.systemPrompt);
		tmpDir = tmp.dir;
		tmpPath = tmp.filePath;
		args.push("--append-system-prompt", tmpPath);
	}

	const logPath = `/tmp/pi-subagent-${sessionId}.log`;
	const sockPath = `/tmp/pi-subagent-${sessionId}.sock`;

	const rs: RunningSubagent = {
		proc: null as any,
		sessionId,
		agentName: agent.name,
		task,
		cwd,
		startedAt: Date.now(),
		progress: newProgress(),
		messages: [],
		stdin: null,
		resolveOnStop: null,
		isDone: false,
		logPath,
		logLines: [],
		watchHandle: null,
		sockPath,
		sockServer: null as any,
		sockClients: new Set(),
		worktreePath,
		isolationBranch,
		parentHeadCommit,
		parentCwd: parentCwdForCleanup,
	};

	// Unix socket server for external viewers
	try { fs.unlinkSync(sockPath); } catch { /* not there yet */ }
	const sockServer = net.createServer((socket) => {
		rs.sockClients.add(socket);
		// Replay buffered lines so new viewer sees previous output
		for (const line of rs.logLines) {
			try { socket.write(line + "\n"); } catch { /* */ }
		}
		socket.on("close", () => { rs.sockClients.delete(socket); });
		socket.on("error", () => { rs.sockClients.delete(socket); });
	});
	sockServer.listen(sockPath, () => { /* ready */ });
	sockServer.on("error", () => { /* ignore */ });
	rs.sockServer = sockServer;

	// Open the live log file and write the header.
	const logEntry = (text: string) => {
		try { fs.appendFileSync(logPath, text + "\n"); } catch { /* */ }
		rs.logLines.push(text);
		rs.watchHandle?.requestRender();
		for (const client of rs.sockClients) {
			try { client.write(text + "\n"); } catch { rs.sockClients.delete(client); }
		}
	};

	// ANSI style helpers (Catppuccin-like)
	const S = {
		reset: "\x1b[0m",
		bold: "\x1b[1m",
		dim: "\x1b[2m",
		fgCyan: "\x1b[36m",
		fgGreen: "\x1b[32m",
		fgRed: "\x1b[31m",
		fgMagenta: "\x1b[35m",
		fgYellow: "\x1b[33m",
		fgBlue: "\x1b[34m",
		bgBlue: "\x1b[44m",
		bgRed: "\x1b[41m",
		toolPending: "\x1b[34m\x1b[1m",   // bold blue
		toolSuccess: "\x1b[32m",          // green
		toolError: "\x1b[31m\x1b[1m",     // bold red
		turnHdr: "\x1b[2m\x1b[36m",       // dim cyan
		think: "\x1b[2m",                  // dim
		headerFg: "\x1b[34m\x1b[1m",      // bold blue
		doneOk: "\x1b[32m\x1b[1m",        // bold green
		doneFail: "\x1b[31m\x1b[1m",      // bold red
		aside: "\x1b[2m\x1b[35m",          // dim magenta
	};
	const hdr = (lbl: string) => S.headerFg + lbl + S.reset + S.dim;

	logEntry(`${hdr("Agent:")} ${agent.name}  ${hdr("Session:")} ${sessionId}  ${hdr("CWD:")} ${cwd}${S.reset}`);
	logEntry(`${S.dim}Task: ${task.slice(0, 300)}${task.length > 300 ? "…" : ""}${S.reset}`);
	logEntry("");

	let currentTurn = 0;
	let pendingToolCalls: Map<string, string> = new Map(); // toolCallId → summary

	const invocation = getPiInvocation(args);
	const proc = spawn(invocation.command, invocation.args, {
		cwd,
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
		env: {
			...process.env,
			...(agent.allowedSubagents && agent.allowedSubagents.length > 0
				? { PI_SUBAGENT_ALLOWLIST: agent.allowedSubagents.join(",") }
				: {}),
		},
	});

	rs.proc = proc;
	rs.stdin = proc.stdin;

	let stdoutBuffer = "";

	// Debug logging, enabled via PI_ASYNC_DEBUG=1
	const debugLog = process.env.PI_ASYNC_DEBUG
		? (msg: string) => {
			try { fs.appendFileSync("/tmp/pi-async-debug.log", `[${rs.sessionId}] ${msg}\n`); } catch { /* */ }
		  }
		: () => {};
	debugLog("spawned cwd=" + cwd);

	const processLine = (line: string) => {
		if (!line.trim()) return;
		let event: RpcEvent;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}

		debugLog("ev:" + event.type);

		// ── Live log: turn boundaries ──────────────────────────────────
		if (event.type === "turn_start") {
			currentTurn++;
			logEntry(`${S.turnHdr}── Turn ${currentTurn} ──${S.reset}`);
		}

		// ── Live log: tool start ───────────────────────────────────────
		if (event.type === "tool_execution_start") {
			const tn: string = event.toolName || "";
			const ta: Record<string, any> = event.args || {};
			const summary = formatToolAction(tn, ta);
			pendingToolCalls.set(event.toolCallId, summary);
			logEntry(`  ${S.toolPending}▸ ${summary}${S.reset}`);
		}

		// ── Live log: tool end ─────────────────────────────────────────
		if (event.type === "tool_execution_end") {
			const summary = pendingToolCalls.get(event.toolCallId) || event.toolName || "tool";
			pendingToolCalls.delete(event.toolCallId);
			if (event.isError) {
				const errText = typeof event.result === "string"
					? event.result.slice(0, 120)
					: JSON.stringify(event.result).slice(0, 120);
				logEntry(`  ${S.toolError}✖ ${summary}${S.reset} ${S.fgRed}→ ERROR: ${errText}${S.reset}`);
			} else {
				// Extract readable result text
				let resultText = "";
				try {
					if (event.result?.content) {
						for (const c of event.result.content) {
							if (c.type === "text") resultText += c.text;
						}
					}
				} catch { /* */ }
				const trimmed = resultText.trim().slice(0, 200);
				if (trimmed) {
					logEntry(`  ${S.toolSuccess}─ ${trimmed.replace(/\n/g, "\n    ")}${S.reset}`);
				}
			}
		}

		// ── Live log: assistant message content ────────────────────────
		if (event.type === "message_end" && event.message) {
			const msg = event.message;
			if (msg.role === "assistant") {
				for (const part of msg.content) {
					// Thinking / reasoning tokens
					if (part.type === "thinking" && part.thinking?.trim()) {
						const tt = part.thinking.trim().slice(0, 500);
						logEntry(`  ${S.think}[thinking] ${tt.replace(/\n/g, `\n  ${S.think}[thinking] `)}${S.reset}`);
					}
					// Regular text
					if (part.type === "text" && part.text.trim()) {
						const t = part.text.trim();
						logEntry(`  ${t.replace(/\n/g, "\n  ")}${t.includes("\n") ? "" : ""}`);
					}
				}
			}
		}

		// Track session id from response
		if (event.type === "response" && event.id === "session") {
			// session header response
		}

		// Track messages
		if (event.type === "message_end" && event.message) {
			const msg = event.message;
			rs.messages.push(msg);

			if (msg.role === "assistant") {
				rs.progress.turns++;
				updateFooter(ctx);

				// Hard turn limit
				if (rs.progress.turns >= MAX_TURNS_HARD) {
					rs.progress.currentActivity = `hit turn limit (${MAX_TURNS_HARD}), stopping`;
					rs.progress.errors.push(`Turn limit reached (${MAX_TURNS_HARD})`);
					debugLog("turn-limit hit, killing proc");
					proc.kill("SIGTERM");
					setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, HARD_KILL_DELAY_MS);
					return;
				}

				// Detect completion: text-only message (no tool calls) means the
				// model is done. RPC mode keeps stdin open so we must close it to
				// trigger process exit and fire the close handler.
				const hasToolCalls = msg.content.some((c: any) => c.type === "toolCall");
				const hasText = msg.content.some((c: any) => c.type === "text");
				debugLog("msg_end: tc=" + hasToolCalls + " txt=" + hasText + " resolve=" + !!rs.resolveOnStop);
				if (!hasToolCalls && hasText) {
					rs.progress.currentActivity = "completed, closing session";
					rs.isDone = true;
					debugLog("DONE! closing stdin");
					if (rs.stdin && !rs.stdin.destroyed) {
						rs.stdin.end();
					}
				}
			}
		}

		// Track tool execution for progress
		if (event.type === "tool_execution_start") {
			const toolName: string = event.toolName || "";
			const toolArgs: Record<string, any> = event.args || {};
			const files = extractFilesFromArgs(toolName, toolArgs);
			if (files.read) rs.progress.filesRead.add(files.read);
			if (files.write) rs.progress.filesModified.add(files.write);

			const actionSummary = formatToolAction(toolName, toolArgs);
			rs.progress.lastActions.push(actionSummary);
			if (rs.progress.lastActions.length > 5) rs.progress.lastActions.shift();
			rs.progress.currentActivity = actionSummary;
		}

		// Track errors
		if (event.type === "tool_execution_end" && event.isError) {
			const errMsg = typeof event.result === "string" ? event.result : JSON.stringify(event.result);
			rs.progress.errors.push(`${event.toolName}: ${errMsg.slice(0, 200)}`);
		}
	};

	proc.stdout.on("data", (data: Buffer) => {
		const raw = data.toString();
		stdoutBuffer += raw;
		const lines = stdoutBuffer.split("\n");
		stdoutBuffer = lines.pop() || "";
		for (const l of lines) {
			if (l.trim()) processLine(l);
		}
	});

	proc.stderr.on("data", (data: Buffer) => {
		// Accumulate stderr for debugging; don't surface to parent unless needed.
	});

	proc.on("close", async (code) => {
		debugLog("close: code=" + code + " resolve=" + !!rs.resolveOnStop + " done=" + rs.isDone + " turns=" + rs.progress.turns);
		if (stdoutBuffer.trim()) processLine(stdoutBuffer);

		// Write completion footer to live log
		const how = rs.isDone ? "Completed" : (code === 0 ? "Exited" : "Stopped");
		logEntry("");
		const style = rs.isDone ? S.doneOk : S.doneFail;
		logEntry(`${style}── ${how} (${rs.progress.turns} turns, exit ${code ?? "?"}) ──${S.reset}`);

		// Widget stays visible for user to review; they clear it with /watch off

		// Close socket server and clean up
		try {
			for (const client of rs.sockClients) client.destroy();
			rs.sockServer.close();
			fs.unlinkSync(sockPath);
		} catch { /* */ }

		// Worktree isolation: commit changes, remove worktree, keep branch
		const isolationNote = await cleanupWorktree(rs);

		// Clean up temp files
		if (tmpPath) try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
		if (tmpDir) try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }

		// If stop was requested, resolve that waiter (don't double-deliver).
		if (rs.resolveOnStop) {
			rs.resolveOnStop(getFinalOutput(rs.messages) + isolationNote);
			rs.resolveOnStop = null;
		} else {
			cancelWait();
			deliverResult(pi, rs, code ?? 0, isolationNote);
		}

		// Remove from running map
		running.delete(sessionId);
		updateFooter(ctx);
	});

	proc.on("error", () => {
		running.delete(sessionId);
		updateFooter(ctx);
	});

	// Send initial prompt
	rpcSend(proc.stdin, { type: "prompt", message: task });

	return rs;
}

// ── Live Log Viewer TUI Component ────────────────────────────────────────

class LogViewer {
	constructor(
		private lines: string[],
		private agentName: string,
		private sessionId: string,
		private maxHeight: number = 15,
	) {}

	/* TUI state */
	private lastLineCount = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		// Skip cache if lines have grown (live stream)
		if (this.cachedLines && this.cachedWidth === width && this.lastLineCount === this.lines.length) {
			return this.cachedLines;
		}
		this.lastLineCount = this.lines.length;

		const tail = this.lines.slice(-this.maxHeight);
		this.cachedLines = [
			truncateToWidth(`▸ Subagent: ${this.agentName}  |  ${this.sessionId}`, width),
			"",
			...tail.map((l) => truncateToWidth(` ${l}`, width - 1)),
		];
		this.cachedWidth = width;
		return this.cachedLines;
	}
}

function formatToolAction(toolName: string, args: Record<string, any>): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};
	const filePath = (args.file_path || args.path || "") as string;
	const short = filePath ? shortenPath(filePath) : "";

	switch (toolName) {
		case "read": return `read ${short}`;
		case "write": return `write ${short}`;
		case "edit": return `edit ${short}`;
		case "bash": {
			const cmd = (args.command as string) || "...";
			return `bash ${cmd.length > 40 ? cmd.slice(0, 40) + "..." : cmd}`;
		}
		case "grep": return `grep ${args.pattern || "..."}`;
		case "find": return `find ${args.pattern || "..."}`;
		case "subagent": return `subagent ${args.agent || "..."}`;
		case "checkpoint": return "checkpoint";
		default: return toolName;
	}
}

/** Cancel the active wait timer. */
function cancelWait(): void {
	if (activeWait) {
		clearTimeout(activeWait.timer);
		activeWait = null;
	}
}

function deliverResult(pi: ExtensionAPI, rs: RunningSubagent, exitCode: number, isolationNote?: string): void {
	const output = getFinalOutput(rs.messages) || "(no output)";

	const wasAborted = exitCode !== 0 && rs.progress.turns < MAX_TURNS_HARD;
	const prefix = wasAborted ? "[Subagent aborted]" : "[Subagent implement finished]";

	const message = [
		`${prefix} — session: ${rs.sessionId}`,
		`Task: ${rs.task.slice(0, 200)}${rs.task.length > 200 ? "..." : ""}`,
		`Turns: ${rs.progress.turns} | Files read: ${rs.progress.filesRead.size} | Files modified: ${rs.progress.filesModified.size}`,
		rs.progress.errors.length > 0
			? `Errors: ${rs.progress.errors.slice(0, 3).join("; ")}`
			: null,
		isolationNote || null,
		"---",
		output,
	]
		.filter(Boolean)
		.join("\n");

	pi.sendUserMessage(message, { deliverAs: "steer" });
}

// ── Footer ─────────────────────────────────────────────────────────────────

function updateFooter(ctx: any): void {
	if (running.size === 0) {
		ctx.ui.setStatus("subagent-async", undefined);
		return;
	}
	const parts: string[] = [];
	for (const rs of running.values()) {
		parts.push(`${rs.agentName} (${rs.progress.turns}t)`);
	}
	ctx.ui.setStatus("subagent-async", `subagents: ${parts.join(", ")}`);
}

// ── Extension entry point ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── Session lifecycle ──────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		try {
			const agents = discoverAgents(ctx.cwd, "user").agents;
			const agentNames = agents.map((agent) => agent.name).sort();
			const text = `[Subagents] ${agentNames.length} available: ${agentNames.join(", ") || "none"}`;
			pi.events.emit(STARTUP_SUMMARY_EVENT, { key: "subagents", order: 20, text });
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			const text = `[Subagents] Unable to list available subagents: ${detail}`;
			pi.events.emit(STARTUP_SUMMARY_EVENT, { key: "subagents", order: 20, text });
		}

		// Re-attach to orphaned subagents from a previous session
		try {
			const sockDir = "/tmp";
			const files = fs.readdirSync(sockDir).filter((f) => f.startsWith("pi-subagent-") && f.endsWith(".sock"));
			for (const f of files) {
				const sid = f.replace("pi-subagent-", "").replace(".sock", "");
				if (running.has(sid)) continue; // already tracked

				const sockPath = path.join(sockDir, f);
				const logPath = sockPath.replace(".sock", ".log");
				const metaPath = sockPath.replace(".sock", ".meta.json");

				// Read metadata written at spawn time
				let meta: any = null;
				try { meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")); } catch { continue; }

				// Parse current turns from log
				let turns = 0;
				try {
					const log = fs.readFileSync(logPath, "utf-8");
					turns = (log.match(/── Turn (\d+) ──/g) || []).length;
				} catch {}

				const rs: RunningSubagent = {
					proc: null as any,
					sessionId: sid,
					agentName: meta.agentName || "?",
					task: meta.task || "?",
					cwd: meta.cwd || ctx.cwd,
					startedAt: meta.startedAt || Date.now(),
					progress: { turns, filesRead: new Set(), filesModified: new Set(), errors: [], currentActivity: "recovered" },
					messages: [],
					stdin: null,
					resolveOnStop: null,
					isDone: false,
					logPath,
					logLines: [],
					watchHandle: null,
					sockPath,
					sockServer: null as any,
					sockClients: new Set(),
					worktreePath: meta.worktreePath || null,
					isolationBranch: meta.isolationBranch || null,
					parentHeadCommit: meta.parentHeadCommit || null,
					parentCwd: meta.parentCwd || ctx.cwd,
				};

				// Monitor via socket — when it closes, subagent exited.
				// The socket may already be dead (previous pi died without
				// cleanup), in which case connect() fails with ECONNREFUSED.
				// Without an `error` handler that event becomes an
				// uncaughtException and crashes the new pi session.
				const sock = net.createConnection(sockPath);
				let connected = false;
				sock.on("connect", () => {
					connected = true;
				});
				sock.on("error", () => {
					rs.sockClients.delete(sock);
					if (connected) return; // socket lived, then died — close handler will run
					// Orphan: previous session left a sock file behind with no listener.
					// Clean up and skip live tracking.
					try {
						fs.unlinkSync(sockPath);
					} catch {
						/* already gone */
					}
					running.delete(sid);
					updateFooter(ctx);
				});
				sock.on("close", () => {
					rs.sockClients.delete(sock);
					if (!connected) return; // orphan already handled in error handler
					rs.isDone = true;
					// Read final output from log
					let finalOutput = "(no output)";
					try {
						const log = fs.readFileSync(logPath, "utf-8");
						const match = log.match(/── (Completed|Exited|Stopped) \((\d+) turns, exit (\d+)\)/);
						if (match) {
							rs.progress.turns = parseInt(match[2]);
							finalOutput = log.split("── ").pop()?.trim() || finalOutput;
						}
					} catch {}
					deliverResult(pi, rs, 0, `\n[Isolation] Recovered from previous session.`);
					running.delete(sid);
					updateFooter(ctx);
				});

				rs.sockClients.add(sock);
				running.set(sid, rs);
				updateFooter(ctx);
			}
		} catch { /* best-effort */ }
	});

	pi.on("session_shutdown", () => {
		// Don't kill subagents — they survive parent reloads/restarts.
		// Their work commits to branches and is recoverable via git merge.
		// Socket servers and log files persist at /tmp/pi-subagent-<sid>.*
	});

	// ── /subagents command ──────────────────────────────────────────────

	pi.registerCommand("subagents", {
		description: "List running async subagents",
		handler: async (_args, ctx) => {
			if (running.size === 0) {
				ctx.ui.notify("No subagents running.");
				return;
			}
			const lines = Array.from(running.values()).map((rs) => formatProgress(rs));
			ctx.ui.notify(lines.join("\n\n"));
		},
	});

	pi.registerCommand("watch", {
		description: "Show a live log panel for a running subagent. Usage: /watch <session-id> or /watch off",
		handler: async (args, ctx) => {
			const sid = args.trim();

			// Turn off current watch if "off" or empty
			if (!sid || sid === "off") {
				ctx.ui.setWidget("subagent-watch", undefined);
				ctx.ui.notify("Watch cleared.");
				return;
			}

			// Match by full session ID or partial match
			let rs: RunningSubagent | undefined;
			for (const [id, r] of running) {
				if (id === sid || id.endsWith(sid)) {
					rs = r;
					break;
				}
			}
			if (!rs) {
				ctx.ui.notify(`No running subagent matching "${sid}".`);
				return;
			}

			// Build the widget
			const viewer = new LogViewer(
				rs.logLines,
				rs.agentName,
				rs.sessionId,
			);
			rs.watchHandle = ctx.ui.setWidget("subagent-watch", () => viewer, { placement: "belowEditor" });

			ctx.ui.notify(`Watching ${rs.agentName} (${rs.sessionId}). Use /watch off to close.`);
		},
	});

	// ── Tools ───────────────────────────────────────────────────────────

	const SubagentParams = Type.Object({
		agent: Type.String({ description: "Name of the agent to invoke" }),
		task: Type.String({ description: "Task to delegate" }),
		cwd: Type.Optional(Type.String({ description: "Working directory for the subagent process" })),
		inheritParentModel: Type.Optional(
			Type.Boolean({
				description: "Use the parent session's active model instead of the agent default.",
				default: false,
			}),
		),
		isolate: Type.Optional(
			Type.Boolean({
				description: "Run in an isolated git worktree to avoid file conflicts with concurrent subagents. Default: true. When true, a git worktree is created on a branch off the parent HEAD. On completion, uncommitted changes are auto-committed to that branch, the worktree is removed, and the branch remains for the calling session to inspect and merge.",
				default: true,
			}),
		),
		baseRef: Type.Optional(
			Type.String({
				description: "Git ref (commit hash, branch, or tag) to fork the worktree from. Defaults to HEAD if omitted. Use this when changes are on a feature branch that isn't ready for main — pass the branch name or ref. If changes are only in the working tree, create a feature branch, commit them, and pass that branch.",
			}),
		),
	});

	const StatusParams = Type.Object({
		session_id: Type.String({ description: "Session ID of the running subagent" }),
	});

	const SteerParams = Type.Object({
		session_id: Type.String({ description: "Session ID of the running subagent" }),
		message: Type.String({ description: "Steering message to inject" }),
	});

	const StopParams = Type.Object({
		session_id: Type.String({ description: "Session ID of the running subagent" }),
		final_message: Type.Optional(
			Type.String({ description: "Final steering message before stopping" }),
		),
	});

	// ── subagent ───────────────────────────────────────────────────────

	pi.registerTool({
		name: "subagent",
		label: "Subagent (async)",
		description:
			"Spawn a subagent that runs in the background. The parent remains interactive. " +
			"Use subagent_status to check progress, subagent_steer to inject guidance, " +
			"and subagent_stop to tell it to wrap up. Results are delivered as a user message when the subagent finishes.",
		parameters: SubagentParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sessionId = `subagent-${randomUUID()}`;
			const cwd = params.cwd ?? ctx.cwd;

			const agents = discoverAgents(cwd, "user").agents;
			const agent = agents.find((a) => a.name === params.agent);
			if (!agent) {
				const available = agents.map((a) => a.name).join(", ") || "none";
				return {
					content: [{ type: "text", text: `Unknown agent: "${params.agent}". Available: ${available}` }],
				};
			}

			// Check if the parent restricted sub-spawning via PI_SUBAGENT_ALLOWLIST
			const allowlist = process.env.PI_SUBAGENT_ALLOWLIST;
			if (allowlist) {
				const allowed = new Set(
					allowlist.split(",").map((a: string) => a.trim()).filter(Boolean),
				);
				if (!allowed.has(agent.name)) {
					const requested = agent.name;
					const allowedList = [...allowed].sort().join(", ") || "(empty)";
					return {
						content: [{
							type: "text",
							text:
								`Agent "${requested}" is not in this subagent's allowlist ` +
								`(${allowedList}). The parent's \`allowedSubagents\` field ` +
								`restricted sub-spawning to that set.`,
						}],
					};
				}
			}

			// Check if session is already running
			if (running.has(sessionId)) {
				return {
					content: [{ type: "text", text: `Subagent ${sessionId} is already running.` }],
				};
			}

			const parentModel = (() => {
				try { const m = ctx.getModel?.(); if (m?.provider && m?.id) return `${m.provider}/${m.id}`; } catch { /* */ }
				return undefined;
			})();

			// Worktree isolation (default: true)
			let effectiveCwd = cwd;
			let worktreePath: string | null = null;
			let isolationBranch: string | null = null;
			let parentHeadCommit: string | null = null;
			let isolationStatus = "";
			let taskForAgent = params.task;

			if (params.isolate !== false) {
				const wt = await createWorktree(cwd, sessionId, params.baseRef);
				if (wt) {
					effectiveCwd = wt.worktreePath;
					worktreePath = wt.worktreePath;
					isolationBranch = wt.branchName;
					parentHeadCommit = wt.parentHeadCommit;
					isolationStatus = `\nIsolated in worktree \`${wt.branchName}\` (off \`${wt.parentHeadCommit.slice(0, 8)}\`)`;
					taskForAgent =
						`## Worktree isolation\n` +
						`You are running inside an isolated git worktree at \`${wt.worktreePath}\`, branched from \`${wt.parentHeadCommit.slice(0, 12)}\`. ` +
						`Your cwd is the worktree root. Edits go to the worktree branch; the harness auto-commits uncommitted changes, removes the worktree, and keeps the branch for review.\n\n` +
						`If the task lists paths like \`/Users/<owner>/<parent-repo>/foo/bar.rs\`, strip the parent prefix and use \`foo/bar.rs\` as a repo-relative path. Never \`cd\` to an absolute parent-repo path — that bypasses isolation.\n\n` +
						params.task;
				} else {
					isolationStatus = "\n(Worktree isolation unavailable — not a git repo or creation failed.)";
				}
			}

			const rs = await spawnSubagent(
				pi,
				ctx,
				agent,
				taskForAgent,
				effectiveCwd,
				sessionId,
				parentModel,
				params.inheritParentModel ?? false,
				worktreePath,
				isolationBranch,
				parentHeadCommit,
				cwd,
			);

			running.set(sessionId, rs);

		// Write metadata for recovery on session reload
		try {
			fs.writeFileSync(`/tmp/pi-subagent-${sessionId}.meta.json`, JSON.stringify({
				agentName: agent.name,
				task: params.task,
				cwd,
				startedAt: rs.startedAt,
				worktreePath,
				isolationBranch,
				parentHeadCommit,
				parentCwd: cwd,
			}));
		} catch {}

			updateFooter(ctx);

			return {
				content: [
					{
						type: "text",
						text: [
							`Subagent started: ${agent.name} (session: ${sessionId})${isolationStatus}`,
							`Task: ${params.task.slice(0, 200)}${params.task.length > 200 ? "..." : ""}`,
							"",
							"Watch live:",
							"```bash",
							`tail -f /tmp/pi-subagent-${sessionId}.log`,
							"```",
							"Or in-pi: /watch " + sessionId.slice(-8),
							"Or from another terminal: nc -U /tmp/pi-subagent-" + sessionId + ".sock",
							"Use /subagents to check progress.",
						].join("\n"),
					},
				],
			};
		},
	});

	// ── subagent_status ────────────────────────────────────────────────

	pi.registerTool({
		name: "subagent_status",
		label: "Subagent Status",
		description: "Check the progress of a running async subagent.",
		parameters: StatusParams,
		async execute(_toolCallId, params) {
			const rs = running.get(params.session_id);
			if (!rs) {
				// Check if it finished recently — result might still be in flight
				return {
					content: [
						{
							type: "text",
							text: `No running subagent found with session "${params.session_id}". It may have already finished or been stopped.`,
						},
					],
				};
			}

			return {
				content: [{ type: "text", text: formatProgress(rs) }],
			};
		},
	});

	// ── wait ──────────────────────────────────────────────────────────

	const WaitParams = Type.Object({
		seconds: Type.Number({ description: "Number of seconds to wait", minimum: 1, maximum: 300 }),
	});

	pi.registerTool({
		name: "wait",
		label: "Wait",
		description: "Set a non-blocking timer. Returns immediately. After N seconds, if no subagent has completed during the interval, a wake-up message is sent. If a subagent completes before the timer fires, the wake-up is cancelled. Only one wait can be active at a time — calling wait again while waiting returns an error. Use this instead of 'sleep' when waiting for subagent results.",
		parameters: WaitParams,
		async execute(_toolCallId, params) {
			if (activeWait) {
				return { content: [{ type: "text", text: `Already waiting — a timer is active.` }], terminate: true };
			}

			const w = { timer: null as NodeJS.Timeout | null };
			w.timer = setTimeout(() => {
				activeWait = null;
				pi.sendUserMessage(`[timer] ${params.seconds}s elapsed — no subagent completed. Use subagent_status to check.`, { deliverAs: "steer" });
			}, params.seconds * 1000);
			activeWait = w;

			return { content: [{ type: "text", text: `Timer set for ${params.seconds}s.` }], terminate: true };
		},
	});

	// ── subagent_steer ─────────────────────────────────────────────────

	pi.registerTool({
		name: "subagent_steer",
		label: "Subagent Steer",
		description: "Inject a steering message into a running async subagent. The message is delivered before the subagent's next LLM call.",
		parameters: SteerParams,
		async execute(_toolCallId, params) {
			const rs = running.get(params.session_id);
			if (!rs) {
				return {
					content: [
						{
							type: "text",
							text: `No running subagent found with session "${params.session_id}".`,
						},
					],
				};
			}

			rpcSend(rs.stdin, {
				type: "prompt",
				message: params.message,
				streamingBehavior: "steer",
			});

			return {
				content: [
					{
						type: "text",
						text: `Steering message sent to ${rs.agentName} (${params.session_id}): "${params.message}"`,
					},
				],
			};
		},
	});

	// ── subagent_stop ──────────────────────────────────────────────────

	pi.registerTool({
		name: "subagent_stop",
		label: "Subagent Stop",
		description: "Tell a running async subagent to wrap up and return a summary. Waits up to 5 minutes for the subagent to finish.",
		parameters: StopParams,
		async execute(_toolCallId, params, signal) {
			const rs = running.get(params.session_id);
			if (!rs) {
				return {
					content: [
						{
							type: "text",
							text: `No running subagent found with session "${params.session_id}".`,
						},
					],
				};
			}

			// Send final steer if provided
			const finalMsg = params.final_message || "Wrap up your current work and return a summary. Do not start new tasks.";
			rpcSend(rs.stdin, {
				type: "prompt",
				message: finalMsg,
				streamingBehavior: "steer",
			});

		// Wait for subagent to finish, with timeout
			// The worker won't exit on its own (RPC mode keeps it alive).
			// We rely on the isDone detection (text-only message) to close
			// stdin, which triggers process exit → close handler → resolveOnStop.
			// Fallback: force-kill after a generous timeout.
			const result = await new Promise<string>((resolve) => {
				let resolved = false;
				const finish = (text: string) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(fallbackTimeout);
					if (signal) {
						try { signal.removeEventListener("abort", onAbort); } catch { /* */ }
					}
					resolve(text);
				};

				// Fallback: force-kill the process if it doesn't finish naturally.
				const fallbackTimeout = setTimeout(() => {
					rs.proc.kill("SIGTERM");
					setTimeout(() => {
						if (!rs.proc.killed) rs.proc.kill("SIGKILL");
						finish("[Force-stopped after timeout]");
					}, HARD_KILL_DELAY_MS);
				}, STOP_TIMEOUT_MS);

				rs.resolveOnStop = (finalOutput?: string) => {
					finish(finalOutput || "(no output)");
				};

				// If already done (subagent finished before we set resolveOnStop),
				// close stdin now to trigger exit.
				if (rs.isDone && rs.stdin && !rs.stdin.destroyed) {
					rs.stdin.end();
				}

				const onAbort = () => finish("[Aborted]");
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
			});

			return {
				content: [
					{
						type: "text",
						text: `${rs.agentName} (${params.session_id}) stopped.\n\n${result}`,
					},
				],
			};
		},
	});
}
