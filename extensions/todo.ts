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
});

const MAX_VISIBLE = 4;

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
		refreshWidget(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		reconstructState(ctx);
		refreshWidget(ctx);
	});

	// ── Tool ──

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: `Track tasks for this session. Actions: list, add (text), start (id), complete (id), defer (id), remove (id), edit (id, text), clear, setDoc (text).

Use setDoc first to register the path to the detailed plan doc (e.g. setDoc with text "docs/TODO.md"). Then add one-sentence summaries referencing step numbers from that doc (e.g. "Step 3: wire up the new auth middleware"). The doc path is shown in the widget so you always know where the details live.`,
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const snapshot = (): TodoDetails => ({
				action: params.action,
				todos: [...todos],
				nextId,
				doc,
			});

			switch (params.action) {
				case "list":
					return {
						content: [
							{
								type: "text",
								text: todos.length
									? todos
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
									: "No tasks.",
							},
						],
						details: snapshot(),
					};

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
					return {
						content: [{ type: "text", text: `Added #${todo.id}: ${todo.text}` }],
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
					return {
						content: [{ type: "text", text: `Edited #${editTodo.id}: "${oldText}" → "${editTodo.text}"` }],
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
