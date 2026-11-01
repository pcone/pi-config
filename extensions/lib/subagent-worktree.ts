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
import { join } from "node:path";

/**
 * Human worktree root. Subagent trees get their own namespace inside it so
 * the guard can block sibling trees without also blocking hand-made
 * worktrees (`~/Developer/wt/tfd-425`), which a child has no business
 * touching either — but blocking those needs the *parent-repo* rule, not
 * this one.
 */
export const SUBAGENT_WORKTREE_NAMESPACE = "Developer/wt/subagents";

/** `~/Developer/wt/subagents`, the parent of every subagent worktree. */
export function subagentWorktreeBase(home: string = homedir()): string {
	return join(home, SUBAGENT_WORKTREE_NAMESPACE);
}

/**
 * `<base>/<repo>-<suffix>`. The repo name keeps the path legible; the suffix
 * is the session id tail, so the tree is identifiable from `git worktree
 * list` and by a human reaping a stale one.
 */
export function subagentWorktreePath(repoName: string, suffix: string, home: string = homedir()): string {
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
