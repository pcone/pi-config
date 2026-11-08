/**
 * Seat sync: at session start in a clone's main checkout, fetch and
 * fast-forward to the upstream when that is safe, and warn loudly with the
 * evidence when it is not.
 *
 * The fetch runs off the turn path. `session_start` is awaited before the first
 * prompt (`agent-session.js:2680`), so the handler gates on the filesystem and
 * returns; everything that spawns git runs in a task nobody awaits. Only the
 * fast-forward decision waits for the fetch, because it is worthless without it.
 *
 * Logic: `extensions/lib/seat-sync.ts`. Design: `docs/design/seat-sync.md`.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyReport, seatScope, syncSeat, type SeatReport, type SeatUi } from "./lib/seat-sync.ts";

/** @internal test hook — the background task the last `session_start` started. */
let lastSync: Promise<void> = Promise.resolve();
export function _testLastSync(): Promise<void> {
	return lastSync;
}

/** @internal test hook — the report the last sync produced (undefined when its
 *  gate skipped before spawning git). */
let lastReport: SeatReport | undefined;
export function _testLastReport(): SeatReport | undefined {
	return lastReport;
}

/** @internal test hook — fetch bound for the next syncs (default: 10 s). A row
 *  can then prove the first prompt is served without waiting out the real one. */
let fetchTimeoutOverride: number | undefined;
export function _testSetFetchTimeout(ms: number | undefined): void {
	fetchTimeoutOverride = ms;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		// Cleared per start, so a gate skip leaves no report from the last session
		// behind (a reload runs this again in the same process).
		lastReport = undefined;
		lastSync = Promise.resolve();
		// Filesystem gate only, on purpose: this handler is on the startup path.
		const scope = seatScope(ctx.cwd);
		if (!scope.isSeat) return;
		lastSync = runSync(ctx, scope.root);
	});
}

async function runSync(ctx: ExtensionContext, root: string): Promise<void> {
	const debug = process.env.PI_SEAT_SYNC_DEBUG === "1";
	let report: SeatReport;
	try {
		report = await syncSeat(root, { fetchTimeoutMs: fetchTimeoutOverride });
	} catch (err) {
		// Detached, so an unhandled rejection here would take the session with it.
		// The only way out of `syncSeat` is a broken git contract or a bug: say so
		// loudly rather than leave the checkout unsynced and silent.
		console.warn(`[seat-sync] ${(err as Error).message}`);
		report = {
			outcome: "blocked",
			reason: (err as Error).message,
			status: "seat sync: BLOCKED — internal error",
			warning: `seat sync: BLOCKED — ${root} was not synced: ${(err as Error).message}`,
			commands: [],
		};
	}
	lastReport = report;
	try {
		applyReport(ctx as unknown as SeatUi, report, debug);
	} catch (err) {
		// The report path is the last place a stale ctx can still throw, and this
		// task's rejection would be unhandled: pi installs no handler for it, and
		// Bun exits 1 on one. Losing the report is bad; killing the session is worse.
		console.warn(`[seat-sync] report failed: ${(err as Error).message}\n${report.warning ?? report.status ?? report.reason}`);
	}
}
