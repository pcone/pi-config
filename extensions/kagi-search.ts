/**
 * Kagi Search Extension
 *
 * Provides a `kagi_search` tool that the LLM can use to search the web
 * via the Kagi Search API, plus a `/kagi-key` command to set the API key.
 *
 * Configuration (in priority order):
 * 1. Environment variable KAGI_API_KEY
 * 2. ~/.pi/agent/kagi.json  {"apiKey": "..."}
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { Type } from "typebox";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface KagiConfig {
	apiKey?: string;
}

interface KagiSearchMeta {
	trace: string;
	node: string;
	ms: number;
}

interface KagiSearchResult {
	url: string;
	title: string;
	snippet?: string;
	time?: string;
	image?: { url: string };
	props?: Record<string, unknown>;
}

interface KagiRelatedSearch {
	url: string;
	title: string;
	snippet?: string;
	props?: Record<string, unknown>;
}

interface KagiSearchError {
	code: string;
	message: string;
	url?: string;
}

interface KagiSearchResponse {
	meta: KagiSearchMeta;
	data: {
		search?: KagiSearchResult[];
		related_search?: KagiRelatedSearch[];
	} | null;
	errors?: KagiSearchError[];
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Load API key: env var > global config > empty
	let apiKey = process.env.KAGI_API_KEY ?? "";

	// Try loading from ~/.pi/agent/kagi.json (global config)
	const configPath = join(homedir(), ".pi", "agent", "kagi.json");
	try {
		if (existsSync(configPath)) {
			const config: KagiConfig = JSON.parse(readFileSync(configPath, "utf-8"));
			if (config.apiKey) {
				apiKey = config.apiKey;
			}
		}
	} catch {
		// Ignore read errors
	}

	const KAGI_API_URL = "https://kagi.com/api/v1/search";

	// Shared cache directory under ~/.pi/cache/<extension-name>/
	const cacheRoot = resolve(homedir(), ".pi", "cache");
	const searchDir = join(cacheRoot, "kagi-search");
	mkdirSync(searchDir, { recursive: true });

	// Sweep stale cache files older than CACHE_TTL_MS on each pi startup.
	// Cleanup runs only here — no periodic or close-time sweeps.
	const CACHE_TTL_MS = 72 * 60 * 60 * 1000;
	try {
		const now = Date.now();
		for (const f of readdirSync(searchDir)) {
			const fp = join(searchDir, f);
			try {
				const age = now - statSync(fp).mtimeMs;
				if (age > CACHE_TTL_MS) rmSync(fp);
			} catch { /* race with concurrent removal */ }
		}
	} catch { /* dir may not exist yet */ }

	// ---- kagi_search tool --------------------------------------------------

	pi.registerTool({
		name: "kagi_search",
		label: "Kagi Search",
		description:
			"Search the web using the Kagi Search API. Returns a list of relevant results " +
			"with titles, URLs, and snippets. Use when you need up-to-date information " +
			"that is not in the model's training data.",
		promptSnippet: "Search the web for current information on any topic",
		promptGuidelines: [
			"Use kagi_search when you need up-to-date information from the web that is not in the model's training data.",
			"For programming questions, include specific error messages, library names, and version numbers in the query.",
			"Set limit to 3-5 for targeted queries, or omit for broader discovery.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			limit: Type.Optional(
				Type.Integer({
					description: "Maximum number of results (default 10, max 20)",
					minimum: 1,
					maximum: 20,
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			if (!apiKey) {
				return {
					content: [
						{
							type: "text",
							text:
								"Kagi API key is not configured.\n\n" +
								"Set the **KAGI_API_KEY** environment variable, or create " +
								"`~/.pi/agent/kagi.json` with:\n\n" +
								'```json\n{"apiKey": "your-key-here"}\n```\n\n' +
								"Use `/kagi-key <your-key>` to save it right now.",
						},
					],
					details: { error: "no_api_key" },
					isError: true,
				};
			}

			const query = params.query;
			const body = { query };

			const response = await fetch(KAGI_API_URL, {
				method: "POST",
				headers: {
					Authorization: `Bot ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
				signal,
			});

			if (!response.ok) {
				const body = await response.text();
				return {
					content: [
						{
							type: "text",
							text:
								`Kagi Search API returned HTTP ${response.status} ${response.statusText}\n` +
								body.slice(0, 2000),
						},
					],
					details: { error: "api_error", status: response.status },
					isError: true,
				};
			}

			let json: KagiSearchResponse;
			try {
				json = (await response.json()) as KagiSearchResponse;
			} catch {
				return {
					content: [
						{
							type: "text",
							text: "Kagi Search API returned non-JSON response.",
						},
					],
					details: { error: "parse_error" },
					isError: true,
				};
			}

			// Check for API-level error
			if (json.errors && json.errors.length > 0) {
				const err = json.errors[0];
				return {
					content: [
						{
							type: "text",
							text: `Kagi Search API error [${err.code}]: ${err.message}`,
						},
					],
					details: { error: "api_error", code: err.code },
					isError: true,
				};
			}

			// No results or empty data
			if (!json.data || (!json.data.search && !json.data.related_search)) {
				return {
					content: [{ type: "text", text: `Search for "${query}" returned no results (${json.meta.ms}ms)` }],
					details: { query, resultCount: 0, responseTimeMs: json.meta.ms },
				};
			}

			// Save full results to temp file (always)
			const safeName = query.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 80);
			const dumpFile = join(searchDir, `${safeName}.json`);
			writeFileSync(dumpFile, JSON.stringify(json, null, 2));

			// Build truncated summary for the LLM
			const results = json.data.search ?? [];
			const related = json.data.related_search ?? [];

			const lines: string[] = [];
			for (const item of results.slice(0, 8)) {
				const published = item.time ? ` _(Published: ${item.time})_` : "";
				lines.push(
					`- [${item.title}](${item.url})${published}`,
				);
			}
			if (results.length > 8) {
				lines.push(`- *… and ${results.length - 8} more results*`);
			}

			if (related.length > 0) {
				lines.push(
					`\n**Related:** ${related.map((r) => r.title).join(", ")}`,
				);
			}

			const summary = `Search for "${query}" — ${results.length} results (${json.meta.ms}ms). Full data saved to \`${dumpFile}\`. Use \`read\` to inspect it.`;

			return {
				content: [
					{
						type: "text",
						text: `${summary}\n\n${lines.join("\n")}`,
					},
				],
				details: {
					query,
					resultCount: results.length,
					relatedCount: related.length,
					responseTimeMs: json.meta.ms,
					savedTo: dumpFile,
				},
			};
		},
	});

	// ---- /kagi-key command --------------------------------------------------

	pi.registerCommand("kagi-key", {
		description: "View or set the Kagi Search API key (saved to ~/.pi/agent/kagi.json)",
		handler: async (args, ctx) => {
			const key = args?.trim();

			if (!key) {
				// Show current status
				if (apiKey) {
					const masked = apiKey.slice(0, 4) + "…" + apiKey.slice(-4);
					ctx.ui.notify(`Kagi API key is set: ${masked}`, "info");
				} else {
					ctx.ui.notify(
						"Kagi API key is not configured. " +
							"Pass it as an argument, set KAGI_API_KEY env var, " +
							"or create ~/.pi/agent/kagi.json manually.",
						"warn",
					);
				}
				return;
			}

			// Save to global config
			const filePath = join(homedir(), ".pi", "agent", "kagi.json");
			try {
				writeFileSync(filePath, JSON.stringify({ apiKey: key }, null, 2));
			} catch (err) {
				ctx.ui.notify(
					`Failed to write ${filePath}: ${(err as Error).message}`,
					"error",
				);
				return;
			}

			apiKey = key;
			ctx.ui.notify("Kagi API key saved to " + filePath, "info");
		},
	});
}
