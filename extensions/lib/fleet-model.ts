/**
 * Fleet flash-seat model resolution — shared by the subagent spawn path,
 * compaction, and the `/fleet-model` command.
 *
 * The fleet's flash seat (implement, 3 reviewers, 2 scouts, compaction) has a
 * standing default — `zai/glm-5.3-flash` — versioned in the agent frontmatter
 * and mirrored in this table. A runtime override file (`~/.pi/fleet-model.json`)
 * can flip the whole seat back to `deepseek/deepseek-v4-flash-0731` during a
 * credit-low period with zero file edits. Runtime state can only override,
 * never define, the default; a missing or corrupt file fails open to the
 * default. See decisions/subagents/020-fleet-glm-53-flash-single-tier.md.
 *
 * Pure module: node:fs / node:path / node:os only (no pi-package imports), so
 * tests can import it directly under `bun test`. The home dir is resolved at
 * CALL time — `process.env.HOME` first (node's os.homedir() honors it; bun's
 * does not), falling back to `os.homedir()` — so tests can redirect HOME.
 */

import * as fs from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type FlashKey = "glm" | "deepseek"

export interface FlashModel {
	provider: string
	model: string
}

/** Authoritative flash-seat table — one rule flips the frontmatter, the
 *  subagent-async fallback literal, and compaction together. */
export const FLASH_SEAT: Record<FlashKey, FlashModel> = {
	glm: { provider: "zai", model: "zai/glm-5.3-flash" },
	deepseek: { provider: "openrouter", model: "deepseek/deepseek-v4-flash-0731" },
}

/** Standing default — runtime state can only override, never define, this. */
export const DEFAULT_FLASH: FlashKey = "glm"

/** pi's --thinking level set (the defaultThinkingLevel vocabulary). */
export const LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const

/** State-file path, resolved at CALL time so tests can redirect HOME. */
function stateFilePath(): string {
	// bun's os.homedir() ignores process.env.HOME (unlike node's), so check the
	// env first to keep the redirect contract from the decision-020 matrix.
	const home = process.env.HOME ?? homedir()
	return join(home, ".pi", "fleet-model.json")
}

/**
 * Read the runtime override. Missing file, unparsable JSON, or an unknown
 * value → null (fail open to the default). Read never throws.
 */
export function readFlashOverride(): FlashKey | null {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(stateFilePath(), "utf8"))
		const k = (parsed as { flash?: unknown } | null)?.flash
		return k === "glm" || k === "deepseek" ? k : null
	} catch {
		return null
	}
}

/** Resolve the effective flash seat: override if present, else the default. */
export function resolveFlashSeat(): FlashModel {
	return FLASH_SEAT[readFlashOverride() ?? DEFAULT_FLASH]
}

/**
 * Split a `provider/model:level` id at its LAST colon. The suffix counts as a
 * level only if it is in LEVELS — so `z-ai/glm-5.2:batch` stays intact
 * (level: null, base unchanged) while `zai/glm-5.3-flash:high` splits.
 */
export function splitModelLevel(id: string): { base: string; level: string | null } {
	const idx = id.lastIndexOf(":")
	if (idx === -1) return { base: id, level: null }
	const base = id.slice(0, idx)
	const suffix = id.slice(idx + 1)
	return (LEVELS as readonly string[]).includes(suffix)
		? { base, level: suffix }
		: { base: id, level: null }
}

/**
 * Substitute the flash seat in a model id. Matches ONLY the two flash-seat
 * base strings (after the level split) and rewrites them to the currently
 * resolved seat, preserving the effort suffix. Non-flash models — the oracle
 * (`deepseek/deepseek-v4-pro-0813`), orchestrator (`zai/glm-5.3`), and
 * anything else — plus `undefined` pass through untouched.
 */
export function resolveFlashModel(m: string | undefined): string | undefined {
	if (m === undefined) return undefined
	const { base, level } = splitModelLevel(m)
	if (base === FLASH_SEAT.glm.model || base === FLASH_SEAT.deepseek.model) {
		const seat = resolveFlashSeat().model
		return level ? `${seat}:${level}` : seat
	}
	return m
}

/** Write the runtime override (atomic: tmp + rename — writeMetaJson pattern). */
export function writeFlashOverride(k: FlashKey): void {
	const target = stateFilePath()
	fs.mkdirSync(dirname(target), { recursive: true })
	const tmp = `${target}.tmp.${process.pid}`
	fs.writeFileSync(tmp, JSON.stringify({ flash: k }, null, 2))
	fs.renameSync(tmp, target)
}

/** Remove the runtime override. Missing file = no-op, not an error. */
export function clearFlashOverride(): void {
	try {
		fs.unlinkSync(stateFilePath())
	} catch {
		/* missing file = no-op */
	}
}
