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
