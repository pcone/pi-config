---
title: "PDF responses convert to Markdown (never raw binary in context)"
type: decision
status: done
date: 2026-08-01
---

# PDF responses convert to Markdown (never raw binary in context)

**What:** `fetch_url` on a PDF URL and `read` on a local `.pdf` file convert the PDF to Markdown via pymupdf4llm (preferred) or pdftotext (fallback). Neither path ever injects raw PDF bytes into model context. All conversions are automatic — the model never needs to manually invoke a converter.

**Why:** Session `019fafc6-15e4-7673-8ebf-5afc631cf92b` called `fetch_url` on Microsoft Research PDFs 6 times. Because `fetch_url` treats `application/pdf` as "non-HTML" and inlines raw binary (up to 200KB per call), ~1.2MB of PDF binary garbage entered the context across 18 fetch_url calls. Worse, the incident URL serves `content-type: text/html` — the *actual* body is a PDF, so content-type-based detection alone would miss it. The `read` tool has no binary detection either; a local `.pdf` read would dump the same garbage.

Two verified corruption mechanisms:
1. **Content-type alone is insufficient** — the incident URL (microsoft.com research PDF) returns `text/html` to curl, body is a PDF. Body-sniff (`%PDF-` prefix) is mandatory.
2. **`pi.exec` returns stdout as a utf-8-decoded string** — writing the decoded body back to disk for conversion corrupts binary. Verified: 396KB PDF becomes 626KB after the utf-8 round-trip, conversion yields 0 characters. The fix: re-fetch with `curl -o <tempfile>`, which writes raw bytes directly to disk.

pymupdf4llm also prints diagnostics ("=== Document parser messages ===" + OCR announcements) to **stdout**, which would pollute the markdown output. The verified fix: `pymupdf.set_messages(stream=io.StringIO())` silences diagnostics → stderr, leaving stdout clean.

**Alternatives considered:**

- **Pure-JS PDF libs (pdfjs-dist, pdf-parse)** — pdfjs-dist bundles a full JS PDF renderer (~2MB). pdf-parse is a thin wrapper with worse extraction quality and no markdown output — would need custom markdown assembly for headings/lists/tables. Rejected: worse output, heavier JS dep, no OCR path.
- **markitdown (Microsoft)** — heavier Python dependency (requires `markitdown[all]`), worse output quality on academic papers (observed: flattens multi-column layouts, loses heading hierarchy). pymupdf4llm produces better structured output with smaller deps.
- **Single fetch, write stdout to disk** — corrupts binary (see above). The only byte-safe path is a second `curl -o` fetch.
- **Rely on content-type alone** — misses the incident URL case (text/html content-type with PDF body). Body sniff is mandatory.
- **pymupdf4llm only (no pdftotext fallback)** — pymupdf4llm requires Python + pip install. pdftotext is much lighter (brew install poppler) and works well for text-heavy PDFs. Users without Python still get conversion.

**Tradeoffs:**

- **Re-fetch cost** — PDF URLs incur a second `curl` call (first for headers/body sniff, second with `-o` for raw bytes). The first call's body is now only used for the initial detection (64-char prefix), so the cost is real but bounded: small PDFs will have already been downloaded twice before we knew they were PDFs. Acceptable: the alternative is garbage in context.
- **engine probing on first PDF** — each process probes pymupdf4llm then pdftotext once, cached for the session lifetime. ~1-2s overhead on first PDF encounter.
- **temp file management** — converted markdown >12K chars lands in `~/.pi/tmp/pdf-convert/` with a 72h TTL sweep on startup. Same pattern as fetch-url's temp dir.

**Design:**

1. **`extensions/lib/pdf-convert.ts`** (shared module, not an extension — lives in `lib/` so the extension loader's `*.ts` auto-discovery skips it) — detection (`isPdfContentType`, `isPdfBody`, `isPdfBytes`), converter (`createPdfConverter` with engine chain pymupdf4llm → pdftotext → error), temp helpers, response builders (`buildFetchPdfResponse`, `buildReadPdfResponse`).
2. **`extensions/fetch-url.ts`** — PDF detection fires BEFORE the HTML/non-HTML split, so even a PDF mislabeled `text/html` routes to the PDF path. Re-fetches with `curl -o`, converts, responds via `buildFetchPdfResponse`, sets `details.transform = "pdf"`.
3. **`extensions/pdf-read-guard.ts`** — `tool_result` handler intercepting `read` on `.pdf` paths. Replaces content wholesale with converted markdown (inline/saved/error). Follows rules.ts handler pattern.
4. **`skills/pdf/SKILL.md`** — on-demand skill with verified manual commands for when automatic conversion fails.
5. **system prompt note** — short behavioral instruction in `APPEND_SYSTEM.md`.

Conversion engine order (pymupdf4llm → pdftotext → descriptive error):
- pymupdf4llm produces structured markdown with headings, lists, tables, and OCR via tesseract.
- pdftotext is a lighter fallback for text-heavy PDFs.
- If both are unavailable, the error names the missing tool and its install command.

All exec paths use a 120s timeout (pymupdf4llm OCR can be slow on scanned docs).

**Test coverage:** `tests/pdf-convert.test.ts` — detection cases, engine fallback with stub ExecFn, response builder cases (inline/save/error), real end-to-end conversion on a fixture PDF, never-binary invariant assertions.
