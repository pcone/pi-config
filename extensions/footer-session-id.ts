/**
 * Session ID Footer
 *
 * Replaces the default footer with one that preserves pi's existing layout
 * (cwd top-left, tokens bottom-left, model bottom-right) and adds a
 * right-aligned session identifier on the right side of the stats line.
 *
 * Encoding: 18 contiguous bits drawn from the random region of the UUID
 * map bijectively to three themed words via three 64-entry lists —
 * adjective, fantasy creature, and class/job, with sci-fi scattered
 * through.
 *
 * Source bits (UUIDv7 layout):
 *   bit 48-51  = version nibble (always 7), skipped
 *   bit 52-55  = hex 13 (random_a byte 0)       ┐
 *   bit 56-59  = hex 14 (random_a byte 1)       ├─ all of random_a (12 bits)
 *   bit 60-63  = hex 15 (random_a byte 2)       ┘
 *   bit 64-65  = variant (always 10), included    \u2190 redundant 2 bits
 *   bit 66-69  = hex 17 (random_b byte 0)       ┐
 *   bit 70-75  = hex 18 top 6 bits (random_b)    ┴\u2014 first 10 bits of random_b
 *
 * Encoded bits: 52-69 of the UUID (18 contiguous bits). Sourcing every
 * encoded bit from the random region guarantees that two sessions in the
 * same millisecond still produce distinct phrases, because random_a and
 * random_b are randomized per UUID by design.
 *
 * Reversibility: looking up each word's index recovers hex chars 13, 14,
 * 15, and 17 of the UUID (4 full hex chars of the random region) plus
 * the top 6 bits of hex 18. Hex 16 (variant, always 8 or 9 for v7) sits
 * between hex 15 and hex 17 and is implicit. Use `decodeSessionFingerprint`
 * for a single grep-friendly string.
 *
 * Format: `adjective-creature-class` (e.g. `arcane-phoenix-archmage`).
 *
 * 64³ = 262,144 distinct phrases. Collision probability between any two
 * random sessions is ~1 in 262k, effectively zero for any real workflow.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Word lists — 64 entries each. Fantasy and sci-fi mixed throughout.
//
// Constraints enforced at module load:
//   - exactly 64 entries per list
//   - all entries unique within each list
//   - no entry appears in more than one list (decode would be ambiguous)
// ---------------------------------------------------------------------------

// Fantasy/sci-fi descriptors: colors, elements, materials, qualities, time.
const ADJECTIVES = [
	"amber", "ancient", "arcane", "ashen", "astral", "atomic", "auroral", "azure",
	"barren", "blazing", "bold", "brazen", "bronze", "burning", "celestial", "cinder",
	"cobalt", "copper", "cosmic", "crimson", "crystal", "cursed", "cyber", "dark",
	"dawn", "deathless", "dire", "distant", "divine", "ebony", "elder", "ember",
	"emerald", "eternal", "ethereal", "frozen", "galactic", "gilded", "glacial", "golden",
	"hallowed", "hidden", "hoary", "icy", "infernal", "jade", "lightning", "lunar",
	"midnight", "molten", "mystic", "nebula", "noble", "obsidian", "phantom", "plasma",
	"primal", "quantum", "radiant", "rippling", "sacred", "shadow", "silver", "stormy",
];

// Fantasy creatures (mythological beasts, races) + sci-fi (androids, synths).
const CREATURES = [
	"angel", "android", "apparition", "archon", "banshee", "basilisk", "behemoth", "chimera",
	"chimaera", "couatl", "demon", "djinn", "drake", "dryad", "efreet", "elemental",
	"elf", "fae", "fiend", "firebird", "genie", "ghost", "giant", "gnome",
	"goblin", "golem", "gorgon", "griffin", "harpy", "hydra", "ifrit", "imp",
	"incubus", "jackal", "kraken", "lich", "manticore", "medusa", "mephit", "mimic",
	"minotaur", "mummy", "naga", "nymph", "ogre", "oni", "oracle", "pegasus",
	"phoenix", "pixie", "revenant", "roc", "salamander", "seraph", "shade", "siren",
	"sphinx", "sprite", "succubus", "synth", "titan", "treant", "unicorn", "wraith",
];

// Fantasy classes (mage, cleric…) + occupations + sci-fi roles.
const CLASSES = [
	"alchemist", "arbalist", "arcanist", "archer", "archmage", "artificer", "assassin", "astromancer",
	"augur", "barbarian", "bard", "binder", "cleric", "conjurer", "crusader", "cultist",
	"diplomat", "diviner", "druid", "duelist", "enchanter", "executioner", "explorer", "gladiator",
	"gunslinger", "hacker", "harbinger", "healer", "hexer", "hunter", "illusionist", "inquisitor",
	"invoker", "knight", "monk", "navigator", "necromancer", "occultist", "paladin", "pathfinder",
	"pilgrim", "pilot", "priest", "psion", "ranger", "reaver", "rogue", "sage",
	"scout", "shaman", "smith", "sorcerer", "summoner", "swashbuckler", "templar", "thief",
	"vanguard", "warden", "warmage", "warrior", "wizard", "wonderer", "zealot", "zephyrus",
];

// Build a quick lookup from word → index for the decoder.
const ADJ_INDEX = new Map(ADJECTIVES.map((w, i) => [w, i]));
const CRE_INDEX = new Map(CREATURES.map((w, i) => [w, i]));
const CLS_INDEX = new Map(CLASSES.map((w, i) => [w, i]));

// Compile-time invariant checks. A typo'd entry or cross-list collision
// would corrupt the encoding, so fail loudly rather than silently producing
// ambiguous output.
function assertValid(name: string, list: string[], index: Map<string, number>) {
	if (list.length !== 64) throw new Error(`${name}: need 64 entries, got ${list.length}`);
	if (index.size !== 64) throw new Error(`${name}: ${64 - index.size} duplicate entries`);
}
assertValid("ADJECTIVES", ADJECTIVES, ADJ_INDEX);
assertValid("CREATURES", CREATURES, CRE_INDEX);
assertValid("CLASSES", CLASSES, CLS_INDEX);
for (const w of ADJECTIVES) {
	if (CRE_INDEX.has(w) || CLS_INDEX.has(w)) {
		throw new Error(`ADJECTIVES: '${w}' collides with another list`);
	}
}
for (const w of CREATURES) {
	if (CLS_INDEX.has(w)) {
		throw new Error(`CREATURES: '${w}' collides with CLASSES`);
	}
}

// ---------------------------------------------------------------------------
// Encoding — bijective mapping from first 18 bits of UUID → 3 themed words.
// ---------------------------------------------------------------------------

/**
 * Extract the 18-bit value used to index all three words. Same value drives
 * both the phrase and the per-session color, so adding color costs no
 * extra entropy. Returns null if the UUID is too short to read.
 */
