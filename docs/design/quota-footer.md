# Provider quota in the footer

The footer's row-3 slot shows the active model provider's plan usage. One
descriptor per provider: `{ provider, endpoint, auth, parse, render }`, plus the
segment's overflow policy and an optional render-time prefix. One fetch path,
one warn-once, one renderer.

Code: `extensions/lib/quota.ts` (mechanism), `extensions/footer-session-id.ts`
(the footer's cache slot and 60s cycle). Rulings and display specs:
`decisions/external-tools/006-opencode-go-usage-footer.md` and
`008-model-error-mail.md`.

## Descriptors

| provider | endpoint | auth | windows |
| --- | --- | --- | --- |
| `zai` | `GET https://api.z.ai/api/monitor/usage/quota/limit` | bare key | 5h, 7d, MCP cap |
| `minimax` | `GET https://api.minimax.io/v1/api/openplatform/coding_plan/remains` | Bearer | 5h, 7d |
| `minimax-cn` | `GET https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` | Bearer | 5h, 7d |
| `opencode-go` | `GET https://opencode.ai/zen/go/v1/usage` | Bearer | 5h, 7d, monthly |
| `kimi-coding` | `GET https://api.kimi.com/coding/v1/usages` | Bearer | 5h, monthly |

All but MiniMax's are undocumented endpoints consumed by community tools. The
key comes from `ctx.modelRegistry.getApiKeyForProvider(provider)` — the same
auth inference uses, so `KIMI_API_KEY` and an OAuth subscription token both
work for `kimi-coding`. The response is the authority on whether a key carries a
coding plan; there is no key-prefix heuristic.

## Adding a provider

A descriptor entry, not a fetcher and not a renderer. `parse` returns the
segment's parts — a window carries its label, used percentage, reset instant,
optional %-through function and width-ladder drop order; a tier carries the
dimmed trailing text. Provider identity is attached in one place
(`snapshotFor`), so a parser cannot return another provider's numbers: the
MiniMax hosts share one parser and still tag their own provider.

## Rendering

A window renders `<label>:<used%>` with the shared pressure colours (≥85 error,
≥60 warning, else success), then `thru<N>%` where the window length is
knowable, then the time to reset. A tier renders dimmed as `· <text>`.

The width ladder drops parts by `dropOrder` — highest first, 0 never — and
falls back to the first part when nothing droppable is left: z.ai drops its MCP
cap then its tier and never a token window; Go drops its monthly window then its
weekly one. The fallback is clipped for the token-window providers and
ellipsised for Go and Kimi, which is each provider's pre-refactor behaviour.
`tests/footer-quota-characterisation.test.ts` pins every one of those bytes.

## Kimi Code

Probed 2026-11-03 with the box's OAuth subscription token. `GET
https://api.kimi.com/coding/v1/usages` answers:

```json
{
  "limits": [
    { "window": { "duration": 300, "timeUnit": "TIME_UNIT_MINUTE" },
      "detail": { "limit": "100", "used": "18", "remaining": "82",
                  "resetTime": "2026-11-03T04:57:54.427337Z" } }
  ],
  "usages": {
    "limit_5h":          { "used_ratio": 0.1792, "reset_time": "2026-11-03T04:57:54Z" },
    "limit_month_total": { "used_ratio": 0.1079, "reset_time": "2026-12-01T00:00:00Z" },
    "limit_month_code":  { "used_ratio": 0.1079, "reset_time": "2026-12-01T00:00:00Z" }
  }
}
```

`usages` is the source: a `used_ratio` — already used, not remaining, unlike
MiniMax's payload — plus an absolute reset instant per window.
The `limits` array beside it is the same 5h window in rounded strings. The
monthly window is `limit_month_code` — the coding plan's series; the seat only
runs coding. The two monthly series held the same ratio in the probe, so prefer
the coding one and do not fall back to the total: a different quantity under the
same `mo:` label would read as the coding cap.

Display follows the Go shape (decision 006): rolling percent + time to reset,
monthly percent + %-through + time to reset. The percentage is the used
fraction the other providers show. Kimi has no tier in this payload, and no
second request is made to `/coding/v1/me` for the plan name.

Two probes on 2026-11-03, both 200: the payload above at 04:28:45Z rendered
`5h:18% 29m mo:11% thru7% 27.8d` (the fixture
`tests/footer-kimi-usage.test.ts` pins); the footer's own fetch path a few
minutes later rendered `5h:28% 2m mo:12% thru7% 27.8d`, the figures decision
008 § Outcome quotes.

## Cost

The footer's 60s cycle makes one request per interval, and only for a provider
in the table — a `kimi-coding` session polls `/coding/v1/usages` once a minute,
a provider with no descriptor is never fetched. Subagent sessions skip quota
polling entirely. A failed fetch warns once per provider per process and keeps
the last good snapshot; a provider switch clears it.
