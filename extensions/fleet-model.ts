/**
 * /fleet-model — view or flip the fleet flash seat.
 *
 * No args → show the current resolution. `glm` → restore the standing default
 * (removes the override file; absence = default). `deepseek` → write the 0731
 * override so a credit-low period survives with zero file edits. State lives
 * at `~/.pi/fleet-model.json` — created/removed at runtime, never checked in.
 * Anything else → error notify with usage; no write.
 * See decisions/subagents/020-fleet-glm-53-flash-single-tier.md.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import {
	FLASH_SEAT,
	DEFAULT_FLASH,
	readFlashOverride,
	writeFlashOverride,
	clearFlashOverride,
} from "./lib/fleet-model.ts"

const USAGE = "Usage: /fleet-model [glm|deepseek]"

export default function (pi: ExtensionAPI) {
	pi.registerCommand("fleet-model", {
		description:
			"View or switch the fleet flash seat model: /fleet-model [glm|deepseek] (no arg = show current)",
		handler: async (args, ctx) => {
			const arg = args?.trim() ?? ""
			const override = readFlashOverride()

			if (!arg) {
				const seat = FLASH_SEAT[override ?? DEFAULT_FLASH].model
				const status = override
					? `flash seat: ${seat} (override) — /fleet-model glm to restore`
					: `flash seat: ${seat} (default)`
				ctx.ui.notify(`${status}\n${USAGE}`, "info")
				return
			}

			if (arg === "glm") {
				clearFlashOverride()
				ctx.ui.notify(`flash seat: ${FLASH_SEAT.glm.model} (default restored)`, "info")
				return
			}

			if (arg === "deepseek") {
				writeFlashOverride("deepseek")
				ctx.ui.notify(
					`flash seat: ${FLASH_SEAT.deepseek.model} (override set — /fleet-model glm to restore)`,
					"info",
				)
				return
			}

			ctx.ui.notify(`Unknown fleet-model argument: ${arg}\n${USAGE}`, "error")
		},
	})
}
