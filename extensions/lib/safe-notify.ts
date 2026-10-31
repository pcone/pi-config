/**
 * Best-effort `ctx.ui.notify`.
 *
 * Two states make the call throw, and both are normal rather than exceptional:
 *
 * - **Stale ctx** — pi's `ExtensionContext` getters call `assertActive()`
 *   (`runner.js:613-637`), which throws after a session replacement or reload.
 *   Reading `ctx.ui` is what throws, so the access must stay inside the `try`.
 * - **No UI** — a harness ctx can report `hasUI: true` while `ui` is present but
 *   without `notify`, so `hasUI` is not the predicate for "notify is callable".
 *
 * A notification is never the point of the work that raises it; letting either
 * state escape converts a recoverable outcome into an extension error, and in an
 * error handler (`auto-checkpoint.ts`) it replaces the reported bug with the
 * handler's own crash. See pi-config#12.
 */
export type NotifyLevel = "info" | "warning" | "error";

export function safeNotify(
	ctx: { ui: { notify?(message: string, level?: NotifyLevel): void } },
	message: string,
	level: NotifyLevel = "info",
): void {
	try {
		ctx.ui.notify?.(message, level);
	} catch { /* ctx stale after reload */ }
}
