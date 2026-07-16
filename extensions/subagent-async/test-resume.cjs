#!/usr/bin/env node
/**
 * Tests for subagent_resume functionality (meta round-trip, argv
 * composition, error paths, validation helpers, AgentConfig construction,
 * response shapes, and the "already running" guard).
 *
 * Run: node test-resume.cjs
 *
 * These tests exercise the pure-logic helpers at the module level.
 * Integration tests that spawn a real pi process are gated behind
 * PI_ASYNC_INTEGRATION=1.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execSync, spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");

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

function ok(cond, msg) {
  assert.ok(cond, msg);
}

function throws(fn, expectedMsg) {
  try {
    fn();
    ok(false, "expected throw but none occurred");
  } catch (e) {
    if (expectedMsg) ok(e.message.includes(expectedMsg), `expected "${expectedMsg}" in "${e.message}"`);
  }
}

// ── Inlined pure helpers (mirror index.ts module-level exports) ─────────────
// The extension is TypeScript ESM; these are tested at the logic level
// matching the existing test-viewer.cjs pattern.

function metaPath(sessionId) {
  return `/tmp/pi-subagent-${sessionId}.meta.json`;
}

function writeMetaJson(sessionId, data) {
  const target = metaPath(sessionId);
  const tmp = `${target}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, target);
}

function readMetaJson(sessionId) {
  try {
    const raw = fs.readFileSync(metaPath(sessionId), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function updateMetaJson(sessionId, updates) {
  const existing = readMetaJson(sessionId) || {};
  const merged = { ...existing, ...updates };
  writeMetaJson(sessionId, merged);
}

function buildSubagentArgs(config) {
  const args = ["--mode", "rpc"];
  if (config.model) args.push("--model", config.model);
  if (config.tools && config.tools.length > 0) args.push("--tools", config.tools.join(","));
  if (config.excludeTools && config.excludeTools.length > 0) {
    args.push("--exclude-tools", config.excludeTools.join(","));
  }
  if (config.sessionFile) {
    args.push("--session", config.sessionFile);
  }
  return args;
}

/**
 * Resolve a subagent session ID from a full or partial identifier.
 * Same logic as resolveSubagentMeta in index.ts.
 */
function resolveSubagentMeta(sessionId) {
  let files;
  try {
    files = fs.readdirSync("/tmp").filter(
      (f) => f.startsWith("pi-subagent-") && f.endsWith(".meta.json")
    );
  } catch {
    return null;
  }

  const candidates = [];
  for (const f of files) {
    const sid = f.replace("pi-subagent-", "").replace(".meta.json", "");
    if (sid === sessionId || sid.endsWith(sessionId)) {
      const meta = readMetaJson(sid);
      if (meta) candidates.push({ sid, meta });
    }
  }

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const ids = candidates.map((c) => c.sid).join(", ");
  throw new Error(
    `Ambiguous partial session id "${sessionId}" matches multiple sessions: ${ids}. ` +
      `Use a longer suffix or the full id.`
  );
}

/**
 * Validate a meta object for resume. Mirror of validateResumeMeta in index.ts.
 */
function validateResumeMeta(meta, sid) {
  if (!meta) {
    return {
      ok: false,
      error: `No prior session found with id "${sid}". The session may have been purged or never existed. Spawn a fresh subagent instead.`,
      isError: false,
    };
  }
  if (!meta.sessionFile) {
    return {
      ok: false,
      error: `Session file not captured for "${sid}". The original subagent may have crashed before reporting its session. Spawn a fresh subagent instead.`,
      isError: true,
    };
  }
  if (!fs.existsSync(meta.sessionFile)) {
    return {
      ok: false,
      error: `Session file ${meta.sessionFile} no longer exists. Cannot resume.`,
      isError: true,
    };
  }
  return { ok: true };
}

/**
 * Build an AgentConfig from persisted meta fields. Mirror of buildAgentConfigFromMeta.
 */
