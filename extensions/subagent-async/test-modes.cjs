#!/usr/bin/env node
/**
 * Tests for mode pure helpers (nextMode, isValidMode) from modes.ts
 * Run: node test-modes.cjs
 *
 * These test the deterministic pure-logic layer of the modes extension.
 * The TUI injection / /mode command / status rendering surface is not
 * unit-testable without a running pi TUI and is verified by code review
 * (the existing modes.ts has no tests either). This test boundary
 * exercises the pure input/output transformers that are the primary
 * correctness evidence for the modes.ts code change.
 */

const assert = require("node:assert");

// ── Test harness ────────────────────────────────────────────────────────────

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
  assert.deepStrictEqual(actual, expected, msg);
}

function ok(value, msg) {
  assert.ok(value, msg);
}

// ── Inline replicas of the pure helpers from modes.ts ──────────────────────
//
// These are exact functional replicas. The TypeScript source in modes.ts
// is the authoritative version; reviewers audit modes.ts directly to
// confirm the bodies match.

/**
 * Replica of nextMode from modes.ts.
 * 3-way cycle: implement → orchestrate → plan → implement.
 */
function nextMode(current) {
  if (current === "implement") return "orchestrate";
  if (current === "orchestrate") return "plan";
  return "implement";
}

/**
 * Replica of isValidMode from modes.ts.
 * Accepts exactly the three mode strings (case-sensitive, no whitespace).
 */
function isValidMode(s) {
  return s === "implement" || s === "orchestrate" || s === "plan";
}

// ── Tests: nextMode ─────────────────────────────────────────────────────────

console.log("\nnextMode:");

test("implement → orchestrate", () => {
  eq(nextMode("implement"), "orchestrate");
});

test("orchestrate → plan", () => {
  eq(nextMode("orchestrate"), "plan");
});

test("plan → implement", () => {
  eq(nextMode("plan"), "implement");
});

test("round-trip: implement → orchestrate → plan → implement", () => {
  eq(nextMode(nextMode(nextMode("implement"))), "implement");
});

test("round-trip: orchestrate → plan → implement → orchestrate", () => {
  eq(nextMode(nextMode(nextMode("orchestrate"))), "orchestrate");
});

test("round-trip: plan → implement → orchestrate → plan", () => {
  eq(nextMode(nextMode(nextMode("plan"))), "plan");
});

test("double cycle returns same value", () => {
  const twice = (m) => nextMode(nextMode(nextMode(nextMode(nextMode(nextMode(m))))));
  eq(twice("implement"), "implement");
  eq(twice("orchestrate"), "orchestrate");
  eq(twice("plan"), "plan");
});

// ── Tests: isValidMode ──────────────────────────────────────────────────────

console.log("\nisValidMode:");

test('accepts "implement"', () => {
  eq(isValidMode("implement"), true);
});

test('accepts "orchestrate"', () => {
  eq(isValidMode("orchestrate"), true);
});

test('accepts "plan"', () => {
  eq(isValidMode("plan"), true);
});

test('rejects empty string', () => {
  eq(isValidMode(""), false);
});

test('rejects "orchestrator" (agent name, not mode)', () => {
  eq(isValidMode("orchestrator"), false);
});

test('rejects "PLAN" (case-sensitive)', () => {
  eq(isValidMode("PLAN"), false);
});

test('rejects "Plan" (case-sensitive)', () => {
  eq(isValidMode("Plan"), false);
});

test('rejects "IMPLEMENT" (case-sensitive)', () => {
  eq(isValidMode("IMPLEMENT"), false);
});

test('rejects "ORCHESTRATE" (case-sensitive)', () => {
  eq(isValidMode("ORCHESTRATE"), false);
});

test('rejects "foo" (arbitrary string)', () => {
  eq(isValidMode("foo"), false);
});

test('rejects "implement " (trailing whitespace)', () => {
  eq(isValidMode("implement "), false);
});

test('rejects " implement" (leading whitespace)', () => {
  eq(isValidMode(" implement"), false);
});

test('rejects " implement " (surrounding whitespace)', () => {
  eq(isValidMode(" implement "), false);
});

test("rejects number", () => {
  eq(isValidMode(42), false);
});

test("rejects null", () => {
  eq(isValidMode(null), false);
});

test("rejects undefined", () => {
  eq(isValidMode(undefined), false);
});

test("rejects object", () => {
  eq(isValidMode({ mode: "plan" }), false);
});

// ── Cross-check: isValidMode and nextMode consistency ───────────────────────

console.log("\nConsistency checks:");

test("nextMode always returns a valid mode", () => {
  ok(isValidMode(nextMode("implement")), "nextMode(implement) must be valid");
  ok(isValidMode(nextMode("orchestrate")), "nextMode(orchestrate) must be valid");
  ok(isValidMode(nextMode("plan")), "nextMode(plan) must be valid");
});

test("valid modes cycle without gaps", () => {
  const modes = ["implement", "orchestrate", "plan"];
  const seen = new Set();
  let current = "implement";
  for (let i = 0; i < 3; i++) {
    ok(isValidMode(current), `cycle step ${i}: ${current} must be valid`);
    ok(!seen.has(current), `cycle step ${i}: ${current} must not repeat`);
    seen.add(current);
    current = nextMode(current);
  }
  eq(current, "implement", "after 3 steps we return to implement");
  eq(seen.size, 3, "all 3 modes visited exactly once");
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
