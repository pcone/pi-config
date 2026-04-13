import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { writeFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage, AssistantMessage } from "@mariozechner/pi-agent-core";


const CHECKPOINT_DIR = ".pi/checkpoints";
const CONTEXT_CLEAR_MARKER = "<!-- context-clear -->";

// ---------------------------------------------------------------------------
// Context filtering helpers
// ---------------------------------------------------------------------------

/**
 * Strip unsigned thinking blocks from an assistant message.
 * Blocks with `thinkingSignature` are kept — the API requires them
 * for extended-thinking continuity across turns.
 */
function stripUnsignedThinking(msg: AssistantMessage): AssistantMessage {
  const filtered = msg.content.filter(
    (block) => block.type !== "thinking" || (block as any).thinkingSignature,
  );
  return filtered.length === msg.content.length ? msg : { ...msg, content: filtered };
}

/** Strip all thinking blocks from an assistant message. */
function stripAllThinking(msg: AssistantMessage): AssistantMessage {
  const filtered = msg.content.filter((block) => block.type !== "thinking");
  return filtered.length === msg.content.length ? msg : { ...msg, content: filtered };
}

/** Check if an assistant message contains the context-clear marker. */
function hasContextClearMarker(msg: AgentMessage): boolean {
  if (msg.role !== "assistant") return false;
  return msg.content.some(
    (block) => block.type === "text" && block.text.includes(CONTEXT_CLEAR_MARKER),
  );
}

/**
 * Strip tool_use blocks from an assistant message's content.
 * If only thinking/tool_use blocks remain after stripping, the message
 * content is replaced with a minimal stub.
 */
function stripToolUseFromAssistant(msg: AssistantMessage): AssistantMessage {
  const filtered = msg.content.filter((block) => block.type !== "toolCall");
  if (filtered.length === 0) {
    return { ...msg, content: [{ type: "text" as const, text: "(tool calls cleared from context)" }] };
  }
  return { ...msg, content: filtered };
}

/**
 * Prepare messages for the LLM context window:
 *  1. Find the last assistant message containing <!-- context-clear -->.
 *     For all messages before that point, strip tool_use blocks from
 *     assistant messages and remove tool_result messages entirely.
 *  2. Strip unsigned thinking blocks from all assistant messages except
 *     the last (which may be in-progress). Signed thinking blocks
 *     (with thinkingSignature) are always preserved for API continuity.
 */
function prepareContextMessages(messages: AgentMessage[]): AgentMessage[] {
  // Find the last message index containing the context-clear marker.
  let clearBoundary = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (hasContextClearMarker(messages[i])) {
      clearBoundary = i;
      break;
    }
  }

  // Find the last assistant message index (don't strip thinking from it —
  // it may be the in-progress response).
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }

  const result: AgentMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    let msg = messages[i];

    if (i < clearBoundary) {
      // Before the clear boundary: strip tool I/O
      if (msg.role === "toolResult") continue; // drop entirely
      if (msg.role === "assistant") {
        msg = stripToolUseFromAssistant(msg as AssistantMessage);
      }
    }

    // Strip thinking from assistant messages:
    // - Before clear boundary: strip ALL thinking (including signed) — that
    //   context is archived and no longer needed for API continuity.
    // - After clear boundary: strip only unsigned thinking, preserving signed
    //   blocks needed for extended-thinking API continuity.
    // - Last assistant message: don't touch (may be in-progress).
    if (msg.role === "assistant" && i !== lastAssistantIdx) {
      if (i < clearBoundary) {
        msg = stripAllThinking(msg as AssistantMessage);
      } else {
        msg = stripUnsignedThinking(msg as AssistantMessage);
      }
    }

    result.push(msg);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/** Run a checkpoint: archive the session, compact context, and optionally continue. */
