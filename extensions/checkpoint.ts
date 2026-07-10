import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage, AssistantMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const CHECKPOINT_DIR = ".pi/checkpoints";
const MARKER = "[CHECKPOINT]";

type StrippedAssistant = Omit<AssistantMessage, "content"> & {
	content: AssistantMessage["content"];
};

/** Drop thinking blocks from assistant messages. Archives are for reference, not API replay. */
function stripThinking(msg: AssistantMessage): AssistantMessage {
	const filtered = msg.content.filter((b) => b.type !== "thinking");
	return filtered.length === msg.content.length ? msg : { ...msg, content: filtered };
}

/** Write session entries to a JSONL archive. */
async function archiveSession(
	cwd: string,
	entries: unknown[],
	summary: string,
): Promise<string> {
	const archiveDir = join(cwd, CHECKPOINT_DIR);
	await mkdir(archiveDir, { recursive: true });
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const archivePath = join(archiveDir, `session-${ts}.jsonl`);

	const lines: string[] = [];
	for (const entry of entries as Array<{ type: string; message?: AgentMessage }>) {
		if (entry?.type === "message" && entry.message?.role === "assistant") {
			lines.push(JSON.stringify({ ...entry, message: stripThinking(entry.message) }));
		} else {
			lines.push(JSON.stringify(entry));
		}
	}
	await writeFile(archivePath, lines.join("\n") + "\n", "utf8");

	const metaPath = archivePath.replace(/\.jsonl$/, ".meta.json");
	await writeFile(
		metaPath,
		JSON.stringify({ timestamp: new Date().toISOString(), summary, entryCount: entries.length }, null, 2),
		"utf8",
	);
	return archivePath;
}

