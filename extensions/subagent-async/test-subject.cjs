#!/usr/bin/env node
/**
 * Regression test for the auto-commit subject leak.
 *
 * Bug: preCommitSteps built the isolation auto-commit subject from
 *   `subagent(${name}): ${task.slice(0,72)}`, where `task` was the full
 *   delivery payload — i.e. the harness-injected "## Worktree isolation"
 *   preamble followed by the real task. The commit subject therefore read
 *   `subagent(implement-pro): ## Worktree isolation` and conveyed nothing
 *   about the work. Repro in this repo's own history: commit 5feef34.
 *
 * Fix: `rs.task` is now the CLEAN task identity; the preamble + review-policy
 *   annotation reach the child only (promptMessage). The subject is derived
 *   via subjectFromTask(cleanTask) — first non-empty line, truncated.
 *
 * This test mirrors subjectFromTask (it can't import index.ts — pi's packages
 * resolve only under jiti at runtime) and exercises the OLD vs NEW derivation
 * through a real temp git repo, so it also pins the newline→subject mechanics.
 *
 * Run: node test-subject.cjs
 */
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// ── subjectFromTask — KEEP IN SYNC with index.ts ───────────────────────────
function subjectFromTask(task) {
	const firstLine = task
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.length > 0);
	return (firstLine ?? "(no task)").slice(0, 72);
}

// The OLD (buggy) derivation: raw first 72 chars of whatever was in `task`.
function oldSubject(task) {
	return task.slice(0, 72);
}

// ── Test harness ───────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function test(name, fn) {
	try {
		fn();
		console.log(`  ✅ ${name}`);
		passed++;
	} catch (e) {
		console.log(`  ❌ ${name}`);
		console.log(`     ${e.message}`);
		failed++;
	}
}

function eq(actual, expected, msg) {
	assert.strictEqual(actual, expected, msg);
}

// ── subjectFromTask unit cases ─────────────────────────────────────────────
test("single-line task → that line", () => {
	eq(subjectFromTask("Refactor the foo module"), "Refactor the foo module");
});

test("multi-line work order → first non-empty line", () => {
	const wo = [
		"WO-2026-013: Fix the widget renderer",
		"",
		"## Context",
		"Lots of detail here.",
	].join("\n");
	eq(subjectFromTask(wo), "WO-2026-013: Fix the widget renderer");
});

test("leading blank lines / whitespace are skipped", () => {
	eq(subjectFromTask("\n\n   \n  Trim me"), "Trim me");
});

test("truncates to 72 chars", () => {
	const long = "x".repeat(200);
	eq(subjectFromTask(long).length, 72);
});

test("empty task → sentinel", () => {
	eq(subjectFromTask(""), "(no task)");
	eq(subjectFromTask("\n  \n"), "(no task)");
});

// ── The bug repro: OLD vs NEW on a preamble'd payload ──────────────────────
const PREAMBLE =
	"## Worktree isolation\n" +
	"You are running inside an isolated git worktree at `/tmp/pi-subagent-wt-deadbeef`, branched from `abc123def456`. " +
	"Your cwd is the worktree root.\n\n" +
	"If the task lists paths like `/Users/x/repo/foo.rs`, strip the parent prefix.\n\n";
const REAL_TASK = "Refactor the widget renderer to use the new batch API";
const payloadForChild = PREAMBLE + REAL_TASK; // what the child receives
const cleanTask = REAL_TASK; // what rs.task holds after the fix

test("OLD derivation leaks the preamble into the subject", () => {
	// Documents the bug: the subject begins with the boilerplate header.
	const subject = `subagent(implement-pro): ${oldSubject(payloadForChild)}`.split("\n")[0];
	assert.ok(
		subject.startsWith("subagent(implement-pro): ## Worktree isolation"),
		`expected preamble leak, got: ${JSON.stringify(subject)}`,
	);
});

test("NEW derivation yields the real work as subject", () => {
	const subject = `subagent(implement-pro): ${subjectFromTask(cleanTask)}`;
	eq(subject, "subagent(implement-pro): Refactor the widget renderer to use the new batch API");
});

// ── End-to-end through real git: subject survives `git log --format='%s'` ──
// Pins the newline→subject mechanics, which is where the original evidence was
// ambiguous (%s is first-line; a preamble \n hid the rest in the body).
function withTempRepo(fn) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subj-test-"));
	const git = (args) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
	try {
		git(["init", "-q"]);
		git(["config", "user.email", "t@t"]);
		git(["config", "user.name", "t"]);
		fs.writeFileSync(path.join(dir, "f.txt"), "init\n");
		git(["add", "-A"]);
		git(["commit", "-q", "-m", "init"]);
		return fn(dir, git);
	} finally {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
	}
}

withTempRepo((dir, git) => {
	test("git %s with NEW subject does not mention Worktree isolation", () => {
		const msg = `subagent(implement-pro): ${subjectFromTask(cleanTask)}`;
		fs.writeFileSync(path.join(dir, "f.txt"), "change\n");
		git(["add", "-A"]);
		git(["commit", "-q", "-m", msg]);
		const subject = git(["log", "--format=%s", "-1"]).toString().trim();
		eq(subject, "subagent(implement-pro): Refactor the widget renderer to use the new batch API");
	});

	test("git %s with OLD (buggy) subject leaks the preamble", () => {
		const msg = `subagent(implement-pro): ${oldSubject(payloadForChild)}`;
		fs.writeFileSync(path.join(dir, "f.txt"), "change2\n");
		git(["add", "-A"]);
		git(["commit", "-q", "-m", msg]);
		const subject = git(["log", "--format=%s", "-1"]).toString().trim();
		// git %s is the first paragraph (blank-line-delimited) with internal
		// newlines collapsed to spaces. The preamble has no blank line after
		// the header, so the whole boilerplate collapses into one subject —
		// the exact shape of the handoff evidence.
		assert.ok(
			subject.startsWith("subagent(implement-pro): ## Worktree isolation"),
			`expected preamble leak, got: ${JSON.stringify(subject)}`,
		);
		assert.ok(
			subject.includes("You are running inside an isolated git worktree"),
			`expected preamble body in subject, got: ${JSON.stringify(subject)}`,
		);
		assert.ok(
			!subject.includes("Refactor the widget"),
			`real work must NOT appear in buggy subject, got: ${JSON.stringify(subject)}`,
		);
	});
});

// ── Result ─────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
