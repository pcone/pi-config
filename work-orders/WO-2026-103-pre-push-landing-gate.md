# WO-2026-103 — a pre-push gate for the two landing rules

### Metadata

- **work_order_id**: WO-2026-103
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit
- **estimated_complexity**: small
- **review_policy**: required
- **order_source**: owner ruling 2026-11-18 on pi-config#20, relayed by the claude seat: "(A) Shared pre-push hook (Recommended)", recorded on the issue. Scoped by `bug-triage`'s correction on the same issue.

### Premise (established)

`rules/work-order-numbering.md:29` claimed the gate enforced the id rule. It did not:
`docs_validate.py` exists only in tfd, this repo has no `scripts/`, and `.git/hooks/`
held samples with `core.hooksPath` unset. The claim arrived with `f402e6f`, a shared
`rules/` file, without the mechanism — and the same gap let WO-2026-102's first push
report success while landing nothing.

### Scope

`bin/pre-push`, its hook installation, the numbering rule's text, and rows.

Two refusals, nothing else:

| rule | refuses |
| --- | --- |
| (A) landing | a push carrying the mainline ref (`refs/heads/main`) whose pushed `local_sha` is not `HEAD`, naming both shas |
| (B) numbering | a push adding a file under `work-orders/` whose id another live ref already holds, naming the holding ref |

Scoping, as corrected: rule (A) applies only to mainline pushes — a side-branch push from
a checkout on another commit is ordinary work. Rule (B) runs only when the push adds a
`work-orders/` path. Refs this push introduces are excluded from (B) by name and by
commit, since a normal landing updates a branch that already holds the id it adds.

**Shared with tfd.** tfd's `.githooks/pre-push` keeps its docs validator and pipes the
same stdin into this file for rules (A) and (B). tfd's side of that is tfd's to land;
`bug-triage` verifies the symlink and the side-branch scoping.

### Acceptance rows

`tests/pre-push-hook.test.ts` drives the real script against throwaway repos:

1. mainline push whose `local_sha` is not `HEAD` → refused, both shas named.
2. mainline push that is `HEAD` → passes silently.
3. side-branch push from a checkout on another commit → passes.
4. detached-HEAD landing of a real commit → refused.
5. added id held by another live ref → refused, ref named.
6. added id held by nobody → passes.
7. push adding no `work-orders/` file → passes without scanning refs (a `git` shim
   records invocations; no `for-each-ref`/`ls-tree` may appear).

Each row red under the mutation that removes its check: no rule (A) → rows 1 and 4; no
(B) refusal → row 5; no pushed-ref exclusion → row 6 (false refusal); unconditional id
scan → row 7.

### Fixed after review: the first push of any branch was refused

`bug-triage` measured the landed hook in a scratch clone and found rule (B) refusing
`git push origin main:refs/heads/feat` — a new ref, nothing new claimed — for 82 ids held
by unrelated refs. Cause: for `remote_sha == zero` the added set was the pushed ref's whole
tree, so the exclusion list (which covers only the refs the push carries) never applied to
the ids it found. The lazy path also called the ref listing before deciding whether any
order was added.

Fixed shape:

- a ref being **updated** → added set = files that ref gains against its old tip (A-filter);
- a ref being **created** → added set = files whose commits no *other* live ref holds
  (`git log --not <other tips>`), which is empty for an alias and exact for a fork;
- the ref exclusion compares full `%(refname)`, so the name arm matches stdin's
  fully-qualified names instead of never matching;
- the ref listing is computed on first use, so an ordinary mainline push pays nothing.

Rows added: an alias branch whose ids other refs hold passes (red under the whole-tree
version — this is the row that pins the fix); a new branch adding a fresh id passes; a new
branch reusing an id another ref holds is refused naming it. Cost after the fix: ordinary
mainline push 0.19-0.23 s; a first push of a new branch 0.24 s; worst case — a push that
adds an order in this 36-ref repo — unchanged at ~0.9 s.

### Installing it: the symlink tracks the worktree

`.git/hooks/pre-push` is a relative symlink to `../../bin/pre-push`, so it resolves into
whatever commit the checkout is on. `bug-triage` hit this verifying across commits: it
checked out an older revision, measured that revision's hook, and reproduced the fixed
false positive while believing it was testing the fix. For a checkout that stays on the
mainline this is the intended behaviour — the gate moves with the tree. For measuring
across commits, copy the file out (`git show <rev>:bin/pre-push > /tmp/hook`) and point the
symlink at the copy. It is also why tfd should symlink to this file rather than copy it:
a copy is a second implementation that drifts, and the drift here would be a gate that
silently stops checking.

tfd's side of the wiring changes tfd's own `.githooks/pre-push`, so it is a tfd order, not
this one. It should record that the pre-fix hook would have refused the first push of every
triage pin branch (`git push origin bug-triage/<n>-<slug>`).

### Rework after review (2026-11-19): REJECT_AND_REWORK

