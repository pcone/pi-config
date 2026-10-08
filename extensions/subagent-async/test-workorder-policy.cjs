#!/usr/bin/env node
/**
 * Regression test for decision 014 — the work order as the single source
 * of truth for the review gate.
 *
 * The `subagent` tool gains a `workOrderPath` param. At spawn the harness
 * reads the referenced work order from the parent checkout, parses its
 * canonical `- **review_policy**: skip` bullet (first-word-after-colon
 * semantics: `required | skip` and `required` both parse as required), and
 * keys the review-gate suppression decision on the parsed value — the WO
 * wins over the `review_policy` tool param on disagreement. A
 * missing/unreadable WO hard-fails the spawn with a loud tool error (no
 * spawn, no worktree). Without `workOrderPath`, prior behavior is
 * preserved (tool param OR canonical task-text bullet).
 *
 * This test cannot import index.ts — `typebox` and `@earendil-works/*`
 * resolve only under jiti at runtime. So, following the test-subject.cjs /
 * test-carry-uncommitted.cjs precedent, it mirrors the WO parse, the gate
 * decision, and the skip injection (KEEP IN SYNC contracts below) and
 * exercises them through the real execute call-site shape: WO read at
 * spawn → effective policy computed ONCE → threaded into BOTH the gate
 * decision (the RS record's `reviewParentRequirements`) and the skip
 * injection. Real WO files are written to a temp repo and read the way the
 * execute does (`path.join(cwd, workOrderPath)`); rows cover the
 * WO-2026-037 behavior/failure matrix.
 *
 * Run: node test-workorder-policy.cjs
 */
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// ── parseWorkOrderPolicy — KEEP IN SYNC with index.ts ─────────────────────
// Decision 014 + 2026-10-07 ruling: the bold line (leading bullet OPTIONAL —
// a bare `**review_policy**: skip` metadata line is accepted) or the YAML
// frontmatter line. First-word-after-colon semantics: `- **review_policy**:
// skip ...` → skip; anything else (required, template literal `required |
// skip`, absent) → required. Deliberately NOT a substring match for `skip`.
const POLICY_BOLD_RE = /^\s*(?:-\s*)?\*\*review_policy\*\*:\s*(\S+)/m;
const POLICY_YAML_RE = /^review_policy:\s*(\S+)/m;

function parseWorkOrderPolicy(woText) {
	const m = woText.match(POLICY_BOLD_RE) || woText.match(POLICY_YAML_RE);
	return m && m[1] === "skip" ? "skip" : "required";
}

// ── Review-gate decision — KEEP IN SYNC with index.ts ─────────────────────
// The task-text declaration is the bold line only (YAML is a work-order
// spelling, not something a task string carries), same first-word semantics.
// It fails on the template literal `required | skip` (skip is not the first
// token) — first-token semantics, mirrored by parseWorkOrderPolicy.
function taskDeclaresPolicySkip(task) {
	const m = POLICY_BOLD_RE.exec(task);
	return !!m && m[1] === "skip";
}

// Mirrors spawnSubagent's gate computation: effective policy = the WO's
// parsed value when a workOrderPolicy is present (it wins over the tool
// param), else the tool param; the task-text declaration applies ONLY to
// WO-less dispatches.
function computeGate(workOrderPolicy, reviewPolicy, task) {
	const effectiveReviewPolicy = workOrderPolicy ?? reviewPolicy;
	const gateSkipped =
		effectiveReviewPolicy === "skip" ||
		(workOrderPolicy === undefined && taskDeclaresPolicySkip(task));
	return { effectiveReviewPolicy, gateSkipped };
}

// ── maybeInjectReviewPolicySkip — KEEP IN SYNC with index.ts ──────────────
// Injects a skip declaration when the EFFECTIVE policy is skip but the task
// does not already declare it. When the WO declares required (effective =
// required), nothing is injected even if the param said skip — WO wins.
function maybeInjectReviewPolicySkip(task, reviewPolicy) {
	if (reviewPolicy !== "skip") return task;
	if (taskDeclaresPolicySkip(task)) return task;
	const skipLine = "\n\n- **review_policy**: skip (set by orchestrator on the subagent call — do not spawn reviewers; orchestrator will review the diff directly)";
	return task + skipLine;
}

