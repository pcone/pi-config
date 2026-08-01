---
title: "Browser fallback for JS challenge pages"
type: decision
status: done
date: 2026-07-31
---

# Browser fallback for JS challenge pages

**What:** When curl hits a JS-challenge page (Anubis PoW, Cloudflare Turnstile, hCaptcha, etc.), `fetch_url` can fall back to headless Chrome via `puppeteer-core` to execute the challenge JS and extract the resulting page. Opt-in via `browser_fallback: true`.

**Why:** The most common anti-bot systems use JS challenges — curl can't execute JavaScript, so `fetch_url` currently returns a challenge placeholder instead of the real content. Anubis specifically (widely deployed on indie/hacker sites) uses a SHA-256 PoW challenge that Chrome solves automatically in 2-10s of CPU time. Cloudflare Turnstile and similar are solved transparently by a browser.

**Alternatives considered:**

- **Native PoW solver (Node `crypto`)** — would handle Anubis specifically, but breaks when the challenge format changes and can't handle any opaque JS challenge (Cloudflare, reCAPTCHA, custom walls). Rejected: per-system maintenance burden for marginal startup-time savings.
- **curl-impersonate** — spoofs TLS fingerprints to evade passive fingerprinting, but doesn't execute JS. Doesn't help with Anubis or any active challenge. Rejected: wrong layer of the problem.
- **Full non-headless Chrome** — not needed. Anubis is computational (no visual CAPTCHA). Cloudflare Turnstile is behavioral (runs JS, observes timing). Neither requires human interaction. Rejected: headless mode is sufficient.

**Tradeoffs:**

- **Chrome dependency** — `puppeteer-core` requires a Chromium-based browser at a known path. The fallback is optional and degrades gracefully (clear error when Chrome is missing). ~500ms cold-start overhead. Acceptable: the request that triggered the fallback was already going to fail with curl.
- **puppeteer-core as optional dep** — not bundled in `dependencies`; must be installed separately. The tool detects absence at call time and returns a clear error. Keeps the base extension lightweight for users who never hit JS challenges.

**Design:**

1. Curl runs first (fast path, unchanged).
2. If the HTML response matches challenge signatures (see below) AND `browser_fallback: true`, retry via headless Chrome.
3. Chrome navigates to the URL (`domcontentloaded`, not `networkidle0` — see below), polls the DOM until the challenge markers clear or the timeout elapses, then extracts `document.documentElement.outerHTML`.
4. The extracted HTML runs through the existing Readability → turndown pipeline — identical to the curl path.
5. If Chrome isn't available (binary missing, puppeteer-core not installed), the original curl result is returned with a note that browser fallback would have been tried but isn't configured.

**Anti-detection measures (observed via live testing against anubis.techaro.lol):**

- Headless Chrome's UA contains `HeadlessChrome`, which Anubis rejects outright (`Access Denied: error code ...`, title "Oh noes!") *without presenting the PoW challenge*. Fix: `page.setUserAgent()` with a clean Chrome UA. Observed: reject → challenge → real content in ~2s.
- Headless Chrome reports `navigator.webdriver === true`; Anubis similarly rejects. Fix: `--disable-blink-features=AutomationControlled` launch flag.
- `networkidle0` as the wait condition fires too early: the PoW computation is CPU-bound, so the network goes idle while JS crunches, and we'd harvest the challenge page itself. Fix: wait for `domcontentloaded`, then poll every 1s until `detectChallenge()` returns null (the solved page has no challenge markers) or the timeout elapses.
- `page.content()` throws "Execution context was destroyed" when the challenge-solve navigation lands mid-read. Fix: wrap content reads in try/catch, treating an unreadable page as "still challenging".

**Challenge detection signatures:**

| Signature | System |
|-----------|--------|
| `<meta name="generator" content="Anubis"` | Anubis |
| `Protected by Anubis` | Anubis |
| `cf-challenge-running` | Cloudflare Turnstile |
| `<div class="g-recaptcha"` | reCAPTCHA |
| `<div class="h-captcha"` | hCaptcha |
| `<noscript>.*enable JavaScript` | Generic JS-required gate |

**Chrome path resolution order:**
1. `CHROME_PATH` env var
2. `PUPPETEER_EXECUTABLE_PATH` env var (puppeteer's own convention)
3. macOS: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
4. macOS: `/Applications/Chromium.app/Contents/MacOS/Chromium`
5. Linux: `google-chrome-stable`, `google-chrome`, `chromium`
6. puppeteer-core's built-in `executablePath()` which searches platform-standard locations

**Test coverage:** Validated live against `https://anubis.techaro.lol/docs/design/how-anubis-works/` with Chrome 151 (installed via `brew install --cask google-chrome`):

- `fetch_url` with `browser_fallback: true` returns the real docs content (~2s), transformed via Readability → markdown. Verified via a fresh `pi -p` process loading the extension from disk.
- Pre-fix failures observed and fixed: UA rejection ("Access Denied"), `navigator.webdriver` rejection, premature `networkidle0` harvest of the challenge page, and `page.content()` navigation race.
