/**
 * Minimal todo extension for orchestrator sessions.
 *
 * One tool, six actions, a sliding-window widget, /todos command.
 * State lives in tool result details for automatic branching support.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface Todo {
	id: number;
	text: string;
	status: "pending" | "in_progress" | "done" | "deferred";
}

interface TodoDetails {
	action: "list" | "add" | "start" | "complete" | "defer" | "clear" | "setDoc" | "remove" | "edit";
	todos: Todo[];
	nextId: number;
	doc?: string;
	error?: string;
}

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "start", "complete", "defer", "clear", "setDoc", "remove", "edit"] as const),
	text: Type.Optional(Type.String({ description: "Task description (for add), new text (for edit), or doc path (for setDoc)" })),
	id: Type.Optional(Type.Number({ description: "Task ID (for start/complete/defer/remove/edit)" })),
	includeComplete: Type.Optional(
		Type.Boolean({ description: "For list, include completed tasks (default: false)" }),
	),
});

const MAX_VISIBLE = 4;

/** Brevity threshold (chars): add/edit texts longer than this get a nudge. */
const LONG_TASK_NUDGE = 200;
/** Non-blocking nudge appended to add/edit success text for over-long tasks. */
const LONG_TASK_NUDGE_MSG =
	" Nudge: long task — keep tasks to 1–2 short sentences; move detail to the plan doc.";

/**
 * Render the current non-done task list as a compact context block: a
 * heading (with plan-doc path when set), one line per non-done task in array
 * order, an optional done-count footer line, and a directive line. Pure +
 * exported so it is unit-testable; mirrors the `list` action's default view.
 * Returns "" when there are no non-done tasks (empty list or all done).
 */
export function renderTodoBlock(todos: Todo[], doc: string | undefined): string {
	const open = todos.filter((t) => t.status !== "done");
	if (open.length === 0) return "";
	const lines: string[] = [doc ? `## Current tasks (plan: ${doc})` : "## Current tasks"];
	for (const t of open) {
		const mark =
			t.status === "in_progress" ? "[>]" : t.status === "deferred" ? "[-]" : "[ ]";
		lines.push(`${mark} #${t.id}: ${t.text}`);
	}
	const done = todos.filter((t) => t.status === "done").length;
	if (done > 0) lines.push(`${done} done (hidden — /todos to view all)`);
	lines.push(
		"Work from this list: one in_progress at a time; mark done when complete; keep each task to 1–2 short sentences with detail in the plan doc.",
	);
	return lines.join("\n");
}

function icon(t: Todo): string {
	switch (t.status) {
		case "done":
			return "✓";
		case "in_progress":
			return "▸";
		case "deferred":
			return "◌";
		default:
			return "•";
	}
}

class TodoListComponent {
	private todos: Todo[];
	private doc: string | undefined;
	private theme: any;
	private onClose: () => void;

	constructor(todos: Todo[], doc: string | undefined, theme: any, onClose: () => void) {
		this.todos = todos;
		this.doc = doc;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];
		const th = this.theme;

		lines.push("");
		const title = this.doc ? ` Tasks [${this.doc}] ` : " Tasks ";
		lines.push(truncateToWidth(th.fg("accent", title), width));
		lines.push(truncateToWidth(th.fg("borderMuted", "─".repeat(width)), width));
		lines.push("");