export function sessionBits(uuid: string): number | null {
	const hex = uuid.replace(/-/g, "").slice(0, 20);
	if (hex.length < 20) return null;
	const ra = parseInt(hex.slice(13, 16), 16);
	const rbTop = (parseInt(hex.slice(17, 19), 16) >>> 2) & 0x3f;
	return (ra << 6) | rbTop;
}

/** Encode a UUID session ID as `adjective-creature-class`. */
export function encodeSessionId(uuid: string): string {
	const v = sessionBits(uuid);
	if (v === null) return "wandering-???-seeker";
	const a = (v >> 12) & 0x3f;
	const c = (v >> 6) & 0x3f;
	const k = v & 0x3f;
	return `${ADJECTIVES[a]}-${CREATURES[c]}-${CLASSES[k]}`;
}

/**
 * Map HSL to an ANSI truecolor fg escape code. h ∈ [0, 360), s and l are
 * percentages. Used to give each session a distinct, deterministic color.
 */
function hslToAnsiFg(h: number, s: number, l: number): string {
	const sn = s / 100;
	const ln = l / 100;
	const c = (1 - Math.abs(2 * ln - 1)) * sn;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = ln - c / 2;
	let r = 0, g = 0, b = 0;
	if (h < 60) [r, g, b] = [c, x, 0];
	else if (h < 120) [r, g, b] = [x, c, 0];
	else if (h < 180) [r, g, b] = [0, c, x];
	else if (h < 240) [r, g, b] = [0, x, c];
	else if (h < 300) [r, g, b] = [x, 0, c];
	else [r, g, b] = [c, 0, x];
	r = Math.round((r + m) * 255);
	g = Math.round((g + m) * 255);
	b = Math.round((b + m) * 255);
	return `\x1b[38;2;${r};${g};${b}m`;
}

