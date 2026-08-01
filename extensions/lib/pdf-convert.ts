/**
 * PDF detection, conversion (pymupdf4llm → pdftotext), temp-file helpers,
 * and response builders shared by fetch-url and pdf-read-guard.
 *
 * Design: decisions/fetch-url/002-pdf-conversion.md
 */

import { mkdir, writeFile, readdir, stat, unlink } from "node:fs/promises"
import { join, resolve } from "node:path"
import { homedir } from "node:os"
import { createHash } from "node:crypto"

// ── Constants ──────────────────────────────────────────────────────────

/** Inline cap for converted PDF markdown (mirrors fetch-url's INLINE_MAX_CHARS). */
export const PDF_INLINE_MAX_CHARS = 12_000

/** Timeout for pymupdf4llm (OCR can be slow on scanned docs). */
export const PDF_CONVERT_TIMEOUT_MS = 120_000

// ── Temp directory ─────────────────────────────────────────────────────

const PDF_TEMP_DIR = resolve(homedir(), ".pi", "tmp", "pdf-convert")
const TEMP_TTL_MS = 72 * 60 * 60 * 1000

// Sweep stale temp files older than TEMP_TTL_MS on module load.
;(async () => {
	try {
		await mkdir(PDF_TEMP_DIR, { recursive: true })
		const now = Date.now()
		for (const f of await readdir(PDF_TEMP_DIR)) {
			const fp = join(PDF_TEMP_DIR, f)
			try {
				const { mtimeMs } = await stat(fp)
				if (now - mtimeMs > TEMP_TTL_MS) await unlink(fp)
			} catch { /* race */ }
		}
	} catch { /* dir may not exist yet */ }
})()

// ── Types ──────────────────────────────────────────────────────────────

export type PdfEngine = "pymupdf4llm" | "pdftotext"

export type PdfConversion =
	| { ok: true; markdown: string; engine: PdfEngine }
	| { ok: false; error: string }

export interface ExecFn {
	(
		cmd: string,
		args: string[],
		opts?: { timeout?: number; cwd?: string; signal?: AbortSignal },
	): Promise<{ stdout: string; stderr: string; code: number }>
}

// ── Detection ──────────────────────────────────────────────────────────

/**
 * Test a content-type header for PDF. Case-insensitive, matches
 * "application/pdf", "application/PDF", "text/html; application/pdf", etc.
 */
export function isPdfContentType(contentType: string): boolean {
	return /\bpdf\b/i.test(contentType)
}

/**
 * Prefix-sniff a possibly-lossy decoded body string for PDF magic bytes.
 * The incident URL (microsoft.com research PDF) serves text/html with a PDF
 * body — content-type alone is insufficient.
 *
 * Only checks the first ~64 chars to avoid scanning large payloads.
 */
export function isPdfBody(body: string): boolean {
	return /^\s*%PDF-/.test(body.slice(0, 64))
}

/**
 * Sniff raw bytes for PDF magic via latin1 (byte-preserving) decoding.
 * UTF-8 would lossy-decode non-ASCII bytes; latin1 maps every byte 1:1 to
 * a codepoint so the %PDF- prefix survives intact.
 */
export function isPdfBytes(buf: Uint8Array): boolean {
	const head = new TextDecoder("latin1").decode(buf.slice(0, 64))
	return /^\s*%PDF-/.test(head)
}

// ── Converter ──────────────────────────────────────────────────────────

/**
 * Build a PDF-to-markdown converter backed by `exec`.
 *
 * Engine availability is probed once per instance and cached (pymupdf4llm
 * first, then pdftotext).  If neither engine is available the converter
 * returns `{ ok: false }` with a descriptive error naming the missing tool
 * and its install command.
 */
export function createPdfConverter(exec: ExecFn) {
	let _probedEngine: PdfEngine | null | undefined = undefined

	const pythonBin = process.env.PDF_MD_PYTHON ?? "python3"

	async function probeEngine(): Promise<PdfEngine | null> {
		if (_probedEngine !== undefined) return _probedEngine

		// Try pymupdf4llm first.
		try {
			const r = await exec(pythonBin, ["-c", "import pymupdf4llm"], {
				timeout: 15_000,
			})
			if (r.code === 0) {
				_probedEngine = "pymupdf4llm"
				return _probedEngine
			}
		} catch { /* probe failed — try next */ }

		// Fall back to pdftotext.
		try {
			const r = await exec("sh", ["-c", "command -v pdftotext"], {
				timeout: 5_000,
			})
			if (r.code === 0 && r.stdout.trim()) {
				_probedEngine = "pdftotext"
				return _probedEngine
			}
		} catch { /* probe failed */ }

		_probedEngine = null
		return null
	}

	async function convertWithPymupdf4llm(
		pdfPath: string,
	): Promise<PdfConversion> {
		const cmd = pythonBin
		const args = [
			"-c",
			"import sys, io, pymupdf, pymupdf4llm; pymupdf.set_messages(stream=io.StringIO()); print(pymupdf4llm.to_markdown(sys.argv[1]))",
			pdfPath,
		]
		try {
			const r = await exec(cmd, args, { timeout: PDF_CONVERT_TIMEOUT_MS })
			if (r.code !== 0) {
				return {
					ok: false,
					error: `pymupdf4llm exited ${r.code}: ${r.stderr || r.stdout || "(no output)"}`,
				}
			}
			const md = r.stdout.trim()
			if (!md) {
				return {
					ok: false,
					error: "PDF produced no extractable text (scanned pages? tesseract missing?)",
				}
			}
			return { ok: true, markdown: md, engine: "pymupdf4llm" }
		} catch (e: any) {
			return { ok: false, error: `pymupdf4llm failed: ${e.message || e}` }
		}
	}

	async function convertWithPdfToText(
		pdfPath: string,
	): Promise<PdfConversion> {
		try {
			const r = await exec("pdftotext", ["-layout", pdfPath, "-"], {
				timeout: PDF_CONVERT_TIMEOUT_MS,
			})
			if (r.code !== 0) {
				return {
					ok: false,
					error: `pdftotext exited ${r.code}: ${r.stderr || r.stdout || "(no output)"}`,
				}
			}
			const md = (r.stdout ?? "").trim()
			if (!md) {
				return {
					ok: false,
					error: "PDF produced no extractable text (scanned pages? tesseract missing?)",
				}
			}
			return { ok: true, markdown: md, engine: "pdftotext" }
		} catch (e: any) {
			return { ok: false, error: `pdftotext failed: ${e.message || e}` }
		}
	}

	async function convert(pdfPath: string): Promise<PdfConversion> {
		const engine = await probeEngine()

		if (engine === "pymupdf4llm") return convertWithPymupdf4llm(pdfPath)
		if (engine === "pdftotext") return convertWithPdfToText(pdfPath)

		return {
			ok: false,
			error:
				"No PDF conversion engine available. Install one:\n" +
				"  pip install pymupdf4llm   (recommended; includes OCR via tesseract)\n" +
				"  brew install poppler       (provides pdftotext)",
		}
	}

	return { convert }
}

