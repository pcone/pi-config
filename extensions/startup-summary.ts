import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STARTUP_SUMMARY_EVENT = "pi-config:startup-summary-item";

interface StartupSummaryItem {
	key: string;
	order: number;
	text: string;
}

function isStartupSummaryItem(value: unknown): value is StartupSummaryItem {
	if (!value || typeof value !== "object") return false;
	const item = value as Partial<StartupSummaryItem>;
	return (
		typeof item.key === "string" &&
		typeof item.order === "number" &&
		typeof item.text === "string"
	);
}

/**
 * Collect startup notices from extensions and render them together.
 *
 * Pi coalesces consecutive info notifications into one status entry, so
 * independently emitted [Rules], [Subagents], and [Modes] notices overwrite
 * one another. Collection happens during session_start; resources_discover
 * runs immediately afterward and prints one multi-line status entry.
 */
export default function startupSummaryExtension(pi: ExtensionAPI): void {
	const items = new Map<string, StartupSummaryItem>();

	pi.events.on(STARTUP_SUMMARY_EVENT, (value) => {
		if (!isStartupSummaryItem(value)) return;
		items.set(value.key, value);
	});

	pi.on("resources_discover", async (_event, ctx) => {
		const lines = [...items.values()]
			.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
			.map((item) => item.text);
		items.clear();

		if (lines.length === 0) return;

		const text = lines.join("\n");
		if (ctx.hasUI) {
			ctx.ui.notify(text, "info");
		} else {
			console.log(text);
		}
	});
}