/**
 * Per-session color derived from the same 18-bit value as the phrase.
 * Sweeps the full hue range (linear: v / 2^18 * 360); saturation is held
 * constant so the only varying dimension is hue. Lightness is configurable
 * so the staleness indicator can fade the words while keeping the hue.
 * Defaults to 58 — slightly desaturated (60%) and middling lightness,
 * legible against both light and dark backgrounds.
 */
export function sessionColor(uuid: string, lightness: number = 58): string {
	const v = sessionBits(uuid);
	if (v === null) return "";
	const hue = (v / 262144) * 360;
	return hslToAnsiFg(hue, 60, lightness);
}

/** Staleness table: time since last activity mapped to a glyph + lightness.
 *  Hand-tuned 6 buckets with thresholds at 30s, 5m, 30m, 2h, 8h. Bucket
 *  widths grow roughly 10× each step (log-ish), giving more resolution
 *  where short-lived sessions need to be distinguishable (minutes) and
 *  fewer buckets across the long tail (hours). Glyph fill drops ~25% per
 *  step so adjacent states are visually distinct even when the lightness
 *  delta is small; lightness itself ramps 60 → 38 across the full range.
 *  Sessions idle for 8h or more land in the final bucket (max stale). */
type Staleness = { glyph: string; lightness: number };

const STALENESS_BUCKETS: ReadonlyArray<{ maxAgeMs: number; staleness: Staleness }> = [
	{ maxAgeMs: 30_000, staleness: { glyph: "\u25cf", lightness: 60 } }, //   < 30s: just finished
	{ maxAgeMs: 5 * 60_000, staleness: { glyph: "\u25d5", lightness: 56 } }, //   < 5m: brief pause
	{ maxAgeMs: 30 * 60_000, staleness: { glyph: "\u25d0", lightness: 52 } }, //   < 30m: short break
	{ maxAgeMs: 2 * 60 * 60_000, staleness: { glyph: "\u25d4", lightness: 47 } }, //   < 2h: pause
	{ maxAgeMs: 8 * 60 * 60_000, staleness: { glyph: "\u25cc", lightness: 43 } }, //   < 8h: long break
	{ maxAgeMs: Number.POSITIVE_INFINITY, staleness: { glyph: "\u25cb", lightness: 38 } }, //   >= 8h: stale
];

function stalenessFor(ageMs: number): Staleness {
	const hit = STALENESS_BUCKETS.find((b) => ageMs < b.maxAgeMs);
	return (hit ?? STALENESS_BUCKETS[STALENESS_BUCKETS.length - 1]!).staleness;
}

/** Time elapsed since the most recent entry on the current branch, in ms.
 *  Returns 0 for sessions with no entries yet (treated as fresh). */
function lastActivityMs(entries: ReadonlyArray<unknown>): number {
	let latest = 0;
	for (const entry of entries) {
		const ts = Date.parse((entry as { timestamp?: string }).timestamp ?? "");
		if (Number.isFinite(ts) && ts > latest) latest = ts;
	}
	return latest;
}

/** Current thinking level from the most recent `thinking_level_change`
 *  entry on the current branch. `getBranch()` returns leaf-to-root, so the
 *  first match is the active one. Returns undefined if no such entry
 *  exists yet (treat as "off"). */
function currentThinkingLevel(branch: ReadonlyArray<unknown>): string | undefined {
	// getBranch() returns root-to-leaf (chronological), so iterate in reverse to
	// find the most recent thinking_level_change entry.
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i] as { type?: string; thinkingLevel?: string };
		if (e.type === "thinking_level_change") return e.thinkingLevel;
	}
	return undefined;
}

/** Internal: reverse `encodeSessionId` to its raw 18-bit value. */
function decodeToValue(words: string): number | null {
	const parts = words.toLowerCase().split("-");
	if (parts.length !== 3) return null;
	const a = ADJ_INDEX.get(parts[0]);
	const c = CRE_INDEX.get(parts[1]);
	const k = CLS_INDEX.get(parts[2]);
	if (a === undefined || c === undefined || k === undefined) return null;
	return (a << 12) | (c << 6) | k;
}

/**
 * Reverse the encoding. Returns the recovered random-region bits:
 * hex chars 13, 14, 15 (full random_a nibbles) and hex 17 plus the top 2
 * bits of hex 18 (top of random_b).
 */
