---
title: "Fable-sweep count in the owner-asks footer"
type: decision
status: active
date: 2026-11-23
---

# Fable-sweep count in the owner-asks footer

**Ruling (owner, 2026-11-23, Claude session c06ee577: "this sounds good to me").** In a repo
whose upstream carries `docs/fable-sweeps.md`, the owner-asks status shows how many landings the
last Fable review has not swept, and how long the oldest of them has waited:
`owner asks: 3 open · 1 new · fable: 37 unreviewed · 6d`. It is one implementation shared by the
pi status bar and Claude Code's statusline (`extensions/owner-asks/lib.ts`, `countText`).

**The range (owner request, 2026-11-23: "can we show a time range alongside the raw number of
unreviewed commits?").** The age is the committer date of the first first-parent commit after the
marker, measured to now — the landing that has waited longest. `Nm` under an hour, `Nh` under two
days, `Nd` beyond. Nothing unreviewed reads `fable: reviewed`, with no range: an age of a landing
that does not exist is not a fact.

**Source.** The marker is `reviewed_through: <40-hex sha>` in that file's YAML frontmatter, a
commit on the upstream branch. The file is read at `@{u}` — `git show @{u}:docs/fable-sweeps.md`
— inside the same call that reads the asks, so it reuses the existing background fetch rather
than starting a second one. The count is `git rev-list --first-parent --count <sha>..@{u}`: one
first-parent commit is one landing, so one merge per work order or fix counts once, not once per
commit the branch brought with it.

**Absent means nothing, invalid means warn.** A repo with no marker file, or a file with no
`reviewed_through` key, shows no fable segment — that is a repo with no sweep, not an error. A
marker that is present but unusable (not 40 hex, or not an ancestor of the upstream tip) shows
`fable: marker invalid` and draws the footer as a warning, because a sweep count that silently
stops counting is worse than one that says its marker is broken. A count alone draws nothing: it
is information, not a call to act.

**Only landings that change code (tfd R98, owner 2026-11-23).** A landing counts unless *every*
path its first-parent diff touches matches a glob in the marker file's `non_code:` list — the
footer reads that list from the file rather than hard-coding it, and tfd's pre-push hook reads the
same one. `*` spans any run of characters including `/`, so `*.md` covers that type at any depth;
the list is written in that extension style. No `non_code:` key means every landing counts, as
before R98. A landing that changes no paths at all is excluded by the rule read literally ("every
path matches" is vacuously true), which is also the honest answer: it has no code to read. A key
that names no list (`non_code: {}`) is `invalid`, drawn as the warning, rather than silently
counting everything.

**One git call.** `git log --first-parent --diff-merges=first-parent --name-only
--format=%x00%ct <sha>..@{u}` gives the count, the age and the paths: `%x00` starts each block so a
path list never runs into the next commit's date, and the landings are newest first, so the last
counted one is the oldest. The explicit `--diff-merges=first-parent` is redundant on current git —
`--first-parent` already changes that default — and is kept because it names what the count reads.

**`fable: reviewed` is reachable.** Before R98 no marker could be fully swept, because the commit
carrying the marker was itself a landing after it. A marker commit touches only `*.md`, so the
non-code filter skips it and the unstamped case is now an ordinary state — the repo-fixture row
reaches it. The question the number answers is "how many landings has nobody swept",
and a landing is a merge on the mainline. Counting every commit would make the number move when
an unrelated branch is merged in, and would read 2n for n landings that each carried a topic
commit.

**Why the marker is not a counter in this repo.** The sweeps happen in tfd, on tfd's landings;
pi-config reads tfd's marker rather than keeping a second tally that would have to be kept in
step. The tfd side — the marker file and the `/fable-sweep` skill — is tfd's own work order.

**Alternatives considered.** A timestamp instead of a sha (a rebase or a squash makes a date
ambiguous, and "which landings were in" stops being answerable); counting from the last commit
that touched `docs/fable-reviews/` (a review that sweeps nothing writes nothing, so the marker
would never advance); showing the segment for a repo with no marker (`0 unreviewed` reads as
swept, which is a claim about work nobody has done).

**Not shown in:** pi print/JSON mode and subagents, with the rest of the footer.

**Test coverage:** `tests/owner-asks.test.ts` — the count and age from a fixture with real
first-parent landings and fixed committer dates, the non-code filter (a docs-only landing skipped,
a mixed landing counted, a listed `scripts/*_baseline.json` skipped, an unlisted `.json` counted,
the age taken from the oldest *counted* landing), a merge read by its first-parent diff, the
formatter's unit boundaries, the zero case from a repo fixture, the file absent, no key, a
non-sha marker, a non-ancestor marker, a malformed `non_code`, and the count read at the upstream
rather than the working tree. Each is red with its mechanism removed (dropping `--first-parent`
from the walk; `some` instead of `every`; a hard-coded list; absent treated as matching
everything; reading the newest rather than the oldest; either threshold; rendering zero as a
count; reading the working tree; skipping the validation; absence reported as a zero count).
