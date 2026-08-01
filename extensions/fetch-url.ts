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
import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	isPdfContentType,
	isPdfBody,
	createPdfConverter,
	buildFetchPdfResponse,
	newTempFilePath,
	PDF_INLINE_MAX_CHARS,
} from "./pdf-convert.ts";


// ── Browser fallback (puppeteer-core, optional) ──────────────────────
// Dynamically imported on first use so the extension loads even when
// puppeteer-core isn't installed. If the import fails, browser_fallback
// returns a clear error telling the user how to install it.
let _puppeteer: any = null;
async function getPuppeteer(): Promise<any | null> {
	if (_puppeteer === null) {
		try {
			_puppeteer = await import("puppeteer-core");
		} catch {
			_puppeteer = undefined;
		}
	}
	return _puppeteer;
}

/** Resolve a Chromium-based browser binary path. */
function resolveChromePath(): string | null {
	// Env vars (user override)
	for (const key of ["CHROME_PATH", "PUPPETEER_EXECUTABLE_PATH"]) {
		const v = process.env[key];
		if (v && existsSync(v)) return v;
	}
	// Platform-standard paths
	const macPaths = [
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
	];
	const linPaths = [
		"/usr/bin/google-chrome-stable",
		"/usr/bin/google-chrome",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
	];
	for (const p of [...macPaths, ...linPaths]) {
		if (existsSync(p)) return p;
	}
	return null;
}

// ── Challenge detection ──────────────────────────────────────────────
// Heuristics for detecting JS-challenge / bot-wall responses.
// Returns the system name or null if the page looks like real content.
function detectChallenge(html: string): string | null {
	const lower = html.toLowerCase();
	if (/<meta name="generator" content="anubis"/i.test(lower)) return "Anubis";
	if (/protected by.*anubis/i.test(lower)) return "Anubis";
	if (/cf-challenge-running/.test(lower)) return "Cloudflare Turnstile";
	if (/class="g-recaptcha"/.test(lower)) return "reCAPTCHA";
	if (/class="h-captcha"/.test(lower)) return "hCaptcha";
	// Generic: noscript with "enable JavaScript" on an otherwise empty page
	if (/<noscript>[^<]*javascript/i.test(lower) && html.length < 2000) return "JavaScript required";
	return null;
}

const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
	"(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Inline cap for HTML-derived markdown. Above this, save to disk and have the
// caller grep instead of pulling the whole page into context.
const INLINE_MAX_CHARS = 12_000;

// Inline cap for non-HTML passthrough bodies (JSON/XML/etc.).
const MAX_BODY_CHARS = 200_000;

// Temp directory under ~/.pi/tmp/<extension-name>/. Fetched pages are saved
// here when too large to inline (the model greps them rather than reading
// wholesale). This is NOT a cache — every fetch_url call issues a fresh curl.
// Only the temp-file mechanism reads from this dir (never curl).
const TEMP_DIR = resolve(homedir(), ".pi", "tmp", "fetch-url");
const TEMP_TTL_MS = 72 * 60 * 60 * 1000;
const FETCH_DIR = TEMP_DIR;

