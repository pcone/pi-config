/**
 * Model Tiers — prints an OpenRouter benchmark price/performance tier table
 * on session start. Data is fetched from OpenRouter's API and cached for
 * 24 hours to avoid rate limiting.
 *
 * Startup: 2D Pareto (avg score × cost) with thresholds — compact tier picks.
 * /tiers:  3D Pareto (avg score × cost × multimodal) — full frontier, no thresholds.
 *
 * Pricing assumes 98% cache hit, 90/10 input/output split.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BenchmarkEntry {
  source: string;
  model_permaslug: string;
  display_name: string;
  intelligence_index: number | null;
  coding_index: number | null;
  agentic_index: number | null;
  pricing: { prompt: string; completion: string } | null;
}

interface ModelInfo {
  id: string;
  canonical_slug?: string;
  hugging_face_id?: string | null;
  context_length?: number;
  architecture?: { modality?: string };
  pricing?: {
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
    input_cache_write?: string;
  };
}

interface BenchmarksResponse {
  data: BenchmarkEntry[];
}

interface ModelsResponse {
  data: ModelInfo[];
}

interface ScoredModel {
  name: string;
  slug: string;
  avg: number;
  intelligence: number;
  coding: number;
  agentic: number;
  blendedCost: number;
  promptPrice: number;
  completionPrice: number;
  cacheRead: number;
  valueScore: number;
  multimodal: boolean;
  contextTier: number; // 4=1M+, 3=500K+, 2=200K+, 1=<200K
}

interface CacheData {
  fetchedAt: number;
  benchmarks: BenchmarksResponse;
  models: ModelsResponse;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_DIR = resolve(homedir(), ".pi", "cache", "model-tiers");
const CACHE_FILE = join(CACHE_DIR, "cache.json");
const CACHE_TTL_MS = 72 * 60 * 60 * 1000;

// Sweep stale cache files older than CACHE_TTL_MS on each pi startup.
// Cleanup runs only here — no periodic or close-time sweeps.
try {
  mkdirSync(CACHE_DIR, { recursive: true });
  const now = Date.now();
  for (const f of readdirSync(CACHE_DIR)) {
    const fp = join(CACHE_DIR, f);
    try {
      if (now - statSync(fp).mtimeMs > CACHE_TTL_MS) rmSync(fp);
    } catch { /* race with concurrent removal */ }
  }
} catch { /* dir may not exist yet */ }

const THRESHOLDS = {
  intelligence: 40,
  coding: 56,
  agentic: 30,
};

const CACHE_HIT_RATE = 0.98;
const MISS_RATE = 0.02;
const INPUT_RATIO = 0.90;
const OUTPUT_RATIO = 0.10;

// ---------------------------------------------------------------------------
// Tier definitions
// ---------------------------------------------------------------------------

interface Tier {
  name: string;
  lo: number;
  hi: number;
}

const TIERS: Tier[] = [
  { name: "Tier 1 · Flagship", lo: 95, hi: 100 },
  { name: "Tier 2 · Upper Frontier", lo: 85, hi: 94.9 },
  { name: "Tier 3 · Lower Frontier", lo: 78, hi: 84.9 },
  { name: "Tier 4 · High Value", lo: 65, hi: 77.9 },
  { name: "Tier 5 · Budget", lo: 0, hi: 64.9 },
];

// ---------------------------------------------------------------------------
// Key resolution
// ---------------------------------------------------------------------------

function getOpenRouterKey(): string | undefined {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const key = execSync(
      "security find-generic-password -ws 'pi-openrouter' 2>/dev/null",
      { encoding: "utf-8", timeout: 3000 },
    ).trim();
    if (key) return key;
  } catch { /* keychain failed */ }
  try {
    const authRaw = readFileSync(
      join(process.env.HOME || "~", ".pi", "agent", "auth.json"),
      "utf-8",
    );
    const auth = JSON.parse(authRaw);
    const orCred = auth.openrouter;
    if (orCred?.type === "api_key" && orCred.key) {
      const k = orCred.key;
      if (!k.startsWith("!") && !k.startsWith("$")) return k;
      if (k.startsWith("$")) {
        const envName = k.slice(1).replace(/[${}]/g, "");
        if (process.env[envName]) return process.env[envName];
      }
    }
  } catch { /* auth.json not readable */ }
  return undefined;
}

