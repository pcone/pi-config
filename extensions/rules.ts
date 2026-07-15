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
  allowLarge: boolean;
}

interface ParsedFrontmatter {
  paths?: string[];
  description?: string;
  disableModelInvocation?: boolean;
}

// ---------------------------------------------------------------------------
// Frontmatter parser
//
// Parses a minimal YAML subset covering our schema. Unknown fields are
// silently ignored.
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---[\r\n]+([\s\S]*?)[\r\n]+---[\r\n]+([\s\S]*)$/;

function parseFrontmatter(content: string): {
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
        fm.paths = arrMatch[1]
          .split(",")
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ""));
      }
      // Otherwise paths will be populated from list items below
    } else if (key === "description") {
      fm.description = val.replace(/^['"]|['"]$/g, "");
    } else if (key === "disable-model-invocation") {
      fm.disableModelInvocation = val === "true" || val === "yes";
    } else {
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

function loadRule(filePath: string, warnings: string[]): Rule | null {
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
    let effectiveLineCount = bodyLines.length;

    if (effectiveLineCount > 100 && !allowLarge) {
      warnings.push(
        `Rule "${path.basename(filePath, ".md")}" (${effectiveLineCount} lines) truncated to 100. Add <!-- allow-large --> to override.`,
      );
      effectiveBody = bodyLines.slice(0, 100).join("\n");
      effectiveBody += `\n\n...(content truncated at 100 lines; full rule is ${effectiveLineCount} lines. Read the file directly to see the full rule.)`;
      effectiveLineCount = 100;
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

    // Warn about degenerate rules (no trigger)
    if (!fm?.paths && !disableModelInvocation) {
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
      lineCount: effectiveLineCount,
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
        const rule = loadRule(resolved);
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
  let rules: Map<string, Rule> = new Map();
  let cwd: string = "";

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
    cwd = ctx.cwd;

    const explicitPaths: string[] = [];
    const ruleFlag = pi.getFlag("rule");
    if (typeof ruleFlag === "string" && ruleFlag.trim()) {
      explicitPaths.push(ruleFlag.trim());
    }

    const noDiscovery = pi.getFlag("no-rules") === true || pi.getFlag("no-rules") === "true";
    const warnings: string[] = [];
    rules = discoverRules(noDiscovery, explicitPaths, cwd, warnings);

    // Surface warnings — UI notification for interactive, console fallback
    if (warnings.length > 0) {
      const text = "[rules] " + warnings.join("; ");
      if (ctx.hasUI) {
        ctx.ui.notify(text, "warning");
      } else {
        console.warn(text);
      }
    }

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

    // Collect matching rules not yet injected this segment
    const matching: Rule[] = [];
    for (const rule of rules.values()) {
      if (rule.disableModelInvocation) continue;
      if (!rule.paths || rule.paths.length === 0) continue;
      if (inScope.has(rule.name)) continue;
      if (matchesAnyGlob(rule.paths, targetPath, cwd)) {
        matching.push(rule);
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
      const sorted = [...rules.values()].sort((a, b) =>
        a.name.localeCompare(b.name),
      );

      for (const r of sorted) {
        const status = inScope.has(r.name) ? " [active]" : "";
        const manual = r.disableModelInvocation ? " [manual]" : "";
        const truncated =
          !r.allowLarge && r.lineCount >= 100 ? " (truncated)" : "";
        const desc = r.description ? ` - ${r.description}` : "";
        const paths = r.paths?.length ? `  paths: ${r.paths.join(", ")}` : "";
        lines.push(
          `  ${r.name}${manual}${status}${desc} (${r.lineCount} lines${truncated})`,
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

      const rule = rules.get(name);
      if (!rule) {
        ctx.ui.notify(`Rule not found: "${name}". Use /rules to list.`, "warning");
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

