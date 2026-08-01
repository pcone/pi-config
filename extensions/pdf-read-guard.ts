/**
 * Guard that intercepts `read` results on `.pdf` files and replaces the
 * (binary) content with Markdown converted via pymupdf4llm/pdftotext.
 *
 * Follows the rules.ts `tool_result` handler pattern exactly.
 * Never injects raw PDF bytes into model context.
 */

import { readFile } from "node:fs/promises"
import path from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import {
	isPdfBytes,
	createPdfConverter,
	buildReadPdfResponse,
} from "./lib/pdf-convert.ts"

export default function (pi: ExtensionAPI): void {
	// Lazy converter — probed once per process.
	let _converter: ReturnType<typeof createPdfConverter> | null = null
	function converter() {
		if (!_converter) _converter = createPdfConverter(pi.exec.bind(pi))
		return _converter
	}

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "read") return
		if (event.isError) return

		const p: unknown = event.input?.path
		if (typeof p !== "string" || !p || !/\.pdf$/i.test(p)) return

		const resolved = path.resolve(ctx.cwd, p)

		let buf: Uint8Array | null
		try {
			buf = await readFile(resolved).catch(() => null)
			if (!buf || !isPdfBytes(buf)) return // not a real PDF or read failed — pass through
		} catch {
			return // read errored — pass through untouched
		}

		try {
			const conv = await converter().convert(resolved)
			const r = await buildReadPdfResponse(conv, resolved)
			return {
				content: r.content,
				details: {
					...(event.details ?? {}),
					pdfConversion: conv.ok ? conv.engine : "error",
				},
			}
		} catch {
			// Unexpected error during conversion — pass through
			return undefined
		}
	})
}