		if (this.todos.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No tasks")}`, width));
		} else {
			for (const t of this.todos) {
				const prefix = icon(t);
				let line: string;
				if (t.status === "done") {
					line = `  ${th.fg("success", prefix)} ${th.fg("dim", t.text)}`;
				} else if (t.status === "in_progress") {
					line = `  ${th.fg("accent", prefix)} ${th.fg("text", t.text)}`;
				} else if (t.status === "deferred") {
					line = `  ${th.fg("muted", prefix)} ${th.fg("muted", t.text)}`;
				} else {
					line = `  ${th.fg("text", prefix)} ${th.fg("text", t.text)}`;
				}
				lines.push(truncateToWidth(line, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(th.fg("dim", "  Press Escape to close"), width));
		lines.push("");

		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	let todos: Todo[] = [];
	let nextId = 1;
	let doc: string | undefined;
	// One-shot injection: set on session_start / session_tree / session_compact
	// (the moments the model would otherwise lose the list), consumed and
	// cleared by before_agent_start. Re-prime, not every-turn.
	let pendingTodoInjection = false;

	const reconstructState = (ctx: ExtensionContext) => {
		todos = [];
		nextId = 1;
		doc = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;
			const details = msg.details as TodoDetails | undefined;
			if (details) {
				todos = details.todos;
				nextId = details.nextId;
				if (details.doc !== undefined) doc = details.doc;
			}
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		reconstructState(ctx);
		pendingTodoInjection = todos.length > 0;
		refreshWidget(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		reconstructState(ctx);
		pendingTodoInjection = todos.length > 0;
		refreshWidget(ctx);
	});

	// Re-prime after compaction: the injected list message has been summarized
	// away, so the model loses the list unless we re-inject. Do NOT call
	// reconstructState here — the compacted branch may have summarized away the
	// tool results, which would reset todos[] to empty. The in-memory array
	// survives compaction unchanged.
	pi.on("session_compact", () => {
		pendingTodoInjection = todos.length > 0;
	});

	// Inject the current list as a one-shot display:false message so it lands
	// in context (end-of-input, highest attention) and persists in the branch
	// until the next compaction. Cleared after one emission; never appends to
	// the system prompt and never re-injects on every turn. No PI_IS_SUBAGENT
	// guard: todos are session-scoped, and a subagent's own (usually empty)
	// list injects nothing.
	pi.on("before_agent_start", async () => {
		if (!pendingTodoInjection) return;
		pendingTodoInjection = false;
		const block = renderTodoBlock(todos, doc);
		if (!block) return;
		return {
			message: {
				customType: "todo-injection",
				content: block,
				display: false,
				details: { count: todos.length },
			},
		};
	});

	// ── Tool ──

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: `Track tasks for this session. Actions: list (returns non-completed tasks by default; set includeComplete to true to include completed tasks), add (text), start (id), complete (id), defer (id), remove (id), edit (id, text), clear, setDoc (text).

Use setDoc first to register the path to the detailed plan doc (e.g. setDoc with text "docs/TODO.md"), then add short task summaries referencing step numbers from that doc (e.g. "Step 3: wire up the new auth middleware"). Each task is a title, not a spec: 1–2 short sentences maximum. Full reasoning, sub-steps, and context belong in the plan doc — never in the task text. If a description is growing past two lines, move the detail to the doc and shorten the task.`,
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const snapshot = (): TodoDetails => ({
				action: params.action,
				todos: [...todos],
				nextId,
				doc,
			});

			switch (params.action) {
				case "list": {
					const listedTodos = params.includeComplete
						? todos
						: todos.filter((t) => t.status !== "done");
					return {
						content: [
							{
								type: "text",
								text: listedTodos.length
									? listedTodos
											.map((t) => {
												const mark =
													t.status === "done"
														? "[x]"
														: t.status === "deferred"
															? "[-]"
															: t.status === "in_progress"
																? "[>]"
																: "[ ]";
												return `${mark} #${t.id}: ${t.text}`;
											})
											.join("\n")
									: params.includeComplete
										? "No tasks."
										: "No incomplete tasks.",
							},
						],
						details: snapshot(),
					};
				}

				case "start": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "Error: id required for start" }],
							details: { ...snapshot(), error: "id required" },
						};
					}
					const todo = todos.find((t) => t.id === params.id);
					if (!todo) {
						return {
							content: [{ type: "text", text: `#${params.id} not found` }],
							details: { ...snapshot(), error: `#${params.id} not found` },
						};
					}
					for (const t of todos) {
						if (t.status === "in_progress") t.status = "pending";
					}
					todo.status = "in_progress";
					return {
						content: [{ type: "text", text: `Started #${todo.id}: ${todo.text}` }],
						details: snapshot(),
					};
				}

				case "setDoc": {
					if (!params.text) {
						doc = undefined;
						return {
							content: [{ type: "text", text: "Cleared doc path" }],
							details: snapshot(),
						};
					}
					doc = params.text;
					return {
						content: [{ type: "text", text: `Doc path set: ${doc}` }],
						details: snapshot(),
					};
				}

				case "add": {
					if (!params.text) {
						return {
							content: [{ type: "text", text: "Error: text required for add" }],
							details: { ...snapshot(), error: "text required" },
						};
					}
					const todo: Todo = { id: nextId++, text: params.text, status: "pending" };
					todos.push(todo);
					const nudge = params.text.length > LONG_TASK_NUDGE ? LONG_TASK_NUDGE_MSG : "";
					return {
						content: [{ type: "text", text: `Added #${todo.id}: ${todo.text}${nudge}` }],
						details: snapshot(),
					};
				}

				case "complete": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "Error: id required for complete" }],
							details: { ...snapshot(), error: "id required" },
						};
					}
					const todo = todos.find((t) => t.id === params.id);
					if (!todo) {
						return {
							content: [{ type: "text", text: `#${params.id} not found` }],
							details: { ...snapshot(), error: `#${params.id} not found` },
						};
					}
					todo.status = "done";
					return {
						content: [{ type: "text", text: `Completed #${todo.id}: ${todo.text}` }],
						details: snapshot(),
					};
				}

				case "defer": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "Error: id required for defer" }],
							details: { ...snapshot(), error: "id required" },
						};
					}
					const todo = todos.find((t) => t.id === params.id);
					if (!todo) {
						return {
							content: [{ type: "text", text: `#${params.id} not found` }],
							details: { ...snapshot(), error: `#${params.id} not found` },
						};
					}
					todo.status = todo.status === "deferred" ? "pending" : "deferred";
					return {
						content: [
							{
								type: "text",
								text: `#${todo.id} ${todo.status === "deferred" ? "deferred" : "un-deferred"}: ${todo.text}`,
							},
						],
						details: snapshot(),
					};
				}

				case "remove": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "Error: id required for remove" }],
							details: { ...snapshot(), error: "id required" },
						};
					}
					const removeTodo = todos.find((t) => t.id === params.id);
					if (!removeTodo) {
						return {
							content: [{ type: "text", text: `#${params.id} not found` }],
							details: { ...snapshot(), error: `#${params.id} not found` },
						};
					}
					const removedText = removeTodo.text;
					todos = todos.filter((t) => t.id !== params.id);
					return {
						content: [{ type: "text", text: `Removed #${params.id}: ${removedText}` }],
						details: snapshot(),
					};
				}

				case "edit": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "Error: id required for edit" }],
							details: { ...snapshot(), error: "id required" },
						};
					}
					if (!params.text) {
						return {
							content: [{ type: "text", text: "Error: text required for edit" }],
							details: { ...snapshot(), error: "text required" },
						};
					}
					const editTodo = todos.find((t) => t.id === params.id);
					if (!editTodo) {
						return {
							content: [{ type: "text", text: `#${params.id} not found` }],
							details: { ...snapshot(), error: `#${params.id} not found` },
						};
					}
					const oldText = editTodo.text;
					editTodo.text = params.text;
					const nudge = params.text.length > LONG_TASK_NUDGE ? LONG_TASK_NUDGE_MSG : "";
					return {
						content: [{ type: "text", text: `Edited #${editTodo.id}: "${oldText}" → "${editTodo.text}"${nudge}` }],
						details: snapshot(),
					};
				}

				case "clear": {
					const count = todos.length;
					todos = [];
					nextId = 1;
					return {
						content: [{ type: "text", text: `Cleared ${count} tasks` }],
						details: { action: "clear", todos: [], nextId: 1 },
					};
				}
			}
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.error) {
				return new Text(theme.fg("error", details.error), 0, 0);
			}

			const active = details.todos.filter((t) => t.status === "in_progress");
			const done = details.todos.filter((t) => t.status === "done");
			const deferred = details.todos.filter((t) => t.status === "deferred");

			if (details.action === "list" || details.action === "clear") {
				if (details.todos.length === 0) {
					return new Text(theme.fg("dim", "No tasks"), 0, 0);
				}
				const parts = [`${details.todos.length} task(s)`];
				if (active.length) parts.push(`${active.length} active`);
				if (done.length) parts.push(`${done.length} done`);
				if (deferred.length) parts.push(`${deferred.length} deferred`);
				return new Text(theme.fg("muted", parts.join(" · ")), 0, 0);
			}

			const text = result.content[0];
			const msg = text?.type === "text" ? text.text : "";
			if (details.action === "setDoc") {
				return new Text(theme.fg("accent", "📄 ") + theme.fg("muted", msg), 0, 0);
			}
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
		},
	});

	// ── Widget (sliding window, 4 visible) ──

	function buildWidgetLines(): string[] {
		if (todos.length === 0) return [];

		const active = todos.filter((t) => t.status === "in_progress");
		const done = todos.filter((t) => t.status === "done");
		const deferred = todos.filter((t) => t.status === "deferred");

		const parts: string[] = [`● ${todos.length} tasks`];
		if (doc) parts[0] += ` [${doc}]`;
		if (active.length) parts.push(`${active.length} active`);
		if (done.length) parts.push(`${done.length} done`);
		if (deferred.length) parts.push(`${deferred.length} deferred`);

		const activeIdx = todos.findIndex((t) => t.status === "in_progress");
		let start: number;
		if (activeIdx === -1) {
			start = 0;
		} else {
			start = Math.max(0, Math.min(activeIdx - 1, todos.length - MAX_VISIBLE));
		}
		const visible = todos.slice(start, start + MAX_VISIBLE);
		const hiddenBefore = start;
		const hiddenAfter = todos.length - start - visible.length;

		const lines: string[] = [parts.join(" · ")];
		if (hiddenBefore > 0) lines.push(`  … ${hiddenBefore} earlier`);
		for (const t of visible) {
			lines.push(`  ${icon(t)} ${t.text}`);
		}
		if (hiddenAfter > 0) lines.push(`  … ${hiddenAfter} more`);
		return lines;
	}

	function refreshWidget(ctx: ExtensionContext) {
		if (ctx.mode !== "tui") return;
		const lines = buildWidgetLines();
		ctx.ui.setWidget("todo-widget", lines.length ? lines : undefined);
	}

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName === "todo") refreshWidget(ctx);
	});

	// ── /todos command (full list) ──

	pi.registerCommand("todos", {
		description: "Show all tasks",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				// Non-TUI: just print the list
				const lines = todos.length
					? todos.map((t) => `${icon(t)} #${t.id}: ${t.text}`).join("\n")
					: "No tasks.";
				ctx.ui.notify(lines, "info");
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new TodoListComponent(todos, doc, theme, () => done());
			});
		},
	});
}
