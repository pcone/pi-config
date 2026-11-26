// `provider/id[:level]` model specs, shared by the agent frontmatter parser
// (`allowedModels`) and the spawn-time resolver (decisions 031, 054).

/** pi's thinking levels (`docs/extensions.md` → pi.getThinkingLevel). A model
 *  spec's `:suffix` is a level only when it names one — otherwise it belongs to
 *  the model id (`:free` is a real OpenRouter tag). */
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Split `provider/id[:level]` into the bare spec and its level. */
export function splitModelSpec(spec: string): { id: string; level?: string } {
	const i = spec.lastIndexOf(":");
	if (i > 0 && THINKING_LEVELS.has(spec.slice(i + 1))) {
		return { id: spec.slice(0, i), level: spec.slice(i + 1) };
	}
	return { id: spec };
}
