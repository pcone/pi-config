/**
 * Path-Scoped Rules Extension
 *
 * Injects rule context into the agent's working set based on file path.
 * Rules live in .pi/rules/ and .claude/rules/ as markdown files with
 * optional YAML frontmatter.
 *
 * Two rule modes:
 *   Path-triggered  — has `paths` field in frontmatter. Injects on first
 *                     read/edit/write of a matching file.
 *   Manual-only     — has `disable-model-invocation: true`. Only enters
 *                     conversation via /rule <name>.
 *
 * Design: docs/design/rules.md
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import picomatch from "picomatch";

const STARTUP_SUMMARY_EVENT = "pi-config:startup-summary-item";

// Rules inject on first touch of a matching path; the caps keep one rule from crowding out the
// task. Warn at WARN so the squeeze is visible while writing, truncate at MAX so a rule that grew
// unchecked still loads. Prefer trimming to `<!-- allow-large -->`, which lifts both.
const WARN_RULE_LINES = 150;
const MAX_RULE_LINES = 200;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Rule {
  name: string;
  filePath: string;
  /** Glob patterns from frontmatter. Undefined for manual-only rules without paths. */
  paths: string[] | undefined;
  description: string;
  disableModelInvocation: boolean;
  body: string;
  lineCount: number;
  /** Body was longer than the cap and got truncated (allow-large not set). */
  truncated: boolean;
  allowLarge: boolean;
}

interface ParsedFrontmatter {
  paths?: string[];
  description?: string;
  disableModelInvocation?: boolean;
  /** Known fields from another harness's dialect (Cursor's `globs`/`alwaysApply`). */
  foreignFields?: string[];
}

// ---------------------------------------------------------------------------
// Frontmatter parser
//
// Parses a minimal YAML subset covering our schema. Unknown fields are
// silently ignored; known foreign dialects are recorded for a warning.
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---[\r\n]+([\s\S]*?)[\r\n]+---[\r\n]+([\s\S]*)$/;