// ── Spawn-path mirror — KEEP IN SYNC with the subagent tool execute ──────
// Mirrors the execute call-site flow: resolve the WO against cwd (the
// parent repo root), read + parse it (missing/unreadable → loud tool
// error, NO spawn — no gate decision, no injection), compute the effective
// policy ONCE, then thread it into both the gate decision and the
// injection. Returns { error } or { workOrderPolicy,
// effectiveReviewPolicy, reviewParentRequirements, taskForChild }.
function readWorkOrderAtSpawn(cwd, workOrderPath) {
	if (!workOrderPath) return { ok: true, workOrderPolicy: undefined };
	let woText;
	try {
		woText = fs.readFileSync(path.join(cwd, workOrderPath), "utf8");
	} catch {
		return {
			ok: false,
			error:
				`workOrderPath file not found: ${workOrderPath} (resolved to ${path.join(cwd, workOrderPath)}). ` +
				`Spawn aborted — pass a valid repo-relative path or omit workOrderPath.`,
		};
	}
	return { ok: true, workOrderPolicy: parseWorkOrderPolicy(woText) };
}

function spawnDecisionMirror(cwd, params, agent) {
	const wo = readWorkOrderAtSpawn(cwd, params.workOrderPath);
	if (!wo.ok) return { error: wo.error };
	const { effectiveReviewPolicy, gateSkipped } = computeGate(
		wo.workOrderPolicy,
		params.review_policy,
		params.task,
	);
	return {
		workOrderPolicy: wo.workOrderPolicy,
		effectiveReviewPolicy,
		reviewParentRequirements: gateSkipped ? undefined : agent.reviewParentRequirements,
		taskForChild: maybeInjectReviewPolicySkip(params.task, effectiveReviewPolicy),
	};
}

// ── Test harness ───────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
let skipped = 0;

function test(name, fn) {
	try {
		fn();
		console.log(`  ✅ ${name}`);
		passed++;
	} catch (e) {
		if (e && e.__piSkip) {
			console.log(`  ⏭  ${name} (skipped: ${e.message})`);
			skipped++;
			return;
		}
		console.log(`  ❌ ${name}`);
		console.log(`     ${e.message}`);
		failed++;
	}
}

function skip(msg) {
	const e = new Error(msg);
	e.__piSkip = true;
	throw e;
}

function eq(actual, expected, msg) {
	assert.strictEqual(actual, expected, msg);
}

// Agent configs mirroring the real ones: implement has the two-reviewer
// gate; scout has no `requires_parent_reviewers` (no gate either way).
const IMPLEMENT = { name: "implement", reviewParentRequirements: ["implementation", "tests"] };
const SCOUT = { name: "scout-code", reviewParentRequirements: undefined };

const TASK = "Execute work order `work-orders/WO-2026-XXX.md` in this repository. Read it fully first.";

// Real WO files in a temp dir, read the way the execute does.
function withTempDir(fn) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wopolicy-"));
	try {
		return fn(dir);
	} finally {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
	}
}

const WO_SKIP =
	"# WO-2026-XXX\n\n## Metadata\n\n- **work_order_id**: WO-2026-XXX\n- **review_policy**: skip — docs-only change\n";
const WO_REQUIRED =
	"# WO-2026-XXX\n\n## Metadata\n\n- **work_order_id**: WO-2026-XXX\n- **review_policy**: required\n";
const WO_TEMPLATE_LITERAL =
	"# WO-2026-XXX\n\n## Metadata\n\n- **review_policy**: required | skip — default `required`\n";
const WO_NO_BULLET = "# WO-2026-XXX\n\n## Metadata\n\n- **work_order_id**: WO-2026-XXX\n";
// Metadata block written the way a human writes one: bold lines, no bullets.
const WO_BARE_SKIP =
	"# WO-2026-XXX\n\n### Metadata\n\n**work_order_id**: WO-2026-XXX\n**review_policy**: skip (documentation-only; orchestrator reviews the diff)\n";
// YAML frontmatter — the encoding the mirror did not accept before 2026-10-07.
const WO_YAML_SKIP =
	"---\nwork_order_id: WO-2026-XXX\nreview_policy: skip\n---\n\n# WO-2026-XXX\n";
// Metadata says required; a LATER line says skip — first occurrence wins.
const WO_LATE_SKIP =
	"# WO-2026-XXX\n\n## Metadata\n\n- **review_policy**: required\n\n## Notes\n\n- **review_policy**: skip\n";