function buildAgentConfigFromMeta(meta) {
  return {
    name: meta.agentName || "?",
    description: "",
    systemPrompt: meta.systemPrompt || "",
    tools: Array.isArray(meta.tools) ? meta.tools : [],
    model: meta.model,
    source: "user",
    filePath: "",
    allowedSubagents: Array.isArray(meta.allowedSubagents) ? meta.allowedSubagents : undefined,
    excludeTools: Array.isArray(meta.excludeTools) ? meta.excludeTools : undefined,
  };
}

/**
 * Build the success response for a resumed subagent. Mirror of the tool's return.
 */
function buildResumeSuccessResponse(sid, agentName, task) {
  return {
    content: [
      {
        type: "text",
        text: [
          `Subagent resumed: ${agentName} (session: ${sid})`,
          `Task: ${task.slice(0, 200)}${task.length > 200 ? "..." : ""}`,
          "",
          "Watch live:",
          "```bash",
          `tail -f /tmp/pi-subagent-${sid}.log`,
          "```",
          "Or in-pi: /watch " + sid.slice(-8),
          "Or from another terminal: nc -U /tmp/pi-subagent-" + sid + ".sock",
          "Use /subagents to check progress.",
        ].join("\n"),
      },
    ],
  };
}

// ── Cleanup helpers ─────────────────────────────────────────────────────────

const CLEANUP = [];
function registerCleanup(p) { CLEANUP.push(p); return p; }

