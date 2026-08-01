/**
 * Local Append-System-Prompt Shim
 *
 * Appends a second system-prompt fragment — read from a file that lives
 * outside this repo — immediately after the shared APPEND_SYSTEM.md, so you
 * can experiment with personal/local nudges (e.g. "it's okay to be a little
 * jokey sometimes") without committing them.
 *
 * Fragment source: <agentDir>/APPEND_SYSTEM.local.md, where <agentDir> is
 * pi's agent config dir (defaults to ~/.pi/agent/, overridable via
 * PI_CODING_AGENT_DIR). The file is optional; when it is missing or empty,
 * nothing happens and the shared prompt is untouched.
 *
 * Placement: the fragment is inserted directly after the shared append
 * section so the two live together as "APPEND_SYSTEM.md + local tail",
 * ahead of any project context / skills / cwd that pi appends afterwards.
 * When there is no shared append section to anchor on (e.g. a custom
 * --system-prompt with no APPEND_SYSTEM.md), the fragment is appended at
 * the end instead.
 *
 * before_agent_start rebuilds the system prompt fresh for each agent run,
 * so this never accumulates across turns. The fragment is cached by mtime
 * and re-read on the next agent run after the file is saved, so edits apply
 * live with no restart.
 */

import { readFileSync, statSync } from "node:fs";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LOCAL_APPEND_FILENAME = "APPEND_SYSTEM.local.md";

let cache: { mtimeMs: number; content: string } | undefined;

/**
 * Return the trimmed local fragment, or undefined when the file is absent
 * or empty. Cached by mtime so an unchanged file costs one stat per agent
 * run; editing the file invalidates the cache automatically.
 */
function readLocalAppend(): string | undefined {
	const filePath = `${getAgentDir()}/${LOCAL_APPEND_FILENAME}`;
	let mtimeMs: number;
	try {
		mtimeMs = statSync(filePath).mtimeMs;
	} catch {
		// Missing file is the normal, expected state — stay silent.
		cache = undefined;
		return undefined;
	}
	if (cache && cache.mtimeMs === mtimeMs) {
		return cache.content || undefined;
	}
	let content: string;
	try {
		content = readFileSync(filePath, "utf-8").trim();
	} catch {
		cache = undefined;
		return undefined;
	}
	cache = content ? { mtimeMs, content } : undefined;
	return content || undefined;
}

/**
 * Splice `fragment` into the assembled prompt directly after the shared
 * append section (when present), otherwise at the end. Pure so it can be
 * unit-tested without a running pi session.
 *
 * pi builds the prompt as: base → tools/guidelines → append section →
 * <project_context> → skills → cwd. Anchoring on `baseAppend` (the exact
 * injected APPEND_SYSTEM.md text) places the local tail right after the
 * shared append section and ahead of the project context, matching the
 * "second APPEND_SYSTEM.md" intent. With no anchor the fragment falls to
 * the end of the prompt.
 */
export function injectLocalFragment(
	prompt: string,
	baseAppend: string | undefined,
	fragment: string,
): string {
	const at = baseAppend && prompt.includes(baseAppend)
		? prompt.indexOf(baseAppend) + baseAppend.length
		: prompt.length;
	return `${prompt.slice(0, at)}\n\n${fragment}${prompt.slice(at)}`;
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		const fragment = readLocalAppend();
		if (!fragment) return;
		return {
			systemPrompt: injectLocalFragment(
				event.systemPrompt,
				event.systemPromptOptions.appendSystemPrompt,
				fragment,
			),
		};
	});
}
