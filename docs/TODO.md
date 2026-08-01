# Post-WO-2026-018 verification battery — done

All checks pass; one finding fixed and committed (`e5ceaa6`).

## Results

**Unit/integration**
- `bun test tests/pdf-convert.test.ts` — 29 pass (was 27; +2 new error-format tests)
- Full `bun test` — 300 pass, 2 fail / 2 errors = the pre-existing typebox
  resolution issue in subagent-async tests (verified identical on pre-WO tree)

**Live e2e (fresh `pi -p`, local content-type server + incident URL)**

| Case | Result |
|---|---|
| fetch real.pdf (application/pdf) | converted → saved path (563K chars) ✓ |
| fetch mislabelled.html (text/html, PDF body) | body-sniff caught → converted ✓ |
| fetch octet.pdf (application/octet-stream) | sniff caught → converted ✓ |
| fetch corrupt.pdf (truncated) | single-line error, no binary ✓ |
| fetch password.pdf (AES-256) | clear "password-protected" error ✓ |
| fetch data.json | JSON passthrough unchanged ✓ |
| fetch index.html | Readability unchanged ✓ |
| fetch incident URL (microsoft genev-icfp21.pdf) | converted → saved (93K chars) ✓ |
| read scanned.pdf (image-only) | OCR via tesseract → text ✓ |
| read text-as-pdf.pdf (text misnamed .pdf) | guard pass-through, raw text ✓ |
| read large.pdf | saved-path pointer ✓ |

**Binary-leak check** — full session JSONL inspected: **0 `%PDF` occurrences**;
fetch_url tool results are clean pointers (`--- body (pdf: pymupdf4llm ->
markdown; N chars — saved to disk) ---` + path + grep hint).

**Discouragement** — fresh session confirms: "PDFs are binary" note present in
system prompt verbatim; `pdf` skill discovered with correct description.

## Finding fixed this session

Conversion failures dumped full Python tracebacks into the tool result (context
noise) and password-protected PDFs errored with a cryptic
`TypeError: 'NoneType' object is not subscriptable`. Fixed in
`extensions/lib/pdf-convert.ts`:
- pymupdf4llm snippet pre-checks `is_encrypted` → "PDF is password-protected —
  no text extraction without the password"
- error text = last non-empty stderr line (the exception message), never a
  traceback → corrupt.pdf now reports `pymupdf4llm: RuntimeError: code=7:
  Invalid number of pages`
- results shrank from multi-hundred-byte tracebacks to 186-208 chars
- +2 stub tests (traceback trimming, password case); decision 002 updated
  with the error contract

## Artifacts (gitignored, under tmp/pdf-test/)

- `large.pdf` (158K, 200pp), `password.pdf`, `scanned.pdf` (6.5MB image-only),
  `corrupt.pdf` (40K truncated), `text-as-pdf.pdf`
- `server.py` — content-type test server (port 8741; now stopped)
- session JSONLs used for leak checks
