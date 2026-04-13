/**
 * compact-bash.ts — Compact bash tool output display with optional AI summarization.
 *
 * Two features:
 *
 * 1. PREVIEW LINES — collapsed view shows last N lines instead of the default 5.
 *    Change BASH_PREVIEW_LINES below.
 *
 * 2. AI SUMMARY — when output exceeds SUMMARIZE_THRESHOLD lines, a cheap/fast model
 *    summarizes it into 1-2 lines shown in the collapsed view. The full output is
 *    always available via Ctrl+O to expand.
 *    Set SUMMARIZE_THRESHOLD to Infinity to disable summarization entirely.
 */

import {
  type ExtensionAPI,
  bashToolDefinition,
  getMarkdownTheme,
  keyHint,
  truncateToVisualLines,
} from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Text, truncateToWidth } from "@mariozechner/pi-tui";

// ─── Configuration ────────────────────────────────────────────────────────────

/** Lines shown in collapsed view when output has no summary. */
const BASH_PREVIEW_LINES = 5;

/** Summarize output when it exceeds this many lines. Set to Infinity to disable. */
const SUMMARIZE_THRESHOLD = 5;

/** OpenRouter model to use for summarization. */
const SUMMARY_MODEL = "meta-llama/llama-3.1-8b-instruct";

// ─── Async summary state (module-level, keyed by toolCallId) ─────────────────

/** Resolved summaries ready to display (including errors). */
const summaryCache = new Map<string, string>();

