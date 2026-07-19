/**
 * worktree-guard extension — denylist-based filesystem isolation for subagents.
 *
 * Wraps `read`, `write`, `edit`, `find`, `grep` with a path check that blocks:
 *   1. Paths inside OTHER concurrent subagents' worktrees (paths under
 *      `<os.tmpdir()>/pi-subagent-wt-*` that are not this session's own
 *      worktree). The session's own worktree (set via PI_SUBAGENT_WORKTREE)
 *      is always allowed.
 *   2. Paths inside the parent repo's checkout (set via PI_SUBAGENT_PARENT_CWD).
 *      This prevents the child from contaminating the orchestrator's working tree.
 *
 * Everything else is allowed. Reads and writes to /etc, /usr, ~/.ssh, /tmp/pi-*,
 * the home directory, etc. are NOT blocked — this guard exists to prevent
 * cross-session contamination, not to confine the agent.
 *
 * Activation: the extension is a complete no-op unless PI_SUBAGENT_WORKTREE or
 * PI_SUBAGENT_PARENT_CWD is set in the child process's environment. This is set
 * by extensions/subagent-async/index.ts in spawnSubagent when the child is
 * dispatched with worktree isolation. Non-subagent sessions (or reviewers with
 * `isolate: false` who get empty values) are unaffected.
 *
 * Does NOT wrap `bash`. Bash is the responsibility of the official sandbox
 * extension (sandbox-exec) if installed. Wrapping bash here would double-wrap
 * with whatever else is configured.
 */

