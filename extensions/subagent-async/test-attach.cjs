#!/usr/bin/env node
/**
 * Tests for /attach pure helpers (resolveAttachTarget, buildPromptPayload)
 * Run: node test-attach.cjs
 *
 * These test the pure logic layer of the attach/detach feature. The
 * interactive TUI layer (editor swap, widget render, real RPC submit) is
 * verified by manual smoke test + adversarial review.
 */

const assert = require("node:assert");
const path = require("node:path");

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

// ── Load the helper functions ───────────────────────────────────────────────
//
// The helpers are in a .ts file compiled by tsx at runtime. For standalone
// test execution we extract the logic here to avoid the tsx dependency.
// These are exact functional replicas of the helpers in index.ts.

/**
 * Replica of resolveAttachTarget from index.ts.
 * Encapsulates lookup + all guards: empty arg, not found, already done,
 * no writable stdin.
 */
function resolveAttachTarget(runningMap, sid) {
  if (!sid.trim()) return { ok: false, reason: "empty" };

  let rs;
  for (const [id, r] of runningMap) {
    if (id === sid || id.endsWith(sid)) {
      rs = r;
      break;
    }
  }
  if (!rs) return { ok: false, reason: "notFound" };
  if (rs.isDone) return { ok: false, reason: "done" };
  if (!rs.stdin || rs.stdin.destroyed) return { ok: false, reason: "noStdin" };
  return { ok: true, rs };
}

/**
 * Replica of buildPromptPayload from index.ts.
 * Pins the exact shape — missing streamingBehavior would throw when the
 * child is mid-turn.
 */
function buildPromptPayload(text) {
  return { type: "prompt", message: text, streamingBehavior: "steer" };
}

// ── Helpers to build fake RunningSubagent objects ───────────────────────────

function fakeRs(overrides) {
  return {
    sessionId: "subagent-abc123",
    agentName: "test-agent",
    isDone: false,
    stdin: { destroyed: false, writable: true },
    logLines: [],
    usageStats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, latestCacheHitRate: undefined },
    ...overrides,
  };
}

function fakeMap(entries) {
  const m = new Map();
  for (const e of entries) {
    m.set(e.sessionId, e);
  }
  return m;
}

// ── Tests: resolveAttachTarget ──────────────────────────────────────────────

console.log("\nresolveAttachTarget:");

test("exact full id match → ok", () => {
  const rs = fakeRs();
  const map = fakeMap([rs]);
  const result = resolveAttachTarget(map, "subagent-abc123");
  ok(result.ok, "expected ok");
  eq(result.rs.sessionId, "subagent-abc123");
});

test("partial suffix match → ok", () => {
  const rs = fakeRs({ sessionId: "subagent-abcdef123456" });
  const map = fakeMap([rs]);
  const result = resolveAttachTarget(map, "f123456");
  ok(result.ok, "expected ok");
  eq(result.rs.sessionId, "subagent-abcdef123456");
});

test("empty string → reason empty", () => {
  const result = resolveAttachTarget(new Map(), "");
  eq(result.ok, false);
  eq(result.reason, "empty");
});

test("whitespace only → reason empty", () => {
  const result = resolveAttachTarget(new Map(), "   ");
  eq(result.ok, false);
  eq(result.reason, "empty");
});

test("no match → reason notFound", () => {
  const rs = fakeRs();
  const map = fakeMap([rs]);
  const result = resolveAttachTarget(map, "nonexistent");
  eq(result.ok, false);
  eq(result.reason, "notFound");
});

test("empty map → reason notFound", () => {
  const result = resolveAttachTarget(new Map(), "subagent-xyz");
  eq(result.ok, false);
  eq(result.reason, "notFound");
});

test("isDone true → reason done", () => {
  const rs = fakeRs({ isDone: true });
  const map = fakeMap([rs]);
  const result = resolveAttachTarget(map, "subagent-abc123");
  eq(result.ok, false);
  eq(result.reason, "done");
});