export function decodeSessionWords(words: string): {
	hex13: string;
	hex14: string;
	hex15: string;
	hex17: string;
	hex18Top2: number;
} | null {
	const v = decodeToValue(words);
	if (v === null) return null;
	const ra = (v >> 6) & 0xfff; // top 12 = random_a
	const rbTop = v & 0x3f; // bottom 6 = top of random_b
	return {
		hex13: (ra >> 8).toString(16),
		hex14: ((ra >> 4) & 0xf).toString(16),
		hex15: (ra & 0xf).toString(16),
		hex17: (rbTop >> 2).toString(16),
		hex18Top2: rbTop & 0x3, // 0..3 = top 2 bits of hex 18
	};
}

/**
 * Convenience: returns a grep-friendly fingerprint string. Format is
 * `XYZW:N` where X,Y,Z,W are full hex chars (hex 13, 14, 15, 17) of the
 * random region and N is the top 2 bits of hex 18 (a digit 0-3). UUIDv7's
 * variant nibble (hex 16, always 8 or 9) sits between Z and W and is implicit.
 *
 * Example: a UUID with random region `7abcdef0` produces fingerprint `7ab:e`.
 */
export function decodeSessionFingerprint(words: string): string | null {
	const d = decodeSessionWords(words);
	if (!d) return null;
	return `${d.hex13}${d.hex14}${d.hex15}${d.hex17}:${d.hex18Top2}`;
}

// ---------------------------------------------------------------------------
// Footer rendering — port of pi's FooterComponent with session-words added.
// We can't extend the built-in footer, only replace it, so the existing
// layout (pwd / stats+model / extension-statuses) is reimplemented here.
// ---------------------------------------------------------------------------

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." &&
			!relativeToHome.startsWith(`..${sep}`) &&
			!isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

type Theme = { fg: (color: string, text: string) => string; bold: (s: string) => string };
type FooterData = {
	getGitBranch: () => string | null;
	getExtensionStatuses: () => ReadonlyMap<string, string>;
	getAvailableProviderCount: () => number;
	onBranchChange: (cb: () => void) => () => void;
};
type FooterFactoryCtx = {
	sessionManager: {
		getEntries(): unknown[];
		getBranch(): unknown[];
		getCwd(): string;
		getSessionName(): string | undefined;
		getSessionId(): string;
	};
	model: { id: string; provider: string; reasoning?: boolean; contextWindow?: number } | undefined;
	modelRegistry?: {
		isUsingOAuth?: (model: unknown) => boolean;
		getApiKeyForProvider?: (provider: string) => Promise<string | undefined>;
	};
	getContextUsage?: () => {
		contextWindow?: number;
		percent?: number | null;
	} | undefined;
};

// ---------------------------------------------------------------------------
// Z.ai coding-plan quota — undocumented endpoint consumed by community tools.
// https://api.z.ai/api/monitor/usage/quota/limit
// ---------------------------------------------------------------------------

/** Cached quota data, written by the poll interval and read by render(). */
let cachedQuota: QuotaData | undefined;

/** Set to true after the first fetch failure to suppress repeated console.warn. */
let quotaWarnedOnce = false;

/** Resolved z.ai API key (cached after first resolution), or undefined if unavailable. */
let resolvedZaiKey: string | undefined;

/** True once the API key has been resolved (even if null — prevents re-resolution). */
let zaiKeyResolved = false;

interface QuotaLimitItem {
	type: string;
	unit: number;
	percentage: number;
	usage: number;
	currentValue: number;
	nextResetTime?: number;
}

interface QuotaData {
	level: string;
	limits: QuotaLimitItem[];
}

/**
 * Fetch z.ai coding-plan quota from the undocumented endpoint.
 * No Authorization header prefix — bare key.
 */
async function fetchQuota(apiKey: string): Promise<QuotaData | undefined> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 5000);
	try {
		const res = await fetch(
			"https://api.z.ai/api/monitor/usage/quota/limit",
			{
				headers: { Authorization: apiKey },
				signal: controller.signal,
			},
		);
		if (!res.ok) {
			if (!quotaWarnedOnce) {
				console.warn(`[footer-session-id] quota fetch failed: HTTP ${res.status}`);
				quotaWarnedOnce = true;
			}
			return undefined;
		}
		const json = await res.json() as {
			code?: number;
			data?: { level?: string; limits?: QuotaLimitItem[] };
			success?: boolean;
		};
		if (!json.data?.limits || json.success === false) {
			if (!quotaWarnedOnce) {
				console.warn("[footer-session-id] quota response missing limits field");
				quotaWarnedOnce = true;
			}
			return undefined;
		}
		return {
			level: json.data.level ?? "unknown",
			limits: json.data.limits,
		};
	} catch (err: unknown) {
		if (!quotaWarnedOnce) {
			console.warn(
				"[footer-session-id] quota fetch error:",
				err instanceof Error ? err.message : String(err),
			);
			quotaWarnedOnce = true;
		}
		return undefined;
	} finally {
		clearTimeout(timeoutId);
	}
}

