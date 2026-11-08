/**
 * Best-effort `ctx.ui.notify`.
 *
 * Two states make the call throw, and neither is worth an exception:
 *
 * - **Stale ctx** — pi's `ExtensionContext` getters call `assertActive()`
 *   (`runner.js:613-637`), which throws after a session replacement or reload.
 *   Reading `ctx.ui` is what throws, so it must stay inside the `try`; a helper
 *   that hoists the read does not fix the bug.
 * - **No UI** — in a harness ctx, `hasUI` can be truthy while `ui` carries no
 *   `notify`, so `hasUI` is not the predicate for "notify is callable". `?.`
 *   covers that shape; the `catch` covers the throwing ones.
 *
 * A notification is never the point of the work that raises it; letting either
 * state escape turns a recoverable outcome into an extension error, and in an
 * error handler it replaces the reported bug with the handler's own crash
 * (pi-config#12, pi-config#13).
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

/**
 * The UI surface, or null when the ctx is stale.
 *
 * `hasUI`, `ui`, `mode` and `cwd` are getters on pi's context, each calling
 * `assertActive()` (`runner.js:626-651`), so *reading* them is what throws after
 * a session replacement or reload — not any call made through the value. A
 * detached task (one the handler did not await) outlives exactly that event, so
 * it has to take the surface in one guarded read and give up quietly when there
 * is no longer a session to draw on.
 */
export function liveUi<T>(ctx: { hasUI: boolean; ui: T }): { hasUI: boolean; ui: T } | null {
	try {
		return { hasUI: ctx.hasUI, ui: ctx.ui };
	} catch {
		return null;
	}
}
