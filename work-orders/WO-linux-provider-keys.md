# WO-linux-provider-keys — the two providers that read their key from the Keychain only

Slug-only until dispatch (`rules/work-order-numbering.md`).

## Why

`decisions/settings/006-linux-suite-parity.md` made the suite run on the Debian box. It fixed
runpod-bonsai's *pod-management* path: the reader is a seam, the rows need no Keychain, and a machine
with no `security` gets a message saying so. Three places still reach the macOS Keychain directly, so
on Linux they fail with pi's own shell-expansion error instead of the honest one:

1. `extensions/runpod-bonsai/index.ts:315` — `apiKey: \`!security find-generic-password -s ${LLAMA_KEY_ITEM} -w\``
   in `registerProvider`. It bypasses `keychain()` and the module seam entirely.
2. `extensions/model-tiers/index.ts:131` — `security find-generic-password -ws 'pi-openrouter'`, with an
   `OPENROUTER_API_KEY` env fallback ahead of it. On Linux the fallback is the only path, and a missing
   env var reads as a missing key.
3. Nothing states which key source a Linux box is meant to use, so a reader has to infer it from three
   call sites.

## What

- One key source per provider, chosen once and stated: an env var, a file under `~/.pi/agent/` with a
  named permission, or a refusal that says the provider needs a macOS Keychain. **Owner question** —
  the choice adds user-facing surface (an env var name or a path), so it does not land on an
  implementer's initiative.
- Once chosen: `registerProvider`'s `apiKey` reads through the same function as the request path, and
  `model-tiers` stops catching a Keychain failure into silence.
- Rows: the "no key source on this machine" error message, per provider, and a request path that never
  shells out to `security` on Linux.

## Not in scope

- The pod-management path (already done, decision 006).
- `trust.json`'s shared tracked file — an owner question recorded in
  `decisions/settings/005-linux-install.md`.