// ── Temp-file helpers ──────────────────────────────────────────────────

/**
 * Create a unique temp-file path under ~/.pi/tmp/pdf-convert/.
 * Does not write the file — returns the path for the caller to write.
 */
export async function newTempFilePath(
	stem: string,
	ext: string,
): Promise<string> {
	await mkdir(PDF_TEMP_DIR, { recursive: true })
	const hash = createHash("sha1")
		.update(`${stem}-${Date.now()}-${Math.random()}`)
		.digest("hex")
		.slice(0, 8)
	const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
	return join(PDF_TEMP_DIR, `${stem}-${hash}-${ts}.${ext}`)
}

/**
 * Write content to a uniquely-named temp file and return the path.
 */
export async function saveTempFile(
	content: string,
	stem: string,
	ext: string,
): Promise<string> {
	const p = await newTempFilePath(stem, ext)
	await writeFile(p, content, "utf8")
	return p
}

// ── Response builders ──────────────────────────────────────────────────

/**
 * Build a tool-result content block for a fetch_url PDF conversion.
 *
 * Small (≤12K chars) markdown is inlined with a `pdf: <engine> -> markdown`
 * marker.  Large markdown is saved to disk with grep hints.  Failed
 * conversions produce a clear error + `pdf` skill pointer — never raw bytes.
 */
export async function buildFetchPdfResponse(
	prefix: string,
	conv: PdfConversion,
	url: string,
): Promise<{ content: { type: "text"; text: string }[]; savedPath?: string }> {
	if (conv.ok) {
		if (conv.markdown.length <= PDF_INLINE_MAX_CHARS) {
			const text = `${prefix}\n--- body (pdf: ${conv.engine} -> markdown) ---\n${conv.markdown}`
			return { content: [{ type: "text", text }] }
		}

		const path = await saveTempFile(conv.markdown, "converted", "md")
		const text =
			`${prefix}\n--- body (pdf: ${conv.engine} -> markdown; ${conv.markdown.length} chars — saved to disk) ---\n` +
			`saved: ${path}\n` +
			`It's large — don't read it directly. Use bash to grep it for what you need ` +
			`(e.g. \`grep -n -A5 'keyword' ${path}\`).`
		return { content: [{ type: "text", text }], savedPath: path }
	}

	const text =
		`${prefix}\n--- body (pdf conversion failed) ---\n` +
		`${conv.error}\n` +
		`Use the \`pdf\` skill for manual conversion (pdftotext -layout or pymupdf4llm).`
	return { content: [{ type: "text", text }] }
}

/**
 * Build a tool-result content block for a local `read` PDF conversion.
 *
 * Same inline/save/error branches as `buildFetchPdfResponse`, but the
 * response text says "Read PDF file" rather than including a curl prefix.
 */
export async function buildReadPdfResponse(
	conv: PdfConversion,
	filePath: string,
): Promise<{ content: { type: "text"; text: string }[]; savedPath?: string }> {
	if (conv.ok) {
		if (conv.markdown.length <= PDF_INLINE_MAX_CHARS) {
			const text = `Read PDF file [${conv.engine}] — converted to Markdown:\n\n${conv.markdown}`
			return { content: [{ type: "text", text }] }
		}

		const path = await saveTempFile(conv.markdown, "converted", "md")
		const text =
			`Read PDF file [${conv.engine}] — converted markdown (${conv.markdown.length} chars) saved to disk:\n` +
			`saved: ${path}\n` +
			`PDF files are binary — converted automatically. Don't read raw PDF bytes.\n` +
			`It's large — don't read it directly. Use bash to grep it for what you need ` +
			`(e.g. \`grep -n -A5 'keyword' ${path}\`).`
		return { content: [{ type: "text", text }], savedPath: path }
	}

	const text =
		`Read PDF file — conversion failed: ${conv.error}\n\n` +
		`Use the \`pdf\` skill for manual conversion.`
	return { content: [{ type: "text", text }] }
}
