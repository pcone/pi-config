---
title: "Subagent configuration"
type: decision-index
status: active
date: 2026-07-14
---

| # | Decision | Status |
|---|---|---|
| 001 | Progress-based timeout for subagents | planned |
| 002 | Parent-as-supervisor with RPC mode | superseded by 003 |
| 003 | Async subagents with organic parent supervision | done |
| 004 | Parallel review gate (review-code + review-tests) for code-changing work | amended (reviewer invocation guard, WO-2026-011) |
| 005 | Review tiers: standard (Mimo) vs thorough (GLM) | done |
| 006 | Reviewer-driven re-review signal and round cap | done |
| 007 | Super-orchestrator (`plan` mode): role separation for multi-workstream work | done |
| 008 | Orchestrator → GLM-5.2, compaction → DeepSeek V4 Flash | done |
| 009 | Clean task identity vs. worktree-isolation prompt wrapper (commit-subject leak fix) | done |
| 010 | Pricing source: pi.dev catalog instead of models.json cost overrides | done |
| 011 | 0731 granular benchmarks unpublished — hold implement-pro/oracle, ship flash slots | done |
| 012 | Implementer tier collapse — single implement-pro on 0731 flash | done |
| 013 | Implementer rename — implement-pro → implement (drop the "pro" suffix) | done |
| 014 | Review-skip single source of truth — work order as first-class spawn parameter (`workOrderPath`) | done |
| 015 | Silence-based progress-kill timeout (activates 001) | done |
| 016 | Fleet speed experiment — standard reviewers to GPT-5.6 Luna, implementer stays Flash | done |
| 017 | Single review tier — Luna standard, deep tier dormant (kept as insurance) | done |
