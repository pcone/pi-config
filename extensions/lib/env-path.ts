/**
 * The rule for a harness path override: an environment variable that replaces a
 * default path, or fails the call. Never a fallback.
 *
 * Three overrides answer the same question — "where does this path come from
 * when there is no argument to say?" — and each one is resolved from inside
 * code a test drives with no argument (`createWorktree`, the `session_start`
 * recovery scan, the reap's cargo bound). Process state is the only seam a test
 * has, so the rule lives once, here:
 *
 * - `PI_SUBAGENT_WT_ROOT` — the subagent worktree base.
 * - `PI_SUBAGENT_META_DIR` — the `pi-subagent-*` metas dir.
 * - `PI_SUBAGENT_CARGO_HOME` — the home whose `.cache/cargo-target` the reap
 *   bounds and prunes.
 *
 * Empty, relative or NUL-bearing values throw rather than fall back: the
 * fallback is the bug, because a typo would put a test's files in a human's
 * directory (or make a test read the box's live registry) silently.
 *
 * Every absorb-all path an override travels through calls
 * {@link rethrowIfUnusableEnvPath}: a recovery scan tolerates a torn meta, not a
 * root it could not resolve.
 *
 * Decisions: decisions/subagents/049-injectable-worktree-root.md (the shape),
 * 052-recovery-scan-process-wide-root.md (the other two).
 */
import { isAbsolute } from "node:path";

/**
 * An override is set but cannot name a path. Thrown, never absorbed: the value
 * replaces the real path or fails the call.
 */
export class UnusableEnvPathError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnusableEnvPathError";
	}
}

/**
 * `$name` when it is set and absolute, `fallback` when it is unset.
 *
 * `makeError` keeps a caller's own error class where the failure has a name of
 * its own (`UnusableWorktreeRootError`). That class extends
 * {@link UnusableEnvPathError}, so one `instanceof` covers every variable.
 */
export function absoluteEnvPath(
	name: string,
	fallback: string,
	makeError: (message: string) => Error = (message) => new UnusableEnvPathError(message),
): string {
	const value = process.env[name];
	if (value === undefined) return fallback;
	if (value.length === 0 || value.includes("\0") || !isAbsolute(value)) {
		throw makeError(`${name} must be an absolute path, got ${JSON.stringify(value)}`);
	}
	return value;
}

/**
 * Re-throw an unusable override from a `catch` that absorbs every other
 * failure. A scan that reads the fallback after a failed override is exactly
 * the leak the override removes, so the failure must reach the caller.
 */
export function rethrowIfUnusableEnvPath(e: unknown): void {
	if (e instanceof UnusableEnvPathError) throw e;
}