// ---------------------------------------------------------------------------
// Data fetching with cache
// ---------------------------------------------------------------------------

function loadCache(): CacheData | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const raw = readFileSync(CACHE_FILE, "utf-8");
    const cache = JSON.parse(raw) as CacheData;
    const age = Date.now() - cache.fetchedAt;
    if (age > CACHE_TTL_MS) return null;
    if (!cache.benchmarks?.data || !cache.models?.data) return null;
    return cache;
  } catch {
    return null;
  }
}

function saveCache(data: CacheData): void {
  try {
    const dir = dirname(CACHE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
  } catch { /* silently fail */ }
}

async function fetchBenchmarks(key: string): Promise<BenchmarksResponse> {
  const res = await fetch(
    "https://openrouter.ai/api/v1/benchmarks?source=artificial-analysis",
    { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } },
  );
  if (!res.ok) throw new Error(`Benchmarks fetch failed: ${res.status}`);
  return (await res.json()) as BenchmarksResponse;
}

async function fetchModels(): Promise<ModelsResponse> {
  const res = await fetch("https://openrouter.ai/api/v1/models");
  if (!res.ok) throw new Error(`Models fetch failed: ${res.status}`);
  return (await res.json()) as ModelsResponse;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function normValue(value: number, min: number, max: number): number {
  const range = max - min;
  return range > 0 ? (value - min) / range : 0;
}

/** Build a model lookup from the /v1/models response. */
function buildLookup(models: ModelsResponse): Map<string, ModelInfo> {
  const map = new Map<string, ModelInfo>();
  for (const m of models.data) {
    if (m.canonical_slug) map.set(m.canonical_slug, m);
    if (m.id) map.set(m.id, m);
  }
  return map;
}

/** Check whether a model has open weights (hugging_face_id is non-null). */
function isOpenWeights(mi: ModelInfo | undefined): boolean {
  return !!(mi?.hugging_face_id);
}

/** Check whether a model supports image input. */
function isMultimodal(mi: ModelInfo | undefined): boolean {
  const mod = mi?.architecture?.modality ?? "";
  return mod.includes("image");
}

/** Quantize context window size into comparable tiers. */
function contextTier(mi: ModelInfo | undefined): number {
  const ctx = mi?.context_length ?? 0;
  return ctx >= 1_000_000 ? 2 : 1;  // 1M+ vs below
}

/** 3D: avg, multimodal, cost. Used for /tiers. */
function paretoFilter3D(models: ScoredModel[]): ScoredModel[] {
  return models.filter((a) => {
    for (const b of models) {
      if (
        b.avg > a.avg &&
        (b.multimodal ? 1 : 0) > (a.multimodal ? 1 : 0) &&
        b.blendedCost < a.blendedCost
      )
        return false;
    }
    return true;
  });
}

/** Compute global min/max for each AA index across all benchmarked models. */
function computeBounds(benchmarks: BenchmarksResponse) {
  let iMin = Infinity, iMax = -Infinity;
  let cMin = Infinity, cMax = -Infinity;
  let aMin = Infinity, aMax = -Infinity;
  for (const b of benchmarks.data) {
    const i = b.intelligence_index, c = b.coding_index, a = b.agentic_index;
    if (i != null && c != null && a != null) {
      iMin = Math.min(iMin, i); iMax = Math.max(iMax, i);
      cMin = Math.min(cMin, c); cMax = Math.max(cMax, c);
      aMin = Math.min(aMin, a); aMax = Math.max(aMax, a);
    }
  }
  return { iMin, iMax, cMin, cMax, aMin, aMax };
}

// @for-testing-only — export is safe; scoreModels is pure (no IO, no pi globals)
export function scoreModels(benchmarks: BenchmarksResponse, models: ModelsResponse): ScoredModel[] {
  const lookup = buildLookup(models);
  const bnd = computeBounds(benchmarks);
  const results: ScoredModel[] = [];

  for (const b of benchmarks.data) {
    const intelligence = b.intelligence_index ?? 0;
    const coding = b.coding_index ?? 0;
    const agentic = b.agentic_index ?? 0;
    if (
      intelligence < THRESHOLDS.intelligence ||
      coding < THRESHOLDS.coding ||
      agentic < THRESHOLDS.agentic
    )
      continue;

    const avg =
      ((normValue(intelligence, bnd.iMin, bnd.iMax) +
        normValue(coding, bnd.cMin, bnd.cMax) +
        normValue(agentic, bnd.aMin, bnd.aMax)) /
        3) *
      100;

    const mi = lookup.get(b.model_permaslug);
    const p = mi?.pricing ?? {};
    const promptPrice = parseFloat(p.prompt ?? "0") || 0;
    const completionPrice = parseFloat(p.completion ?? "0") || 0;
    const cacheRead = parseFloat(p.input_cache_read ?? "0") || 0;
    const effectiveInput =
      cacheRead > 0
        ? MISS_RATE * promptPrice + CACHE_HIT_RATE * cacheRead
        : promptPrice;
    const blended = effectiveInput * INPUT_RATIO + completionPrice * OUTPUT_RATIO;
    const valueScore = blended > 0 ? avg / (blended * 1e6) : Infinity;

    results.push({
      name: b.display_name,
      slug: b.model_permaslug,
      avg,
      intelligence,
      coding,
      agentic,
      blendedCost: blended,
      promptPrice,
      completionPrice,
      cacheRead,
      valueScore,
      multimodal: isMultimodal(mi),
      contextTier: contextTier(mi),
    });
  }

  results.sort((a, b) => b.avg - a.avg);
  return results;
}

function scoreAllModels(benchmarks: BenchmarksResponse, models: ModelsResponse): ScoredModel[] {
  const lookup = buildLookup(models);
  const bnd = computeBounds(benchmarks);
  const results: ScoredModel[] = [];

  for (const b of benchmarks.data) {
    const intelligence = b.intelligence_index ?? 0;
    const coding = b.coding_index ?? 0;
    const agentic = b.agentic_index ?? 0;
    if (intelligence === 0 && coding === 0 && agentic === 0) continue;

    const avg =
      ((normValue(intelligence, bnd.iMin, bnd.iMax) +
        normValue(coding, bnd.cMin, bnd.cMax) +
        normValue(agentic, bnd.aMin, bnd.aMax)) /
        3) *
      100;

    const mi = lookup.get(b.model_permaslug);
    const p = mi?.pricing ?? {};
    const promptPrice = parseFloat(p.prompt ?? "0") || 0;
    const completionPrice = parseFloat(p.completion ?? "0") || 0;
    const cacheRead = parseFloat(p.input_cache_read ?? "0") || 0;
    const effectiveInput =
      cacheRead > 0
        ? MISS_RATE * promptPrice + CACHE_HIT_RATE * cacheRead
        : promptPrice;
    const blended = effectiveInput * INPUT_RATIO + completionPrice * OUTPUT_RATIO;
    const valueScore = blended > 0 ? avg / (blended * 1e6) : Infinity;

    results.push({
      name: b.display_name,
      slug: b.model_permaslug,
      avg,
      intelligence,
      coding,
      agentic,
      blendedCost: blended,
      promptPrice,
      completionPrice,
      cacheRead,
      valueScore,
      multimodal: isMultimodal(mi),
      contextTier: contextTier(mi),
    });
  }

  results.sort((a, b) => b.avg - a.avg);
  return results;
}

// ---------------------------------------------------------------------------
// Color gradients (true color ANSI)
// ---------------------------------------------------------------------------

function lerpColor(c1: number[], c2: number[], t: number): string {
  const r = Math.round(c1[0] + (c2[0] - c1[0]) * t);
  const g = Math.round(c1[1] + (c2[1] - c1[1]) * t);
  const b = Math.round(c1[2] + (c2[2] - c1[2]) * t);
  return `\x1b[38;2;${r};${g};${b}m`;
}

function costColor(cost: number, min: number, max: number): string {
  const range = max - min || 1;
  const t = Math.max(0, Math.min(1, (cost - min) / range));
  if (t < 0.5) return lerpColor([34, 204, 68], [221, 204, 34], t * 2);
  return lerpColor([221, 204, 34], [221, 51, 51], (t - 0.5) * 2);
}

function scoreColor(score: number, min: number, max: number): string {
  const range = max - min || 1;
  const t = Math.max(0, Math.min(1, (score - min) / range));
  if (t < 0.5) return lerpColor([224, 128, 160], [192, 96, 192], t * 2);
  return lerpColor([192, 96, 192], [128, 64, 224], (t - 0.5) * 2);
}

const reset = "\x1b[39m";

// ---------------------------------------------------------------------------
// Pareto filters
// ---------------------------------------------------------------------------

/** 2D: A dominates B when A.avg > B.avg AND A.blendedCost < B.blendedCost */
function paretoFilter2D(models: ScoredModel[]): ScoredModel[] {
  return models.filter((a) => {
    for (const b of models) {
      if (b.avg > a.avg && b.blendedCost < a.blendedCost) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

// @for-testing-only — export is safe; renderTable is pure (no IO, no pi globals)
export function renderTable(models: ScoredModel[], title = "MODEL TIERS", oCostMin?: number, oCostMax?: number, oScoreMin?: number, oScoreMax?: number): string {
  const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
  const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
  const cyan = (s: string) => `\x1b[36m${s}\x1b[39m`;
  const green = (s: string) => `\x1b[32m${s}\x1b[39m`;
  const yellow = (s: string) => `\x1b[33m${s}\x1b[39m`;

  const costs = models.map((m) => m.blendedCost);
  const scores = models.map((m) => m.avg);
  const costMin = oCostMin ?? Math.min(...costs);
  const costMax = oCostMax ?? Math.max(...costs);
  const scoreMin = oScoreMin ?? Math.min(...scores);
  const scoreMax = oScoreMax ?? Math.max(...scores);

  const lines: string[] = [];

  lines.push(
    bold(`  ${title}`) +
      dim(`  ·  98% cache, 90/10 I/O  ·  I≥${THRESHOLDS.intelligence} C≥${THRESHOLDS.coding} A≥${THRESHOLDS.agentic}`),
  );

  for (const tier of TIERS) {
    const members = models.filter((m) => m.avg >= tier.lo && m.avg <= tier.hi);
    if (members.length === 0) continue;

    const byPerf = [...members].sort((a, b) => b.avg - a.avg);
    const byValue = [...members].sort((a, b) => b.valueScore - a.valueScore);
    const bestPerf = byPerf[0];
    const bestValue = byValue[0];
    const remaining = members.filter((m) => m !== bestPerf && m !== bestValue);
    const runnerUp =
      remaining.length > 0
        ? remaining.reduce((a, b) =>
            a.valueScore * a.avg > b.valueScore * b.avg ? a : b,
          )
        : null;

    const count = dim(`(${members.length})`);
    lines.push(`  ${bold(tier.name)}  ${count}`);

    const show = (label: string, color: (s: string) => string, m: ScoredModel) => {
      const sc = scoreColor(m.avg, scoreMin, scoreMax);
      const cc = costColor(m.blendedCost, costMin, costMax);
      const avgPlain = m.avg.toFixed(1).padStart(5);
      const costPlain = `$${(m.blendedCost * 1e6).toFixed(2)}/M`.padStart(9);
      const nameStr = m.name.length > 45 ? m.name.slice(0, 44) + "…" : m.name;
      lines.push(
        `    ${color(label.padEnd(7))} ${nameStr.padEnd(46)} ${sc}${avgPlain}${reset} avg  ${cc}${costPlain}${reset}`,
      );
    };

    show("★ PERF", green, bestPerf);
    if (bestValue !== bestPerf) show("★ VALUE", cyan, bestValue);
    if (runnerUp && runnerUp !== bestPerf && runnerUp !== bestValue) show("☆ ALT", yellow, runnerUp);
  }

  return lines.join("\n");
}

function renderFullTable(models: ScoredModel[], dominatedCount: number, title: string, hiddenCount?: number, oCostMin?: number, oCostMax?: number, oScoreMin?: number, oScoreMax?: number): string {
  if (models.length === 0) return "";

  const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
  const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;

  const costs = models.map((m) => m.blendedCost);
  const scores = models.map((m) => m.avg);
  const costMin = oCostMin ?? Math.min(...costs);
  const costMax = oCostMax ?? Math.max(...costs);
  const scoreMin = oScoreMin ?? Math.min(...scores);
  const scoreMax = oScoreMax ?? Math.max(...scores);

  const lines: string[] = [];
  const hidden = dominatedCount > 0 ? dim(`, −${dominatedCount} dominated`) : "";
  lines.push(
    bold(`  ${title}`) +
      dim("  ·  98% cache, 90/10 I/O") +
      hidden,
  );

  for (const m of models) {
    const sc = scoreColor(m.avg, scoreMin, scoreMax);
    const cc = costColor(m.blendedCost, costMin, costMax);
    const nameStr = m.name.length > 48 ? m.name.slice(0, 47) + "…" : m.name;
    lines.push(
      `  ${nameStr.padEnd(49)} ${sc}${m.avg.toFixed(1).padStart(5)}${reset} ${cc}$${(m.blendedCost * 1e6).toFixed(2)}/M${reset}`,
    );
  }

  if (hiddenCount && hiddenCount > 0) {
    lines.push(dim(`  … ${hiddenCount} more (below $0.00/M cutoff)`));
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Shared cache helper
// ---------------------------------------------------------------------------

async function getOrFetchCache(
  ctx: { ui: { setStatus: (id: string, text: string | null) => void } },
): Promise<CacheData | null> {
  let cache = loadCache();
  if (!cache) {
    const key = getOpenRouterKey();
    if (!key) return null;
    ctx.ui.setStatus("model-tiers", "Fetching benchmark data...");
    const [benchmarks, models] = await Promise.all([
      fetchBenchmarks(key),
      fetchModels(),
    ]);
    cache = { fetchedAt: Date.now(), benchmarks, models };
    saveCache(cache);
  }
  ctx.ui.setStatus("model-tiers", "");
  return cache;
}

// ---------------------------------------------------------------------------
// Side-by-side layout for /tiers
// ---------------------------------------------------------------------------

/** Strip ANSI escape codes for width calculation. */
function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Pad a string to a target visible width, accounting for ANSI codes. */
function padVisible(s: string, width: number): string {
  const vlen = visibleLen(s);
  return vlen >= width ? s : s + " ".repeat(width - vlen);
}

function sideBySide(left: string, right: string): string {
  const leftLines = left.split("\n");
  const rightLines = right.split("\n");
  const maxLines = Math.max(leftLines.length, rightLines.length);
  const leftWidth = Math.max(...leftLines.map(visibleLen)) + 4; // 4-col gutter

  const out: string[] = [];
  for (let i = 0; i < maxLines; i++) {
    const l = padVisible(leftLines[i] ?? "", leftWidth);
    const r = rightLines[i] ?? "";
    out.push(l + r);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
  // ── TUI entry renderer (startup tiers — never enters LLM context) ──
  pi.registerEntryRenderer<{ content: string }>("model-tiers", (entry, _options, theme) => {
    const data = entry.data ?? { content: "" };
    return new Text(data.content, 1, 1, (text) => theme.bg("customMessageBg", text));
  });

  // ── Startup: 2D compact tier picks ──
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    try {
      const cache = await getOrFetchCache(ctx);
      if (!cache) {
        console.log("[model-tiers] No OpenRouter API key found — skipping");
        return;
      }
      const scored = scoreModels(cache.benchmarks, cache.models);
      const frontier = paretoFilter2D(scored);

      // Open-weights only Pareto
      const lookup = buildLookup(cache.models);
      const openWeights = scored.filter((m) =>
        isOpenWeights(lookup.get(m.slug)),
      );
      const openFrontier = paretoFilter2D(openWeights);

      // Global color scale from full frontier so open-weights colors match
      const gCostMin = Math.min(...frontier.map((m) => m.blendedCost));
      const gCostMax = Math.max(...frontier.map((m) => m.blendedCost));
      const gScoreMin = Math.min(...frontier.map((m) => m.avg));
      const gScoreMax = Math.max(...frontier.map((m) => m.avg));

      if (openFrontier.length > 0) {
        const left = renderTable(frontier, "MODEL TIERS");
        const right = renderTable(openFrontier, "OPEN-WEIGHTS TIERS", gCostMin, gCostMax, gScoreMin, gScoreMax);
        pi.appendEntry("model-tiers", { content: sideBySide(left, right) });
      } else {
        pi.appendEntry("model-tiers", { content: renderTable(frontier) });
      }
    } catch (err) {
      console.log(`[model-tiers] Error: ${(err as Error).message}`);
    }
  });

  // ── /tiers-open: full 2D Pareto, open-weights only, no thresholds ──
  pi.registerCommand("tiers-open", {
    description: "Show 2D Pareto frontier for open-weights models only",
    handler: async (_args, ctx) => {
      try {
        const cache = await getOrFetchCache(ctx);
        if (!cache) {
          ctx.ui.notify("No OpenRouter API key found", "error");
          return;
        }
        const scored = scoreAllModels(cache.benchmarks, cache.models);
        const lookup = buildLookup(cache.models);

        // 2D Pareto on open-weights models only
        const openModels = scored.filter((m) => isOpenWeights(lookup.get(m.slug)));
        const openFrontier = paretoFilter2D(openModels);
        const removed = openModels.length - openFrontier.length;

        const content = renderFullTable(
          openFrontier,
          removed,
          "OPEN-WEIGHTS MODELS (2D Pareto: score × cost)",
        );

        pi.sendMessage({
          customType: "model-tiers-open",
          content,
          display: true,
        });
      } catch (err) {
        console.log(`[model-tiers] /tiers-open error: ${(err as Error).message}`);
      }
    },
  });

  // ── /tiers: full 3D Pareto, no thresholds ──
  pi.registerCommand("tiers", {
    description: "Show 2D Pareto frontiers: all models + image-only",
    handler: async (_args, ctx) => {
      try {
        const cache = await getOrFetchCache(ctx);
        if (!cache) {
          ctx.ui.notify("No OpenRouter API key found", "error");
          return;
        }
        const scored = scoreAllModels(cache.benchmarks, cache.models);

        // 2D Pareto on all models
        const allFrontier = paretoFilter2D(scored);
        const firstFree = allFrontier.findIndex((m) => m.blendedCost * 1e6 < 0.005);
        const allCut = firstFree >= 0 ? allFrontier.slice(0, firstFree + 1) : allFrontier;

        // 2D Pareto on image-supporting models only
        const imgModels = scored.filter((m) => m.multimodal);
        const imgFrontier = paretoFilter2D(imgModels);
        const imgFirstFree = imgFrontier.findIndex((m) => m.blendedCost * 1e6 < 0.005);
        const imgCut =
          imgFirstFree >= 0 ? imgFrontier.slice(0, imgFirstFree + 1) : imgFrontier;

        const removed = scored.length - allFrontier.length;
        const allHidden = allFrontier.length - allCut.length;
        const imgHidden = imgFrontier.length - imgCut.length;
        const left = renderFullTable(allCut, removed, "ALL MODELS (2D Pareto: score × cost)", allHidden);
        const right = renderFullTable(imgCut, 0, "IMAGE-SUPPORTING (2D Pareto: score × cost)", imgHidden);

        const content = sideBySide(left, right);

        pi.sendMessage({
          customType: "model-tiers-full",
          content,
          display: true,
        });
      } catch (err) {
        console.log(`[model-tiers] /tiers error: ${(err as Error).message}`);
      }
    },
  });
}
