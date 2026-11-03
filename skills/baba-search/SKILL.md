---
name: baba-search
description: Semantic search over this repository's docs and code through its baba daemon — one query, ranked chunks with path, heading, score and excerpt. Use when a question spans files and you would otherwise grep three guessed spellings ("how does the daemon decide liveness", "where is the retry policy"), i.e. anything a pi seat would answer with semantic_search. Not for exact-string lookup, a file you already know, or anything outside the repo.
---

# baba-search

```bash
/Users/scott/Developer/baba-pi/bin/baba-search.ts "<query>" [-k N]
```

`-k` is how many results to return, default 10. The path is absolute, so it works from any
working directory. If the path is missing, that checkout is behind `origin/main`; report it
rather than pulling, since it may hold another session's uncommitted work.

## When to use it

A question about this repo's docs or code that you would otherwise answer by grepping three
guessed spellings and reading the hits. Phrase it as a question or a topic ("how does the
daemon decide liveness"), not as a symbol name.

Anything a pi seat would answer with `semantic_search` is this: the same daemon, the same
index, the same ranking.

## What it costs

One socket round trip. The embedder lives in the daemon, so a query loads nothing and costs
nothing beyond that round trip — a few hundred milliseconds warm.

The daemon is per repo. The first call after it has been idle can take ten seconds or more
while it refreshes the index; later calls are immediate. A query from a worktree or a
subdirectory resolves to the main checkout's daemon, so the answer covers the main
checkout's docs and code rather than your worktree's uncommitted state.

## Output

Numbered results on stdout: score, path, heading, excerpt. Diagnostics go to stderr, so
stdout pipes.

```
$ /Users/scott/Developer/baba-pi/bin/baba-search.ts "checkpoint wait state" -k 1
1. [0.033] docs/design/checkpoint-waits.md — docs/design/checkpoint-waits.md § Checkpoint waits
   # Checkpoint waits

A session can be waiting on someone: the owner's ruling, a restart, a peer's reply, a subagent it must gate. That wait is session state. A checkpoint continues …
```

Exit 1 means no repo, no daemon, or the daemon answered with an error, and stderr names which. Exit 2 is a usage error.

## When not to use it

- An exact string: a symbol, an error message, a path. `rg` is exact and free.
- A file you already know. Read it.
- Anything outside this repo. The index covers this repo's docs and code only.
- An exhaustive match list. It returns the top `-k` chunks, not every occurrence.
