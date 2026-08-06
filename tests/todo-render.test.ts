/**
 * Golden tests for renderTodoBlock (extensions/todo.ts).
 *
 * renderTodoBlock is the pure, exported core of the todo list's context
 * injection: it renders the current non-done task list as a compact block
 * (heading, one line per open task, optional done-count footer, directive
 * line). The before_agent_start handler is a thin flag-check + composition
 * over this function, so pinning the exact output here covers the injected
 * content end-to-end. These tests construct Todo[] inline and assert exact
 * strings — no coupling to nextId or the tool runtime.
 */
import { describe, it, expect } from "bun:test";
import { renderTodoBlock } from "../extensions/todo";

interface Todo {
	id: number;
	text: string;
	status: "pending" | "in_progress" | "done" | "deferred";
}

const DIRECTIVE =
	"Work from this list: one in_progress at a time; mark done when complete; keep each task to 1–2 short sentences with detail in the plan doc.";

const todo = (id: number, text: string, status: Todo["status"]): Todo => ({ id, text, status });

describe("renderTodoBlock", () => {
	it("returns an empty string for an empty list", () => {
		expect(renderTodoBlock([], undefined)).toBe("");
		expect(renderTodoBlock([], "docs/TODO.md")).toBe("");
	});

	it("returns an empty string when all tasks are done", () => {
		const todos = [todo(1, "Ship it", "done"), todo(2, "Party", "done")];
		expect(renderTodoBlock(todos, undefined)).toBe("");
	});

	it("renders a single pending task: heading + line + directive, no done-count footer", () => {
		const todos = [todo(1, "Scaffold the project", "pending")];
		expect(renderTodoBlock(todos, undefined)).toBe(
			["## Current tasks", "[ ] #1: Scaffold the project", DIRECTIVE].join("\n"),
		);
	});

	it("renders mixed statuses with correct marks, in array order, with done-count footer", () => {
		const todos = [
			todo(1, "Scaffold the project", "pending"),
			todo(2, "Wire up the new auth middleware", "in_progress"),
			todo(3, "Draft the API spec", "deferred"),
			todo(4, "Ship v1", "done"),
		];
		expect(renderTodoBlock(todos, undefined)).toBe(
			[
				"## Current tasks",
				"[ ] #1: Scaffold the project",
				"[>] #2: Wire up the new auth middleware",
				"[-] #3: Draft the API spec",
				"1 done (hidden — /todos to view all)",
				DIRECTIVE,
			].join("\n"),
		);
	});

	it("includes the plan-doc path in the heading when doc is set", () => {
		const todos = [todo(1, "Step 3: wire up the new auth middleware", "in_progress")];
		expect(renderTodoBlock(todos, "docs/TODO.md")).toBe(
			[
				"## Current tasks (plan: docs/TODO.md)",
				"[>] #1: Step 3: wire up the new auth middleware",
				DIRECTIVE,
			].join("\n"),
		);
	});

	it("preserves input array order and does not re-sort by status", () => {
		// Deliberately non-status-sorted: deferred first, then pending, then in_progress.
		const todos = [
			todo(1, "Write docs", "deferred"),
			todo(2, "Scaffold", "pending"),
			todo(3, "Wire API", "in_progress"),
		];
		const out = renderTodoBlock(todos, undefined);
		expect(out).toBe(
			[
				"## Current tasks",
				"[-] #1: Write docs",
				"[ ] #2: Scaffold",
				"[>] #3: Wire API",
				DIRECTIVE,
			].join("\n"),
		);
	});

	it("counts multiple done tasks in the footer", () => {
		const todos = [
			todo(1, "Scaffold", "done"),
			todo(2, "Ship v1", "done"),
			todo(3, "Celebrate", "pending"),
		];
		expect(renderTodoBlock(todos, undefined)).toBe(
			[
				"## Current tasks",
				"[ ] #3: Celebrate",
				"2 done (hidden — /todos to view all)",
				DIRECTIVE,
			].join("\n"),
		);
	});
});
