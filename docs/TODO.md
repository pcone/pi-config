# WO-2026-018: PDF → Markdown integration + binary-PDF discouragement

## Problem

Session `019fafc6-15e4-7673-8ebf-5afc631cf92b` (tfd work, 2026-07-29) called
`fetch_url` on Microsoft Research PDFs 6 times. `fetch_url` treated
`application/pdf` as "non-HTML" and inlined up to 200KB of raw binary per call
(~1.2MB total across 18 fetch_url calls, 6 of them PDF dumps). Verified from the
session JSONL: tool results with `%PDF-1.7` bodies and compressed streams.

Root cause: `extensions/fetch-url.ts` non-HTML branch dumps body verbatim.
Core `read` tool would do the same for local `.pdf` files (no binary detection;
only images are special-cased).

## Fixes (all verified feasible)

### 1. `extensions/pdf-convert.ts` (new shared module)
- Detection: `isPdfContentType` (header regex), `isPdfBody` (prefix sniff on
  decoded string), `isPdfFile` (prefix sniff on bytes, latin1 decode).
- Converter via injected `exec` fn (testable): pymupdf4llm first, pdftotext
  fallback, clear error if neither. pymupdf4llm invocation must silence
  `pymupdf.message()` via `pymupdf.set_messages(stream=io.StringIO())`
  (verified: diagnostics go to stdout otherwise).
- `PDF_MD_PYTHON` env override for python binary.
- Temp save (own dir `~/.pi/tmp/pdf-convert/`, 72h TTL) + inline threshold
  12K chars (match fetch-url's INLINE_MAX_CHARS).
- Response-text builders (pure, testable): fetch_url variant (with curl prefix)
  and read-guard variant.

### 2. `extensions/fetch-url.ts` (modify)
- In non-HTML branch, detect PDF BEFORE generic passthrough (content-type
  regex OR body prefix sniff — the incident URL serves `text/html` to HEAD,
  so sniffing is mandatory).
- PDF path: re-fetch with `curl -o` (utf-8 round-trip corrupts binary —
  verified: 396KB → 626KB, conversion yields 0 chars), convert, inline-or-save.
- `details.transform` gains "pdf" value.
- Tool description: state PDFs auto-convert to Markdown; never read raw PDF bytes.

### 3. `extensions/pdf-read-guard.ts` (new extension)
- `tool_result` handler for `read` on `.pdf` paths (case-insensitive).
  Resolve via ctx.cwd, read bytes, sniff `%PDF-`; convert; replace content
  with converted markdown (or saved-path pointer / error).
- Order-independent vs rules.ts (replaces content wholesale; carries its own
  one-line "PDFs are binary, converted automatically" note).
- Never sets isError on success (rules.ts skips injection on isError).

### 4. `APPEND_SYSTEM.md` — 3-line "PDFs" behavioral net (bash cat etc.)
### 5. `skills/pdf/SKILL.md` (new) — on-demand conversion workflow + rules
### 6. `decisions/fetch-url/002-pdf-conversion.md` + index update
### 7. `README.md` — structure/temp-dir/skill/rule updates
### 8. `tests/pdf-convert.test.ts` — detection, converter (stub exec + real
    pdftotext integration on 590-byte fixture PDF), response builders.

## Verified facts (orchestrator)

- pymupdf4llm 1.28.0 installed user-level (`pip install --user
  --break-system-packages`); PEP 668 enforced on this Python 3.14.
- Incident PDF converts: 92,971 chars markdown, 4.5s, real headings/authors.
- pdftotext (poppler) at /opt/homebrew/bin/pdftotext — good text fallback.
- Fixture PDF (590B, one page "Hello PDF World") works in both engines.
- `pi.exec` ExecResult.stdout is a decoded string; timeout option in ms.
- Extension tool_result handlers compose sequentially; readdir load order
  is not guaranteed alphabetical.
- Worktree was dirty (23 files, incl. fetch-url.ts browser-fallback work) —
  snapshot-committed before dispatch so HEAD matches live config.

## Steps

- [x] Investigate incident session, root cause, tooling
- [x] Validate pymupdf4llm + pdftotext + fixture + stdout/bytes issues
- [x] Snapshot commit dirty working tree
- [x] Dispatch WO-2026-018 to implement-pro
- [ ] Review diff, run tests, end-to-end verify fetch_url + read guard
- [ ] Update README/decisions/skill/APPEND_SYSTEM (implementer does, I verify)