/** In-flight summarization promises. */
const pendingSummaries = new Set<string>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function getTextOutput(result: any): string {
  if (!result) return "";
  return (result.content ?? [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => (c.text ?? "").replace(/\r/g, ""))
    .join("\n");
}

async function fetchSummary(
  toolCallId: string,
  output: string,
  modelRegistry: any,
): Promise<void> {
  try {
    const model = modelRegistry.find("openrouter", SUMMARY_MODEL);
    if (!model) {
      summaryCache.set(toolCallId, `[model not found: openrouter/${SUMMARY_MODEL}]`);
      return;
    }

    const auth = await modelRegistry.getApiKeyAndHeaders(model);
    if (!auth?.ok) {
      summaryCache.set(toolCallId, `[auth failed: ${auth?.error ?? "unknown"}]`);
      return;
    }

    // Build prompt with tail-truncated output (last N complete lines within 8KB)
    const MAX_BYTES = 8000;
    const lines = output.split("\n");
    let kept = lines.length;
    while (kept > 0 && Buffer.byteLength(lines.slice(lines.length - kept).join("\n"), "utf-8") > MAX_BYTES) kept--;
    const skipped = lines.length - kept;
    const body = (skipped > 0 ? `[first ${skipped} lines omitted]\n` : "") + lines.slice(lines.length - kept).join("\n");
    const prompt = `Summarize this terminal command output. Rules:
- If the result is expected/successful (files listed, tests passed, build succeeded, command ran cleanly): respond with a brief phrase of 3-6 words, e.g. "Listed 107 JS files" or "All 42 tests passed".
- If something failed, errored, or was surprising: give 1-3 sentences with the specific details.
No preamble, just the summary.\n\n<output>\n${body}\n</output>`;

    // Use fetch directly — bypasses pi-ai's complete() which mishandles some OpenRouter models
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${auth.apiKey}`,
        ...(auth.headers ?? {}),
      },
      body: JSON.stringify({
        model: SUMMARY_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 150,
      }),
    });

    if (!resp.ok) {
      summaryCache.set(toolCallId, `[HTTP ${resp.status}: ${await resp.text()}]`);
      return;
    }

    const data = await resp.json() as any;
    const summary = (data?.choices?.[0]?.message?.content ?? "").trim();
    summaryCache.set(toolCallId, summary || "[empty response]");
  } catch (err) {
    summaryCache.set(toolCallId, `[error: ${(err as Error).message ?? err}]`);
  } finally {
    pendingSummaries.delete(toolCallId);
  }
}

// ─── BashResultRenderComponent ────────────────────────────────────────────────

class BashResultRenderComponent extends Container {
  state: {
    cachedWidth?: number;
    cachedLines?: string[];
    cachedSkipped?: number;
  } = {};
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    // Inherit name, label, description, parameters, promptSnippet, renderCall
    ...bashToolDefinition,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const result = await bashToolDefinition.execute(toolCallId, params, signal, onUpdate, ctx);

      const output = getTextOutput(result).trim();
      const lineCount = output ? output.split("\n").length : 0;

      if (lineCount > SUMMARIZE_THRESHOLD && !summaryCache.has(toolCallId)) {
        pendingSummaries.add(toolCallId);
        fetchSummary(toolCallId, output, ctx.modelRegistry);
      }

      return result;
    },

    renderResult(result, options, theme, context) {
      const state = context.state as {
        startedAt?: number;
        endedAt?: number;
        interval?: ReturnType<typeof setInterval>;
        summaryPollInterval?: ReturnType<typeof setInterval>;
        phase?: number;       // 0=summary, 1=last 20 lines, 2=full
        lastExpanded?: boolean;
      };

      // Mirror built-in timing logic
      if (state.startedAt !== undefined && options.isPartial && !state.interval) {
        state.interval = setInterval(() => context.invalidate(), 1000);
      }
      if (!options.isPartial || context.isError) {
        state.endedAt ??= Date.now();
        if (state.interval) {
          clearInterval(state.interval);
          state.interval = undefined;
        }
      }

      // Every Ctrl+O press (any transition of expanded) advances the phase.
      // Only use 3-phase cycling for long outputs; short outputs just show all.
      const output = getTextOutput(result).trim();
      const lineCount = output ? output.split("\n").length : 0;
      const usePhaseCycling = lineCount > SUMMARIZE_THRESHOLD;

      if (usePhaseCycling && state.lastExpanded !== undefined && options.expanded !== state.lastExpanded) {
        state.phase = ((state.phase ?? 0) + 1) % 3;
      }
      state.lastExpanded = options.expanded;
      const phase = usePhaseCycling ? (state.phase ?? 0) : (options.expanded ? 2 : 0);

      const component =
        (context.lastComponent as BashResultRenderComponent | undefined) ??
        new BashResultRenderComponent();
      component.clear();

      const renderState = component.state;

      if (output) {
        const lines = output.split("\n");
        const styledOutput = lines
          .map((line: string) => theme.fg("toolOutput", line))
          .join("\n");

        if (phase === 2) {
          // Full output
          component.addChild(new Text(`\n${styledOutput}`, 0, 0));
          if (state.summaryPollInterval) {
            clearInterval(state.summaryPollInterval);
            state.summaryPollInterval = undefined;
          }
        } else if (phase === 1) {
          // Last 20 lines
          const PARTIAL_LINES = 20;
          component.addChild({
            render(width: number): string[] {
              if (renderState.cachedLines === undefined || renderState.cachedWidth !== width) {
                const preview = truncateToVisualLines(styledOutput, PARTIAL_LINES, width);
                renderState.cachedLines = preview.visualLines;
                renderState.cachedSkipped = preview.skippedCount;
                renderState.cachedWidth = width;
              }
              const out: string[] = [""];
              if (renderState.cachedSkipped && renderState.cachedSkipped > 0) {
                const hint =
                  theme.fg("muted", `... (${renderState.cachedSkipped} earlier lines,`) +
                  ` ${keyHint("app.tools.expand", "full output")})`;
                out.push(truncateToWidth(hint, width, "..."));
              }
              out.push(...(renderState.cachedLines ?? []));
              return out;
            },
            invalidate() {
              renderState.cachedWidth = undefined;
              renderState.cachedLines = undefined;
              renderState.cachedSkipped = undefined;
            },
          } as any);
        } else {
          // Phase 0: summary (or raw preview if output is short / no summary yet)
          const summary = summaryCache.get(context.toolCallId);
          const isPending = pendingSummaries.has(context.toolCallId);

          if (isPending && !state.summaryPollInterval) {
            state.summaryPollInterval = setInterval(() => {
              if (!pendingSummaries.has(context.toolCallId)) {
                clearInterval(state.summaryPollInterval);
                state.summaryPollInterval = undefined;
              }
              context.invalidate();
            }, 200);
          } else if (!isPending && state.summaryPollInterval) {
            clearInterval(state.summaryPollInterval);
            state.summaryPollInterval = undefined;
          }

          if (summary) {
            const md = new Markdown(summary, 0, 0, getMarkdownTheme());
            const indicator = theme.fg("muted", "∑ ");
            component.addChild({
              render(width: number): string[] {
                const indent = 2;
                const mdLines = md.render(width - indent);
                if (mdLines.length === 0) return [""];
                return [
                  "",
                  indicator + (mdLines[0] ?? ""),
                  ...mdLines.slice(1).map((l: string) => "  " + l),
                ];
              },
              invalidate() { md.invalidate?.(); },
            } as any);
          } else {
            // No summary: show last BASH_PREVIEW_LINES lines
            component.addChild({
              render(width: number): string[] {
                if (renderState.cachedLines === undefined || renderState.cachedWidth !== width) {
                  const preview = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
                  renderState.cachedLines = preview.visualLines;
                  renderState.cachedSkipped = preview.skippedCount;
                  renderState.cachedWidth = width;
                }
                const out: string[] = [""];
                if (isPending) {
                  out.push(truncateToWidth(theme.fg("muted", "∑ summarizing…"), width, "..."));
                } else if (renderState.cachedSkipped && renderState.cachedSkipped > 0) {
                  const hint =
                    theme.fg("muted", `... (${renderState.cachedSkipped} earlier lines,`) +
                    ` ${keyHint("app.tools.expand", "to expand")})`;
                  out.push(truncateToWidth(hint, width, "..."));
                }
                out.push(...(renderState.cachedLines ?? []));
                return out;
              },
              invalidate() {
                renderState.cachedWidth = undefined;
                renderState.cachedLines = undefined;
                renderState.cachedSkipped = undefined;
              },
            } as any);
          }
        }
      }

      // Preserve truncation warnings
      const truncation = (result as any)?.details?.truncation;
      const fullOutputPath = (result as any)?.details?.fullOutputPath;
      if (truncation?.truncated || fullOutputPath) {
        const warnings: string[] = [];
        if (fullOutputPath) warnings.push(`Full output: ${fullOutputPath}`);
        if (truncation?.truncated) {
          if (truncation.truncatedBy === "lines") {
            warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
          } else {
            warnings.push(`Truncated: ${truncation.outputLines} lines shown`);
          }
        }
        component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
      }

      // Preserve elapsed/duration display
      if (state.startedAt !== undefined) {
        const label = options.isPartial ? "Elapsed" : "Took";
        const endTime = state.endedAt ?? Date.now();
        component.addChild(
          new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - state.startedAt)}`)}`, 0, 0),
        );
      }

      component.invalidate();
      return component;
    },
  });
}