// Both encodings present — the bold line is the one the work-order template
// prescribes and wins, in either direction. Round-1 review: precedence was
// pinned only in the TS suite's parser rows, not through the mirror's gate.
const WO_BOTH_BOLD_SKIP =
	"---\nwork_order_id: WO-2026-XXX\nreview_policy: required\n---\n\n# WO-2026-XXX\n\n**review_policy**: skip (docs-only)\n";
const WO_BOTH_BOLD_REQUIRED =
	"---\nwork_order_id: WO-2026-XXX\nreview_policy: skip\n---\n\n# WO-2026-XXX\n\n**review_policy**: required\n";

// ── parseWorkOrderPolicy unit pins ─────────────────────────────────────────
test("parse: `skip` first word → skip", () => {
	eq(parseWorkOrderPolicy(WO_SKIP), "skip");
});

test("parse: `required` → required", () => {
	eq(parseWorkOrderPolicy(WO_REQUIRED), "required");
});

test("parse: template literal `required | skip` → required (first word, no substring match)", () => {
	eq(parseWorkOrderPolicy(WO_TEMPLATE_LITERAL), "required");
});

test("parse: absent bullet → required", () => {
	eq(parseWorkOrderPolicy(WO_NO_BULLET), "required");
});

test("parse: first occurrence wins (metadata required, body skip → required)", () => {
	eq(parseWorkOrderPolicy(WO_LATE_SKIP), "required");
});

test("parse: bare bold line (no bullet) → skip (2026-10-07 ruling)", () => {
	eq(parseWorkOrderPolicy(WO_BARE_SKIP), "skip");
});

test("parse: YAML frontmatter → skip (mirror gap fixed 2026-10-07)", () => {
	eq(parseWorkOrderPolicy(WO_YAML_SKIP), "skip");
});

test("parse: bold line beats YAML when both are present (bold says skip)", () => {
	eq(parseWorkOrderPolicy(WO_BOTH_BOLD_SKIP), "skip");
});

test("parse: bold line beats YAML when both are present (bold says required)", () => {
	eq(parseWorkOrderPolicy(WO_BOTH_BOLD_REQUIRED), "required");
});

test("parse: leading whitespace tolerated on the bold line (dash or no dash)", () => {
	eq(parseWorkOrderPolicy("  **review_policy**: skip"), "skip");
});

// ── taskDeclaresPolicySkip unit pins ──────────────────────────────────────
// First-token semantics: `skip,` is not `skip`. Round-1 review: the TS suite
// pinned this, the mirror did not — a `\bskip\b` regression here was silent.
test("task-text: `skip,` is not a first-token skip (dashed spelling)", () => {
	eq(taskDeclaresPolicySkip("- **review_policy**: skip, because docs"), false);
});

test("task-text: `skip,` is not a first-token skip (bare spelling)", () => {
	eq(taskDeclaresPolicySkip("**review_policy**: skip, because docs"), false);
});

test("task-text: `skip` with trailing rationale IS a first-token skip", () => {
	eq(taskDeclaresPolicySkip("**review_policy**: skip (docs-only; orchestrator reviews)"), true);
});

