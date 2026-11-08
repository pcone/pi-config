#!/usr/bin/env node
/**
 * Tests for watch-session viewer and subagent-async extension
 * Run: node test-viewer.cjs
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// ── Test harness ────────────────────────────────────────────────────────────

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

// A row whose fixture another user name can build throws this instead.
function skip(msg) {
  const e = new Error(msg);
  e.__piSkip = true;
  throw e;
}

function eq(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, msg);
}

// ── Import viewer functions ─────────────────────────────────────────────────

const {
  discoverSessions,
  truncate,
  plainLen,
  padRight,
  timeAgo,
  countLines,
} = require("./watch-session.cjs");
const {
  parseTerminalFooter,
  readTerminalFooter,
  outcomeFromFooter,
} = require("../lib/subagent-state.ts");

// ── Tests: plainLen ─────────────────────────────────────────────────────────

console.log("\nplainLen:");
test("plain text", () => eq(plainLen("hello"), 5));
test("empty", () => eq(plainLen(""), 0));
test("bold ANSI", () => eq(plainLen("\x1b[1mbold\x1b[22m"), 4));
test("dim ANSI", () => eq(plainLen("\x1b[2mdim\x1b[22m"), 3));
test("color ANSI", () => eq(plainLen("\x1b[34mblue\x1b[0m"), 4));
test("multiple sequences", () => {
  eq(plainLen("\x1b[1m\x1b[34mhello\x1b[0m\x1b[22m"), 5);
});
test("no ANSI at all", () => eq(plainLen("just text 123"), 13));
test("complex unicode", () => eq(plainLen("\x1b[2m→ result\x1b[0m"), 8));
test("only ANSI codes", () => eq(plainLen("\x1b[1m\x1b[0m"), 0));

// ── Tests: truncate ────────────────────────────────────────────────────────

console.log("\ntruncate:");
test("no truncation needed", () => {
  eq(truncate("short", 10), "short");
});
test("plain text truncation", () => {
  const r = truncate("hello world this is long", 12);
  eq(r, "hello world\u2026\x1b[0m");
});
test("exact width", () => {
  eq(truncate("12345", 5), "12345");
});
test("ANSI text, visible fits", () => {
  const r = truncate("\x1b[34mblue\x1b[0m", 10);
  eq(r, "\x1b[34mblue\x1b[0m");
});
test("ANSI text, visible truncated", () => {
  const r = truncate("\x1b[34ma long blue string\x1b[0m", 12);
  // Should keep ANSI codes intact, truncate visible chars
  eq(plainLen(r), 12); // 11 visible chars + 1 ellipsis
  eq(r.startsWith("\x1b[34m"), true);
  eq(r.endsWith("\u2026\x1b[0m"), true);
});
test("ANSI with multiple sequences truncated", () => {
  const r = truncate("\x1b[1m\x1b[34mcolorful text here\x1b[0m", 15);
  eq(plainLen(r), 15);
});
test("empty string", () => {
  eq(truncate("", 5), "");
});
test("single char at width 1", () => {
  eq(truncate("a", 1), "a");
});
test("single char at width 2, too long", () => {
  eq(truncate("ab", 1), "\u2026\x1b[0m");
});

// ── Tests: padRight ─────────────────────────────────────────────────────────

console.log("\npadRight:");
test("no padding needed", () => eq(padRight("hi", 2), "hi"));
test("simple padding", () => eq(padRight("hi", 5), "hi   "));
test("ANSI-aware padding", () => {
  const r = padRight("\x1b[34mhi\x1b[0m", 5);
  eq(r, "\x1b[34mhi\x1b[0m   ");
});
test("ANSI content exactly fills", () => {
  eq(padRight("\x1b[1mabc\x1b[22m", 3), "\x1b[1mabc\x1b[22m");
});

// ── Tests: timeAgo ──────────────────────────────────────────────────────────

console.log("\ntimeAgo:");
test("seconds", () => eq(timeAgo(30_000), "30s ago"));
test("under 60s", () => eq(timeAgo(59_000), "59s ago"));
test("one minute", () => eq(timeAgo(60_000), "1m ago"));
test("minutes and seconds", () => eq(timeAgo(90_000), "1m ago"));
test("multiple minutes", () => eq(timeAgo(5 * 60_000), "5m ago"));
test("under one hour", () => eq(timeAgo(59 * 60_000), "59m ago"));
test("one hour", () => eq(timeAgo(60 * 60_000), "1h ago"));
test("multiple hours", () => eq(timeAgo(3 * 60 * 60_000), "3h ago"));
test("zero", () => eq(timeAgo(0), "0s ago"));

// ── Tests: countLines ───────────────────────────────────────────────────────

console.log("\ncountLines:");
test("single line no newline", () => {
  const tmp = createTempFile("oneline.txt", "hello");
  eq(countLines(tmp), 0);
  unlink(tmp);
});
test("newline terminated", () => {
  const tmp = createTempFile("twoline.txt", "hello\nworld\n");
  eq(countLines(tmp), 2); // two \n chars
  unlink(tmp);
});
test("three lines", () => {
  const tmp = createTempFile("three.txt", "a\nb\nc\n");
  eq(countLines(tmp), 3);
  unlink(tmp);
});
test("empty file", () => {
  const tmp = createTempFile("empty.txt", "");
  eq(countLines(tmp), 0);
  unlink(tmp);
});
test("missing file", () => {
  eq(countLines("/tmp/this-file-does-not-exist-xyz123"), 0);
});

// ── Tests: discoverSessions ─────────────────────────────────────────────────

console.log("\ndiscoverSessions:");

const CLEANUP = [];

function registerCleanup(p) { CLEANUP.push(p); return p; }
function unlink(p) { try { fs.unlinkSync(p); } catch {} }

function createSessionFiles(id) {
  const sock = `/tmp/pi-subagent-${id}.sock`;
  const log = `/tmp/pi-subagent-${id}.log`;
  registerCleanup(sock);
  registerCleanup(log);
  return { sock, log };
}

// Helper: write log and touch socket with specific mtime
function touchLog(logPath, content, ageSec) {
  fs.writeFileSync(logPath, content || "log content");
  const ts = Date.now() - ageSec * 1000;
  fs.utimesSync(logPath, ts / 1000, ts / 1000);
}
function touchSocket(sockPath, ageSec) {
  fs.writeFileSync(sockPath, "");
  const ts = Date.now() - ageSec * 1000;
  fs.utimesSync(sockPath, ts / 1000, ts / 1000);
}

test("active session with socket", () => {
  const f = createSessionFiles("test-active-001");
  touchSocket(f.sock, 10);
  touchLog(f.log, "some log\n── Completed (2 turns, exit 0)", 10);
  const sessions = discoverSessions();
  const s = sessions.find((x) => x.id === "test-active-001");
  eq(Boolean(s), true);
  eq(s.status, "RUNNING");
  eq(s.sockPath, f.sock);
  eq(s.logPath, f.log);
});

test("ordering by mtime (most recent first)", () => {
  const a = createSessionFiles("test-order-a");
  const b = createSessionFiles("test-order-b");
  touchSocket(a.sock, 60);
  touchSocket(b.sock, 10); // b is more recent
  const sessions = discoverSessions();
  const idxA = sessions.findIndex((x) => x.id === "test-order-a");
  const idxB = sessions.findIndex((x) => x.id === "test-order-b");
  eq(idxB < idxA, true, "b (more recent) should come before a");
});

test("completed session (no socket, recent log)", () => {
  const f = createSessionFiles("test-done-001");
  unlink(f.sock); // no socket = completed
  touchLog(f.log, "log\ngoes\nhere\n── Completed (5 turns, exit 0)", 60);
  const sessions = discoverSessions();
  const s = sessions.find((x) => x.id === "test-done-001");
  eq(Boolean(s), true);
  eq(s.status, "COMPLETED");
});

test("completed without log text match = STOPPED", () => {
  const f = createSessionFiles("test-stopped-001");
  unlink(f.sock);
  touchLog(f.log, "just some log\nno completion footer", 60);
  const sessions = discoverSessions();
  const s = sessions.find((x) => x.id === "test-stopped-001");
  eq(Boolean(s), true);
  eq(s.status, "STOPPED");
  eq(s.word, null);
  eq(s.outcome, null);
});

test("errored footer = ERRORED, never COMPLETED", () => {
  const f = createSessionFiles("test-errored-001");
  unlink(f.sock);
  touchLog(f.log, "log\ngoes\nhere\n── Errored (3 turns, exit 1)", 60);
  const s = discoverSessions().find((x) => x.id === "test-errored-001");
  eq(Boolean(s), true);
  eq(s.status, "ERRORED");
  eq(s.word, "Errored");
  eq(s.outcome, "errored");
});

test("overflowed footer with exit 0 = OVERFLOWED, failure outcome", () => {
  const f = createSessionFiles("test-overflowed-001");
  unlink(f.sock);
  touchLog(f.log, "log\n── Overflowed (3 turns, exit 0)", 60);
  const s = discoverSessions().find((x) => x.id === "test-overflowed-001");
  eq(Boolean(s), true);
  eq(s.status, "OVERFLOWED");
  eq(s.outcome, "overflowed");
});

test("exited footer names its word, exit code decides the outcome", () => {
  const f = createSessionFiles("test-exited-001");
  unlink(f.sock);
  touchLog(f.log, "log\n── Exited (3 turns, exit 1)", 60);
  const s = discoverSessions().find((x) => x.id === "test-exited-001");
  eq(s.status, "EXITED");
  eq(s.word, "Exited");
  eq(s.outcome, "aborted");
});

test("stopped footer with exit ? = STOPPED, exitCode null", () => {
  const f = createSessionFiles("test-stopped-q-001");
  unlink(f.sock);
  touchLog(f.log, "log\n── Stopped (3 turns, exit ?)", 60);
  const s = discoverSessions().find((x) => x.id === "test-stopped-q-001");
  eq(s.status, "STOPPED");
  eq(s.word, "Stopped");
  eq(s.outcome, "aborted");
});

test("aborted footer = ABORTED, failure outcome", () => {
  const f = createSessionFiles("test-aborted-001");
  unlink(f.sock);
  touchLog(f.log, "log\n── Aborted (3 turns, exit 0)", 60);
  const s = discoverSessions().find((x) => x.id === "test-aborted-001");
  eq(s.status, "ABORTED");
  eq(s.word, "Aborted");
  eq(s.outcome, "aborted");
});

test("killed footer = KILLED, never COMPLETED", () => {
  const f = createSessionFiles("test-killed-001");
  unlink(f.sock);
  touchLog(f.log, "log\n── Killed (3 turns, exit ?)", 60);
  const s = discoverSessions().find((x) => x.id === "test-killed-001");
  eq(s.status, "KILLED");
  eq(s.word, "Killed");
  eq(s.outcome, "killed");
});

test("stale log (>30min) excluded", () => {
  const f = createSessionFiles("test-stale-001");
  unlink(f.sock);
  touchLog(f.log, "old log\n── Completed (1 turns, exit 0)", 2000);
  const sessions = discoverSessions();
  const s = sessions.find((x) => x.id === "test-stale-001");
  eq(s, undefined);
});

test("empty /tmp (no sessions) returns empty array", () => {
  // We can't easily mock readdirSync, but we know it returns an array.
  // Just verify the function doesn't throw.
  const sessions = discoverSessions();
  eq(Array.isArray(sessions), true);
});

// ── Tests: the shared discovery (WO-2026-082) ───────────────────────────────
// Both viewers find sessions through `extensions/lib/subagent-discovery.ts`.
// This file runs under plain `node`, so these rows also prove the new lib
// loads through node's type stripping. They drive the module over a private
// dir with a fixed clock, then check one `/tmp` fixture through both viewers.

console.log("\nshared discovery:");

const discovery = require("../lib/subagent-discovery.ts");

const WO082_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wo082-cjs-"));
const WO082_NOW = 1_700_000_000_000;

function placeInDir(name, content, ageMs) {
  const p = path.join(WO082_DIR, name);
  fs.writeFileSync(p, content);
  const ts = (WO082_NOW - ageMs) / 1000;
  fs.utimesSync(p, ts, ts);
  return p;
}

process.on("exit", () => {
  try { fs.rmSync(WO082_DIR, { recursive: true, force: true }); } catch {}
});

test("a socket session is running, joined by its log and footer", () => {
  placeInDir("pi-subagent-test-wo082-20.sock", "", 10 * 1000);
  placeInDir("pi-subagent-test-wo082-20.log", "── Turn 1 ──\n  text\n── Completed (1 turns, exit 0) ──\n", 10 * 1000);
  const found = discovery.discoverSessions({ dir: WO082_DIR, now: WO082_NOW });
  eq(found.length, 1);
  eq(found[0].id, "test-wo082-20");
  eq(found[0].running, true);
  eq(found[0].turns, 1);
  eq(found[0].footer, { word: "Completed", turns: 1, exitCode: 0 });
  eq(found[0].sockPath, path.join(WO082_DIR, "pi-subagent-test-wo082-20.sock"));
});

test("a socket outlives the window; a stale log alone does not", () => {
  placeInDir("pi-subagent-test-wo082-21.sock", "", 90 * 60 * 1000);
  placeInDir("pi-subagent-test-wo082-21.log", "── Turn 1 ──\n", 90 * 60 * 1000);
  placeInDir("pi-subagent-test-wo082-22.log", "── Turn 1 ──\n", 40 * 60 * 1000);
  const ids = discovery.discoverSessions({ dir: WO082_DIR, now: WO082_NOW }).map((s) => s.id);
  eq(ids.includes("test-wo082-21"), true);
  eq(ids.includes("test-wo082-22"), false);
});

test("an unreadable log is kept, with no content, footer or turns", () => {
  // 0000 is readable to root, so the fixture is not unreadable there.
  if (process.getuid?.() === 0) skip("root reads a 0000 file");
  const logPath = placeInDir("pi-subagent-test-wo082-23.log", "── Completed (1 turns, exit 0) ──\n", 1000);
  fs.chmodSync(logPath, 0o000);
  const s = discovery.discoverSessions({ dir: WO082_DIR, now: WO082_NOW }).find((x) => x.id === "test-wo082-23");
  eq(Boolean(s), true);
  eq(s.content, null);
  eq(s.footer, null);
  eq(s.turns, 0);
});

test("a picked session with an unreadable log is kept as STOPPED", () => {
  // 0000 is readable to root, so the fixture is not unreadable there.
  if (process.getuid?.() === 0) skip("root reads a 0000 file");
  const f = createSessionFiles("test-wo082-25");
  unlink(f.sock);
  touchLog(f.log, "── Completed (1 turns, exit 0) ──\n", 60);
  fs.chmodSync(f.log, 0o000);

  const s = discoverSessions().find((x) => x.id === "test-wo082-25");
  eq(Boolean(s), true);
  eq(s.status, "STOPPED");
  eq(s.word, null);
  eq(s.outcome, null);
});

test("both viewers report the same facts for one session", () => {
  const f = createSessionFiles("test-wo082-24");
  unlink(f.sock);
  touchLog(f.log, "── Turn 1 ──\n── Turn 2 ──\n── Errored (2 turns, exit 1) ──\n", 60);

  const picked = discoverSessions().find((s) => s.id === "test-wo082-24");
  const shared = discovery.discoverSessions().find((s) => s.id === "test-wo082-24");
  eq(Boolean(picked), true);
  eq(Boolean(shared), true);
  eq(shared.footer, { word: "Errored", turns: 2, exitCode: 1 });
  eq(picked.word, "Errored");
  eq(picked.outcome, "errored");
  eq(picked.mtimeMs, shared.mtimeMs);
  eq(picked.status, "ERRORED");
});

// ── Tests: completion footer parser ─────────────────────────────────────────
// The rows drive the shared parser; the fixtures are the lines the extension's
// footer writer emits (`── <word> (<n> turns, exit <code|?>) ──`).

console.log("\nCompletion footer parser:");

// [fixture, word, outcome, turns, exitCode] — expected values spelled out, not
// recomputed from the table the writer builds.
const FOOTER_ROWS = [
  ["── Completed (3 turns, exit 0) ──", "Completed", "finished", 3, 0],
  ["── Errored (3 turns, exit 1) ──", "Errored", "errored", 3, 1],
  ["── Overflowed (3 turns, exit 0) ──", "Overflowed", "overflowed", 3, 0],
  ["── Aborted (3 turns, exit 0) ──", "Aborted", "aborted", 3, 0],
  ["── Killed (3 turns, exit ?) ──", "Killed", "killed", 3, null],
  ["── Exited (3 turns, exit 0) ──", "Exited", "finished", 3, 0],
  ["── Exited (3 turns, exit 1) ──", "Exited", "aborted", 3, 1],
  ["── Stopped (3 turns, exit 143) ──", "Stopped", "aborted", 3, 143],
  ["── Stopped (3 turns, exit ?) ──", "Stopped", "aborted", 3, null],
];

for (const [line, word, outcome, turns, exitCode] of FOOTER_ROWS) {
  test(`${word} (exit ${exitCode === null ? "?" : exitCode})`, () => {
    const parsed = parseTerminalFooter(line);
    eq(parsed, { word, turns, exitCode });
    eq(outcomeFromFooter(parsed), outcome);
  });
}

test("ANSI prefix does not hide the footer", () => {
  const parsed = parseTerminalFooter("\x1b[1;32m── Errored (2 turns, exit 1) ──\x1b[0m");
  eq(parsed, { word: "Errored", turns: 2, exitCode: 1 });
});

test("the old `exit null` spelling is not a footer", () => {
  // The writer emits `?` for an absent exit code; `null` is the spelling the
  // retired viewer regex coerced to 0.
  eq(parseTerminalFooter("── Stopped (0 turns, exit null)"), null);
});

test("no match on normal log line", () => {
  eq(parseTerminalFooter("  ▸ bash echo hello"), null);
});

test("no match on partial", () => {
  eq(parseTerminalFooter("── Completed (3 turns)"), null);
});

test("no match on a word no writer emits", () => {
  eq(parseTerminalFooter("── Finished (1 turns, exit 0) ──"), null);
});

test("readTerminalFooter tolerates lines after the footer", () => {
  const log = "── Turn 1 ──\nassistant text\n── Aborted (1 turns, exit 0) ──\ntrailing noise\n";
  eq(readTerminalFooter(log), { word: "Aborted", turns: 1, exitCode: 0 });
});

test("readTerminalFooter returns the last footer, not the first", () => {
  const log = "── Completed (2 turns, exit 0) ──\n── Errored (3 turns, exit 1) ──\n";
  eq(readTerminalFooter(log), { word: "Errored", turns: 3, exitCode: 1 });
});

test("readTerminalFooter is null without a footer", () => {
  eq(readTerminalFooter("── Turn 1 ──\nassistant text\n"), null);
});

// ── Tests: formatToolAction (from extension) ────────────────────────────────

console.log("\nformatToolAction:");

// Inline the pure function from the extension
function formatToolAction(toolName, args) {
  const typ = toolName;
  switch (typ) {
    case "bash": return `bash: ${(args.command || "").slice(0, 120)}`;
    case "read": return `read ${args.path || "?"}`;
    case "write": return `write ${args.path || "?"}`;
    case "edit": return `edit ${args.path || "?"}`;
    case "subagent": return `subagent: ${args.agent || "?"} → ${(args.task || "").slice(0, 80)}`;
    case "subagent_async": return `subagent_async: ${args.agent || "?"} → ${(args.task || "").slice(0, 80)}`;
    case "checkpoint": return `checkpoint: ${(args.summary || "").slice(0, 80)}`;
    case "fetch_url": return `fetch ${args.url || "?"}`;
    case "kagi_search": return `search: ${args.query || "?"}`;
    default: return `${typ}`;
  }
}

test("bash tool", () => {
  const r = formatToolAction("bash", { command: 'echo "hello world"' });
  eq(r, 'bash: echo "hello world"');
});
test("bash truncation", () => {
  const long = "x".repeat(200);
  const r = formatToolAction("bash", { command: long });
  eq(r.length, "bash: ".length + 120);
});
test("read tool", () => {
  eq(formatToolAction("read", { path: "/tmp/foo.txt" }), "read /tmp/foo.txt");
});
test("read missing path", () => {
  eq(formatToolAction("read", {}), "read ?");
});
test("write tool", () => {
  eq(formatToolAction("write", { path: "out.md" }), "write out.md");
});
test("edit tool", () => {
  eq(formatToolAction("edit", { path: "index.ts" }), "edit index.ts");
});
test("subagent tool", () => {
  const r = formatToolAction("subagent", { agent: "worker", task: "Summarize this file" });
  eq(r, "subagent: worker → Summarize this file");
});
test("subagent task truncation", () => {
  const longTask = "x".repeat(200);
  const r = formatToolAction("subagent_async", { agent: "scout", task: longTask });
  eq(r.startsWith("subagent_async: scout → "), true);
  eq(r.length, "subagent_async: scout → ".length + 80);
});
test("fetch_url", () => {
  eq(formatToolAction("fetch_url", { url: "https://example.com" }), "fetch https://example.com");
});
test("search", () => {
  eq(formatToolAction("kagi_search", { query: "node.js streams" }), "search: node.js streams");
});
test("unknown tool", () => {
  eq(formatToolAction("mystery_tool", {}), "mystery_tool");
});
test("checkpoint tool", () => {
  const r = formatToolAction("checkpoint", { summary: "Built the main UI component" });
  eq(r, "checkpoint: Built the main UI component");
});

// ── Tests: formatTokens ────────────────────────────────────────────────────
// NOTE: formatTokens and formatStatsLine are duplicated here as inline mirrors
// of the functions in ui.ts. This is the "acceptable alternative" per the
// work order (WO-2026-009), chosen because the TypeScript functions are not
// exported. The test reviewer audits index.ts and ui.ts directly to confirm the function
// bodies match.

console.log("\nformatTokens:");

function formatTokens(count) {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

test("0 tokens", () => eq(formatTokens(0), "0"));
test("999 tokens", () => eq(formatTokens(999), "999"));
test("1000 tokens = 1.0k", () => eq(formatTokens(1000), "1.0k"));
test("9999 tokens = 10.0k (toFixed rounds)", () => eq(formatTokens(9999), "10.0k"));
test("10000 tokens = 10k", () => eq(formatTokens(10000), "10k"));
test("999999 tokens = 1000k", () => eq(formatTokens(999999), "1000k"));
test("1000000 tokens = 1.0M", () => eq(formatTokens(1000000), "1.0M"));
test("9999999 tokens = 10.0M", () => eq(formatTokens(9999999), "10.0M"));
test("10000000 tokens = 10M", () => eq(formatTokens(10000000), "10M"));

// ── Tests: formatStatsLine ──────────────────────────────────────────────────

console.log("\nformatStatsLine:");

function formatStatsLine(stats) {
  const parts = [];
  if (stats.input) parts.push(`\u2191${formatTokens(stats.input)}`);
  if (stats.output) parts.push(`\u2193${formatTokens(stats.output)}`);
  if (stats.cacheRead) parts.push(`R${formatTokens(stats.cacheRead)}`);
  if (stats.cacheWrite) parts.push(`W${formatTokens(stats.cacheWrite)}`);
  if ((stats.cacheRead > 0 || stats.cacheWrite > 0) && stats.latestCacheHitRate !== undefined) {
    parts.push(`CH${stats.latestCacheHitRate.toFixed(1)}%`);
  }
  if (stats.cost) parts.push(`$${stats.cost.toFixed(3)}`);
  return parts.join(" ");
}

test("empty stats (all zeros)", () => eq(formatStatsLine({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, latestCacheHitRate: undefined }), ""));
test("input only", () => eq(formatStatsLine({ input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, latestCacheHitRate: undefined }), "\u2191100"));
test("input and output", () => eq(formatStatsLine({ input: 1500, output: 2000, cacheRead: 0, cacheWrite: 0, cost: 0, latestCacheHitRate: undefined }), "\u21911.5k \u21932.0k"));
test("full breakdown", () => eq(
  formatStatsLine({ input: 5300000, output: 804000, cacheRead: 261000000, cacheWrite: 120000, cost: 18.064, latestCacheHitRate: 99.2 }),
  "\u21915.3M \u2193804k R261M W120k CH99.2% $18.064"
));
test("full breakdown, zero cost", () => {
  const result = formatStatsLine({ input: 5300000, output: 804000, cacheRead: 261000000, cacheWrite: 120000, cost: 0, latestCacheHitRate: 99.2 });
  eq(result, "\u21915.3M \u2193804k R261M W120k CH99.2%");
  eq(result.includes("$"), false, "cost segment should be omitted when cost is 0");
});
test("no CH% when cacheRead=0 and cacheWrite=0", () => {
  const result = formatStatsLine({ input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0, latestCacheHitRate: 99 });
  eq(result.includes("CH"), false, "CH% should be omitted when both cacheRead and cacheWrite are 0");
});
test("no CH% when latestCacheHitRate is undefined", () => {
  const result = formatStatsLine({ input: 1000, output: 500, cacheRead: 100, cacheWrite: 50, cost: 0, latestCacheHitRate: undefined });
  eq(result.includes("CH"), false, "CH% should be omitted when latestCacheHitRate is undefined");
});
test("output-only (no input)", () => eq(formatStatsLine({ input: 0, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0, latestCacheHitRate: undefined }), "\u2193500"));
test("cacheRead-only with rate", () => eq(formatStatsLine({ input: 0, output: 0, cacheRead: 100, cacheWrite: 0, cost: 0, latestCacheHitRate: 80.0 }), "R100 CH80.0%"));

// ── Cleanup ─────────────────────────────────────────────────────────────────

process.on("exit", () => {
  for (const p of CLEANUP) {
    try { fs.unlinkSync(p); } catch {}
  }
  console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
  if (failed > 0) process.exitCode = 1;
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function createTempFile(name, content) {
  const p = path.join(os.tmpdir(), name);
  fs.writeFileSync(p, content);
  return p;
}