process.on("exit", () => {
  for (const p of CLEANUP) {
    try { fs.unlinkSync(p); } catch {}
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
});

function makeTestSid() {
  return `subagent-test-${randomUUID()}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS: Meta JSON round-trip
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\nMeta JSON round-trip:");

test("write → read survives all fields", () => {
  const sid = makeTestSid();
  registerCleanup(metaPath(sid));

  const data = {
    agentName: "test-agent",
    task: "do something",
    cwd: "/tmp/test-project",
    startedAt: 1712345678000,
    worktreePath: "/tmp/pi-subagent-wt-abc123",
    isolationBranch: "pi-subagent-abc123",
    parentHeadCommit: "e63cf900f9aa1234567890abcdef",
    parentCwd: "/tmp/test-project",
    tools: ["read", "bash", "edit", "write", "grep"],
    model: "anthropic/claude-sonnet-4-20250514",
    systemPrompt: "You are a helpful coding assistant.\nBe concise.",
    allowedSubagents: ["review-code", "review-tests"],
    excludeTools: ["kagi_search"],
    sessionFile: "/home/user/.pi/agent/sessions/--tmp-test--/1712345680_abc.jsonl",
    piSessionId: "abc123",
  };

  writeMetaJson(sid, data);
  const read = readMetaJson(sid);

  eq(read.agentName, "test-agent");
  eq(read.task, "do something");
  eq(read.cwd, "/tmp/test-project");
  eq(read.startedAt, 1712345678000);
  eq(read.worktreePath, "/tmp/pi-subagent-wt-abc123");
  eq(read.isolationBranch, "pi-subagent-abc123");
  eq(read.parentHeadCommit, "e63cf900f9aa1234567890abcdef");
  eq(read.parentCwd, "/tmp/test-project");
  eq(read.tools.length, 5);
  eq(read.tools[0], "read");
  eq(read.model, "anthropic/claude-sonnet-4-20250514");
  eq(read.systemPrompt, "You are a helpful coding assistant.\nBe concise.");
  eq(read.allowedSubagents.length, 2);
  ok(read.allowedSubagents.includes("review-code"));
  ok(read.allowedSubagents.includes("review-tests"));
  eq(read.excludeTools.length, 1);
  eq(read.excludeTools[0], "kagi_search");
  eq(read.sessionFile, "/home/user/.pi/agent/sessions/--tmp-test--/1712345680_abc.jsonl");
  eq(read.piSessionId, "abc123");
});

test("readMetaJson returns null for missing file", () => {
  const result = readMetaJson("subagent-nonexistent-00000000");
  eq(result, null);
});

test("readMetaJson returns null for malformed JSON", () => {
  const sid = makeTestSid();
  const target = metaPath(sid);
  registerCleanup(target);
  fs.writeFileSync(target, "not json{{{");
  const result = readMetaJson(sid);
  eq(result, null);
});

test("updateMetaJson merges fields without dropping existing", () => {
  const sid = makeTestSid();
  registerCleanup(metaPath(sid));

  writeMetaJson(sid, { agentName: "original", task: "task1", cwd: "/tmp" });
  updateMetaJson(sid, { sessionFile: "/path/to/session.jsonl", piSessionId: "xyz" });

  const read = readMetaJson(sid);
  eq(read.agentName, "original");
  eq(read.task, "task1");
  eq(read.cwd, "/tmp");
  eq(read.sessionFile, "/path/to/session.jsonl");
  eq(read.piSessionId, "xyz");
});

test("updateMetaJson overwrites existing sessionFile on second get_state", () => {
  const sid = makeTestSid();
  registerCleanup(metaPath(sid));

  writeMetaJson(sid, { agentName: "test", sessionFile: "/old/path.jsonl" });
  // Simulate a second get_state response (e.g., after compaction changes file)
  updateMetaJson(sid, { sessionFile: "/new/path.jsonl" });

  const read = readMetaJson(sid);
  eq(read.sessionFile, "/new/path.jsonl");
  eq(read.agentName, "test");
});

test("meta JSON is parseable by JSON.parse at every state", () => {
  const sid = makeTestSid();
  registerCleanup(metaPath(sid));

  // State 1: initial spawn meta (without sessionFile)
  writeMetaJson(sid, {
    agentName: "test",
    task: "hello",
    cwd: "/tmp",
    startedAt: Date.now(),
    tools: ["read", "bash"],
    model: "test/model",
    systemPrompt: "test prompt",
    allowedSubagents: [],
    excludeTools: [],
  });
  let raw = fs.readFileSync(metaPath(sid), "utf-8");
  JSON.parse(raw); // should not throw

  // State 2: after get_state capture (with sessionFile)
  updateMetaJson(sid, {
    sessionFile: "/some/path.jsonl",
    piSessionId: "abc-def",
  });
  raw = fs.readFileSync(metaPath(sid), "utf-8");
  JSON.parse(raw); // should not throw
});

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS: buildSubagentArgs
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\nbuildSubagentArgs:");

test("fresh spawn: no session file", () => {
  const args = buildSubagentArgs({
    model: "test/model",
    tools: ["read", "bash"],
    excludeTools: ["kagi_search"],
  });
  eq(args[0], "--mode");
  eq(args[1], "rpc");
  ok(args.includes("--model"));
  ok(args.includes("test/model"));
  ok(args.includes("--tools"));
  ok(args.includes("read,bash"));
  ok(args.includes("--exclude-tools"));
  ok(args.includes("kagi_search"));
  ok(!args.includes("--session"));
});

test("resume spawn: includes --session", () => {
  const args = buildSubagentArgs({
    model: "test/model",
    tools: ["read", "edit"],
    excludeTools: [],
    sessionFile: "/tmp/test-session.jsonl",
  });
  ok(args.includes("--session"));
  const idx = args.indexOf("--session");
  eq(args[idx + 1], "/tmp/test-session.jsonl");
});

test("resume spawn: all flags present", () => {
  const args = buildSubagentArgs({
    model: "anthropic/claude-sonnet-4",
    tools: ["read", "bash", "edit", "write"],
    excludeTools: ["kagi_search", "fetch_url"],
    sessionFile: "/home/user/.pi/agent/sessions/test.jsonl",
  });

  ok(args.includes("--mode") && args.includes("rpc"), "has --mode rpc");
  ok(args.includes("--model") && args.includes("anthropic/claude-sonnet-4"), "has --model");
  ok(args.includes("--tools") && args.includes("read,bash,edit,write"), "has --tools");
  ok(args.includes("--exclude-tools") && args.includes("kagi_search,fetch_url"), "has --exclude-tools");
  ok(args.includes("--session") && args.includes("/home/user/.pi/agent/sessions/test.jsonl"), "has --session");
});

test("no tools or excludeTools yields minimal args", () => {
  const args = buildSubagentArgs({
    model: "test/model",
    tools: [],
    excludeTools: [],
  });
  ok(!args.includes("--tools"), "no --tools flag when tools empty");
  ok(!args.includes("--exclude-tools"), "no --exclude-tools flag when excludeTools empty");
  ok(!args.includes("--session"), "no --session flag");
});

test("empty model is skipped (falsy guard)", () => {
  const args = buildSubagentArgs({
    model: "",
    tools: [],
    excludeTools: [],
  });
  ok(!args.includes("--model"), "empty model should not add --model flag");
});

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS: resolveSubagentMeta
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\nresolveSubagentMeta:");

test("full ID exact match", () => {
  const sid = makeTestSid();
  registerCleanup(metaPath(sid));
  writeMetaJson(sid, { agentName: "test", sessionFile: "/tmp/s.jsonl" });

  const result = resolveSubagentMeta(sid);
  ok(result !== null);
  eq(result.sid, sid);
  eq(result.meta.agentName, "test");
});

test("partial ID (last 12 chars) match", () => {
  const sid = makeTestSid();
  registerCleanup(metaPath(sid));
  writeMetaJson(sid, { agentName: "partial-test", sessionFile: "/tmp/s.jsonl" });

  const partial = sid.slice(-12);
  const result = resolveSubagentMeta(partial);
  ok(result !== null);
  eq(result.sid, sid);
  eq(result.meta.agentName, "partial-test");
});

test("partial ID (last 8 chars) match", () => {
  const sid = makeTestSid();
  registerCleanup(metaPath(sid));
  writeMetaJson(sid, { agentName: "partial-8", sessionFile: "/tmp/s.jsonl" });

  const partial = sid.slice(-8);
  const result = resolveSubagentMeta(partial);
  ok(result !== null);
  eq(result.sid, sid);
  eq(result.meta.agentName, "partial-8");
});

test("no match returns null", () => {
  const result = resolveSubagentMeta("subagent-nonexistent-00000000");
  eq(result, null);
});

test("ambiguous partial match throws", () => {
  const sid1 = makeTestSid();
  registerCleanup(metaPath(sid1));
  writeMetaJson(sid1, { agentName: "a" });

  const commonSuffix = sid1.slice(-8);
  const suffixSid = `subagent-test-copy-${commonSuffix}`;
  registerCleanup(metaPath(suffixSid));
  writeMetaJson(suffixSid, { agentName: "c" });

  try {
    resolveSubagentMeta(commonSuffix);
    ok(false, "should have thrown");
  } catch (e) {
    ok(e.message.includes("Ambiguous"), `expected ambiguity, got: ${e.message}`);
  }
});

test("ambiguous resolve → catch block returns isError:true with message", () => {
  // Simulate the tool execute's try/catch around resolveSubagentMeta.
  // This verifies the catch block produces the correct response shape.
  const sid1 = makeTestSid();
  const commonSuffix = sid1.slice(-8);
  registerCleanup(metaPath(sid1));
  writeMetaJson(sid1, { agentName: "first", sessionFile: "/tmp/exists.jsonl" });
  const suffixSid = `subagent-test-copy-${commonSuffix}`;
  registerCleanup(metaPath(suffixSid));
  writeMetaJson(suffixSid, { agentName: "second", sessionFile: "/tmp/exists.jsonl" });

  // Mirror of the execute handler's try/catch logic
  let response;
  try {
    const r = resolveSubagentMeta(commonSuffix);
    if (!r) {
      response = { content: [{ type: "text", text: "not found" }] };
    } else {
      response = { content: [{ type: "text", text: "resolved:" + r.sid }] };
    }
  } catch (e) {
    response = {
      content: [{ type: "text", text: e.message }],
      isError: true,
    };
  }

  ok(response !== undefined, "should have produced a response");
  eq(response.isError, true, "ambiguous resolve should set isError: true");
  ok(response.content[0].text.includes("Ambiguous"), "error text should mention 'Ambiguous'");
  ok(response.content[0].text.includes(sid1.slice(-8)), "error text should include partial id");
});

test("meta file with unparseable JSON is skipped", () => {
  const sid = makeTestSid();
  const target = metaPath(sid);
  registerCleanup(target);
  fs.writeFileSync(target, "garbage{{}[not json");

  const result = resolveSubagentMeta(sid);
  eq(result, null, "should skip unparseable meta and return null");
});

test("exactly one candidate among multiple files", () => {
  const sid = makeTestSid();
  registerCleanup(metaPath(sid));
  writeMetaJson(sid, { agentName: "unique-one", sessionFile: "/tmp/s.jsonl" });

  const otherSid = makeTestSid();
  registerCleanup(metaPath(otherSid));
  writeMetaJson(otherSid, { agentName: "other" });

  const result = resolveSubagentMeta(sid);
  ok(result !== null);
  eq(result.sid, sid);
});

test("partial ID must end with the suffix (not just contain it)", () => {
  const sid = makeTestSid();
  registerCleanup(metaPath(sid));
  writeMetaJson(sid, { agentName: "suffix-test", sessionFile: "/tmp/s.jsonl" });

  const middle = sid.slice(10, 18);
  const result = resolveSubagentMeta(middle);
  eq(result, null, "partial in middle of id should not match");
});

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS: validateResumeMeta (error paths + response shape)
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\nvalidateResumeMeta:");

test("null meta → 'No prior session found' error (isError: false)", () => {
  const result = validateResumeMeta(null, "subagent-test-12345678");
  eq(result.ok, false);
  ok(result.error.includes("No prior session found"), `got: ${result.error}`);
  eq(result.isError, false);
});

test("meta without sessionFile → 'Session file not captured' error (isError: true)", () => {
  const sid = makeTestSid();
  const result = validateResumeMeta(
    { agentName: "test", task: "hello", tools: [], model: "x", systemPrompt: "y" },
    sid
  );
  eq(result.ok, false);
  ok(result.error.includes("Session file not captured"), `got: ${result.error}`);
  eq(result.isError, true);
});

test("meta with sessionFile but file deleted → 'no longer exists' error (isError: true)", () => {
  const sid = makeTestSid();
  const result = validateResumeMeta(
    {
      agentName: "test",
      sessionFile: "/tmp/nonexistent-session-99999.jsonl",
    },
    sid
  );
  eq(result.ok, false);
  ok(result.error.includes("no longer exists"), `got: ${result.error}`);
  eq(result.isError, true);
});

test("valid meta with existing sessionFile → ok: true", () => {
  const sid = makeTestSid();
  // Create a temp file to act as the session file
  const tmpPath = `/tmp/pi-resume-test-session-${randomUUID()}.jsonl`;
  registerCleanup(tmpPath);
  fs.writeFileSync(tmpPath, '{"type":"session"}\n');

  const result = validateResumeMeta(
    { agentName: "test", sessionFile: tmpPath },
    sid
  );
  eq(result.ok, true, `expected ok but got: ${JSON.stringify(result)}`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS: buildAgentConfigFromMeta
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\nbuildAgentConfigFromMeta:");

test("all fields map correctly from meta", () => {
  const meta = {
    agentName: "review-code",
    systemPrompt: "You are a code reviewer.\nBe thorough.",
    tools: ["read", "grep", "find", "bash"],
    model: "anthropic/claude-sonnet-4-20250514",
    allowedSubagents: ["scout-code"],
    excludeTools: ["edit", "write", "subagent"],
  };

  const cfg = buildAgentConfigFromMeta(meta);

  eq(cfg.name, "review-code");
  eq(cfg.systemPrompt, "You are a code reviewer.\nBe thorough.");
  eq(cfg.tools.length, 4);
  ok(cfg.tools.includes("read"));
  ok(cfg.tools.includes("grep"));
  eq(cfg.model, "anthropic/claude-sonnet-4-20250514");
  eq(cfg.allowedSubagents.length, 1);
  eq(cfg.allowedSubagents[0], "scout-code");
  eq(cfg.excludeTools.length, 3);
  ok(cfg.excludeTools.includes("edit"));
  eq(cfg.source, "user");
  eq(cfg.filePath, "");
});

test("missing agentName → defaults to '?'", () => {
  const cfg = buildAgentConfigFromMeta({ systemPrompt: "test" });
  eq(cfg.name, "?");
});

test("missing systemPrompt → defaults to ''", () => {
  const cfg = buildAgentConfigFromMeta({ agentName: "x" });
  eq(cfg.systemPrompt, "");
});

test("non-array tools → defaults to []", () => {
  const cfg = buildAgentConfigFromMeta({ agentName: "x", tools: "not-an-array" });
  eq(cfg.tools.length, 0);
});

test("null tools → defaults to []", () => {
  const cfg = buildAgentConfigFromMeta({ agentName: "x", tools: null });
  eq(cfg.tools.length, 0);
});

test("non-array allowedSubagents → defaults to undefined", () => {
  const cfg = buildAgentConfigFromMeta({ agentName: "x", allowedSubagents: "not-array" });
  eq(cfg.allowedSubagents, undefined);
});

test("non-array excludeTools → defaults to undefined", () => {
  const cfg = buildAgentConfigFromMeta({ agentName: "x", excludeTools: null });
  eq(cfg.excludeTools, undefined);
});

test("empty arrays preserved correctly", () => {
  const cfg = buildAgentConfigFromMeta({
    agentName: "x",
    tools: [],
    allowedSubagents: [],
    excludeTools: [],
  });
  eq(cfg.tools.length, 0);
  eq(cfg.allowedSubagents.length, 0);
  eq(cfg.excludeTools.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS: Success response shape (buildResumeSuccessResponse)
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\nResume success response shape:");

test("response has content array with one text element", () => {
  const resp = buildResumeSuccessResponse("subagent-abc123", "review-code", "Follow up question");
  ok(Array.isArray(resp.content), "content should be an array");
  eq(resp.content.length, 1);
  eq(resp.content[0].type, "text");
});

test("response text includes agent name and session id", () => {
  const resp = buildResumeSuccessResponse("subagent-abc12345-6789", "review-code", "Follow up question");
  ok(resp.content[0].text.includes("review-code"), "should include agent name");
  ok(resp.content[0].text.includes("subagent-abc12345-6789"), "should include full session id");
});

test("response text includes task (truncated if >200 chars)", () => {
  const shortTask = "Short task";
  const resp1 = buildResumeSuccessResponse("sid1", "agent", shortTask);
  ok(resp1.content[0].text.includes("Short task"), "should include short task");

  const longTask = "x".repeat(250);
  const resp2 = buildResumeSuccessResponse("sid2", "agent", longTask);
  ok(resp2.content[0].text.includes("x".repeat(200)), "should include truncated task");
  ok(!resp2.content[0].text.includes("x".repeat(250)), "should not include full 250-char task");
  ok(resp2.content[0].text.includes("..."), "should include ellipsis for truncated task");
});

test("response text includes watch/log/socket hints", () => {
  const resp = buildResumeSuccessResponse("subagent-test123", "my-agent", "some task");
  ok(resp.content[0].text.includes("tail -f /tmp/pi-subagent-subagent-test123.log"), "has log tail hint");
  ok(resp.content[0].text.includes("nc -U /tmp/pi-subagent-subagent-test123.sock"), "has socket hint");
  ok(resp.content[0].text.includes("/watch"), "has /watch hint");
});

test("response text includes /subagents progress hint", () => {
  const resp = buildResumeSuccessResponse("sid", "agent", "task");
  ok(resp.content[0].text.includes("/subagents"), "should include progress hint");
});

test("success response has no isError field", () => {
  const resp = buildResumeSuccessResponse("sid", "agent", "task");
  eq(resp.isError, undefined, "success response should not have isError");
});

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS: "Already running" guard
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\nAlready running guard:");

/**
 * Simulate the "already running" check that the tool execute performs.
 * In production, `running` is a Map<string, RunningSubagent>; we mock it
 * with a plain Map to test the guard independently.
 */
function checkAlreadyRunning(runningMap, sid) {
  if (runningMap.has(sid)) {
    return {
      content: [{ type: "text", text: `Subagent "${sid}" is already running.` }],
      isError: true,
    };
  }
  return null; // not running — proceed
}

test("returns error with isError: true when session is in running map", () => {
  const map = new Map();
  const sid = "subagent-test-already-running";
  map.set(sid, { proc: null, agentName: "test" });

  const result = checkAlreadyRunning(map, sid);
  ok(result !== null, "should return error object");
  eq(result.isError, true, "should have isError: true");
  ok(result.content[0].text.includes("already running"), "should mention 'already running'");
  ok(result.content[0].text.includes(sid), "should include session id");
});

test("returns null when session is NOT in running map", () => {
  const map = new Map();
  const result = checkAlreadyRunning(map, "subagent-nonexistent");
  eq(result, null, "should return null for non-running session");
});

test("returns null when map has other sessions but not target", () => {
  const map = new Map();
  map.set("subagent-other-one", {});
  map.set("subagent-other-two", {});

  const result = checkAlreadyRunning(map, "subagent-target");
  eq(result, null, "should not be blocked by other sessions");
});

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS: Integration with real pi binary (gated)
// ═══════════════════════════════════════════════════════════════════════════════

if (process.env.PI_ASYNC_INTEGRATION === "1") {
  console.log("\nIntegration tests (PI_ASYNC_INTEGRATION=1):");

  function piAvailable() {
    try {
      const result = execSync("pi --version", { encoding: "utf-8", timeout: 5000 });
      return result.length > 0;
    } catch {
      return false;
    }
  }

  if (!piAvailable()) {
    console.log("  ⚠️  pi binary not available — skipping integration tests.");
  } else {
    test("fresh spawn via RPC produces get_state response with sessionFile", async () => {
      const proc = spawn("pi", ["--mode", "rpc", "--no-session"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });

      const lines = [];
      proc.stdout.on("data", (d) => { lines.push(...d.toString().split("\n").filter(Boolean)); });

      proc.stdin.write(JSON.stringify({ id: "test-gs", type: "get_state" }) + "\n");

      await new Promise((resolve) => {
        const check = setInterval(() => {
          for (const line of lines) {
            try {
              const ev = JSON.parse(line);
              if (ev.type === "response" && ev.id === "test-gs" && ev.success) {
                clearInterval(check);
                ok(typeof ev.data.sessionFile === "string", "sessionFile should be a string");
                ok(typeof ev.data.sessionId === "string", "sessionId should be a string");
                ok(ev.data.sessionFile.length > 0);
                ok(ev.data.sessionId.length > 0);
                proc.kill();
                resolve();
                return;
              }
            } catch {}
          }
        }, 100);
        setTimeout(() => { clearInterval(check); proc.kill(); resolve(); }, 10000);
      });
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Runbook documentation (manual steps to verify against real pi)
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\n── Manual runbook ──");
console.log("These steps verify the resume flow against a real pi binary:");
console.log("");
console.log("1. SPAWN PHASE:");
console.log("   Start pi in interactive mode, then run a subagent:");
console.log('     /subagent agent=review-code task="Test resume flow: run \'echo hello\'"');
console.log("   Wait for it to complete.");
console.log("");
console.log("2. VERIFY META:");
console.log("   Check that the meta file contains sessionFile and piSessionId:");
console.log("     cat /tmp/pi-subagent-<sid>.meta.json | python3 -m json.tool");
console.log("");
console.log("3. RESUME PHASE:");
console.log("   In the same pi session, try the resume tool:");
console.log('     /subagent_resume session_id=<sid-last-8> task="Follow up: what step are you on?"');
console.log("");
console.log("4. VERIFY CONTEXT:");
console.log("   The resumed agent should respond with awareness of the prior conversation.");
console.log("   Check the log for prior turn references:");
console.log("     tail -f /tmp/pi-subagent-<sid>.log");