// Sweep stale temp files older than TEMP_TTL_MS on each pi startup.
// Cleanup runs only here — no periodic or close-time sweeps.
(async () => {
	try {
		await mkdir(TEMP_DIR, { recursive: true });
		const now = Date.now();
		for (const f of await readdir(TEMP_DIR)) {
			const fp = join(TEMP_DIR, f);
			try {
				const { mtimeMs } = await stat(fp);
				if (now - mtimeMs > TEMP_TTL_MS) await unlink(fp);
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

// ── Browser fallback via headless Chrome ──────────────────────────
// At most one Chrome instance is launched per fetch_url call.
// Returns the page HTML on success, null on failure. Never throws.
async function browserFetch(
	url: string,
	timeoutSec: number,
	signal: AbortSignal | undefined,
	_onUpdate: (update: any) => void,
): Promise<string | null> {
	const puppeteer = await getPuppeteer();
	if (!puppeteer) {
		_onUpdate({ content: [{ type: "text", text: "fetch_url: browser fallback unavailable — puppeteer-core is not installed. Run: npm install puppeteer-core" }] });
		return null;
	}
	const chromePath = resolveChromePath();
	if (!chromePath) {
		_onUpdate({ content: [{ type: "text", text: "fetch_url: browser fallback unavailable — no Chromium-based browser found. Set CHROME_PATH env var to the browser binary." }] });
		return null;
	}

	let browser: any = null;
	try {
		browser = await puppeteer.launch({
			executablePath: chromePath,
			headless: true,
			args: [
				"--no-sandbox",
				"--disable-setuid-sandbox",
				"--disable-dev-shm-usage",
				"--disable-gpu",
				// Hide the automation flag. Anubis and similar bot-walls
				// reject navigator.webdriver === true outright ("Access
				// Denied") instead of presenting the PoW challenge.
				"--disable-blink-features=AutomationControlled",
			],
		});
		const page = await browser.newPage();
		page.setDefaultNavigationTimeout((timeoutSec + 5) * 1000);
		page.setDefaultTimeout((timeoutSec + 5) * 1000);

		// Override the UA: headless Chrome advertises "HeadlessChrome" in
		// the UA string, which bot-walls (Anubis included) treat as an
		// outright bot signal and reject before presenting any challenge.
		// Present a clean Chrome UA instead.
		await page.setUserAgent(
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
			"(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"
		);

		// Honour the parent tool's abort signal.
		if (signal) {
			const onAbort = () => {
				try { browser?.close(); } catch { /* */ }
			};
			signal.addEventListener("abort", onAbort, { once: true });
		}

		try {
			// "domcontentloaded" lands us on the challenge page fast; the
			// PoW computation that follows is CPU-bound (network goes idle
			// while JS crunches), so networkidle0 would fire too early and
			// we'd harvest the challenge page itself.
			await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutSec * 1000 });
		} catch (navErr: any) {
			// Navigation timeout — the page may still have content.
			_onUpdate({ content: [{ type: "text", text: `fetch_url: browser navigation timed out after ${timeoutSec}s — extracting current DOM` }] });
		}

		// Poll until the challenge clears or the timeout elapses. The
		// challenge page has detectable markers (e.g. "Protected by
		// Anubis"); the solved page does not. This is what actually waits
		// out the PoW — it replaces the unreliable networkidle0 signal.
		// page.content() can throw "Execution context was destroyed" when
		// the challenge-solve navigation lands mid-read; treat that as
		// "still challenging" and retry.
		const safeContent = async (): Promise<string | null> => {
			try { return await page.content(); } catch { return null; }
		};
		const deadline = Date.now() + timeoutSec * 1000;
		let html = await safeContent();
		let challenge = html ? detectChallenge(html) : "unknown";
		while (challenge && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 1000));
			html = await safeContent();
			challenge = html ? detectChallenge(html) : "unknown";
		}
		await browser.close();
		browser = null;

		if (html && html.length > 100) return html;
		return null;
	} catch (e: any) {
		_onUpdate({ content: [{ type: "text", text: `fetch_url: browser fallback failed: ${e.message || e}` }] });
		return null;
	} finally {
		if (browser) {
			try { await browser.close(); } catch { /* */ }
		}
	}
}

export default function (pi: ExtensionAPI): void {
	// Lazily-built PDF converter (pymupdf4llm → pdftotext).
	let _pdfConverter: ReturnType<typeof createPdfConverter> | null = null
	function pdfConverter() {
		if (!_pdfConverter) _pdfConverter = createPdfConverter(pi.exec.bind(pi))
		return _pdfConverter
	}

	pi.registerTool({
		name: "fetch_url",
		label: "Fetch URL",
		description:
			"Fetch a URL with curl. Returns curl exit code and the body. " +
			"HTML pages are run through Mozilla Readability and converted to Markdown — " +
			"navigation, ads, and scripts are stripped while structure (headings, lists, " +
			"tables, code) is preserved. Large or non-article HTML is saved to a temp " +
			"file with a path to grep, not read wholesale. " +
			"PDF responses (detected by content-type or body signature) are converted " +
			"to Markdown automatically via pymupdf4llm/pdftotext — never read raw PDF bytes. " +
			"JSON/XML and other non-HTML/non-PDF responses are returned inline. " +
			"Response headers are off by default " +
			"(pass include_headers to get them). For JSON APIs, set headers for auth " +
			"(e.g. ['Authorization: Bearer <token>']). " +
			"Use `browser_fallback: true` to retry JS-challenge pages " +
			"(Anubis, Cloudflare Turnstile) via headless Chrome. " +
			"Requires puppeteer-core and a Chromium-based browser.",
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
			browser_fallback: Type.Optional(
				Type.Boolean({
				description: "If curl returns a JS-challenge page (Anubis, Cloudflare, etc.), retry via headless Chrome which can execute the challenge JS. Requires puppeteer-core and a Chromium-based browser. Default: false.",
			})
		),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			// Reject non-http/https schemes — the model produces safe URLs
			// normally, but hallucinated scheme-less or file:// URLs must
			// not reach curl.
			try {
				const scheme = new URL(params.url).protocol;
				if (scheme !== "http:" && scheme !== "https:") {
					return {
						content: [{ type: "text", text: `fetch_url: scheme "${scheme}" is not supported — only http and https are allowed.` }],
						details: { exitCode: -1, statusCode: "", contentType: "", transform: "error" },
						isError: true,
					};
				}
			} catch {
				return {
					content: [{ type: "text", text: `fetch_url: "${params.url}" is not a valid URL.` }],
					details: { exitCode: -1, statusCode: "", contentType: "", transform: "error" },
					isError: true,
				};
			}

			const args: string[] = [
				"-sSL",
				"-i",
				"--retry", "2",
				"--retry-max-time", "10",
				"--max-time",
				String(params.timeout ?? 30),
				"--max-filesize", "52428800",
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
			let { status, contentType, headerBlock, body } = splitResponse(raw);

			const prefixLines: string[] = [`curl exit: ${result.code}`];
			if (result.stderr?.trim()) prefixLines.push(`curl stderr:\n${result.stderr.trim()}`);
			if (params.include_headers && headerBlock) {
				prefixLines.push(`--- response ---\n${headerBlock}`);
			}
			let prefix = prefixLines.join("\n");

			const details: {
				exitCode: number;
				statusCode: string;
				contentType: string;
				transform: "none" | "readability" | "fallback" | "pdf" | "error";
				savedPath?: string;
			} = { exitCode: result.code, statusCode: status, contentType, transform: "none" };

			// --- Non-HTML: return inline (truncated). ---
			if (!/\bhtml\b/i.test(contentType) || !body.trim()) {
				// PDF detection — must fire BEFORE generic passthrough.
				// Content-type OR body sniff (the incident URL serves text/html with a PDF body).
				if (isPdfContentType(contentType) || isPdfBody(body)) {
					// Re-fetch with curl -o to avoid the utf-8 decode round-trip
					// that corrupts binary (verified: 396KB → 626KB).
					const tempPath = await newTempFilePath("pdf", "pdf")
					const pdfArgs: string[] = [
						"-sSL",
						"-o", tempPath,
						"--retry", "2",
						"--retry-max-time", "10",
						"--max-time",
						String(params.timeout ?? 30),
						"--max-filesize", "52428800",
						"-A",
						USER_AGENT,
					]
					if (params.method) pdfArgs.push("-X", params.method)
					for (const h of params.headers ?? []) pdfArgs.push("-H", h)
					if (params.data) pdfArgs.push("--data-raw", params.data)
					pdfArgs.push(params.url)

					const pdfResult = await pi.exec("curl", pdfArgs, {
						cwd: ctx.cwd,
						signal,
					})

					// Clean up temp pdf regardless of outcome.
					try {
						if (pdfResult.code !== 0) {
							const errText =
								`${prefix}\n--- body (pdf fetch failed) ---\n` +
								`curl exit: ${pdfResult.code}\n` +
								`curl stderr: ${(pdfResult.stderr || "").trim() || "(none)"}`
							return { content: [{ type: "text", text: errText }], details }
						}

						const conv = await pdfConverter().convert(tempPath)
						const pdfDetails = { ...details, transform: "pdf" as const }
						return buildFetchPdfResponse(prefix, conv, params.url).then((r) => ({
							content: r.content,
							details: { ...pdfDetails, savedPath: r.savedPath },
						}))
					} finally {
						unlink(tempPath).catch(() => {})
					}
				}

				const truncated =
					body.length > MAX_BODY_CHARS
						? body.slice(0, MAX_BODY_CHARS) +
							`\n...[truncated at ${MAX_BODY_CHARS} chars]`
						: body;
				const text = `${prefix}\n--- body ---\n${truncated}`;
				return { content: [{ type: "text", text }], details };
			}

			// --- JS-challenge detection + browser fallback ---
			// When curl lands on a challenge page (Anubis PoW, Cloudflare
			// Turnstile, etc.), retry with headless Chrome. Chrome executes
			// the challenge JS transparently; we harvest the resulting DOM
			// and feed it through the same Readability pipeline.
			const isHtml = /\bhtml\b/i.test(contentType);
			if (isHtml && body.trim() && params.browser_fallback) {
				const challenge = detectChallenge(body);
				if (challenge) {
					_onUpdate({ content: [{ type: "text", text: `fetch_url: ${challenge} challenge detected, trying browser fallback...` }] });
					try {
						const browserHtml = await browserFetch(params.url, params.timeout ?? 60, signal, _onUpdate);
						if (browserHtml) {
							body = browserHtml;
							prefixLines.unshift(`browser fallback (${challenge} challenge solved via headless Chrome)`);
							prefix = prefixLines.join("\n");
							details.transform = "none"; // reset — will be re-set by the pipeline below
						} else {
							prefixLines.push(`[browser fallback for ${challenge} returned empty — showing curl result]`);
							prefix = prefixLines.join("\n");
						}
					} catch (e: any) {
						prefixLines.push(`[browser fallback for ${challenge} error: ${e.message || e} — showing curl result]`);
						prefix = prefixLines.join("\n");
					}
				}
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