export default function (pi: ExtensionAPI) {
	// Always archive before compaction. If our `checkpoint` tool triggered it,
	// short-circuit the LLM-based summarization by returning the agent's own summary.
	pi.on("session_before_compact", async (event, ctx) => {
		const { customInstructions, preparation } = event;
		const summary = customInstructions?.includes(MARKER)
			? customInstructions.replace(MARKER, "").trim()
			: `Auto-archived before compaction (${preparation.tokensBefore.toLocaleString()} tokens)`;

		try {
			await archiveSession(ctx.cwd, ctx.sessionManager.getEntries(), summary);
			ctx.ui.notify(`Archived session: ${summary.split("\n", 1)[0]}`, "info");
		} catch (err) {
			ctx.ui.notify(
				`Archive failed (compaction continues): ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
		}

		if (customInstructions?.includes(MARKER)) {
			return {
				compaction: {
					summary,
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
				},
			};
		}
	});

	pi.registerTool({
		name: "checkpoint",
		label: "Checkpoint",
		description:
			"Archive the current session, clear context, and continue. " +
			"Use at logical task boundaries when work for this turn is done but more remains. " +
			"Archives are searchable with search_checkpoint.",
		parameters: Type.Object({
			summary: Type.String({ description: "What was accomplished and the current state." }),
			nextSteps: Type.Optional(
				Type.String({
					description:
						"What comes next. Used as the kickoff prompt if continue is true. Defaults to 'Continue work'.",
				}),
			),
			continue: Type.Optional(
				Type.Boolean({
					description: "If true (default), follow up with a fresh prompt so work continues. Set false to stop.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const doContinue = params.continue !== false;
			const next = params.nextSteps ?? (doContinue ? "Continue work" : "Awaiting user instruction");
			const summary = `${params.summary}\n\n## Next Steps\n${next}`;

			ctx.compact({
				customInstructions: `${MARKER}\n${summary}`,
				onComplete: () => {
					ctx.ui.notify("Checkpoint complete — context cleared.", "info");
					if (doContinue) {
						pi.sendUserMessage(next, { deliverAs: "followUp" });
					}
				},
				onError: (err) => {
					ctx.ui.notify(`Checkpoint compaction failed: ${err.message}`, "error");
				},
			});

			return {
				content: [
					{
						type: "text",
						text: `Checkpoint queued. Session will be archived and context cleared.\nNext: ${next}${doContinue ? "" : " (no auto-continue)"}`,
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "search_checkpoint",
		label: "Search Checkpoints",
		description: "Search archived session JSONL files for patterns.",
		parameters: Type.Object({
			pattern: Type.String({ description: "Regex pattern to search for." }),
			archiveGlob: Type.Optional(
				Type.String({
					description: "Glob for archive files. Default: *.jsonl. Use 'session-2025-*' to limit by date.",
				}),
			),
			contextLines: Type.Optional(
				Type.Number({ description: "Lines of context around each match. Default: 2." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const glob = params.archiveGlob ?? "*.jsonl";
			const ctxLines = params.contextLines ?? 2;
			const archiveDir = join(ctx.cwd, CHECKPOINT_DIR);

			let files: string[];
			try {
				files = (await readdir(archiveDir)).filter((f) => f.endsWith(".jsonl"));
			} catch {
				return {
					content: [{ type: "text", text: "No archives yet." }],
					details: {},
				};
			}

			const regex = new RegExp(params.pattern, "gi");
			const matches: string[] = [];

			for (const file of files.sort().reverse()) {
				if (glob !== "*.jsonl" && !matchWildcard(file, glob)) continue;
				const text = await readFile(join(archiveDir, file), "utf8");
				const lines = text.split("\n");
				for (let i = 0; i < lines.length; i++) {
					if (!lines[i]) continue;
					if (regex.test(lines[i])) {
						regex.lastIndex = 0;
						const start = Math.max(0, i - ctxLines);
						const end = Math.min(lines.length, i + ctxLines + 1);
						matches.push(`--- ${file}:${i + 1} ---`);
						for (let j = start; j < end; j++) {
							matches.push(truncate(lines[j], 200));
						}
					}
				}
			}

			if (matches.length === 0) {
				return { content: [{ type: "text", text: `No matches for /${params.pattern}/.` }], details: {} };
			}
			return {
				content: [{ type: "text", text: matches.join("\n") }],
				details: { matchCount: matches.length },
			};
		},
	});

	pi.registerCommand("checkpoints", {
		description: "List archived session checkpoints.",
		async handler(_args, ctx) {
			const archiveDir = join(ctx.cwd, CHECKPOINT_DIR);
			try {
				const files = (await readdir(archiveDir)).filter((f) => f.endsWith(".meta.json"));
				if (files.length === 0) {
					ctx.ui.notify("No checkpoints yet.", "info");
					return;
				}
				const lines: string[] = [`Checkpoints in ${archiveDir}:`];
				for (const f of files.sort().reverse()) {
					const meta = JSON.parse(await readFile(join(archiveDir, f), "utf8"));
					lines.push(`  ${meta.timestamp} — ${meta.summary.split("\n")[0]}`);
				}
				ctx.ui.notify(lines.join("\n"), "info");
			} catch {
				ctx.ui.notify("No checkpoints yet.", "info");
			}
		},
	});

	// /checkpoint — sends a follow-up prompting the model to call its own checkpoint tool.
	// The model composes the summary; this command is just a consistent trigger.
	pi.registerCommand("checkpoint", {
		description:
			"Archive session and compact context. Sends a follow-up prompting the model to summarize and continue. Optional: /checkpoint <focus hint>",
		handler: async (args, ctx) => {
			const focus = args.trim();
			const basePrompt =
				"Run the checkpoint tool now with a concise summary of what was accomplished in this turn and the current state. Let `continue` default to true so work continues automatically after compaction.";
			const prompt = focus ? `${basePrompt}\n\nFocus the summary on: ${focus}` : basePrompt;

			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			ctx.ui.notify("Checkpoint queued — will run after current work.", "info");
		},
	});
}

function matchWildcard(name: string, glob: string): boolean {
	const re = new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
	return re.test(name);
}

function truncate(s: string, n: number): string {
	return s.length <= n ? s : s.slice(0, n) + "...";
}
