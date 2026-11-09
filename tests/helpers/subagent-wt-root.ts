/**
 * Per-file redirect of the subagent worktree base.
 *
 * A test that spawns a `subagent` out of a temp repo reaches `createWorktree`
 * through the tool, so the base cannot be passed as an argument — it comes from
 * `subagentWorktreeBase()`, which honours `PI_SUBAGENT_WT_ROOT`. Without the
 * override the tree lands in the real `~/Developer/wt/subagents` and outlives
 * the temp repo it was branched from.
 *
 * Owner ruling: the override replaces the real path or fails, never falls back
 * to it. So the env var is set to a real directory, and an unusable value is a
 * test bug, not a silent no-op.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PI_SUBAGENT_WT_ROOT_ENV } from "../../extensions/lib/subagent-worktree.ts";

export interface SubagentWtRoot {
	/** The temp dir `subagentWorktreeBase()` now answers. */
	root: string;
	/** Restore the previous override, then delete the temp dir and the trees in it. */
	dispose(): void;
}

/**
 * Point `PI_SUBAGENT_WT_ROOT` at a fresh temp dir. Call once per file at module
 * scope and `dispose()` from `afterAll`, or wrap a single test in
 * try/finally when the rest of the file asserts on the derived base.
 */
export function isolateSubagentWorktrees(prefix = "pi-subagent-wt-root-"): SubagentWtRoot {
	const root = mkdtempSync(join(tmpdir(), prefix));
	const previous = process.env[PI_SUBAGENT_WT_ROOT_ENV];
	process.env[PI_SUBAGENT_WT_ROOT_ENV] = root;
	return {
		root,
		dispose() {
			if (previous === undefined) delete process.env[PI_SUBAGENT_WT_ROOT_ENV];
			else process.env[PI_SUBAGENT_WT_ROOT_ENV] = previous;
			rmSync(root, { recursive: true, force: true });
		},
	};
}