async function doCheckpoint(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  summary: string,
  nextSteps?: string,
  shouldContinue?: boolean,
): Promise<string> {
  const archivePath = await archiveSession(ctx, summary, nextSteps);
  await updateIndex(ctx.cwd);
  ctx.ui.notify(`Session archived: ${archivePath}`, "info");

  const doContinue = shouldContinue !== false;
  const next = nextSteps ?? (doContinue ? "Continue work" : "Awaiting user instruction");

  ctx.compact({
    customInstructions: `[CHECKPOINT]\n${summary}\n\n## Next Steps\n${next}\n\n## Archived History\nPrevious session archived to: ${archivePath}\nUse grep or read to search it if needed:\n- grep -n "pattern" "${archivePath}"\n- read(path="${archivePath}")`,
    onComplete: () => {
      if (doContinue) {
        pi.sendUserMessage(`Continue working on: ${next}`, { deliverAs: "followUp" });
      }
    },
    onError: (error) => {
      ctx.ui.notify(`Compaction failed: ${error.message}`, "error");
    },
  });

  return archivePath;
}

export default function (pi: ExtensionAPI) {
  // -------------------------------------------------------------------------
  // Strip thinking + cleared tool I/O from live LLM context
  // -------------------------------------------------------------------------
  pi.on("context", (event) => {
    const result = prepareContextMessages(event.messages);
    return { messages: result };
  });

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  pi.registerTool({
    name: "checkpoint",
    label: "Checkpoint",
    description:
      "Archive the current session to a timestamped file and clear context. " +
      "Use at logical stopping points when moving to a new feature or task. " +
      "The archived session can be searched later with search_checkpoint. " +
      "After checkpointing, continue working on nextSteps unless continue is false.",
    parameters: Type.Object({
      summary: Type.String({ description: "What was accomplished in this session" }),
      nextSteps: Type.Optional(Type.String({ description: "What's planned for the next session. The agent will continue working on these after checkpoint." })),
      continue: Type.Optional(Type.Boolean({ description: "Whether to continue with nextSteps after checkpoint. Default: true. Set to false when the user needs to switch context or give a new instruction." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const archivePath = await doCheckpoint(ctx, pi, params.summary, params.nextSteps, params.continue);
        return {
          content: [
            {
              type: "text",
              text: `Session archived to ${archivePath}.\nContext cleared for next task.\n\nUse grep or read to search the archive if you need to reference past work.`,
            },
          ],
          details: { archivePath, summary: params.summary },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Checkpoint failed: ${message}`, "error");
        throw error;
      }
    },
  });

  pi.registerTool({
    name: "search_checkpoint",
    label: "Search Checkpoint",
    description:
      "Search through archived session files for patterns. " +
      "Archives are stored as JSONL and contain the full conversation history.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Regex pattern to search for" }),
      archiveGlob: Type.Optional(Type.String({ description: "Glob pattern for archive files (e.g. '*.jsonl'). Default: all archives" })),
      contextLines: Type.Optional(Type.Number({ description: "Number of lines of context around matches. Default: 2" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const results = await searchArchives(ctx.cwd, params.pattern, params.archiveGlob ?? "*.jsonl", params.contextLines ?? 2);
        if (!results) {
          return { content: [{ type: "text", text: "No archives found or no matches." }], details: {} };
        }
        return { content: [{ type: "text", text: `Search results from archives:\n\n${results}` }], details: {} };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Search failed: ${message}`, "error");
        return { content: [{ type: "text", text: `Search failed: ${message}` }], details: { error: message } };
      }
    },
  });

  pi.registerCommand("checkpoints", {
    description: "List all archived session checkpoints",
    async handler(_args, ctx) {
      try {
        const index = await getIndex(ctx.cwd);
        ctx.ui.notify(index ?? "No checkpoints found", "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed: ${message}`, "error");
      }
    },
  });

  pi.registerCommand("checkpoint-continue", {
    description: "Checkpoint current session and continue with a new prompt",
    async handler(args, _ctx) {
      const extra = args.trim() ? ` Additional context: ${args.trim()}.` : "";
      pi.sendUserMessage(
        `Checkpoint the session now. Summarize what has been accomplished and what comes next.${extra}`,
      );
    },
  });

  pi.registerCommand("checkpoint-stop", {
    description: "Checkpoint current session and stop — do not auto-continue",
    async handler(args, _ctx) {
      const extra = args.trim() ? ` Additional context: ${args.trim()}.` : "";
      pi.sendUserMessage(
        `Checkpoint the session now with continue set to false. Summarize what has been accomplished.${extra}`,
      );
    },
  });

  // -------------------------------------------------------------------------
  // Auto-archive on every compaction (manual checkpoint and auto-compaction)
  // -------------------------------------------------------------------------

  pi.on("session_before_compact", async (event, ctx) => {
    if (event.customInstructions?.includes("[CHECKPOINT]")) {
      // Agent-triggered checkpoint: use the agent's own summary directly,
      // skipping the default LLM summarization. The agent knows what it was
      // doing and what comes next better than a transcript summarizer.
      const summary = event.customInstructions.replace("[CHECKPOINT]", "").trim();
      const archivePath = await archiveSession(ctx, summary, undefined);
      await updateIndex(ctx.cwd);
      ctx.ui.notify(`Session archived: ${archivePath}`, "info");

      return {
        compaction: {
          summary,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          details: { archivedTo: archivePath, type: "checkpoint" },
        },
      };
    }

    // Auto-compaction: archive as a side effect, then let pi's default
    // LLM-powered summarization proceed by not returning a compaction result.
    try {
      const entries = ctx.sessionManager.getEntries();
      const turnCount = entries.filter(
        (e: any) => e.type === "message" && e.message?.role === "assistant",
      ).length;
      const summary = `Auto-archived on compaction (~${turnCount} assistant turns)`;
      const archivePath = await archiveSession(ctx, summary, undefined);
      await updateIndex(ctx.cwd);
      ctx.ui.notify(`Session auto-archived: ${archivePath}`, "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Auto-archive failed (compaction continues): ${message}`, "warning");
    }
  });
}

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

interface CheckpointEntry {
  timestamp: string;
  summary: string;
  nextSteps?: string;
  archivePath: string;
  turnCount: number;
}

/**
 * Write session entries to archive JSONL, stripping thinking blocks from
 * assistant messages but preserving tool results (output, isError, etc).
 */
async function archiveSession(ctx: ExtensionContext, summary: string, nextSteps?: string): Promise<string> {
  const entries = ctx.sessionManager.getEntries();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveDir = join(ctx.cwd, CHECKPOINT_DIR);

  await mkdir(archiveDir, { recursive: true });
  const archivePath = join(archiveDir, `session-${timestamp}.jsonl`);

  let jsonl = "";
  for (const entry of entries) {
    // Strip thinking blocks from assistant message entries before archiving
    // (Archives are for reference/search, not sent back to the API)
    if (entry.type === "message" && (entry.message as AgentMessage).role === "assistant") {
      const filtered: typeof entry = {
        ...entry,
        message: stripAllThinking(entry.message as AssistantMessage) as any,
      };
      jsonl += JSON.stringify(filtered) + "\n";
    } else {
      jsonl += JSON.stringify(entry) + "\n";
    }
  }
  await writeFile(archivePath, jsonl, "utf8");

  const meta: CheckpointEntry = {
    timestamp: new Date().toISOString(),
    summary,
    nextSteps,
    archivePath,
    turnCount: entries.length,
  };
  await writeFile(archivePath.replace(".jsonl", ".meta.json"), JSON.stringify(meta, null, 2), "utf8");

  return archivePath;
}

async function updateIndex(cwd: string): Promise<void> {
  const archiveDir = join(cwd, CHECKPOINT_DIR);
  const indexPath = join(archiveDir, "INDEX.md");

  let index = "# Session Checkpoints\n\n";
  index += "Archives can be searched with:\n";
  index += "```bash\n";
  index += "grep -n 'pattern' .pi/checkpoints/session-*.jsonl\n";
  index += "```\n\n";
  index += "## Archives\n\n";

  try {
    const files = await readdir(archiveDir);
    const metaFiles = files.filter((f) => f.endsWith(".meta.json")).sort().reverse();

    if (metaFiles.length === 0) {
      index += "_No archives yet_\n";
    } else {
      for (const metaFile of metaFiles) {
        const content = await readFile(join(archiveDir, metaFile), "utf8");
        try {
          const meta: CheckpointEntry = JSON.parse(content);
          const archiveName = metaFile.replace(".meta.json", "");
          index += `### ${meta.timestamp}\n`;
          index += `- Archive: \`${archiveName}.jsonl\`\n`;
          index += `- Summary: ${meta.summary}\n`;
          if (meta.nextSteps) index += `- Next: ${meta.nextSteps}\n`;
          index += `- Turns: ${meta.turnCount}\n\n`;
        } catch {
          // skip invalid meta
        }
      }
    }

    await writeFile(indexPath, index, "utf8");
  } catch {
    // dir doesn't exist yet
  }
}

async function getIndex(cwd: string): Promise<string | null> {
  try {
    return await readFile(join(cwd, CHECKPOINT_DIR, "INDEX.md"), "utf8");
  } catch {
    return null;
  }
}

async function searchArchives(cwd: string, pattern: string, glob: string, contextLines: number): Promise<string | null> {
  const archiveDir = join(cwd, CHECKPOINT_DIR);
  let results = "";
  let matchCount = 0;

  try {
    const files = await readdir(archiveDir);
    const jsonlFiles = files.filter(
      (f) => f.endsWith(".jsonl") && (glob === "*.jsonl" || f.match(glob.replace(/\*/g, ".*"))),
    );

    const regex = new RegExp(pattern, "gi");

    for (const file of jsonlFiles.sort().reverse()) {
      const content = await readFile(join(archiveDir, file), "utf8");
      const lines = content.split("\n");
      let inContext = 0;
      let fileHasMatches = false;
      let fileResult = `## ${file}\n`;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;

        let searchText = line;
        try {
          const entry = JSON.parse(line);
          searchText = extractSearchText(entry);
        } catch {
          // use raw line
        }

        if (regex.test(searchText)) {
          fileHasMatches = true;
          matchCount++;
          inContext = contextLines;
          const start = Math.max(0, i - contextLines);
          for (let j = start; j < i; j++) {
            if (lines[j].trim()) fileResult += `  ${lines[j].slice(0, 200)}${lines[j].length > 200 ? "..." : ""}\n`;
          }
          fileResult += `> ${line.slice(0, 300)}${line.length > 300 ? "..." : ""}\n`;
        } else if (inContext > 0) {
          fileResult += `  ${line.slice(0, 200)}${line.length > 200 ? "..." : ""}\n`;
          inContext--;
        }
      }

      if (fileHasMatches) results += fileResult + "\n";
    }

    return matchCount === 0 ? null : `Found ${matchCount} matches across archives:\n\n${results}`;
  } catch {
    return null;
  }
}

function extractSearchText(entry: Record<string, unknown>): string {
  const parts: string[] = [];

  if (entry.type === "message") {
    const msg = entry.message as Record<string, unknown>;
    if (typeof msg.content === "string") {
      parts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block === "object" && block && "text" in block) {
          parts.push(String((block as Record<string, unknown>).text));
        }
      }
    }
  }

  if (entry.customType && typeof entry.content === "string") {
    parts.push(entry.content);
  }

  if (entry.type === "compaction" && typeof entry.summary === "string") {
    parts.push(entry.summary);
  }

  return parts.join(" ");
}