export function parseFrontmatter(content: string): {
  frontmatter: ParsedFrontmatter | null;
  body: string;
} {
  const m = content.match(FRONTMATTER_RE);
  if (!m) return { frontmatter: null, body: content };

  const yamlText = m[1];
  const body = m[2];

  const fm: ParsedFrontmatter = {};
  let currentKey: string | null = null;

  for (const rawLine of yamlText.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // List item under the current key
    if (line.startsWith("- ") && currentKey !== null) {
      const val = line.slice(2).trim().replace(/^['"]|['"]$/g, "");
      if (currentKey === "paths") {
        if (!fm.paths) fm.paths = [];
        fm.paths.push(val);
      }
      continue;
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      currentKey = null;
      continue;
    }

    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    currentKey = key;

    if (key === "paths") {
      // Handle inline array: paths: ["**/*.tfd"]
      const arrMatch = val.match(/^\[(.*)\]$/);
      if (arrMatch) {
        // `paths: []` is an explicit no-op, not a one-element [""] list
        fm.paths = arrMatch[1].trim()
          ? arrMatch[1]
              .split(",")
              .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
          : [];
      } else if (val) {
        // Scalar form: paths: "**/*.tfd" — Claude Code accepts this shape too
        fm.paths = [val.replace(/^['"]|['"]$/g, "")];
      }
      // Bare `paths:` — populated from list items below
    } else if (key === "description") {
      fm.description = val.replace(/^['"]|['"]$/g, "");
    } else if (key === "disable-model-invocation") {
      fm.disableModelInvocation = val === "true" || val === "yes";
    } else {
      // Record known foreign dialects (Cursor) so loadRule can warn precisely
      if (key === "globs" || key === "alwaysApply") {
        (fm.foreignFields ??= []).push(key);
      }
      // Unknown key — don't collect stray list items under it
      currentKey = null;
    }
  }

  // Strip negation patterns with a warning
  if (fm.paths) {
    const negated = fm.paths.filter((p) => p.startsWith("!"));
    if (negated.length > 0) {
      console.warn(
        `[rules] Negation patterns not supported in v1, stripping: ${negated.join(", ")}`,
      );
      fm.paths = fm.paths.filter((p) => !p.startsWith("!"));
    }
  }

  return { frontmatter: fm, body };
}

// ---------------------------------------------------------------------------
// Rule loading
// ---------------------------------------------------------------------------

function findMarkdownFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }
  return results;
}

export function loadRule(filePath: string, warnings: string[]): Rule | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const { frontmatter: fm, body } = parseFrontmatter(content);

    if (!body.trim()) {
      warnings.push(`Skipping empty rule: ${filePath}`);
      return null;
    }

    const bodyLines = body.split("\n");
    const firstNonEmpty = bodyLines.find((l) => l.trim());
    const allowLarge =
      firstNonEmpty?.trim() === "<!-- allow-large -->";

    let effectiveBody = body;
    // Full line count before any truncation: what /rules reports, so a
    // truncated rule shows its real size and the (truncated) marker is
    // reachable (lineCount used to be clamped to the cap, hiding both).
    const totalLineCount = bodyLines.length;
    let truncated = false;

    if (
      !allowLarge &&
      totalLineCount > WARN_RULE_LINES &&
      totalLineCount <= MAX_RULE_LINES
    ) {
      warnings.push(
        `Rule "${path.basename(filePath, ".md")}" is ${totalLineCount} lines; trim it before ${MAX_RULE_LINES}`,
      );
    }

    if (totalLineCount > MAX_RULE_LINES && !allowLarge) {
      warnings.push(
        `Rule "${path.basename(filePath, ".md")}" (${totalLineCount} lines) truncated to ${MAX_RULE_LINES}. Add <!-- allow-large --> to override.`,
      );
      effectiveBody = bodyLines.slice(0, MAX_RULE_LINES).join("\n");
      effectiveBody += `\n\n...(content truncated at ${MAX_RULE_LINES} lines; full rule is ${totalLineCount} lines. Read the file directly to see the full rule.)`;
      truncated = true;
    }

    const name = path.basename(filePath, ".md");

    let description = fm?.description;
    if (!description) {
      const heading = bodyLines.find((l) => l.trim().startsWith("# "));
      description = heading
        ? heading.trim().replace(/^#+\s*/, "")
        : name;
    }

    const disableModelInvocation =
      fm?.disableModelInvocation ?? false;

    // Warn about a foreign dialect (Cursor's globs/alwaysApply) before the
    // generic no-trigger warning — the fix is a field rename, not a new trigger
    const foreign = fm?.foreignFields ?? [];
    if (foreign.length > 0) {
      const fixes: string[] = [];
      if (foreign.includes("globs")) fixes.push("rename `globs` to `paths`");
      if (foreign.includes("alwaysApply"))
        fixes.push(
          "`alwaysApply` has no pi equivalent — always-on instructions belong in AGENTS.md/APPEND_SYSTEM.md; use `paths` or `disable-model-invocation: true`",
        );
      warnings.push(
        `Rule "${name}" uses Cursor-style frontmatter (${foreign.join(", ")}); ${fixes.join("; ")}.`,
      );
    } else if (!fm?.paths?.length && !disableModelInvocation) {
      warnings.push(
        `Rule "${name}" has no paths field and is not manual-only — never triggers. Add paths or set disable-model-invocation: true.`,
      );
    }

    return {
      name,
      filePath,
      paths: fm?.paths,
      description,
      disableModelInvocation,
      body: effectiveBody,
      lineCount: totalLineCount,
      truncated,
      allowLarge,
    };
  } catch (err) {
    warnings.push(`Error loading rule from ${filePath}: ${err}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rule discovery
// ---------------------------------------------------------------------------

const RULE_DIRS_PRIORITY = (
  cwd: string,
): Array<{ dir: string; label: string }> => {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return [
    // Project-level (higher precedence)
    { dir: path.join(cwd, ".pi", "rules"), label: "project/.pi/rules" },
    { dir: path.join(cwd, ".claude", "rules"), label: "project/.claude/rules" },
    // User-level (lower precedence)
    ...(home
      ? [
          { dir: path.join(home, ".pi", "agent", "rules"), label: "user/.pi/agent/rules" },
          { dir: path.join(home, ".claude", "rules"), label: "user/.claude/rules" },
        ]
      : []),
  ];
};

function discoverRules(
  noDiscovery: boolean,
  explicitPaths: string[],
  cwd: string,
  warnings: string[],
): Map<string, Rule> {
  const rules = new Map<string, Rule>();
  const seenNames = new Set<string>();

  const add = (dir: string, _label: string) => {
    for (const filePath of findMarkdownFiles(dir)) {
      const rule = loadRule(filePath, warnings);
      if (rule && !seenNames.has(rule.name)) {
        seenNames.add(rule.name);
        rules.set(rule.name, rule);
      }
    }
  };

  // Priority order: first-seen wins
  if (!noDiscovery) {
    for (const { dir, label } of RULE_DIRS_PRIORITY(cwd)) {
      add(dir, label);
    }
  }

  // Explicit --rule paths come last but beat discovery precedence
  // by being loaded after discovery, so they override on name collision.
  // Actually: design says "explicit beats discovery" so we add them last.
  for (const p of explicitPaths) {
    const resolved = path.resolve(cwd, p);
    if (fs.existsSync(resolved)) {
      if (fs.statSync(resolved).isDirectory()) {
        add(resolved, `--rule ${p}`);
      } else {
        const rule = loadRule(resolved, warnings);
        if (rule) {
          // Override if name exists from discovery
          seenNames.add(rule.name);
          rules.set(rule.name, rule);
        }
      }
    } else {
      console.warn(`[rules] --rule path not found: ${resolved}`);
    }
  }

  return rules;
}

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

function matchesAnyGlob(
  patterns: string[],
  filePath: string,
  cwd: string,
): boolean {
  if (patterns.length === 0) return false;

  const normalized = filePath.replace(/\\/g, "/");
  const relative = path.relative(cwd, normalized).replace(/\\/g, "/");

  try {
    const matcher = picomatch(patterns, { bash: true });
    return matcher(normalized) || matcher(relative);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------

/**
 * Re-read a rule from disk immediately before it is injected. Discovery is a
 * snapshot taken at session start, but a session can outlive an edit to a rule
 * it has not injected yet, and a rule fix that only reaches the next process
 * start is a dead fix. Returns null when the file no longer yields a rule
 * (missing, unreadable, emptied) — nothing stale is ever injected.
 */
function refreshRule(rule: Rule): Rule | null {
  return loadRule(rule.filePath, []);
}

/** Build the text block appended to a tool result. */
function buildInjection(rules: Rule[]): string {
  const blocks = rules.map((r) => {
    const pathsAttr = r.paths?.length ? ` paths="${r.paths.join(", ")}"` : "";
    return `<rule name="${r.name}"${pathsAttr}>\n${r.body}\n</rule>`;
  });
  return `\n---\n${blocks.join("\n\n")}\n`;
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function rulesExtension(pi: ExtensionAPI) {
  const inScope = new Set<string>();
  const dropped = new Set<string>();
  let rules: Map<string, Rule> = new Map();
  let cwd: string = "";
  let noDiscovery = false;
  let explicitPaths: string[] = [];

  /** Re-run discovery. `announce` is startup-only: a compact refreshes silently. */
  const rediscover = (announce: boolean, ctx?: any): void => {
    const warnings: string[] = [];
    rules = discoverRules(noDiscovery, explicitPaths, cwd, warnings);
    if (warnings.length === 0) return;
    const text = "[rules] " + warnings.join("; ");
    if (announce && ctx?.hasUI) {
      ctx.ui.notify(text, "warning");
    } else {
      console.warn(text);
    }
  };

  // ------------------------------------------------------------------
  // Flags
  // ------------------------------------------------------------------

  pi.registerFlag("no-rules", {
    description: "Disable automatic rule discovery",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("rule", {
    description: "Load an additional rule file or directory: --rule <path>",
    type: "string",
  });

  // ------------------------------------------------------------------
  // Session start — discover rules
  // ------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    inScope.clear();
    dropped.clear();
    cwd = ctx.cwd;

    explicitPaths = [];
    const ruleFlag = pi.getFlag("rule");
    if (typeof ruleFlag === "string" && ruleFlag.trim()) {
      explicitPaths.push(ruleFlag.trim());
    }

    noDiscovery = pi.getFlag("no-rules") === true || pi.getFlag("no-rules") === "true";
    rediscover(true, ctx);

    if (rules.size > 0) {
      const ruleNames = Array.from(rules.keys()).sort();
      const text = `[Rules] ${rules.size} loaded: ${ruleNames.join(", ")}. /rules to list, /rule <name> to read.`;
      pi.events.emit(STARTUP_SUMMARY_EVENT, { key: "rules", order: 10, text });
    }
  });

  // ------------------------------------------------------------------
  // tool_result — inject path-triggered rules on first touch
  // ------------------------------------------------------------------

  pi.on("tool_result", async (event) => {
    if (
      event.toolName !== "read" &&
      event.toolName !== "edit" &&
      event.toolName !== "write"
    ) {
      return;
    }

    if (event.isError) return;

    // All three tools supply `path` in their input
    const targetPath: unknown = event.input?.path;
    if (typeof targetPath !== "string" || !targetPath) return;

    // Collect matching rules not yet injected this segment. Each candidate is
    // re-read from disk first: a rule edited since discovery must inject its
    // current body (and current paths), and a rule file deleted since discovery
    // must not inject at all.
    const matching: Rule[] = [];
    for (const rule of rules.values()) {
      if (inScope.has(rule.name)) continue;

      const fresh = refreshRule(rule);
      if (!fresh) {
        if (!dropped.has(rule.name)) {
          dropped.add(rule.name);
          console.warn(
            `[rules] Rule "${rule.name}" no longer loads from ${rule.filePath}; not injecting it.`,
          );
        }
        continue;
      }

      if (fresh.disableModelInvocation) continue;
      if (!fresh.paths || fresh.paths.length === 0) continue;
      if (matchesAnyGlob(fresh.paths, targetPath, cwd)) {
        matching.push(fresh);
      }
    }

    if (matching.length === 0) return;

    // Alphabetical injection order
    matching.sort((a, b) => a.name.localeCompare(b.name));
    for (const rule of matching) inScope.add(rule.name);

    const injectionText = buildInjection(matching);

    return {
      content: [...event.content, { type: "text" as const, text: injectionText }],
    };
  });

  // ------------------------------------------------------------------
  // session_compact — clear in-scope set
  // ------------------------------------------------------------------

  pi.on("session_compact", async () => {
    inScope.clear();
    dropped.clear();
    // Re-read from disk: files added, edited or removed since session start
    // reach the new segment. Silent — a compact is not a startup.
    rediscover(false);
  });

  // ------------------------------------------------------------------
  // /rules command
  // ------------------------------------------------------------------

  pi.registerCommand("rules", {
    description: "List all available rules",
    handler: async (_args, ctx) => {
      if (rules.size === 0) {
        ctx.ui.notify("No rules found.", "info");
        return;
      }

      const lines: string[] = [];
      // Display fresh facts, not the discovery snapshot: line counts and cap
      // markers must describe the file as it is now (a rule can grow or be
      // deleted mid-session).
      const sorted = [...rules.values()]
        .map((snapshot) => ({ snapshot, fresh: refreshRule(snapshot) }))
        .sort((a, b) => a.snapshot.name.localeCompare(b.snapshot.name));

      for (const { snapshot, fresh } of sorted) {
        const r = fresh ?? snapshot;
        const status = inScope.has(r.name) ? " [active]" : "";
        const manual = r.disableModelInvocation ? " [manual]" : "";
        const suffix = fresh === null
          ? " (no longer loads)"
          : r.truncated
            ? " (truncated)"
            : r.lineCount > WARN_RULE_LINES
              ? " (near cap)"
              : "";
        const desc = r.description ? ` - ${r.description}` : "";
        const paths = r.paths?.length ? `  paths: ${r.paths.join(", ")}` : "";
        lines.push(
          `  ${r.name}${manual}${status}${desc} (${r.lineCount} lines${suffix})`,
        );
        if (paths) lines.push(paths);
      }

      ctx.ui.notify(
        `Rules (${sorted.length}):\n${lines.join("\n")}`,
        "info",
      );
    },
  });

  // ------------------------------------------------------------------
  // /rule <name> command
  // ------------------------------------------------------------------

  pi.registerCommand("rule", {
    description: "Read a rule by name: /rule <name>",
    handler: async (args, ctx) => {
      const name = args.trim();
      if (!name) {
        ctx.ui.notify("Usage: /rule <rule_name>", "warning");
        return;
      }

      const snapshot = rules.get(name);
      if (!snapshot) {
        ctx.ui.notify(`Rule not found: "${name}". Use /rules to list.`, "warning");
        return;
      }

      // Manual injection is an injection: serve the body on disk now, not the
      // discovery snapshot. A rule that no longer loads injects nothing and is
      // left out of the in-scope set so it can recover if the file returns.
      const rule = refreshRule(snapshot);
      if (!rule) {
        ctx.ui.notify(
          `Rule "${name}" no longer loads from ${snapshot.filePath} — not injecting it.`,
          "warning",
        );
        return;
      }

      inScope.add(rule.name);

      const pathsAttr = rule.paths?.length
        ? ` paths="${rule.paths.join(", ")}"`
        : "";
      const body = `<rule name="${rule.name}"${pathsAttr}>\n${rule.body}\n</rule>`;

      ctx.ui.notify(`Injected rule: ${rule.name}`, "info");

      pi.sendUserMessage(
        `[Manual rule injection: ${rule.name}]\n${body}`,
      );
    },
  });

}

