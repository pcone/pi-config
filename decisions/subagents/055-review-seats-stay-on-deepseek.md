# 055 — Review seats stay on DeepSeek V4.1 Flash; 044's rollback is withdrawn

**Date:** 2026-11-27
**Status:** accepted — owner ruling (owner, 2026-11-27)
**Supersedes:** 044's Rollback clause. 041 stays suspended.

## Ruling (owner, 2026-11-27)

> "we're sticking with deepseek reviewers until opencode go adds a model with equal cost and quality - currently deepseek v4.1 flash is too good to be worth trying anything else, although feel free to do a read of their catalogue to see if there's anything new"

Recorder's reading: `review-code`, `review-plan` and `review-tests` keep
`opencode-go/deepseek-v4.1-flash:high`. The trigger to revisit is a model on the OpenCode Go plan
with equal cost and quality. Restored OpenRouter credits are not a trigger.

## Why it was asked

[044](044-review-seats-opencode-go-deepseek.md) moved the review seats "in the meantime", with
rollback to [041](041-glm-review-seats-openrouter.md) "when OpenRouter credits are restored".
[047](047-every-seat-on-high.md) routed the oracle through OpenRouter on 2026-11-07, so 044's condition
was met, and no record said whether the rollback still applied.

## What stands

- 044's named cost: reviewers share the implementer's model, so 023's decorrelation stays lost.
  `APPEND_SYSTEM.md` § Subagents tells a dispatcher how to weigh a clean review.
- 047's routing rule: OpenCode Go serves `deepseek-v4.1-flash` only.

## Catalogue read (2026-11-27)

Read from `opencode.ai/go` and `opencode.ai/docs/go/`. The page gives each model's estimated
requests per 5 hours on the Go plan; all paid models share one allowance.

| Model | Est. requests / 5 h | Note |
|---|---|---|
| DeepSeek V4.1 Flash 1017 | 43,300 | the fleet's seat |
| Muse Spark 1.2 / 1.3 Contributor | 45,300 | trains on the user's data; limited regions |
| MiMo-V2.6-Flash | 30,100 | 023's reviewer experiment, replaced by 037 |
| LongCat 2.5 | 11,400 | marked New; hosted in China; limited regions |
| GLM-5.3-Flash | 6,320 | 041's reviewer model |
| Hy4 | 2,710 | marked New |
| Qwen4 Max | 463 | marked New |

Two time-limited free models are also marked New (HungerG Free, Hy4 flash Free). Recorder's reading:
no model added since 044 matches DeepSeek V4.1 Flash on cost. Quality was not measured.
