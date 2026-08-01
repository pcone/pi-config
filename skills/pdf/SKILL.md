---
name: pdf
description: Convert PDF documents (local files or URLs) to Markdown. Load when a task involves reading or extracting text from PDF files, or when automatic PDF conversion fails and you need the manual path.
---

# PDF conversion

PDFs are binary — never read raw bytes into context. No `read`/`cat`/`head`/`xxd` of a `.pdf`.

## Automatic paths

- **`fetch_url` on a PDF URL**: auto-detected via content-type or body signature (`%PDF-`), re-fetched with `curl -o` (to avoid utf-8 corruption), converted via pymupdf4llm or pdftotext.
- **`read` on a local `.pdf`**: intercepted by the pdf-read-guard extension, content replaced with converted Markdown.
- Large results are saved to `~/.pi/tmp/pdf-convert/` — don't read them wholesale; use bash to grep (`grep -n -A5 'keyword' <path>`).

## Manual conversion commands

When automatic conversion fails (missing dependency, scanned PDF with no tesseract), use these directly:

### pymupdf4llm (recommended)

```bash
python3 -c "import sys, io, pymupdf, pymupdf4llm; pymupdf.set_messages(stream=io.StringIO()); print(pymupdf4llm.to_markdown(sys.argv[1]))" file.pdf
```

The `set_messages(stream=io.StringIO())` call is required — pymupdf4llm prints diagnostics to stdout otherwise, which would pollute the markdown output.

### pdftotext (fallback)

```bash
pdftotext -layout file.pdf -
```

Or to a file: `pdftotext -layout file.pdf out.txt`

### Scanned PDFs

pymupdf4llm uses tesseract for OCR automatically when it's installed (`brew install tesseract`). pdftotext cannot extract text from scanned pages at all — if you see "no extractable text" with pdftotext, install pymupdf4llm + tesseract.

### Installing converters

```bash
pip install pymupdf4llm   # recommended; includes OCR via tesseract
brew install poppler       # provides pdftotext
```