/**
 * Resolve and cache the z.ai API key. Returns true if any key is configured.
 *
 * Do NOT gate on a key-prefix heuristic: the endpoint response is the authority
 * on whether this is a coding-plan key. Real coding-plan keys do not
 * consistently start with `sk-sp-` (verified against a live Pro subscription
 * whose key had a hex prefix). A standard pay-as-you-go key simply returns no
 * `data.limits`, which renderQuotaSegment already treats as "render nothing".
 */
async function ensureZaiKey(ctx: FooterFactoryCtx): Promise<boolean> {
	if (zaiKeyResolved) return !!resolvedZaiKey;
	zaiKeyResolved = true;
	try {
		const key = await ctx.modelRegistry?.getApiKeyForProvider?.("zai");
		if (key) {
			resolvedZaiKey = key;
			return true;
		}
		resolvedZaiKey = undefined;
		return false;
	} catch {
		resolvedZaiKey = undefined;
		return false;
	}
}

/** Unit → display label mapping for quota windows. */
const QUOTA_LABELS: Record<number, string> = {
	3: "5h",   // TOKENS_LIMIT, 5-hour rolling window
	6: "7d",   // TOKENS_LIMIT, weekly
	5: "MCP",  // TIME_LIMIT, monthly MCP cap (web search / reader / Zread)
};

/**
 * Format a compact duration-until-reset from a Unix-ms timestamp.
 * Returns "" when the timestamp is missing or already in the past (the next
 * poll tick refreshes with a fresh reset time — never render a stale/reset one).
 *   <1h → "⟳47m",   ≥1h → "⟳4.9h"
 */
function formatResetDuration(nextResetTime: number | undefined, now: number): string {
	if (!nextResetTime) return "";
	const deltaMs = nextResetTime - now;
	if (deltaMs <= 0) return "";
	const mins = deltaMs / 60000;
	if (mins < 60) return `⟳${Math.round(mins)}m`;
	return `⟳${(mins / 60).toFixed(1)}h`;
}

/**
 * Build the quota segment string for the footer top line.
 * Returns empty string when no quota data is available or model is not zai.
 */
function renderQuotaSegment(
	quota: QuotaData | undefined,
	modelProvider: string | undefined,
	width: number,
	theme: { fg: (color: string, text: string) => string },
): string {
	if (modelProvider !== "zai" || !quota || !quota.limits.length) return "";

	const parts: string[] = [];

	// Unit 3 = 5h window, unit 6 = 7d window (always show when available)
	for (const u of [3, 6] as const) {
		const entry = quota.limits.find((l) => l.unit === u);
		if (!entry) continue;
		const usedPct = entry.percentage;
		const remainPct = Math.max(0, 100 - usedPct);
		const label = QUOTA_LABELS[u] ?? `u${u}`;
		const coloredPct = (() => {
			const pct = `${remainPct}%`;
			if (usedPct >= 85) return theme.fg("error", pct);
			if (usedPct >= 60) return theme.fg("warning", pct);
			// used < 60% — green (success)
			return theme.fg("success", pct);
		})();
		let part = `${label}:${coloredPct}`;
		// 5h window only: append compact duration until reset, always shown —
		// it's the actionable "when do I get capacity back" signal. Weekly/
		// monthly resets are too far out to earn footer space.
		if (u === 3) {
			const reset = formatResetDuration(entry.nextResetTime, Date.now());
			if (reset) part += ` ${theme.fg("dim", reset)}`;
		}
		parts.push(part);
	}

	// MCP (unit 5) — only if non-zero usage
	const mcpEntry = quota.limits.find((l) => l.unit === 5);
	if (mcpEntry && mcpEntry.currentValue > 0) {
		const usedPct = mcpEntry.percentage;
		const remainPct = Math.max(0, 100 - usedPct);
		const coloredPct = (() => {
			const pct = `${remainPct}%`;
			if (usedPct >= 85) return theme.fg("error", pct);
			if (usedPct >= 60) return theme.fg("warning", pct);
			return theme.fg("success", pct);
		})();
		parts.push(`MCP:${coloredPct}`);
	}

	if (parts.length === 0) return "";

	// Plan tier at the end, dimmed
	const tier = quota.level.toLowerCase();
	parts.push(`${theme.fg("dim", `· ${tier}`)}`);

	const segment = parts.join(" ");

	// Width-budget check: drop MCP first, then tier, if too wide
	const segWidth = visibleWidth(segment);
	if (segWidth <= width) return segment;

	// Try dropping MCP
	const noMcpParts = parts.filter((elem) => !elem.startsWith("MCP:"));
	if (noMcpParts.length >= 2) {
		const noMcp = noMcpParts.join(" ");
		if (visibleWidth(noMcp) <= width) return noMcp;
		// Drop tier too
		const noTierParts = noMcpParts.filter((_, i) => {
			// tier is the last entry (starts with dim "· ")
			return i < noMcpParts.length - 1;
		});
		if (noTierParts.length >= 1) {
			const noTier = noTierParts.join(" ");
			if (visibleWidth(noTier) <= width) return noTier;
			// Drastic: just show the first entry
			return parts[0]!;
		}
	}
	// Fallback: just return the first entry
	return parts[0]!;
}

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";
const CONFIG_DIR_NAME = ".pi";