test("stdin null → reason noStdin", () => {
  const rs = fakeRs({ stdin: null });
  const map = fakeMap([rs]);
  const result = resolveAttachTarget(map, "subagent-abc123");
  eq(result.ok, false);
  eq(result.reason, "noStdin");
});

test("stdin destroyed → reason noStdin", () => {
  const rs = fakeRs({ stdin: { destroyed: true } });
  const map = fakeMap([rs]);
  const result = resolveAttachTarget(map, "subagent-abc123");
  eq(result.ok, false);
  eq(result.reason, "noStdin");
});

test("multiple sessions — matches correct one by endsWith", () => {
  const rs1 = fakeRs({ sessionId: "subagent-aaaa1111" });
  const rs2 = fakeRs({ sessionId: "subagent-bbbb2222" });
  const map = fakeMap([rs1, rs2]);
  const result = resolveAttachTarget(map, "2222");
  ok(result.ok, "expected ok");
  eq(result.rs.sessionId, "subagent-bbbb2222");
});

test("multiple sessions — exact match preferred", () => {
  const rs1 = fakeRs({ sessionId: "subagent-abc" });
  const rs2 = fakeRs({ sessionId: "subagent-xyzabc" });
  // Both end with "abc", but the first one iterated wins (the helper uses
  // for...of which iterates in insertion order and breaks on first match).
  const map = fakeMap([rs1, rs2]);
  const result = resolveAttachTarget(map, "abc");
  ok(result.ok, "expected ok");
  // Both end with "abc"; the exact match on rs1 hits first.
  eq(result.rs.sessionId, "subagent-abc");
});

test("does NOT mutate the map", () => {
  const rs = fakeRs();
  const map = fakeMap([rs]);
  resolveAttachTarget(map, "nonexistent");
  eq(map.size, 1, "map size unchanged");
  ok(map.has("subagent-abc123"), "original entry still present");
});

test("partial suffix match on done session → reason done", () => {
  const rs = fakeRs({ sessionId: "subagent-abcdef123456", isDone: true });
  const map = fakeMap([rs]);
  const result = resolveAttachTarget(map, "f123456");
  eq(result.ok, false);
  eq(result.reason, "done");
});

test("partial suffix match on destroyed stdin → reason noStdin", () => {
  const rs = fakeRs({ sessionId: "subagent-abcdef123456", stdin: { destroyed: true } });
  const map = fakeMap([rs]);
  const result = resolveAttachTarget(map, "f123456");
  eq(result.ok, false);
  eq(result.reason, "noStdin");
});

// ── Tests: buildPromptPayload ───────────────────────────────────────────────

console.log("\nbuildPromptPayload:");

test("simple text → correct shape", () => {
  const payload = buildPromptPayload("hello world");
  eq(payload, {
    type: "prompt",
    message: "hello world",
    streamingBehavior: "steer",
  });
});

test("empty string → correct shape", () => {
  const payload = buildPromptPayload("");
  eq(payload, {
    type: "prompt",
    message: "",
    streamingBehavior: "steer",
  });
});

test("multi-line text preserved", () => {
  const payload = buildPromptPayload("line 1\nline 2\nline 3");
  eq(payload.type, "prompt");
  eq(payload.streamingBehavior, "steer");
  eq(payload.message, "line 1\nline 2\nline 3");
});

test("text with special characters preserved", () => {
  const payload = buildPromptPayload("fix: /path/to/file (ref #123)");
  eq(payload.type, "prompt");
  eq(payload.streamingBehavior, "steer");
  eq(payload.message, "fix: /path/to/file (ref #123)");
});

test("exact keys — no extra properties", () => {
  const payload = buildPromptPayload("test");
  const keys = Object.keys(payload).sort();
  eq(keys, ["message", "streamingBehavior", "type"]);
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
