#!/usr/bin/env node
/**
 * watch-session — Live multi-pane viewer for async subagent sessions.
 *
 * Usage:  node watch-session.js                # 1-pane, most recent
 *         node watch-session.js <session-id>   # single session
 *         node watch-session.js -r             # auto 3-pane, most recent
 */

const { createConnection } = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

// ── Args ────────────────────────────────────────────────────────────────────

const arg = process.argv[2];
const autoRecent = arg === "-r" || arg === "--recent";

// ── Terminal helpers ────────────────────────────────────────────────────────

const ESC = "\x1b";
const HIDE_CURSOR = ESC + "[?25l";
const SHOW_CURSOR = ESC + "[?25h";
const CLEAR_SCREEN = ESC + "[2J";
const HOME = ESC + "[H";
const CLEAR_LINE = ESC + "\x1b[K";
const ENTER_ALT = ESC + "[?1049h";
const EXIT_ALT = ESC + "[?1049l";

const INVERSE = (s) => ESC + "[7m" + s + ESC + "[27m";
const BOLD = (s) => ESC + "[1m" + s + ESC + "[22m";
const DIM = (s) => ESC + "[2m" + s + ESC + "[22m";

function plainLen(s) {
  return s.replace(/\[[0-9;]*[A-Za-z]/g, "").length;
}

function plainLine(s) {
  return s.replace(/\[[0-9;]*[A-Za-z]/g, "");
}

function truncate(str, width) {
  const visible = plainLen(str);
  if (visible <= width) return str;
  let out = "";
  let v = 0;
  let inAnsi = false;
  for (let i = 0; i < str.length && v < width - 1; i++) {
    if (str[i] === "\u001b" && str[i + 1] === "[") {
      inAnsi = true;
      out += str[i];
    } else if (inAnsi) {
      out += str[i];
      if (/[A-Za-z]/.test(str[i])) inAnsi = false;
    } else {
      out += str[i];
      v++;
    }
  }
  return out + "\u2026\u001b[0m";
}

function padRight(s, width) {
  const len = plainLen(s);
  return s + " ".repeat(Math.max(0, width - len));
}

function timeAgo(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

// ── Discover sessions ───────────────────────────────────────────────────────

const RECENT_WINDOW_MS = 30 * 60 * 1000;

function discoverSessions() {
  /** @type {Array<{id:string, sockPath:string, logPath:string, status:string, mtimeMs:number, order:number}>} */
  const sessions = [];

  // Active sessions (have a socket)
  let sockFiles = [];
  try { sockFiles = fs.readdirSync("/tmp").filter((f) => f.startsWith("pi-subagent-") && f.endsWith(".sock")); } catch {}

  for (const f of sockFiles) {
    const id = f.replace("pi-subagent-", "").replace(".sock", "");
    const sockPath = `/tmp/${f}`;
    const logPath = sockPath.replace(".sock", ".log");
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(logPath).mtimeMs; } catch {}
    try { mtimeMs = Math.max(mtimeMs, fs.statSync(sockPath).mtimeMs); } catch {}
    sessions.push({ id, sockPath, logPath, status: "RUNNING", mtimeMs, order: 0 });
  }

  // Recently finished (log file exists, no socket, modified in last 30 min)
  let logFiles = [];
  try { logFiles = fs.readdirSync("/tmp").filter((f) => f.startsWith("pi-subagent-") && f.endsWith(".log")); } catch {}

  for (const f of logFiles) {
    const id = f.replace("pi-subagent-", "").replace(".log", "");
    const logPath = `/tmp/${f}`;
    const sockPath = logPath.replace(".log", ".sock");
    if (sessions.some((s) => s.id === id)) continue; // already via socket
    let stat = null;
    try { stat = fs.statSync(logPath); } catch { continue; }
    const age = Date.now() - stat.mtimeMs;
    if (age > RECENT_WINDOW_MS) continue;
    const lines = countLines(logPath);
    const done = lines > 0 && fs.readFileSync(logPath, "utf-8").includes("── Completed");
    sessions.push({ id, sockPath, logPath, status: done ? "COMPLETED" : "STOPPED", mtimeMs: stat.mtimeMs, order: 0 });
  }

  // Sort by mtime descending, then add order
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  sessions.forEach((s, i) => { s.order = i + 1; });

  return sessions;
}

function countLines(filePath) {
  try {
    const buf = fs.readFileSync(filePath, "utf-8");
    let n = 0;
    for (const ch of buf) { if (ch === "\n") n++; }
    return n;
  } catch { return 0; }
}

// ── Picker UI ───────────────────────────────────────────────────────────────

function pickSession(sessions) {
  return new Promise((resolve) => {
    let selected = 0;
    let cols = process.stdout.columns || 80;
    let rows = process.stdout.rows || 24;

    function renderPicker() {
      const w = cols;
      let buf = HOME + CLEAR_LINE + INVERSE(padRight("  Select session  |  \u2191\u2193 navigate  |  enter select  |  q quit", w)) + "\r\n";

      const maxItems = rows - 3;
      for (let i = 0; i < Math.min(sessions.length, maxItems); i++) {
        const s = sessions[i];
        const marker = i === selected ? "\x1b[7m" : "";
        const reset = i === selected ? "\x1b[27m" : "";
        const prefix = marker + (i === selected ? " \u25b6 " : "   ") + reset;
        const statusColor = s.status === "RUNNING" ? "\x1b[32m" : s.status === "COMPLETED" ? "\x1b[34m" : "\x1b[33m";
        const idShort = s.id.startsWith("subagent-") ? s.id.slice(9, 17) : s.id.slice(0, 8);
        const line = `${prefix}${statusColor}${s.status.padEnd(10)}\x1b[0m  ${idShort}  ${DIM(timeAgo(Date.now() - s.mtimeMs))}`;
        buf += CLEAR_LINE + truncate(line, w) + "\r\n";
      }

      buf += "\r\n" + CLEAR_LINE + DIM("  " + sessions.length + " sessions found (active + last 30 min)");
      process.stdout.write(buf);
    }

    function onKey(data) {
      const key = data.toString();
      if (key === "q" || key === "\x1b") { cleanupPicker(); process.exit(0); }
      if (key === "\x1b[A" || key === "k") { selected = Math.max(0, selected - 1); renderPicker(); }
      if (key === "\x1b[B" || key === "j") { selected = Math.min(sessions.length - 1, selected + 1); renderPicker(); }
      if (key === "\r" || key === "\n") { cleanupPicker(); resolve(sessions[selected]); }
    }

    function onResize() {
      cols = process.stdout.columns || 80;
      rows = process.stdout.rows || 24;
      renderPicker();
    }

    function cleanupPicker() {
      process.stdin.removeListener("data", onKey);
      process.stdout.removeListener("resize", onResize);
    }

    process.stdin.setRawMode(true);
    process.stdout.write(HIDE_CURSOR + ENTER_ALT + CLEAR_SCREEN);
    process.stdin.on("data", onKey);
    process.stdout.on("resize", onResize);
    renderPicker();
  });
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Fast path: explicit session ID — single pane
  if (arg && !autoRecent) {
    const sockPath = arg.startsWith("/")
      ? arg
      : `/tmp/pi-subagent-${arg.startsWith("subagent-") ? arg : `subagent-${arg}`}.sock`;
    return runSingleViewer(sockPath, arg);
  }

  // Multi-pane mode: discover sessions and build a picker or auto-assign
  let sessions = discoverSessions();
  const running = sessions.filter((s) => s.status === "RUNNING");

  if (running.length === 0) {
    console.error("No running subagent sessions found.");
    process.exit(1);
  }

  // Start with 1 pane showing most recent, or N if -r flag
  const initialCount = autoRecent ? Math.min(running.length, 3) : 1;
  return runMultiViewer(running.slice(0, initialCount).map((s) => s.id), initialCount);
}

// ── Multi-pane viewer ──────────────────────────────────────────────────────

function runMultiViewer(initialIds, initialSplitCount) {
  let splitCount = initialSplitCount;
  let cols = process.stdout.columns || 80;
  let rows = process.stdout.rows || 24;
  let showThinking = true;
  let autoCycle = false;
  let newSessionAlert = false;
  const knownSessions = new Set();

  const MOUSE_SGR_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;

  // Per-pane state
  const panes = [];

  function createPane(sid) {
    const sockPath = sid.startsWith("/")
      ? sid
      : `/tmp/pi-subagent-${sid.startsWith("subagent-") ? sid : `subagent-${sid}`}.sock`;
    const p = {
      sid,
      sockPath,
      lines: [],
      done: false,
      exitCode: 0,
      turns: 0,
      connected: false,
      connectedAt: 0,
      scrollOffset: 0,
      userScrolled: false,
      socket: null,
      rl: null,
    };
    panes.push(p);
    connectPane(p);
    return p;
  }

  // Initialize panes from provided IDs
  for (const id of initialIds) {
    createPane(id);
    knownSessions.add(id);
  }

  // ── Connection ───────────────────────────────────────────────────────

  function connectPane(p) {
    p.socket = createConnection(p.sockPath);
    p.socket.on("connect", () => {
      p.connected = true;
      p.connectedAt = Date.now();
      render();
    });
    p.rl = readline.createInterface({ input: p.socket, crlfDelay: Infinity });
    p.rl.on("line", (line) => {
      p.lines.push(line);
      // Match completion footer — may have ANSI codes at start
      const m = plainLine(line).match(/^── (Completed|Exited|Stopped) \((\d+) turns, exit (\d+)\)/);
      if (m) {
        p.done = true;
        p.exitCode = parseInt(m[3]);
        p.turns = parseInt(m[2]);
      }
      if (!p.userScrolled) {
        p.scrollOffset = Math.max(0, (showThinking ? p.lines : p.lines.filter((l) => !l.includes("[thinking]"))).length - getBodyRows());
      }
      render();
    });
    p.socket.on("close", () => {
      p.connected = false;
      if (!p.done) { p.done = true; p.exitCode = 0; }
      render();
    });
    p.socket.on("error", () => {
      p.connected = false;
      p.done = true;
      p.lines.push("\x1b[31m[connection lost]\x1b[0m");
      render();
    });
  }

  // ── Session management ───────────────────────────────────────────────

  function getAssignedIds() {
    return new Set(panes.map((p) => p.sid));
  }

  function getAvailableSessions() {
    const assigned = getAssignedIds();
    return discoverSessions().filter((s) => s.status === "RUNNING" && !assigned.has(s.id));
  }

  function cyclePaneSession(paneIdx) {
    if (paneIdx >= panes.length) return;
    const available = getAvailableSessions();
    if (available.length === 0) {
      // If nothing else available, leave as-is
      return;
    }
    const p = panes[paneIdx];
    // Close old connection
    try { p.rl.close(); } catch {}
    try { p.socket.destroy(); } catch {}
    // Pick first available
    p.sid = available[0].id;
    p.sockPath = available[0].sockPath;
    p.lines = [];
    p.done = false;
    p.connected = false;
    p.connectedAt = 0;
    p.scrollOffset = 0;
    p.userScrolled = false;
    p.turns = 0;
    p.exitCode = 0;
    connectPane(p);
    render();
  }

  function refreshPanes() {
    const sessions = discoverSessions().filter((s) => s.status === "RUNNING");
    // Close all
    for (const p of panes) {
      try { p.rl.close(); } catch {}
      try { p.socket.destroy(); } catch {}
    }
    panes.length = 0;
    // Reassign from most recent
    const count = Math.min(sessions.length, splitCount);
    for (let i = 0; i < count; i++) {
      createPane(sessions[i].id);
    }
    splitCount = count;
    render();
  }

  function setSplitCount(n) {
    n = Math.max(1, Math.min(n, 9));
    if (n === splitCount) return;
    if (n > panes.length) {
      // Add panes
      const available = getAvailableSessions();
      for (let i = panes.length; i < n && available.length > 0; i++) {
        const s = available.shift();
        createPane(s.id);
      }
    } else if (n < panes.length) {
      // Remove panes
      while (panes.length > n) {
        const p = panes.pop();
        try { p.rl.close(); } catch {}
        try { p.socket.destroy(); } catch {}
      }
    }
    splitCount = Math.max(1, panes.length);
    render();
  }

  // ── Render helpers ───────────────────────────────────────────────────

  function getBodyRows() {
    if (panes.length === 0) return 5;
    const paneHeader = 1;
    const separator = 0; // we use dimmed line separator between panes
    const totalOverhead = panes.length * paneHeader + (panes.length - 1) * separator + 1; // +1 for global footer
    return Math.max(3, Math.floor((rows - totalOverhead - 1) / panes.length));
  }

  function renderPaneHeader(p, w) {
    const elapsed = p.connectedAt ? Math.round((Date.now() - p.connectedAt) / 1000) : 0;
    const sStr = p.done
      ? p.exitCode === 0 ? "COMPLETED" : `EXIT ${p.exitCode}`
      : p.connected ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : "connecting";
    const idShort = p.sid.startsWith("subagent-") ? p.sid.slice(9, 17) : p.sid.slice(0, 8);
    const tStr = p.turns > 0 ? ` | ${p.turns}t` : "";
    return INVERSE(padRight(` ${idShort}  |  ${sStr}${tStr}`, w));
  }

  // ── Render ───────────────────────────────────────────────────────────

  function render() {
    const w = cols;
    const bodyRows = getBodyRows();
    let buf = HOME;

    for (let pi = 0; pi < panes.length; pi++) {
      const p = panes[pi];

      // Pane header
      buf += CLEAR_LINE + renderPaneHeader(p, w) + "\r\n";

      // Pane body with scroll
      let filtered = showThinking ? p.lines : p.lines.filter((l) => !l.includes("[thinking]"));
      const maxScroll = Math.max(0, filtered.length - bodyRows);
      p.scrollOffset = Math.max(0, Math.min(p.scrollOffset, maxScroll));

      let startIdx;
      if (p.userScrolled) {
        startIdx = p.scrollOffset;
      } else {
        startIdx = maxScroll;
        p.scrollOffset = maxScroll;
      }
      const visible = filtered.slice(startIdx, startIdx + bodyRows);

      for (let i = 0; i < bodyRows; i++) {
        let line = i < visible.length ? visible[i] : "";
        if (line && p.done) line = "\x1b[2m" + line;
        buf += CLEAR_LINE + truncate(" " + line.replace(/^ {0,2}/, ""), w) + "\r\n";
      }

      // Separator between panes
      if (pi < panes.length - 1) {
        buf += CLEAR_LINE + DIM("─".repeat(w)) + "\r\n";
      }
    }

    // Global footer
    const thinkT = showThinking ? "[t] thinking" : "[t] hidden";
    const cycleT = autoCycle ? "[c] auto-cycle*" : "[c] auto-cycle";
    const alertH = newSessionAlert ? " ⚡ NEW SESSION " : "";
    const refreshH = "[r] refresh";
    const countH = "[1-" + panes.length + "] panes";
    const footer = ` ${thinkT}  ${cycleT}  ${refreshH}  ${countH}  [shift+N] cycle  [g] bottom  [q] quit` + alertH;
    buf += CLEAR_LINE + INVERSE(padRight(footer, w));

    // Flash alert — reset after render
    if (newSessionAlert) {
      newSessionAlert = false;
      setTimeout(() => render(), 500); // re-render to flash off/on
    }

    process.stdout.write(buf);
  }

  // ── Input ────────────────────────────────────────────────────────────

  function cleanup() {
    process.stdout.write(SHOW_CURSOR + "\x1b[?1000l\x1b[?1006l" + EXIT_ALT + "\n");
    process.exit(0);
  }

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  process.stdin.setRawMode(true);
  process.stdout.write(HIDE_CURSOR + "\x1b[?1000h\x1b[?1006h" + ENTER_ALT + CLEAR_SCREEN);

  process.stdout.on("resize", () => {
    cols = process.stdout.columns || 80;
    rows = process.stdout.rows || 24;
    render();
  });

  process.stdin.on("data", (data) => {
    const s = data.toString();

    // Mouse scroll — route to focused pane (first one by default)
    const mm = s.match(MOUSE_SGR_RE);
    if (mm) {
      const button = parseInt(mm[1]);
      const row = parseInt(mm[3]);
      const scrollDelta = button === 64 ? -3 : button === 65 ? 3 : 0;
      if (scrollDelta !== 0) {
        // Find which pane the click is in
        const bodyR = getBodyRows();
        let acc = 1; // header
        let targetIdx = 0;
        for (let i = 0; i < panes.length; i++) {
          acc += bodyR + (i < panes.length - 1 ? 1 : 0); // body rows + separator
          if (row <= acc) { targetIdx = i; break; }
        }
        if (targetIdx < panes.length) {
          const p = panes[targetIdx];
          p.scrollOffset = Math.max(0, p.scrollOffset + scrollDelta);
          p.userScrolled = true;
          const filtered = showThinking ? p.lines : p.lines.filter((l) => !l.includes("[thinking]"));
          if (p.scrollOffset >= filtered.length - bodyR) {
            p.userScrolled = false;
          }
          render();
        }
        return;
      }
    }

    // Keyboard
    if (s === "q" || s === "\x1b") cleanup();
    if (s === "t") { showThinking = !showThinking; render(); }
    if (s === "c") { autoCycle = !autoCycle; if (autoCycle) doAutoCycle(); render(); }
    if (s === "r") { refreshPanes(); }
    if (s === "g") {
      for (const p of panes) { p.userScrolled = false; }
      render();
    }
    // Numeric: set split count
    if (/^[1-9]$/.test(s)) { setSplitCount(parseInt(s)); }
    // Shift+Numeric: cycle pane
    if (s.length > 1 && s[0] === "\x1b") {
      // Shift+number sends different sequences depending on terminal
      // Ghostty: Shift+1 = "!", Shift+2 = "@", etc. Let's handle both
    }
    // Raw shifted numbers (Ghostty sends the shifted char in raw mode)
    if (s === "!") cyclePaneSession(0);
    if (s === "@") cyclePaneSession(1);
    if (s === "#") cyclePaneSession(2);
    if (s === "$") cyclePaneSession(3);
    if (s === "%") cyclePaneSession(4);
    if (s === "^") cyclePaneSession(5);
    if (s === "&") cyclePaneSession(6);
    if (s === "*") cyclePaneSession(7);
    if (s === "(") cyclePaneSession(8);
  });

  function doAutoCycle() {
    const sessions = discoverSessions();
    const running = sessions.filter((s) => s.status === "RUNNING");
    const assigned = new Set(panes.map((p) => p.sid));
    const unassigned = running.filter((s) => !assigned.has(s.id));
    // Update known set for new-session alert
    for (const s of running) knownSessions.add(s.id);

    for (const s of unassigned) {
      // Try to place in a completed pane
      const deadIdx = panes.findIndex((p) => p.done);
      if (deadIdx >= 0) {
        const p = panes[deadIdx];
        try { p.rl.close(); } catch {}
        try { p.socket.destroy(); } catch {}
        p.sid = s.id;
        p.sockPath = s.sockPath;
        p.lines = [];
        p.done = false;
        p.connected = false;
        p.connectedAt = 0;
        p.scrollOffset = 0;
        p.userScrolled = false;
        p.turns = 0;
        p.exitCode = 0;
        connectPane(p);
      } else {
        // No completed pane — flash alert
        newSessionAlert = true;
        break; // only flash once per scan
      }
    }
  }

  const tick = setInterval(() => {
    if (autoCycle) doAutoCycle();
    render();
  }, 5000);
  render();
}

// ── Single-pane fallback ───────────────────────────────────────────────────

function runSingleViewer(sockPath, sid) {
  // Create multi-viewer with one pane
  runMultiViewer([sid], 1);
}

if (require.main === module) {
  main().catch((err) => {
    process.stdout.write(SHOW_CURSOR + EXIT_ALT + "\n");
    console.error(err.message);
    process.exit(1);
  });
} else {
  module.exports = {
    discoverSessions,
    truncate,
    plainLen,
    padRight,
    timeAgo,
    countLines,
    RECENT_WINDOW_MS,
  };
}