function readAutoCompactEnabled(): boolean {
	try {
		const envDir = process.env[ENV_AGENT_DIR];
		const agentDir = envDir || path.join(os.homedir(), CONFIG_DIR_NAME, "agent");
		const settingsPath = path.join(agentDir, "settings.json");
		const raw = fs.readFileSync(settingsPath, "utf-8");
		const parsed = JSON.parse(raw) as { compaction?: { enabled?: boolean } };
		return parsed.compaction?.enabled ?? true;
	} catch {
		return true;
	}
}

// Initial value at module load. Updated by the render interval in the footer
// factory below; also re-read on every branch change via requestRender.
let cachedAutoCompactEnabled = readAutoCompactEnabled();

// Holds the active footer's requestRender so thinking_level_select can
// trigger a redraw without waiting for the 30s interval or a branch change.
let requestRenderRef: (() => void) | null = null;

/** Export for testing — pure function mapping quota data to footer segment string. */
export { renderQuotaSegment };

export default function (pi: ExtensionAPI) {
	// Re-render the footer whenever the thinking level changes. The footer
	// factory reads the level from session entries in render(), so it just
	// needs to be called again.
	pi.on("thinking_level_select", async () => {
		requestRenderRef?.();
	});

	// Re-render when the model changes — model name, provider, context window
	// are read from ctx.model in render(), which updates before this event fires.
	pi.on("model_select", async () => {
		requestRenderRef?.();
	});

	function installFooter(ctx: unknown): void {
		const c = ctx as { ui: { setFooter: (factory: FooterFactory) => void } };
		c.ui.setFooter((tui, theme, footerData) => {
			requestRenderRef = () => tui.requestRender();
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			// Periodic refresh so the staleness indicator updates while the
			// session is idle (no user input or session events would otherwise
			// trigger a render). Re-reads autoCompact from settings.json each
			// tick too — toggles in `/settings` show up within 30s. pi's
			// requestRender throttles internally via renderTimer /
			// MIN_RENDER_INTERVAL_MS, so 30s is cheap.
			const refreshInterval = setInterval(() => {
				cachedAutoCompactEnabled = readAutoCompactEnabled();
				tui.requestRender();
			}, 30_000);

			// Quota polling: every 60s, fetch z.ai coding-plan quota when the active
			// provider is zai and any API key is configured. Silently retains
			// last-known value on failure. The interval is cheap — the guard inside
			// checks provider at tick time, and render() checks per-call.
			const fc = ctx as FooterFactoryCtx;
			const quotaInterval = setInterval(async () => {
				const model = fc.model;
				if (model?.provider !== "zai") {
					cachedQuota = undefined;
					return;
				}
				const hasKey = await ensureZaiKey(fc);
				if (!hasKey || !resolvedZaiKey) {
					cachedQuota = undefined;
					return;
				}
				const quota = await fetchQuota(resolvedZaiKey);
				if (quota) cachedQuota = quota;
			}, 60_000);

			// Kick off the first quota fetch immediately (don't wait 60s).
			// This is async; cachedQuota stays undefined until it resolves.
			(async () => {
				const model = fc.model;
				if (model?.provider !== "zai") return;
				const hasKey = await ensureZaiKey(fc);
				if (!hasKey || !resolvedZaiKey) return;
				const quota = await fetchQuota(resolvedZaiKey);
				if (quota) {
					cachedQuota = quota;
					tui.requestRender();
				}
			})();

			return {
				dispose() {
					requestRenderRef = null;
					unsub();
					clearInterval(refreshInterval);
					clearInterval(quotaInterval);
					// Reset module-level state so a future re-install starts fresh.
					cachedQuota = undefined;
					quotaWarnedOnce = false;
					zaiKeyResolved = false;
					resolvedZaiKey = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const fc = ctx as FooterFactoryCtx;
					const sm = fc.sessionManager;

					// --- Token / cost aggregates from session entries. ---
					let totalInput = 0;
					let totalOutput = 0;
					let totalCacheRead = 0;
					let totalCacheWrite = 0;
					let totalCost = 0;
					let latestCacheHitRate: number | undefined;
					for (const entry of sm.getEntries()) {
						const e = entry as { type: string; message?: { role: string } & AssistantMessage };
						if (e.type === "message" && e.message?.role === "assistant") {
							const m = e.message;
							totalInput += m.usage.input;
							totalOutput += m.usage.output;
							totalCacheRead += m.usage.cacheRead;
							totalCacheWrite += m.usage.cacheWrite;
							totalCost += m.usage.cost.total;
							const promptTokens = m.usage.input + m.usage.cacheRead + m.usage.cacheWrite;
							latestCacheHitRate =
								promptTokens > 0 ? (m.usage.cacheRead / promptTokens) * 100 : undefined;
						}
					}

					// --- Context usage. ---
					const ctxUsage = fc.getContextUsage?.();
					const model = fc.model;
					const contextWindow = ctxUsage?.contextWindow ?? model?.contextWindow ?? 0;
					const contextPercentValue = ctxUsage?.percent ?? 0;
					const contextPercent =
						ctxUsage?.percent !== null && ctxUsage?.percent !== undefined
							? contextPercentValue.toFixed(1)
							: "?";

					// --- pwd line. ---
					let pwd = formatCwdForFooter(sm.getCwd(), process.env.HOME || process.env.USERPROFILE);
					const branch = footerData.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;
					const sessionName = sm.getSessionName();
					if (sessionName) pwd = `${pwd} • ${sessionName}`;

					// --- stats parts. ---
					const statsParts: string[] = [];
					if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
					if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
					if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
					if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);
					if ((totalCacheRead > 0 || totalCacheWrite > 0) && latestCacheHitRate !== undefined) {
						statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
					}
					const usingSubscription = model && fc.modelRegistry?.isUsingOAuth?.(model);
					if (totalCost || usingSubscription) {
						const costStr = `$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
						statsParts.push(costStr);
					}

					let contextPercentStr: string;
					const autoIndicator = cachedAutoCompactEnabled ? " (auto)" : "";
					const contextPercentDisplay =
						contextPercent === "?"
							? `?/${formatTokens(contextWindow)}${autoIndicator}`
							: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
					if (contextPercentValue > 90) contextPercentStr = theme.fg("error", contextPercentDisplay);
					else if (contextPercentValue > 70) contextPercentStr = theme.fg("warning", contextPercentDisplay);
					else contextPercentStr = contextPercentDisplay;
					statsParts.push(contextPercentStr);

					let statsLeft = statsParts.join(" ");
					let statsLeftWidth = visibleWidth(statsLeft);
					if (statsLeftWidth > width) {
						statsLeft = truncateToWidth(statsLeft, width, "...");
						statsLeftWidth = visibleWidth(statsLeft);
					}

					// --- model name with optional provider + thinking level. ---
					// Reading thinkingLevel off the extension context always returns
					// undefined (the ExtensionContext type doesn't expose it), so we
					// walk the current branch and pick the most recent
					// thinking_level_change entry. Branch-only — entries on sibling
					// branches shouldn't influence the displayed state.
					const sessionBranch = sm.getBranch();
					const modelName = model?.id || "no-model";
					let rightSideWithoutProvider = modelName;
					if (model?.reasoning) {
						const tl = currentThinkingLevel(sessionBranch) || "off";
						rightSideWithoutProvider =
							tl === "off"
								? `${modelName} • thinking off`
								: `${modelName} • thinking ${tl}`;
					}
					let rightSide = rightSideWithoutProvider;
					if (footerData.getAvailableProviderCount() > 1 && model) {
						rightSide = `(${model.provider}) ${rightSideWithoutProvider}`;
						if (statsLeftWidth + 2 + visibleWidth(rightSide) > width) {
							rightSide = rightSideWithoutProvider;
						}
					}

					// --- session identifier with staleness indicator. ---
					// Right-aligned on the pwd line. The leading glyph tracks time
					// since the most recent entry on the current branch (filled →
					// 3/4 → half → 1/4 → dotted → empty across 6 buckets), and
					// the words themselves fade along the same axis so the signal
					// is reinforced two ways.
					const sessionId = sm.getSessionId();
					const sessionWords = encodeSessionId(sessionId);
					const lastMs = lastActivityMs(sessionBranch);
					const staleness = stalenessFor(lastMs === 0 ? 0 : Date.now() - lastMs);
					const colorStart = sessionColor(sessionId, staleness.lightness);
					const iconColored = theme.fg("dim", staleness.glyph);
					const sessionSide = colorStart
						? `${iconColored} ${colorStart}${sessionWords}\x1b[39m`
						: `${iconColored} ${sessionWords}`;
					const sessionSideWidth = visibleWidth(sessionSide);

					// Layout: stats [...padding] model, right-aligned (unchanged).
					const minPadding = 2;
					const statsLine = (() => {
						const totalNeeded = statsLeftWidth + minPadding + visibleWidth(rightSide);
						if (totalNeeded <= width) {
							const padding = " ".repeat(width - statsLeftWidth - visibleWidth(rightSide));
							return statsLeft + padding + rightSide;
						}
						const availableForRight = width - statsLeftWidth - minPadding;
						if (availableForRight > 0) {
							const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
							const truncatedRightWidth = visibleWidth(truncatedRight);
							const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
							return statsLeft + padding + truncatedRight;
						}
						return statsLeft;
					})();

					const dimStatsLeft = theme.fg("dim", statsLeft);
					const remainder = statsLine.slice(statsLeft.length);
					const dimRemainder = theme.fg("dim", remainder);

					// --- Top line: pwd (left) + quota (right) + session words (right). ---
					// The quota block is inserted between pwd and session words on the
					// right side. Width-budget conscious: if the full row would overflow,
					// drop the quota block first, then fall through to existing behavior.
					const pwdDim = theme.fg("dim", pwd);
					const pwdVisible = visibleWidth(pwdDim);

					// Build the quota segment (empty string when not applicable).
					// Width budget here is generous — the real fit check happens below
					// using exact visible widths (needsBoth / needsPwdSessionOnly).
					const quotaStr = renderQuotaSegment(
						cachedQuota,
						model?.provider,
						Math.max(30, width),
						theme,
					);
					const quotaWidth = quotaStr ? visibleWidth(quotaStr) + 1 : 0; // +1 for spacer

					let pwdLine: string;
					const rightBlockWidth = quotaWidth + sessionSideWidth;
					const needsBoth = pwdVisible + 2 + rightBlockWidth <= width;
					const needsPwdSessionOnly = pwdVisible + 2 + sessionSideWidth <= width;

					if (needsBoth && quotaStr) {
						// Fits everything: pwd ... quota session
						const fill = " ".repeat(width - pwdVisible - rightBlockWidth);
						pwdLine = pwdDim + fill + quotaStr + " " + sessionSide;
					} else if (needsPwdSessionOnly) {
						// Fits without quota: pwd ... session
						const fill = " ".repeat(width - pwdVisible - sessionSideWidth);
						pwdLine = pwdDim + fill + sessionSide;
					} else {
						// Not enough room for both — truncate pwd to width on its own.
						pwdLine = truncateToWidth(pwdDim, width, theme.fg("dim", "..."));
					}

					const lines: string[] = [pwdLine, dimStatsLeft + dimRemainder];

					// Extension statuses (preserved from FooterComponent).
					const extensionStatuses = footerData.getExtensionStatuses();
					if (extensionStatuses.size > 0) {
						const sortedStatuses = Array.from(extensionStatuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => sanitizeStatusText(text));
						const statusLine = sortedStatuses.join(" ");
						lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
					}

					return lines;
				},
			};
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		installFooter(ctx);
	});
}

type FooterFactory = (
	tui: { requestRender: () => void },
	theme: Theme,
	footerData: FooterData,
) => { render: (width: number) => string[]; invalidate: () => void; dispose?: () => void };