import { realpathSync } from "node:fs";
import { sep } from "node:path";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import {
	createEditTool,
	createFindTool,
	createGrepTool,
	createReadTool,
	createWriteTool,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

/**
 * Resolved prefix of all subagent worktrees on this system. Worktree paths
 * are created as `path.join(os.tmpdir(), "pi-subagent-wt-<suffix>")` by
 * subagent-async's createWorktree (see extensions/subagent-async/index.ts).
 *
 * Important: `tmpdir()` is platform-specific:
 *   - Linux:  typically "/tmp"
 *   - macOS:  the per-user TMPDIR, e.g. "/var/folders/dh/.../T"
 *
 * We realpathSync the prefix at module load so the comparison is consistent
 * with the symlink-resolved absolute paths produced by {@link resolveAbsolute}.
 * On macOS this resolves `/var` to `/private/var`.
 */
const WORKTREE_ROOT_PREFIX: string = (() => {
	const base = tmpdir().replace(/\/+$/, "");
	try {
		return realpathSync(base) + sep + "pi-subagent-wt-";
	} catch {
		// tmpdir() should always exist, but be defensive
		return base + sep + "pi-subagent-wt-";
	}
})();

// ── Pure helpers (exported for unit tests) ─────────────────────────────────

export interface GuardContext {
	/**
	 * Absolute, symlink-resolved path to this session's own worktree.
	 * Empty when not isolated. Already resolved through {@link resolveAnchor}.
	 */
	myWorktree: string;
	/**
	 * Absolute, symlink-resolved path to the parent repo's checkout.
	 * Empty when not isolated. Already resolved through {@link resolveAnchor}.
	 */
	parentCwd: string;
}

export interface BlockResult {
	blocked: boolean;
	reasonShort?: string;
	reasonLong?: string;
}

/**
 * Resolve `anchor` through symlinks. Falls back to the raw value if the path
 * does not exist (defensive — anchors are expected to exist when the child
 * process starts, but this avoids a load-time crash if the harness misconfigures
 * the env vars).
 *
 * Used to canonicalize `myWorktree` and `parentCwd` so that comparisons
 * against symlink-resolved input paths work correctly on macOS where
 * `/var` is a symlink to `/private/var`.
 */
export function resolveAnchor(anchor: string): string {
	if (!anchor) return "";
	try {
		return realpathSync(anchor);
	} catch {
		return anchor;
	}
}

/**
 * Build a GuardContext from raw env-var values. Resolves both anchors
 * through symlinks so subsequent comparisons in {@link isBlocked} are
 * consistent.
 */
export function makeGuardContext(worktreeEnv: string, parentCwdEnv: string): GuardContext {
	return {
		myWorktree: resolveAnchor(worktreeEnv),
		parentCwd: resolveAnchor(parentCwdEnv),
	};
}

/**
 * Parent-repo subdirectories that isolated subagents may READ (but not write).
 * These hold static config the agent legitimately needs — skill definitions
 * (e.g. the work-order-template SKILL.md) and agent prompts. Listed as dir
 * names relative to parentCwd; the comparison in {@link isAllowlistedParentRead}
 * is separator-aware so `skills-evil` does not match `skills`.
 */
const PARENT_READ_ALLOWLIST = ["skills", "agents"];

/** Returns true if `absPath` is the dir itself or under it, separator-aware. */
function isAllowlistedParentRead(absPath: string, parentCwd: string): boolean {
	for (const dir of PARENT_READ_ALLOWLIST) {
		const allowedRoot = parentCwd + sep + dir;
		if (absPath === allowedRoot || absPath.startsWith(allowedRoot + sep)) {
			return true;
		}
	}
	return false;
}

/**
 * Returns whether `absPath` falls inside a protected directory (another
 * concurrent subagent's worktree, or the parent repo's checkout).
 *
 * `absPath` MUST be an absolute, symlink-resolved path. Use {@link resolveAbsolute}
 * to normalize inputs before calling this. The `ctx` values must be
 * symlink-resolved as well — use {@link resolveAnchor} (or the convenience
 * {@link makeGuardContext}).
 *
 * `op` is the operation kind: `"read"` (read/find/grep) or `"write"`
 * (write/edit). Reads of allowlisted parent-repo doc dirs (skills/,
 * agents/) are permitted so isolated subagents can load skill and agent
 * definitions; writes to the parent repo are always blocked. Defaults to
 * `"read"`.
 */
export function isBlocked(
	absPath: string,
	ctx: GuardContext,
	op: "read" | "write" = "read",
): BlockResult {
	// 1. Block other concurrent subagents' worktrees.
	//    Any path under the system worktree root (`<tmpdir>/pi-subagent-wt-`)
	//    that is NOT inside `myWorktree` is forbidden. This includes the
	//    root worktree directory itself, the other worktree's root, and
	//    any path inside another worktree.
	if (absPath === WORKTREE_ROOT_PREFIX || absPath.startsWith(WORKTREE_ROOT_PREFIX)) {
		const isOwn =
			ctx.myWorktree.length > 0 &&
			(absPath === ctx.myWorktree || absPath.startsWith(ctx.myWorktree + sep));
		if (!isOwn) {
			return {
				blocked: true,
				reasonShort: "this is another concurrent subagent's worktree",
				reasonLong: ctx.myWorktree
					? `path is inside another concurrent subagent's worktree (your worktree is ${ctx.myWorktree})`
					: "path is inside a concurrent subagent's worktree",
			};
		}
	}

	// 2. Block the parent repo's checkout — EXCEPT read-category access to
	//    allowlisted doc dirs (skills/, agents/), which isolated subagents
	//    legitimately need (e.g. loading the work-order-template SKILL.md).
	//    Writes/edits to the parent repo remain fully blocked.
	if (
		ctx.parentCwd.length > 0 &&
		(absPath === ctx.parentCwd || absPath.startsWith(ctx.parentCwd + sep))
	) {
		if (op === "read" && isAllowlistedParentRead(absPath, ctx.parentCwd)) {
			return { blocked: false };
		}
		return {
			blocked: true,
			reasonShort: "this is the parent repo's checkout",
			reasonLong: "path is the parent repo's checkout; the orchestrator manages it directly",
		};
	}

	return { blocked: false };
}

/**
 * Resolve `inputPath` to an absolute, symlink-resolved path. Falls back to
 * resolving just the parent directory when the full path does not exist
 * (e.g. for write targets on files that don't exist yet).
 */
export function resolveAbsolute(inputPath: string, cwd: string): string {
	const abs = isAbsolute(inputPath) ? inputPath : resolvePath(cwd, inputPath);
	try {
		return realpathSync(abs);
	} catch {
		const parent = dirname(abs);
		try {
			return join(realpathSync(parent), abs.slice(parent.length + 1));
		} catch {
			return abs;
		}
	}
}

/** Extract the path argument from a tool call's params. Returns "." when missing. */
export function getTargetPath(name: string, params: any): string {
	switch (name) {
		case "read":
		case "write":
		case "edit":
			return typeof params?.path === "string" ? params.path : "";
		case "find":
		case "grep":
			// `path` is optional; default to "." (= cwd).
			return typeof params?.path === "string" && params.path.length > 0 ? params.path : ".";
		default:
			return "";
	}
}

/**
 * Format the structured violation message returned to the agent.
 */
export function formatViolation(absPath: string, block: BlockResult, ctx: GuardContext): string {
	const lines = [
		`Worktree-guard violation: '${absPath}' is in a protected directory.`,
		`Reason: ${block.reasonShort ?? "protected directory"}.`,
	];
	if (ctx.myWorktree) {
		lines.push(
			`You must not read or write outside your worktree '${ctx.myWorktree}'.`,
			`Other concurrent subagents have their own worktrees — do not touch them.`,
		);
	} else {
		lines.push(
			`You must not access protected directories (other concurrent subagents' worktrees, or the parent repo's checkout).`,
		);
	}
	if (block.reasonLong) {
		lines.push(`Details: ${block.reasonLong}.`);
	}
	return lines.join("\n");
}

/**
 * Wrap a tool's `execute` function with the worktree-guard path check.
 * Returns a new execute function that:
 *   - If the path argument resolves outside the worktree (or matches a
 *     sibling worktree / parent repo): throws an Error with the
 *     formatted violation message.
 *   - Otherwise: delegates to `original.execute()`.
 *
 * Exported for unit tests; the default-export extension uses it to wrap
 * each tool it registers.
 */
export function makeGuardWrapper(
	name: string,
	original: { execute: (...args: any[]) => any },
	ctx: GuardContext,
) {
	return async function guardedExecute(
		toolCallId: string,
		params: any,
		signal?: any,
		onUpdate?: any,
		extCtx?: { cwd: string },
	) {
		const target = getTargetPath(name, params);
		if (target.length > 0 && extCtx) {
			const absTarget = resolveAbsolute(target, extCtx.cwd);
			// write/edit mutate; read/find/grep only read. Reads of allowlisted
			// parent-repo doc dirs (skills/, agents/) are permitted.
			const op: "read" | "write" = name === "write" || name === "edit" ? "write" : "read";
			const block = isBlocked(absTarget, ctx, op);
			if (block.blocked) {
				throw new Error(formatViolation(absTarget, block, ctx));
			}
		}
		return original.execute(toolCallId, params, signal, onUpdate);
	};
}

// ── Extension wiring ───────────────────────────────────────────────────────

const TOOLS_TO_WRAP = ["read", "write", "edit", "find", "grep"] as const;

export default function (pi: ExtensionAPI) {
	const worktreeEnv = process.env.PI_SUBAGENT_WORKTREE ?? "";
	const parentCwdEnv = process.env.PI_SUBAGENT_PARENT_CWD ?? "";

	// Graceful no-op: if neither guard anchor is set, this extension is not
	// needed. Don't register any wrapped tools — the original built-in tools
	// remain active.
	if (!worktreeEnv && !parentCwdEnv) return;

	const ctx = makeGuardContext(worktreeEnv, parentCwdEnv);

	// Create the underlying tools at module load (mirrors the sandbox extension
	// pattern). The child process's cwd IS the worktree when isolation is
	// active, so `process.cwd()` is correct here.
	const localCwd = process.cwd();
	const originals = new Map<string, any>([
		["read", createReadTool(localCwd)],
		["write", createWriteTool(localCwd)],
		["edit", createEditTool(localCwd)],
		["find", createFindTool(localCwd)],
		["grep", createGrepTool(localCwd)],
	]);

	for (const name of TOOLS_TO_WRAP) {
		const original = originals.get(name)!;
		pi.registerTool({
			...original,
			label: `${name} (guarded)`,
			execute: makeGuardWrapper(name, original, ctx),
		});
	}
}