An independent review (`~/Developer/notes/review-pi-config-103/review.md`) rejected the
landed gate on five findings, each reproduced before it was fixed:

- **The mainline was a literal.** `mainline_branch=main` is pi-config's answer, not tfd's
  (`hamster`, `scripts/change_scope.py:21`), so the rules could never fire there. The hook
  now reads `git config pi.mainline` and fails hard when it is unset — no default, because
  a gate that silently picks a branch is the failure this file exists to prevent.
- **Rule (B) refused legitimate landings.** A `merge --no-ff` of a branch that had added an
  id counted that branch as a rival holder, and so did a side branch that merged the
  mainline. A ref this push descends from is now excluded (`merge-base --is-ancestor`
  against every pushed commit), with a row for each shape.
- **Renames slipped through.** The reserve step renumbers by renaming; with rename
  detection the new path is `R`, not `A`, so `--diff-filter=A` never saw it. Both the
  `diff` and the `log` now pass `--no-renames`, with a two-push row that fails without it.
- **The gate failed open.** `2>/dev/null` plus an unchecked substitution turned an
  unreadable old tip into "nothing added", so a force push landed unchecked. Every git call
  now aborts with a named message, including a failure inside `$( )`, which does not stop
  its caller on its own.
- **A2 passed when the local mainline was missing**, and deleting the mainline reported
  "this checkout is not on the commit being pushed". Both now name what they found;
  deleting a ref passes, deleting the mainline refuses saying so.

**tfd is still not wired.** The review's H1 stands: `~/Developer/tfd/.githooks/pre-push`
does not call this file, and the rule text and this order previously said it did — a false
record, now corrected to "pi-config only, tfd's wiring is a tfd order". That edit is a
change to tfd's push machinery and is being coordinated with the claude seat before it
lands there.

### Q-103-a (owner question) — the incident is invisible to a pre-push hook

Measured while landing this order, in a scratch clone (`/tmp/s4`): with the local mainline
already up to date and the commits sitting on a detached `HEAD`, `git push origin main`
runs the hook with **empty stdin** and prints `Everything up-to-date`:

```
HEAD=033d1a8 main=084bc65 origin/main=084bc65
== hook stdin:
== end
Everything up-to-date
```

That is exactly WO-2026-102's shape, and rule (A) as scoped in the ruling cannot fire:
there is no line to judge. What it does catch is the other stale-main landing —
`git push origin main` from a checkout whose local `main` holds a commit `HEAD` does not
(`git push origin <branch>:main`, or a main checked out elsewhere).

- **(a) Add an empty-stdin rule: refuse when git hands the hook no refs, `HEAD` is
  detached, and `HEAD` is not an ancestor of the local mainline.** This is the only point
  in a push that knows nothing was pushed; the message can name `HEAD` and the mainline
  tip. False positives are confined to detached checkouts pushing a branch that needed no
  update, where the refusal costs nothing and the diagnosis is the point.
- **(b) Land no such rule.** The gate keeps the stale-main and numbering cases; a
  stranded landing is caught by a peer comparing `origin/main`, or not at all.

**Ruling (owner, 2026-11-19, relayed by the claude seat): "Refuse that case (Recommended)".**
So (a), landed: when git hands the hook no refs, `HEAD` is detached and `HEAD` is not an
ancestor of the local mainline, the hook refuses naming both shas. A detached `HEAD` *on* the
mainline's history — an older commit, a tag — is a normal read-only checkout and passes, as
does an empty push from an attached `HEAD`. The row that pinned the old pass-through is
replaced by three: attached-HEAD empty push passes, detached-on-mainline passes,
detached-off-mainline refuses. The refusal row is red with the rule removed.

This is the one rule that changes what a no-op push does, so `bug-triage` re-verified it at
`a0f804d`: all four shapes behave, and its stdin instrumentation confirms the reachable form
is an explicit refspec whose target is already current (`git push origin main` while
detached, 0 bytes of stdin). A bare `git push` from a detached HEAD never reaches the hook
— git exits 128 with "You are not currently on a branch" — so a row claiming that form is
caught would be wrong.

### Cost, measured

- Mainline push adding no work-order: hook 0.04-0.06 s vs `--no-verify` 0.05-0.07 s — no
  measurable addition (three runs each, temp clone with a bare remote).
- Worst case, a push adding a work-order id in this repo (36 refs, 30 distinct commits):
  0.82 s, one `ls-tree` per distinct commit. Accepted and recorded: the push that adds an
  order is deliberate and rare, and the ref listing dedupes commits so branch aliases do
  not each cost a process.

### Sequencing

Standalone; no preparatory refactor — the hook is a new file and the rule text is edited
in place. `pi-config#20` carries the ruling.

### Verification

- Rows 1-7 pass, and each mutation above turns its named row red.
- `git push` from this repo prints nothing on a clean mainline push.
- `bin/heavy -- bun test` green.
