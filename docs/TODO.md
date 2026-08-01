# WO-2026-018: PDF → Markdown integration + binary-PDF discouragement

**Status: done** — merged on `main` at `0c3ee2c` (worktree branch `pi-subagent-7d84fdbf5532`).

## Problem

Session `019fafc6-15e4-7673-8ebf-5afc631cf92b` (tfd work, 2026-07-29) called
`fetch_url` on Microsoft Research PDFs 6 times. `fetch_url` treated
`application/pdf` as "non-HTML" and inlined up to 200KB of raw binary per call
(~1.2MB total across 18 fetch_url calls). Verified from the session JSONL.

Root cause: `extensions/fetch-url.ts` non-HTML branch dumped body verbatim.
Core `read` tool had the same hole for local `.pdf` files (no binary detection).

## Fixes shipped

1. `extensions/lib/pdf-convert.ts` (new) — detection (`isPdfContentType`,
   `isPdfBody` prefix-sniff, `isPdfBytes` latin1 sniff), converter factory
   (pymupdf4llm → pdftotext → descriptive error; `PDF_MD_PYTHON` override),
   temp helpers (`~/.pi/tmp/pdf-convert/`, 72h TTL), response builders.
   Lives under `lib/` because the extension loader treats every `*.ts` at the
   extensions root as an extension (found via `pi -p` startup error).
2. `extensions/fetch-url.ts` — PDF branch fires BEFORE the HTML/non-HTML split
   (a PDF served as `text/html` still routes correctly). Re-fetches with
   `curl -o` (utf-8 string round-trip corrupts binary — verified 396KB→626KB),
   converts, inlines ≤12K chars else saves `.md` with grep hints, error + skill
   pointer on failure. Tool description tells the model PDFs auto-convert.
3. `extensions/pdf-read-guard.ts` (new) — `tool_result` handler for `read` on
   `.pdf` paths; replaces content wholesale with converted markdown. Never raw
   bytes, never isError on success (rules.ts injection unaffected).
4. `APPEND_SYSTEM.md` — 4-line "PDFs" behavioral net (covers bash `cat`).
5. `skills/pdf/SKILL.md` (new) — on-demand conversion workflow + verified
   manual commands.
6. `decisions/fetch-url/002-pdf-conversion.md` — decision record (incident
   data, corruption mechanisms, alternatives with why-rejected).
7. `tests/pdf-convert.test.ts` — 27 tests, all pass (detection, engine
   fallback via stub ExecFn, response builders, real e2e conversion on fixture
   PDF, never-binary invariant).

## Verification

- `bun test tests/pdf-convert.test.ts` — 27 pass / 0 fail.
- Full `bun test` — 269 pass; 2 pre-existing failures (typebox resolution in
  subagent-async tests) confirmed identical on the pre-WO tree — unrelated.
- Live e2e via fresh `pi -p`: fetch_url on the incident genev-icfp21.pdf →
  converted to markdown, saved to `~/.pi/tmp/pdf-convert/`, model grepped it.
  `read` on local `.pdf` → "Hello PDF World" markdown. HTML fetch (example.com)
  → Readability path unchanged. All three loaded extensions cleanly.

## Notes

- pymupdf4llm 1.28.0 installed user-level (`pip install --user
  --break-system-packages`); pdftotext (poppler) as fallback.
- Committed the previously-dirty working tree first (snapshot `95386b6`,
  junk-cleanup `2f87f6e`) so the worktree forked from the live config.
- `extensions/bun.lock` gained 161 lines of lockfile reconciliation (puppeteer
  deps already in package.json) — benign.
- Known accepted notes: `buildReadPdfResponse`'s `filePath` param unused (kept
  for spec fidelity); large-response tests write to `~/.pi/tmp/pdf-convert/`
  (72h TTL sweep).