// ── Matrix rows through the call-site shape (spawnDecisionMirror) ─────────
withTempDir((dir) => {
	fs.writeFileSync(path.join(dir, "WO-SKIP.md"), WO_SKIP);
	fs.writeFileSync(path.join(dir, "WO-REQ.md"), WO_REQUIRED);
	fs.writeFileSync(path.join(dir, "WO-TMPL.md"), WO_TEMPLATE_LITERAL);
	fs.writeFileSync(path.join(dir, "WO-NO.md"), WO_NO_BULLET);
	fs.writeFileSync(path.join(dir, "WO-BARE.md"), WO_BARE_SKIP);
	fs.writeFileSync(path.join(dir, "WO-YAML.md"), WO_YAML_SKIP);
	fs.writeFileSync(path.join(dir, "WO-BOTH-SKIP.md"), WO_BOTH_BOLD_SKIP);
	fs.writeFileSync(path.join(dir, "WO-BOTH-REQ.md"), WO_BOTH_BOLD_REQUIRED);

	test("(a) WO declares skip + workOrderPath, no param → gate suppressed + bullet injected", () => {
		const r = spawnDecisionMirror(dir, { workOrderPath: "WO-SKIP.md", task: TASK }, IMPLEMENT);
		eq(r.workOrderPolicy, "skip");
		eq(r.effectiveReviewPolicy, "skip");
		eq(r.reviewParentRequirements, undefined, "gate suppressed (RS record undefined)");
		assert.ok(r.taskForChild.includes("- **review_policy**: skip"), "skip bullet injected into task");
	});

	test("(b) WO declares required + workOrderPath + param skip → gate LIVE, NO injection (WO wins)", () => {
		const r = spawnDecisionMirror(dir, { workOrderPath: "WO-REQ.md", review_policy: "skip", task: TASK }, IMPLEMENT);
		eq(r.workOrderPolicy, "required");
		eq(r.effectiveReviewPolicy, "required", "WO wins over the tool param");
		assert.deepStrictEqual(r.reviewParentRequirements, ["implementation", "tests"], "gate stays live");
		eq(r.taskForChild, TASK, "no skip injection when WO declares required");
	});

	test("WO template literal unedited (`required | skip`) → parses required → gate LIVE", () => {
		const r = spawnDecisionMirror(dir, { workOrderPath: "WO-TMPL.md", task: TASK }, IMPLEMENT);
		eq(r.workOrderPolicy, "required");
		assert.deepStrictEqual(r.reviewParentRequirements, ["implementation", "tests"], "gate live");
		eq(r.taskForChild, TASK, "no injection");
	});

	test("WO with no review_policy bullet → required → gate LIVE", () => {
		const r = spawnDecisionMirror(dir, { workOrderPath: "WO-NO.md", task: TASK }, IMPLEMENT);
		eq(r.workOrderPolicy, "required");
		assert.deepStrictEqual(r.reviewParentRequirements, ["implementation", "tests"]);
	});

	test("(c) missing WO path → loud tool error, no spawn (no gate decision, no injection)", () => {
		const r = spawnDecisionMirror(dir, { workOrderPath: "WO-MISSING.md", task: TASK }, IMPLEMENT);
		assert.ok(r.error, "error returned, not a spawn");
		assert.ok(
			r.error.includes("workOrderPath file not found: WO-MISSING.md"),
			`loud error names the path: ${r.error}`,
		);
		assert.ok(r.error.includes("Spawn aborted"), "spawn aborted message");
		assert.strictEqual(r.reviewParentRequirements, undefined, "no RS record — spawn never happened");
		assert.strictEqual(r.taskForChild, undefined, "no task built — spawn never happened");
	});

	test("unreadable WO (chmod 000) → loud tool error, no spawn", () => {
		const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
		if (isRoot) skip("running as root — chmod 000 does not make a file unreadable");
		fs.writeFileSync(path.join(dir, "WO-LOCKED.md"), WO_REQUIRED);
		fs.chmodSync(path.join(dir, "WO-LOCKED.md"), 0o000);
		try {
			const r = spawnDecisionMirror(dir, { workOrderPath: "WO-LOCKED.md", task: TASK }, IMPLEMENT);
			assert.ok(r.error, "error returned");
			assert.ok(r.error.includes("workOrderPath file not found"), "loud error");
		} finally {
			fs.chmodSync(path.join(dir, "WO-LOCKED.md"), 0o644);
		}
	});

	test("(d) no WO, param skip → gate suppressed + injected (current behavior unchanged)", () => {
		const r = spawnDecisionMirror(dir, { review_policy: "skip", task: TASK }, IMPLEMENT);
		eq(r.workOrderPolicy, undefined);
		eq(r.effectiveReviewPolicy, "skip");
		eq(r.reviewParentRequirements, undefined);
		assert.ok(r.taskForChild.includes("- **review_policy**: skip"), "bullet injected");
	});

	test("no WO, canonical bullet in task text → gate suppressed, no double injection", () => {
		const bulletTask = TASK + "\n\n- **review_policy**: skip (orchestrator review)";
		const r = spawnDecisionMirror(dir, { task: bulletTask }, IMPLEMENT);
		eq(r.workOrderPolicy, undefined);
		eq(r.reviewParentRequirements, undefined, "task-text bullet suppresses the gate");
		eq(r.taskForChild, bulletTask, "bullet already present — not injected twice");
	});

	test("no WO, bare bold line in task text → gate suppressed, no double injection (ruling)", () => {
		const bareTask = TASK + "\n\n**review_policy**: skip (docs-only; orchestrator reviews the diff)";
		const r = spawnDecisionMirror(dir, { task: bareTask }, IMPLEMENT);
		eq(r.workOrderPolicy, undefined);
		eq(r.reviewParentRequirements, undefined, "bare bold declaration suppresses the gate");
		eq(r.taskForChild, bareTask, "declaration already present — not injected twice");
	});

	test("no WO, YAML line in task text → NOT a task-text declaration (scope: WO only)", () => {
		const yamlTask = TASK + "\n\nreview_policy: skip";
		const r = spawnDecisionMirror(dir, { task: yamlTask }, IMPLEMENT);
		eq(r.workOrderPolicy, undefined);
		assert.deepStrictEqual(
			r.reviewParentRequirements,
			["implementation", "tests"],
			"YAML does not suppress the gate in a task string",
		);
	});

	test("WO declaring the bare bold line → gate suppressed + declaration injected", () => {
		const r = spawnDecisionMirror(dir, { workOrderPath: "WO-BARE.md", task: TASK }, IMPLEMENT);
		eq(r.workOrderPolicy, "skip");
		eq(r.reviewParentRequirements, undefined, "gate suppressed via the bare declaration");
		assert.ok(r.taskForChild.includes("- **review_policy**: skip"), "declaration injected into task");
	});

	test("WO declaring YAML frontmatter → gate suppressed (mirror gap fixed)", () => {
		const r = spawnDecisionMirror(dir, { workOrderPath: "WO-YAML.md", task: TASK }, IMPLEMENT);
		eq(r.workOrderPolicy, "skip");
		eq(r.reviewParentRequirements, undefined, "gate suppressed via frontmatter");
		assert.ok(r.taskForChild.includes("- **review_policy**: skip"), "declaration injected into task");
	});

	test("WO with YAML required + bold skip → bold wins → gate suppressed", () => {
		const r = spawnDecisionMirror(dir, { workOrderPath: "WO-BOTH-SKIP.md", task: TASK }, IMPLEMENT);
		eq(r.workOrderPolicy, "skip");
		eq(r.effectiveReviewPolicy, "skip");
		eq(r.reviewParentRequirements, undefined, "bold declaration suppresses the gate");
		assert.ok(r.taskForChild.includes("- **review_policy**: skip"), "declaration injected into task");
	});

	test("WO with YAML skip + bold required → bold wins → gate LIVE", () => {
		const r = spawnDecisionMirror(dir, { workOrderPath: "WO-BOTH-REQ.md", task: TASK }, IMPLEMENT);
		eq(r.workOrderPolicy, "required");
		assert.deepStrictEqual(r.reviewParentRequirements, ["implementation", "tests"], "gate live");
		eq(r.taskForChild, TASK, "no injection");
	});

	test("no WO, no param, no bullet → gate LIVE, no injection (unchanged)", () => {
		const r = spawnDecisionMirror(dir, { task: TASK }, IMPLEMENT);
		assert.deepStrictEqual(r.reviewParentRequirements, ["implementation", "tests"]);
		eq(r.taskForChild, TASK);
	});

	test("WO + param both skip → gate suppressed (no disagreement)", () => {
		const r = spawnDecisionMirror(dir, { workOrderPath: "WO-SKIP.md", review_policy: "skip", task: TASK }, IMPLEMENT);
		eq(r.effectiveReviewPolicy, "skip");
		eq(r.reviewParentRequirements, undefined);
		assert.ok(r.taskForChild.includes("- **review_policy**: skip"));
	});

	test("WO declares required + param required (agree) → gate LIVE, no injection", () => {
		const r = spawnDecisionMirror(dir, { workOrderPath: "WO-REQ.md", review_policy: "required", task: TASK }, IMPLEMENT);
		eq(r.effectiveReviewPolicy, "required");
		assert.deepStrictEqual(r.reviewParentRequirements, ["implementation", "tests"], "gate live");
		eq(r.taskForChild, TASK, "no injection");
	});

	test("workOrderPath with non-implement agent (scout) → no gate either way", () => {
		const r = spawnDecisionMirror(dir, { workOrderPath: "WO-SKIP.md", task: TASK }, SCOUT);
		eq(r.reviewParentRequirements, undefined, "scout has no requires_parent_reviewers");
		const r2 = spawnDecisionMirror(dir, { workOrderPath: "WO-REQ.md", task: TASK }, SCOUT);
		eq(r2.reviewParentRequirements, undefined, "still undefined when WO declares required");
	});
});

// ── Result ─────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(failed === 0 ? 0 : 1);
