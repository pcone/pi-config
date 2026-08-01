/**
 * Tests for the local append-system-prompt shim's insertion logic.
 *
 * injectLocalFragment is the only non-trivial behavior: it must splice the
 * local fragment in directly *after* the shared append section (ahead of
 * project context / skills / cwd) when an anchor exists, and fall back to
 * end-of-prompt when it doesn't. The prompts below mirror the real shape
 * pi's buildSystemPrompt produces, so these pin the placement contract.
 */
import { describe, it, expect } from "bun:test";
import { injectLocalFragment } from "../extensions/append-system-local";

const SHARED_APPEND = "# Global instructions\n\nBe excellent to each other.";

/**
 * A prompt shaped like pi's default buildSystemPrompt output:
 *   base → append section → project context → skills → cwd
 * Keeping the full structure means the tests prove placement *relative to
 * the sections that follow the append section*, not just "after the append".
 */
function defaultPrompt(appendSection: string | undefined): string {
	const base = "You are an expert coding assistant.\n\nGuidelines:\n- Be concise";
	const tail = [
		"\n\n<project_context>\n\nAGENTS stuff\n</project_context>",
		"\n\n<skills>\n\nskill content\n</skills>",
		"\n\nCurrent working directory: /repo",
	].join("");
	const section = appendSection ? `\n\n${appendSection}` : "";
	return `${base}${section}${tail}`;
}

describe("injectLocalFragment", () => {
	it("places the fragment directly after the shared append section", () => {
		const prompt = defaultPrompt(SHARED_APPEND);
		const fragment = "# Local nudge\nBe a little jokey sometimes.";

		const result = injectLocalFragment(prompt, SHARED_APPEND, fragment);

		// Fragment sits between the append section and the project context,
		// not at the very end (after cwd) and not before the append section.
		const fragAt = result.indexOf(fragment);
		const appendAt = result.indexOf(SHARED_APPEND);
		const ctxAt = result.indexOf("<project_context>");
		expect(fragAt).toBeGreaterThan(appendAt + SHARED_APPEND.length - 1);
		expect(fragAt).toBeLessThan(ctxAt);
		expect(result).toBe(
			`${prompt.slice(0, appendAt + SHARED_APPEND.length)}\n\n${fragment}${prompt.slice(appendAt + SHARED_APPEND.length)}`,
		);
	});

	it("keeps the project context / skills / cwd after the fragment", () => {
		const prompt = defaultPrompt(SHARED_APPEND);
		const result = injectLocalFragment(prompt, SHARED_APPEND, "NUDGE");

		expect(result).toContain("<project_context>");
		expect(result).toContain("<skills>");
		expect(result).toContain("Current working directory: /repo");
		// Order preserved: fragment before all of the tail sections.
		expect(result.indexOf("NUDGE")).toBeLessThan(result.indexOf("<project_context>"));
	});

	it("falls back to end-of-prompt when there is no shared append section", () => {
		const prompt = defaultPrompt(undefined);
		const result = injectLocalFragment(prompt, undefined, "NUDGE");

		expect(result.endsWith("NUDGE")).toBe(true);
		expect(result).toBe(`${prompt}\n\nNUDGE`);
	});

	it("falls back to end-of-prompt when the anchor is absent from the prompt", () => {
		// e.g. a custom --system-prompt that doesn't echo appendSystemPrompt.
		const prompt = "Custom prompt with no append section at all.";
		const result = injectLocalFragment(prompt, SHARED_APPEND, "NUDGE");

		expect(result).toBe(`${prompt}\n\nNUDGE`);
	});

	it("treats an empty-string anchor as no anchor (inserts at end)", () => {
		// Guard against indexOf("") === 0 placing the fragment at the head.
		const prompt = defaultPrompt("irrelevant body that lacks the anchor");
		const result = injectLocalFragment(prompt, "", "NUDGE");

		expect(result).toBe(`${prompt}\n\nNUDGE`);
	});

	it("does not duplicate or drop the anchor text", () => {
		const prompt = defaultPrompt(SHARED_APPEND);
		const result = injectLocalFragment(prompt, SHARED_APPEND, "NUDGE");

		// Exactly one occurrence of the shared section and of the fragment.
		expect(result.split(SHARED_APPEND).length - 1).toBe(1);
		expect(result.split("NUDGE").length - 1).toBe(1);
	});

	it("wraps the fragment in exactly one blank line on each side", () => {
		const prompt = defaultPrompt(SHARED_APPEND);
		const result = injectLocalFragment(prompt, SHARED_APPEND, "NUDGE");

		expect(result).toContain(`${SHARED_APPEND}\n\nNUDGE\n\n<project_context>`);
	});

	it("handles a multi-line fragment verbatim", () => {
		const prompt = defaultPrompt(SHARED_APPEND);
		const fragment = "# Tone\n\n- Friendly is fine.\n- Stay concise.";
		const result = injectLocalFragment(prompt, SHARED_APPEND, fragment);

		expect(result).toContain(`${SHARED_APPEND}\n\n${fragment}\n\n<project_context>`);
	});
});
