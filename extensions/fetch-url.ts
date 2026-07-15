// Adds a `fetch_url` tool the LLM can call.
//
// HTML responses are run through Mozilla Readability (boilerplate extraction —
// strips nav/ads/scripts/footers) and converted to Markdown via turndown + GFM,
// so headings, lists, code blocks, and tables survive. Non-HTML (JSON, XML,
// images, plain text) is returned verbatim.
//
// Large or non-article output is saved to a temp file instead of inlined into
// context, with an instruction to grep rather than read:
//   - Readability success but markdown > INLINE_MAX_CHARS -> save markdown.
//   - Readability failure (non-article: SPA shells, link pages, error pages) ->
//     save the raw HTML, unless the fallback markdown is small and clean.
//
// Response headers are omitted by default; pass include_headers to get them.

import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import * as turndownPluginGfm from "turndown-plugin-gfm";
import { parseHTML } from "linkedom";
import { mkdir, writeFile, readdir, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
	"(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Inline cap for HTML-derived markdown. Above this, save to disk and have the
// caller grep instead of pulling the whole page into context.
const INLINE_MAX_CHARS = 12_000;

// Inline cap for non-HTML passthrough bodies (JSON/XML/etc.).
const MAX_BODY_CHARS = 200_000;

// Cache directory under ~/.pi/cache/<extension-name>/
const CACHE_DIR = resolve(homedir(), ".pi", "cache", "fetch-url");
const CACHE_TTL_MS = 72 * 60 * 60 * 1000;
const FETCH_DIR = CACHE_DIR;

// Sweep stale cache files older than CACHE_TTL_MS on each pi startup.
// Cleanup runs only here — no periodic or close-time sweeps.
(async () => {
	try {
		await mkdir(CACHE_DIR, { recursive: true });
		const now = Date.now();
		for (const f of await readdir(CACHE_DIR)) {
			const fp = join(CACHE_DIR, f);
			try {
				const { mtimeMs } = await stat(fp);
				if (now - mtimeMs > CACHE_TTL_MS) await unlink(fp);
			} catch { /* race */ }
		}
	} catch { /* dir may not exist yet */ }
})();

type ParsedResponse = {
	status: string;
	contentType: string;
	headerBlock: string;
	body: string;
};

// Split `curl -i` output into the final response's headers and body.
// With -L, curl emits one header block per redirect hop; the final hop's
// headers are the last block whose first line starts with "HTTP/". The body
// is everything after that block (rejoined on blank lines in case it contained
// them). Returns body = raw input if no HTTP block is found.
function splitResponse(raw: string): ParsedResponse {
	const parts = raw.split(/\r?\n\r?\n/);
	let lastHdr = -1;
	for (let i = 0; i < parts.length; i++) {
		const first = parts[i].split(/\r?\n/)[0].trim();
		if (/^HTTP\//.test(first)) lastHdr = i;
	}
	if (lastHdr === -1) {
		return { status: "", contentType: "", headerBlock: "", body: raw };
	}
	const headerBlock = parts[lastHdr];
	const body = parts.slice(lastHdr + 1).join("\n\n");
	const lines = headerBlock.split(/\r?\n/);
	const status = lines[0].trim();
	const headers: Record<string, string> = {};
	for (const line of lines.slice(1)) {
		const idx = line.indexOf(":");
		if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
	}
	return {
		status,
		contentType: headers["content-type"] ?? "",
		headerBlock,
		body,
	};
}

// Lazily-built converter; constructing it per call is wasteful.
let _turndown: TurndownService | null = null;
function turndown(): TurndownService {
	if (!_turndown) {
		_turndown = new TurndownService({
			headingStyle: "atx",
			codeBlockStyle: "fenced",
			bulletListMarker: "-",
		});
		_turndown.use(turndownPluginGfm.gfm);
	}
	return _turndown;
}

// Returns cleaned Markdown for an HTML body. `mode` is "readability" when
// Readability extracted an article, "fallback" for a tag-stripped conversion.
function htmlToMarkdown(body: string): { mode: "readability" | "fallback"; markdown: string } {
	const td = turndown();
	const { document } = parseHTML(body);
	const article = new Readability(document).parse();
	if (article && article.content) {
		return { mode: "readability", markdown: td.turndown(article.content) };
	}
	// No article: strip boilerplate tags and convert whatever remains.
	const doc = parseHTML(body).document;
	let root = doc.body || doc.documentElement;
	// linkedom leaves <body> empty when the source has no explicit <body> tag;
	// fall back to the whole document so loose flow content is still reached.
	if (!root.innerHTML.trim()) root = doc.documentElement;
	for (const sel of ["script", "style", "nav", "header", "footer", "aside", "noscript", "form", "svg", "head", "title", "meta", "link"]) {
		for (const el of [...root.querySelectorAll(sel)]) el.remove();
	}
	return { mode: "fallback", markdown: td.turndown(root.innerHTML || "") };
}

// Save fetched content to a temp file and return its path. Never throws into
// the caller's hot path on a known-bad URL: host falls back to "page".
async function saveFetch(content: string, url: string, ext: string): Promise<string> {
	await mkdir(FETCH_DIR, { recursive: true });
	let host = "page";
	try {
		host = new URL(url).host.replace(/[^a-z0-9.-]/gi, "_") || "page";
	} catch {
		// invalid url — keep "page"
	}
	const hash = createHash("sha1").update(url).digest("hex").slice(0, 8);
	const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const p = join(FETCH_DIR, `${host}-${hash}-${ts}.${ext}`);
	await writeFile(p, content, "utf8");
	return p;
}

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "fetch_url",
		label: "Fetch URL",
		description:
			"Fetch a URL with curl. Returns curl exit code and the body. " +
			"HTML pages are run through Mozilla Readability and converted to Markdown — " +
			"navigation, ads, and scripts are stripped while structure (headings, lists, " +
			"tables, code) is preserved. Large or non-article HTML is saved to a temp " +
			"file with a path to grep, not read wholesale. JSON/XML and other non-HTML " +
			"responses are returned inline. Response headers are off by default " +
			"(pass include_headers to get them). For JSON APIs, set headers for auth " +
			"(e.g. ['Authorization: Bearer <token>']).",
		parameters: Type.Object({
			url: Type.String({ description: "URL (http/https)." }),
			method: Type.Optional(
				Type.String({ description: "HTTP method (default GET)." })
			),
			headers: Type.Optional(
				Type.Array(Type.String(), {
					description: 'Extra request headers, each as "Name: Value".',
				})
			),
			data: Type.Optional(
				Type.String({ description: "Request body (POST/PUT)." })
			),
			timeout: Type.Optional(
				Type.Number({ description: "Timeout in seconds (default 30)." })
			),
			include_headers: Type.Optional(
				Type.Boolean({
					description: "Include the full response header block in the output (default: off).",
				})
			),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args: string[] = [
				"-sSL",
				"-i",
				"--max-time",
				String(params.timeout ?? 30),
				"-A",
				USER_AGENT,
			];
			if (params.method) args.push("-X", params.method);
			for (const h of params.headers ?? []) args.push("-H", h);
			if (params.data) args.push("--data-raw", params.data);
			args.push(params.url);

			const result = await pi.exec("curl", args, {
				cwd: ctx.cwd,
				signal,
			});

			const raw = (result.stdout ?? "").toString();
			const { status, contentType, headerBlock, body } = splitResponse(raw);

			const prefixLines: string[] = [`curl exit: ${result.code}`];
			if (result.stderr?.trim()) prefixLines.push(`curl stderr:\n${result.stderr.trim()}`);
			if (params.include_headers && headerBlock) {
				prefixLines.push(`--- response ---\n${headerBlock}`);
			}
			const prefix = prefixLines.join("\n");

			const details: {
				exitCode: number;
				statusCode: string;
				contentType: string;
				transform: "none" | "readability" | "fallback" | "error";
				savedPath?: string;
			} = { exitCode: result.code, statusCode: status, contentType, transform: "none" };

			// --- Non-HTML: return inline (truncated). ---
			if (!/\bhtml\b/i.test(contentType) || !body.trim()) {
				const truncated =
					body.length > MAX_BODY_CHARS
						? body.slice(0, MAX_BODY_CHARS) +
							`\n...[truncated at ${MAX_BODY_CHARS} chars]`
						: body;
				const text = `${prefix}\n--- body ---\n${truncated}`;
				return { content: [{ type: "text", text }], details };
			}

			// --- HTML: extract to markdown. ---
			let mode: "readability" | "fallback" | "error";
			let markdown = "";
			try {
				const r = htmlToMarkdown(body);
				mode = r.mode;
				markdown = r.markdown;
			} catch {
				mode = "error";
				markdown = "";
			}
			details.transform = mode;

			// Non-article / extraction failed: save raw HTML unless the fallback
			// produced a small, clean markdown worth inlining.
			if (mode !== "readability") {
				if (markdown.trim() && markdown.length <= INLINE_MAX_CHARS) {
					const text = `${prefix}\n--- body (${mode}: html -> markdown) ---\n${markdown}`;
					return { content: [{ type: "text", text }], details };
				}
				const path = await saveFetch(body, params.url, "html");
				details.savedPath = path;
				const text =
					`${prefix}\n--- body (not an article; raw HTML saved to disk) ---\n` +
					`saved: ${path}\n` +
					`Don't read this file directly — it's noisy. Use bash to grep it for what you need ` +
					`(e.g. \`grep -oE 'href="[^"]+"' ${path}\`).`;
				return { content: [{ type: "text", text }], details };
			}

			// Readability succeeded: inline if small, else save markdown to disk.
			if (markdown.length > INLINE_MAX_CHARS) {
				const path = await saveFetch(markdown, params.url, "md");
				details.savedPath = path;
				const text =
					`${prefix}\n--- body (readability markdown; ${markdown.length} chars — saved to disk) ---\n` +
					`saved: ${path}\n` +
					`It's large — don't read it directly. Use bash to grep it for what you need ` +
					`(e.g. search for a heading: \`grep -n '^##' ${path}\`, or grep a keyword and read a window with \`grep -n -A5 'keyword' ${path}\`).`;
				return { content: [{ type: "text", text }], details };
			}

			const text = `${prefix}\n--- body (readability: html -> markdown) ---\n${markdown}`;
			return { content: [{ type: "text", text }], details };
		},
	});
}
