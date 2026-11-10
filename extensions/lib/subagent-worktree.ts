/**
 * Where subagent worktrees live, and the one cargo target dir a clone's
 * worktrees share.
 *
 * Both are owned here because two extensions must agree: subagent-async
 * creates the paths, worktree-guard decides which of them a child may write
 * to. A second copy of the rule there would drift, and the failure is silent
 * — the guard would protect nothing.
 *
 * Decision: decisions/subagents/0NN-worktree-location.md.
 */
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * Human worktree root. Subagent trees get their own namespace inside it so
 * the guard can block sibling trees without also blocking hand-made
 * worktrees (`~/Developer/wt/tfd-425`), which a child has no business
 * touching either — but blocking those needs the *parent-repo* rule, not
 * this one.
 */
export const SUBAGENT_WORKTREE_NAMESPACE = "Developer/wt/subagents";

/**
 * Process-wide override for the worktree base. A subagent dispatch resolves its
 * tree from inside the `subagent` tool, so a call argument cannot reach it — the
 * suite sets this to a temp dir for the whole run
 * (`tests/preload-worktree-root.ts`), and never touches the real
 * `~/Developer/wt/subagents`.
 *
 * Scope: it redirects every derivation from the *ambient* base — creation
 * (`createWorktree`) and the guard's prefix. A caller that passes an explicit
 * `home` is not redirected; see {@link subagentWorktreeBase}.
 */
export const PI_SUBAGENT_WT_ROOT_ENV = "PI_SUBAGENT_WT_ROOT";

/**
 * `PI_SUBAGENT_WT_ROOT` is set but cannot name a base. Thrown, never absorbed:
 * the override replaces the real path or fails the call, it never falls back to
 * `~/Developer/wt/subagents` — a silent fallback is what puts a test's tree in
 * a human's directory.
 */
export class UnusableWorktreeRootError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnusableWorktreeRootError";
	}
}

/**
 * `~/Developer/wt/subagents`, the parent of every subagent worktree, or
 * `$PI_SUBAGENT_WT_ROOT` when that is set.
 *
 * An explicit `home` wins over the override: it states where to derive from, so
 * a derivation test keeps its meaning while the override is on. That branch is
 * also the override's limit — a caller that derives a path it was handed from
 * the home that path belongs to is not redirected. Two of them in
 * build-output-reaper.ts always pass one (`planCargoBound`, whose `home`
 * defaults to `homedir()`, and the bound walk's `opts.home ?? homedir()`);
 * `disposeWorktreeBuildOutput` passes the test seam's `opts.home`, and with none
 * supplied it follows the ambient base like any other caller. See
 * docs/design/subagent-worktree-root.md.
 */
export function subagentWorktreeBase(home?: string): string {
	if (home !== undefined) return join(home, SUBAGENT_WORKTREE_NAMESPACE);
	const override = process.env[PI_SUBAGENT_WT_ROOT_ENV];
	if (override === undefined) return join(homedir(), SUBAGENT_WORKTREE_NAMESPACE);
	if (override.length === 0 || override.includes("\0") || !isAbsolute(override)) {
		throw new UnusableWorktreeRootError(
			`${PI_SUBAGENT_WT_ROOT_ENV} must be an absolute path, got ${JSON.stringify(override)}`,
		);
	}
	return override;
}

/**
 * `<base>/<repo>-<suffix>`. The repo name keeps the path legible; the suffix
 * is the session id tail, so the tree is identifiable from `git worktree
 * list` and by a human reaping a stale one.
 */
export function subagentWorktreePath(repoName: string, suffix: string, home?: string): string {
	return join(subagentWorktreeBase(home), `${repoName}-${suffix}`);
}

/**
 * One target dir per clone, shared by that clone's worktrees.
 *
 * Reachable through `/tmp`, no: a cache dir, because the contents are
 * rebuildable. The point is that registry-crate artifacts (most of a cold
 * build's 3.5 GB) compile once per clone instead of once per worktree, and
 * cargo's own target-dir lock serialises the rustc runs that pin memory.
 * Workspace-crate artifacts still rebuild per worktree — cargo fingerprints
 * them by source path, and each worktree's copy is a different path.
 */
export function cargoTargetDirFor(repoName: string, home: string = homedir()): string {
	return join(home, ".cache", "cargo-target", repoName);
}

/** The parent of every clone's shared dir — what the bound walks. */
export function cargoTargetRoot(home: string = homedir()): string {
	return join(home, ".cache", "cargo-target");
}

/** The 12-char session tail `subagentWorktreePath` appends, plus its separator. */
const WORKTREE_SUFFIX_LEN = 13;

/**
 * The clone name a subagent worktree path was built from, or null when the path
 * is not a direct child of the subagent namespace.
 *
 * The split is positional, not `-`-delimited: a repo name may itself contain
 * dashes (`tfd-d-487`), and the suffix is exactly the session id's last 12
 * characters. Anything else under `~/Developer/wt` (a hand-made worktree) or a
 * pre-namespace path (`/var/folders/.../pi-subagent-wt-<suffix>`) is not a
 * subagent worktree this harness owns and answers null.
 *
 * Each of its three callers passes the home it is deriving for, so the explicit
 * `home` reaches {@link subagentWorktreeBase} and the override does not apply —
 * see that function for which callers that is.
 */
export function repoNameFromWorktreePath(worktreePath: string, home?: string): string | null {
	const base = subagentWorktreeBase(home);
	if (!worktreePath.startsWith(base + "/")) return null;
	const name = worktreePath.slice(base.length + 1);
	if (name.length <= WORKTREE_SUFFIX_LEN || name.includes("/")) return null;
	if (name[name.length - WORKTREE_SUFFIX_LEN] !== "-") return null;
	return name.slice(0, name.length - WORKTREE_SUFFIX_LEN);
}
