/**
 * The spawn loop: start a child `pi` in RPC mode, open its socket and log, decode
 * its event stream into progress and activity, and hand the run to the close
 * handler — which pre-commits, delivers, and schedules the worktree's removal.
 *
 * The largest piece of the extension, and the last extraction of WO-2026-095.
 * Behaviour is unchanged.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs";
import * as net from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MAX_TURNS_HARD } from "../lib/subagent-state.ts";
import { validateOwnerAsks } from "../lib/owner-row.ts";
import type { AgentConfig } from "./agents.ts";
import { closeWorkRecord } from "./records.ts";
import {
	reportDeclaresOwnerAsks,
} from "./recovery.ts";
import {
	buildSubagentArgs,
	buildSubagentProcessEnv,
	bumpActivity,
	resolveGlobalAppendPrompt,
	rpcSend,
	steerChild,
	taskDeclaresPolicySkip,
	type RpcEvent,
} from "./rpc.ts";
import {
	armSilenceTimer,
	deliverCloseResult,
	deliverResult,
	dispatchKillSignals,
	terminalOutcome,
} from "./sleep-guard.ts";
import { turnCapTurn, turnsUsed } from "./turn-cap.ts";
import { notifyChildDetached, updateFooter } from "./ui.ts";
import {
	getFinalOutput,
	postDeliveryCleanup,
	preCommitSteps,
	writeTempFile,
	type CarriedSnapshot,
} from "./worktree.ts";
import {
	ACTIVITY_EVENT_TYPES,
	PI_ASYNC_DEBUG,
	SILENCE_TIMEOUT_DEFAULT_MS,
	TURN_NUDGE_SOFT,
	attachedSessionId,
	clearActiveWait,
	bumpStaleWatchdog,
	debugLog,
	detach,
	eventCountsAsActivity,
	extractFilesFromArgs,
	formatToolAction,
	getPiInvocation,
	getParentTrackerKey,
	newProgress,
	readPersistedSpawns,
	running,
	updateMetaJson,
	type RunningSubagent,
} from "./index.ts";

export async function spawnSubagent(
	pi: ExtensionAPI,
	ctx: any,
	agent: AgentConfig,
	task: string,
	cwd: string,
	sessionId: string,
	// Resolved by the caller through resolveChildModel (decision 031) and used
	// verbatim — the spawn args and the meta.json record consume one value, so
	// they cannot disagree. Resume passes the recorded `meta.model`.
	resolvedModel: string | undefined,
	worktreePath: string | null,
	isolationBranch: string | null,
	parentHeadCommit: string | null,
	parentCwdForCleanup: string,
	/** Shared per-clone cargo target dir; null for unisolated and resumed runs. */
	cargoTargetDir: string | null,
	// When set, the subprocess loads an existing session file instead of
	// creating a new one. Used by subagent_resume.
	resumeSessionFile?: string,
	// Mirrors the work-order `review_policy` field. When `skip`, suppresses
	// the harness's post-implementation review guard for this spawn. Ad-hoc
	// dispatches without a work order should pass `"skip"` here.
	reviewPolicy?: "required" | "skip",
	// Full message delivered to the child. Defaults to `task`. The worktree-
	// isolation preamble + review-policy annotation are delivery wrappers that
	// must reach the child but must NOT pollute `task` — `task` is the clean
	// identity used for the auto-commit subject and result display.
	// See decisions/subagents/009-clean-task-identity.md.
	promptMessage?: string,
	// Snapshot of the parent's uncommitted state carried into the worktree
	// (WO-2026-035), for the preCommitSteps completion filter. Trailing and
	// optional: undefined/null when no carry happened (carryUncommitted:false,
	// baseRef, or no worktree). In-memory only — no persistence.
	carriedSnapshot?: CarriedSnapshot,
	// Parsed `review_policy` from the referenced work order (decision 014),
	// set only when the spawn passed `workOrderPath`. When set, it is the
	// single source of truth for the review gate — it wins over
	// `reviewPolicy` and the task-text bullet on disagreement.
	workOrderPolicy?: "required" | "skip",
	// Decision 015 stage-2: silence-based auto-kill. The child is killed
	// after `silenceTimeoutMs` with no activity (no tool calls AND no
	// assistant messages). Default 30 min; 0 or negative disables.
	silenceTimeoutMs?: number,
	// Decision 046: the per-dispatch turn cap, already resolved by the caller
	// through `resolveTurnCap` (0 → disabled → Infinity). Required: a caller that
	// forgets it would silently run uncapped.
	resolvedTurnCap?: number,
	// Decision 046: turns used by the earlier runs of this same dispatch (the
	// recorded count on a resume, 0 on a fresh spawn).
	turnsBefore?: number,
): Promise<RunningSubagent> {
	// Message actually delivered to the child process. `task` stays the clean
	// identity (commit subject / "Task:" display); the preamble and
	// review-policy annotation live only in promptForChild.
	const promptForChild = promptMessage ?? task;

	// The shared global prompt (decisions/subagents/025-global-append-for-subagents.md).
	// pi's resource loader discovers <agentDir>/APPEND_SYSTEM.md only when no
	// explicit append source is given (`if (!appendSources) { …
	// discoverAppendSystemPromptFile() … }`, dist/core/resource-loader.js).
	// We always pass the agent body below when it is non-empty, which suppresses
	// that discovery — so inject the global file explicitly or subagents never
	// see it. Global first, agent body last, so the role prompt wins on conflict.
	//
	// We deliberately do NOT mirror <cwd>/.pi/APPEND_SYSTEM.md: pi gates that
	// project file on a project-trust check (isProjectTrusted) the spawner
	// cannot re-run, so injecting an untrusted repo's file would bypass it.
	const globalAppendPath = resolveGlobalAppendPrompt();

	// Write the agent body to a temp file (if any) before composing argv, so
	// buildSubagentArgs stays the single composition point for every
	// --append-system-prompt flag.
	let tmpDir: string | null = null;
	let tmpPath: string | null = null;
	if (agent.systemPrompt.trim()) {
		const tmp = await writeTempFile(agent.name, agent.systemPrompt);
		tmpDir = tmp.dir;
		tmpPath = tmp.filePath;
	}
	const appendSystemPrompts = [globalAppendPath, tmpPath ?? undefined]
		.filter((p): p is string => typeof p === "string" && p.length > 0);

	// Build spawn args via shared helper (also used by tests).
	// Fresh spawn: pass the tracking id as --session-id so the child's pi
	// session id IS the handle. Resume: reopen the existing session file
	// (its header id is the handle), which keeps the same id.
	const args = buildSubagentArgs({
		model: resolvedModel ?? "",
		tools: agent.tools ?? [],
		excludeTools: agent.excludeTools ?? [],
		sessionFile: resumeSessionFile,
		sessionId: resumeSessionFile === undefined ? sessionId : undefined,
		appendSystemPrompts,
	});

	const logPath = `/tmp/pi-subagent-${sessionId}.log`;
	const sockPath = `/tmp/pi-subagent-${sessionId}.sock`;

	// Decision 014: the review gate keys on the WORK ORDER when one is
	// referenced (workOrderPolicy), else on the tool param / a bold declaration
	// in the task text (prior behavior). With a WO present, its parsed policy
	// wins on disagreement — the task-text fallback applies only to WO-less
	// dispatches. Computed before the RS record so the soft-prompt guard and
	// `subagent_review_status` see the same value.
	const effectiveReviewPolicy = workOrderPolicy ?? reviewPolicy;
	const gateSkipped =
		effectiveReviewPolicy === "skip" ||
		(workOrderPolicy === undefined && taskDeclaresPolicySkip(task));

	// Decision 015 stage-2: resolve the per-spawn silence timeout. Undefined
	// → 30-min default; 0/negative (and NaN/Infinity) → disabled (0).
	const effectiveSilenceTimeoutMs = silenceTimeoutMs === undefined
		? SILENCE_TIMEOUT_DEFAULT_MS
		: (Number.isFinite(silenceTimeoutMs) && silenceTimeoutMs > 0 ? silenceTimeoutMs : 0);

	// Neither can be guessed: an absent cap would run uncapped and an absent turn
	// count would restart the count a resume is supposed to continue — the exact
	// safe-default failures decision 046 refuses.
	if (resolvedTurnCap === undefined || turnsBefore === undefined) {
		throw new Error("spawnSubagent: resolvedTurnCap and turnsBefore are required (decision 046)");
	}

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
		procExited: false,
		recoveredFooterWord: null,
		killedExplicitly: false,
		stoppedExplicitly: false,
		turnNudged: false,
		turnCap: resolvedTurnCap,
		turnsBefore,
		turnCapReached: false,
		stall: {
			stallTurns: 0,
			stallSteered: false,
			// No branch to watch until the first observation says otherwise.
			stallObserved: false,
			// The isolation branch starts at the parent's HEAD, so that commit is
			// the baseline the first turn's observation compares against.
			lastTip: isolationBranch ? parentHeadCommit : null,
			pending: null,
			// The first fold settles every turn since spawn.
			foldedTurn: turnsBefore,
			inFlight: false,
		},
		logPath,
		logLines: [],
		stderrLines: [],
		watchHandle: null,
		sockPath,
		sockServer: null as any,
		sockClients: new Set(),
		worktreePath,
		isolationBranch,
		parentHeadCommit,
		parentCwd: parentCwdForCleanup,
		parentTrackerKey: getParentTrackerKey(ctx),
		reviewParentRequirements: gateSkipped ? undefined : agent.reviewParentRequirements,
		ownerAsksRequired: reportDeclaresOwnerAsks(agent.systemPrompt),
		usageStats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, latestCacheHitRate: undefined },
		carried: carriedSnapshot ?? null,
		lastActivityMs: Date.now(),
		silenceTimer: null,
		silenceTimeoutMs: effectiveSilenceTimeoutMs,
		killedVia: null,
		toolInFlight: 0,
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
		// Decision 015: any log output counts as activity — a child emitting
		// logs is alive, so the stage-2 silence-kill timer must not fire.
		bumpActivity(rs);
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
	logEntry(`${S.dim}Task: ${promptForChild.slice(0, 300)}${promptForChild.length > 300 ? "…" : ""}${S.reset}`);
	logEntry("");

	let currentTurn = 0;
	let pendingToolCalls: Map<string, string> = new Map(); // toolCallId → summary

	const invocation = getPiInvocation(args);
	const proc = spawn(invocation.command, invocation.args, {
		cwd,
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
		env: buildSubagentProcessEnv({
			sessionId,
			allowlist: agent.allowedSubagents,
			worktreePath,
			parentCwdForCleanup,
			cargoTargetDir,
		}),
	});

	rs.proc = proc;
	rs.stdin = proc.stdin;

	// Swallow EPIPE/stream errors from writing to a dying child's stdin.
	// Without a listener, an 'error' event on the write stream is an
	// unhandled exception and would crash the parent session.
	rs.stdin?.on("error", (err: Error) => {
		debugLog(`subagent stdin error: ${err.message}`);
	});

	// Earliest liveness signal: the process has exited, even though the
	// close handler (running-map removal) may lag behind. Steer/stop must
	// not write into the dead pipe.
	proc.on("exit", () => {
		rs.procExited = true;
	});

	let stdoutBuffer = "";

	// Debug logging, enabled via PI_ASYNC_DEBUG=1
	const debugLog = PI_ASYNC_DEBUG
		? (msg: string) => {
			try { fs.appendFileSync("/tmp/pi-async-debug.log", `[${rs.sessionId}] ${msg}\n`); } catch { /* */ }
		  }
		: () => {};
	debugLog("spawned cwd=" + cwd);

	// Track spawn-to-first-RPC-response latency for timing instrumentation.
	const spawnTime = PI_ASYNC_DEBUG ? Date.now() : 0;
	let firstRpcSeen = false;

	const processLine = (line: string) => {
		if (!line.trim()) return;
		let event: RpcEvent;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}

		if (PI_ASYNC_DEBUG && !firstRpcSeen) {
			firstRpcSeen = true;
			debugLog(`spawn-to-first-rpc (${event.type}): ${Date.now() - spawnTime}ms`);
		}

		debugLog("ev:" + event.type);

		// ── Capture session info from get_state response ───────────────
		if (event.type === "response" && event.id === getStateId) {
			const data = (event as any).data;
			if ((event as any).success && data) {
				rs.sessionFile = data.sessionFile;
				rs.piSessionId = data.sessionId;
				debugLog(`get_state: sessionFile=${rs.sessionFile} piSessionId=${rs.piSessionId}`);
				// Persist to meta so subagent_resume can discover the file later.
				// The meta file was already written by the spawn caller with
				// the agent config fields; we add only sessionFile / piSessionId.
				updateMetaJson(sessionId, {
					sessionFile: rs.sessionFile,
					piSessionId: rs.piSessionId,
				});
			}
		}

		// ── Live log: turn boundaries ──────────────────────────────────
		if (event.type === "turn_start") {
			currentTurn++;
			logEntry(`${S.turnHdr}── Turn ${currentTurn} ──${S.reset}`);
		}

		// ── Live log: tool start ───────────────────────────────────────
		if (event.type === "tool_execution_start") {
			// (activity bump via the union classifier below)
			rs.toolInFlight++; // a tool is now running — suppress the stale-turn
			                   // watchdog's "stalled" alarm while it executes
			const tn: string = event.toolName || "";
			const ta: Record<string, any> = event.args || {};
			const summary = formatToolAction(tn, ta);
			pendingToolCalls.set(event.toolCallId, summary);
			logEntry(`  ${S.toolPending}▸ ${summary}${S.reset}`);
		}

		// ── Live log: tool end ─────────────────────────────────────────
		if (event.type === "tool_execution_end") {
			// (activity bump via the union classifier below)
			if (rs.toolInFlight > 0) rs.toolInFlight--;
			// Re-arm the stalled-turn watchdog so a completed tool starts a fresh
			// 5-minute window — otherwise a subagent that finishes a long tool and
			// is mid-LLM-call when the (old-deadline) timer fires would get a false
			// "stalled" notice. (The turn's own message_end also re-arms.)
			bumpStaleWatchdog(pi, rs);
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

		// ── Activity signal: the decision-015 union (guards 3+4) ────────
		// One classifier for every raw event type that proves the child is
		// alive — tool lifecycle, streaming tool output, LLM-call streaming,
		// provider retries. Cheap enough to run on every event.
		if (eventCountsAsActivity(event.type)) {
			bumpActivity(rs);
		}

		// Provider retry lifecycle: log it (also activity via the classifier
		// above). The issue #1 incident log showed nothing between the last
		// tool result and the kill — a retry line makes degraded-provider
		// kills legible after the fact.
		if (event.type === "auto_retry_start") {
			logEntry(`  ${S.fgYellow}↻ retry ${event.attempt ?? "?"}/${event.maxAttempts ?? "?"} in ${event.delayMs ?? "?"}ms${event.errorMessage ? `: ${String(event.errorMessage).slice(0, 120)}` : ""}${S.reset}`);
		} else if (event.type === "auto_retry_end") {
			logEntry(`  ${S.dim}↻ retry ${event.attempt ?? "?"} ${event.success ? "recovered" : `failed${event.finalError ? `: ${String(event.finalError).slice(0, 120)}` : ""}`}${S.reset}`);
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
				// Reset stalled-turn watchdog — fresh progress means no wake-up needed.
				bumpStaleWatchdog(pi, rs);
				// Decision 015: an assistant message is activity too. (Role-gated
				// here rather than in the raw-type classifier — a user-message
				// message_end must not count.)
				bumpActivity(rs);
				// Accumulate usage stats
				rs.usageStats.input += msg.usage.input;
				rs.usageStats.output += msg.usage.output;
				rs.usageStats.cacheRead += msg.usage.cacheRead;
				rs.usageStats.cacheWrite += msg.usage.cacheWrite;
				rs.usageStats.cost += msg.usage.cost.total;
				const promptTokens = msg.usage.input + msg.usage.cacheRead + msg.usage.cacheWrite;
				if (promptTokens > 0) {
					rs.usageStats.latestCacheHitRate = (msg.usage.cacheRead / promptTokens) * 100;
				}
				updateFooter();

				// Soft turn nudge: warn once near the hard cap so the agent can wrap
				// up with a partial result instead of being hard-killed mid-task.
				if (!rs.turnNudged && rs.progress.turns >= TURN_NUDGE_SOFT) {
					rs.turnNudged = true;
					const nudge =
						`[Turn-limit warning] You have used ${TURN_NUDGE_SOFT} of the ${MAX_TURNS_HARD}-turn ` +
						`hard limit for this subagent run; the process will be killed at ${MAX_TURNS_HARD} turns. ` +
						`Do NOT start new work and do NOT launch reviewers. Wrap up now: complete or abandon the ` +
						`current step, then emit your completion report with **status: partial** (or blocked) — ` +
						`summarize what was completed, what remains, and any open issues. Your next text-only ` +
						`message is your final output.`;
					if (steerChild(rs, nudge)) {
						logEntry(`\x1b[33m[turn-limit] soft nudge injected at ${rs.progress.turns} turns\x1b[0m`);
						debugLog(`turn-nudge: soft nudge at turns=${rs.progress.turns} child=${rs.sessionId}`);
					}
				}

				// Hard turn limit — routes through the shared kill dispatch
				// (dispatchKillSignals), NOT a bare proc.kill: the close handler is
				// the single owner of delivery and reads killedExplicitly/killedVia
				// to prepend the kill marker; a bare kill delivers the child's last
				// message as a normal completion (and escapes the killed/stopped
				// skips, e.g. the owner_asks gate).
				if (rs.progress.turns >= MAX_TURNS_HARD) {
					rs.progress.currentActivity = `hit turn limit (${MAX_TURNS_HARD}), stopping`;
					rs.progress.errors.push(`Turn limit reached (${MAX_TURNS_HARD})`);
					debugLog("turn-limit hit, dispatching kill");
					dispatchKillSignals(rs, "turn-limit");
					return;
				}

				// Per-dispatch turn cap and stall tripwire (decision 046). The hard
				// ceiling above stays first so it keeps its own reason when a cap's
				// grace would overrun it. This site only builds the state and executes
				// the action: both conditions live in decideTurnAction. The commit
				// observation is sampled and asynchronous, so nothing here waits on a
				// spawn.
				if (turnCapTurn(rs).kind === "kill") return;

				// Detect completion: text-only message (no tool calls) means the
				// model is done. RPC mode keeps stdin open so we must close it to
				// trigger process exit and fire the close handler.
				const hasToolCalls = msg.content.some((c: any) => c.type === "toolCall");
				const hasText = msg.content.some((c: any) => c.type === "text");
				debugLog("msg_end: tc=" + hasToolCalls + " txt=" + hasText + " resolve=" + !!rs.resolveOnStop);
				if (!hasToolCalls && hasText) {
					// Reviewer invocation guard: if this child has
				// `reviewParentRequirements` non-empty (i.e. it is itself an
				// implementer with a gate), check whether every required
				// reviewer kind has been spawned from it. The child's harness
				// writes a persisted tracker file at
				// `/tmp/pi-subagent-<childSessionId>.reviewers.json` for every
				// reviewer it spawns; we read that file here to make a
				// cross-process decision (the implementer runs in its own pi
				// process; its in-memory tracker is invisible to us — but the
				// file is the same one `subagent_review_status` reads, so the
				// soft-prompt check and the orchestrator's mechanical gate
				// share one source of truth).
				//
				// If any required reviewer kind is missing, inject a steer
				// prompt into the child's RPC stdin and SKIP the stdin.close()
				// so the implementer re-enters its agent loop with a corrective
				// message. We do NOT hard-stop the implementer: a hard stop
				// would lose model state for the corrective path. The soft
				// prompt is a polite nudge; the orchestrator's mechanical
				// `subagent_review_status` check is the actual gate.
				const required = rs.reviewParentRequirements;
				if (required && required.length > 0 && !rs.stoppedExplicitly && !rs.turnNudged) {
					// The child's harness writes its reviewer-spawn tracker file
					// keyed by its own pi session ID (obtained via
					// getParentTrackerKey inside the child process). We read
					// by `rs.piSessionId` (captured from the child's get_state
					// response) so the file key matches. If get_state never
					// responded (child crashed before responding), skip the
					// soft-prompt guard — the orchestrator's mechanical
					// `subagent_review_status` check is the real gate.
					if (!rs.piSessionId) {
						debugLog(`review-gate: piSessionId not captured, skipping soft-prompt guard`);
						// Fall through to isDone/completion logic below
					} else {
					const trackerKey = rs.piSessionId;
					const trackerState = readPersistedSpawns(trackerKey);
					const spawnedKinds = new Set(trackerState.spawns.map((s) => s.reviewerKind));
					const missing = required.filter((k) => !spawnedKinds.has(k));
					if (missing.length > 0 && !trackerState.reviewCapReached) {
						const message =
							`[review-gate] You returned a final message without spawning all required reviewers. ` +
							`Missing: ${missing.join(", ")}. Per your post-implementation review section, you must launch ` +
							`both reviewers with \`isolate: false\` before reporting \`complete\`. Continuing.`;
						try {
							rpcSend(rs.stdin, {
								type: "prompt",
								message,
								streamingBehavior: "steer",
							});
							logEntry(`\x1b[33m[review-gate] soft prompt injected; missing reviewers: ${missing.join(", ")}\x1b[0m`);
							debugLog(`review-gate: soft prompt for missing=${missing.join(",")} child=${rs.sessionId} trackerKey=${trackerKey}`);
						} catch (e) {
							debugLog(`review-gate: rpcSend failed: ${e instanceof Error ? e.message : String(e)}`);
						}
						// Do NOT close stdin — the corrective prompt re-enters
						// the agent loop. We also do not set isDone=true here
						// because the agent is not actually done; it has a
						// corrective prompt to act on.
						return;
					}
					} // end else (piSessionId captured)
				} // end if (required)

					// R4 (tfd process-controls, owner 2026-10-19): a completion report
					// from an agent whose schema declares `owner_asks` must carry the
					// field — `none`, or registry row ids. Free text is refused: the
					// reply steers the reporter to register the ask as a row and
					// reissue. Same shape as the review-gate steer above, and for the
					// same reason: the refusal happens while the reporter is alive, so
					// no refused report is ever delivered, and the review-status gate
					// (which only sees delivered reports) cannot count one as such.
					if (rs.ownerAsksRequired && !rs.killedExplicitly && !rs.stoppedExplicitly) {
						const reportText = (msg.content as any[])
							.filter((c: any) => c.type === "text")
							.map((c: any) => c.text)
							.join("\n");
						const verdict = validateOwnerAsks(reportText);
						if (!verdict.ok) {
							try {
								rpcSend(rs.stdin, {
									type: "prompt",
									message: `[owner-asks] Report refused. ${verdict.error}`,
									streamingBehavior: "steer",
								});
								logEntry(`\x1b[33m[owner-asks] report refused — ${verdict.error.split("\n")[0]}\x1b[0m`);
								debugLog(`owner-asks: refused report child=${rs.sessionId}`);
							} catch (e) {
								debugLog(`owner-asks: rpcSend failed: ${e instanceof Error ? e.message : String(e)}`);
							}
							// Do NOT close stdin and do NOT set isDone: the report is not
							// delivered until it conforms.
							return;
						}
					}

					rs.progress.currentActivity = "completed, closing session";
					rs.isDone = true;
					debugLog("DONE! closing stdin");

					// Auto-detach: if the user is attached to this session,
					// restore the default editor and clear the attach widget
					// so it isn't orphaned after the child completes.
					if (attachedSessionId === sessionId) {
						detach();
						notifyChildDetached(rs);
					}

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
		// Capture every line. Capped to the last 200 to bound memory for
		// long-running sessions; surfaced in deliverResult when the child
		// exits before completing a turn so the orchestrator sees the
		// actual failure (extension load error, model auth, etc.) instead
		// of a bare "exit 1, 0 turns".
		for (const line of data.toString().split("\n")) {
			if (line) {
				rs.stderrLines.push(line);
				if (rs.stderrLines.length > 200) rs.stderrLines.shift();
			}
		}
	});

	proc.on("close", async (code) => {
		debugLog("close: code=" + code + " resolve=" + !!rs.resolveOnStop + " done=" + rs.isDone + " turns=" + rs.progress.turns);
		// Cancel the stalled-turn watchdog and the stage-2 silence timer —
		// the subagent is leaving the running set, so neither may fire again.
		if (rs.staleTimer) { clearTimeout(rs.staleTimer); rs.staleTimer = null; }
		if (rs.silenceTimer) { clearTimeout(rs.silenceTimer); rs.silenceTimer = null; }
		// Cancel any active wait timer — the subagent's completion delivers
		// its own result as a steer message, so a follow-up "still running"
		// wakeup would be redundant. Multiple subagents share one timer, so
		// clearing on the *first* completion is correct: the caller will be
		// woken by the result and can re-issue wait() for any still-running
		// subagents.
		clearActiveWait();
		if (stdoutBuffer.trim()) processLine(stdoutBuffer);

		// Write completion footer to live log
		const { outcome, footer: how } = terminalOutcome(rs, code);
		logEntry("");
		// The colour follows the outcome, not `isDone`: a completion is green and
		// everything else — a kill, a truncated or errored turn — renders as the
		// abort it was delivered as. `Exited` (a clean exit with nothing delivered)
		// stays red, as it always was.
		const style = outcome === "finished" && rs.isDone ? S.doneOk : S.doneFail;
		logEntry(`${style}── ${how} (${rs.progress.turns} turns, exit ${code ?? "?"}) ──${S.reset}`);

		// Widget stays visible for user to review; they clear it with /watch off

		// Close socket server and clean up
		try {
			for (const client of rs.sockClients) client.destroy();
			rs.sockServer.close();
			fs.unlinkSync(sockPath);
		} catch { /* */ }

		// Auto-detach on unexpected exit: if the user was attached to this
		// session when it died (crash, kill, timeout), restore the default
		// editor so it isn't orphaned. The isDone path above handles the
		// normal-completion case; this catches abnormal termination.
		if (attachedSessionId === sessionId) {
			detach();
			notifyChildDetached(rs);
		}

		// Mark the session as no longer running BEFORE preCommitSteps (which
		// runs multiple git commands). Otherwise subagent_resume would
		// incorrectly reject with "already running" during the commit window
		// for a session that has completed.
		running.delete(sessionId);
		updateFooter();
		// Decision 046: record the dispatch's cumulative turn count so a resume
		// continues it instead of restarting the count the cap compares against.
		updateMetaJson(sessionId, { turnsUsed: turnsUsed(rs) });

		// PRE-DELIVERY: the work-order record first, then the git steps that commit the work
		// (add, diff, commit, rev-parse). The record is written into the tree that will be
		// committed, so it has to precede the commit: an isolated spawn's record lives in the
		// worktree, which is removed after delivery (WO-2026-094 M1/M2). Split from post-delivery
		// cleanup so the result reaches the parent immediately rather than waiting seconds for
		// worktree removal. The funnel runs the appends, then those git steps as its commit step,
		// then the close-time gate — which asks whether THIS process committed the tree it is
		// about to remove.
		const tDeliver = PI_ASYNC_DEBUG ? Date.now() : 0;
		let committed!: Awaited<ReturnType<typeof preCommitSteps>>;
		const recordClose = await closeWorkRecord(rs.workRecord, {
			implementerKey: rs.piSessionId ?? sessionId,
			readFinal: () => getFinalOutput(rs.messages),
			commit: async () => {
				committed = await preCommitSteps(rs);
				return []; // the child's commit is not the record's: its failures are `committed.note`
			},
			mustBeCommitted: rs.worktreePath !== null,
			persist: (failures) => updateMetaJson(sessionId, { recordFailures: failures }),
			carried: { notes: rs.recordNotes ?? [], failures: rs.recordFailures ?? [] },
		});
		const { note: commitNote, finalCommit, hadChanges } = committed;
		rs.recordNotes = recordClose.notes;
		rs.recordFailures = recordClose.failures;
		const recordText = recordClose.text;

		// Clean up temp files
		if (tmpPath) try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
		if (tmpDir) try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }

		// DELIVER: the result reaches the parent now.
		// No double delivery: resolveOnStop and deliverResult are mutually
		// exclusive — see deliverCloseResult (the single delivery owner).
		const deliveryPath = deliverCloseResult(pi, rs, code, commitNote + recordText);
		if (PI_ASYNC_DEBUG) debugLog(`deliverResult (${deliveryPath}): ${Date.now() - tDeliver}ms`);

		// POST-DELIVERY: worktree removal and branch cleanup. Fire-and-forget —
		// must not block the close handler, and failures are surfaced as steer
		// warnings, never fatal.
		postDeliveryCleanup(pi, rs, finalCommit, hadChanges).catch((e) => {
			debugLog(`postDeliveryCleanup: unhandled rejection: ${e instanceof Error ? e.message : String(e)}`);
		});
	});

	proc.on("error", () => {
		running.delete(sessionId);
		updateFooter();
	});

	// Send get_state BEFORE the initial prompt so we capture the child's
	// real sessionFile and pi sessionId before any prompt processing begins.
	// Both commands run on the same RPC pipe; order is preserved by serial
	// stdin writes. If get_state never responds (child crashes immediately),
	// sessionFile remains undefined on rs — subagent_resume will error
	// gracefully for that session.
	const getStateId = `get-state-${randomUUID()}`;
	rpcSend(proc.stdin, { id: getStateId, type: "get_state" });
	rpcSend(proc.stdin, { type: "prompt", message: promptForChild });

	// Arm the stalled-turn watchdog — the subagent is now running and
	// will reset the timer on every assistant turn.
	bumpStaleWatchdog(pi, rs);

	// Arm the stage-2 silence-kill timer (decision 015) — kills a child
	// silent for `silenceTimeoutMs` (no-op when disabled).
	armSilenceTimer(rs);

	return rs;
}
