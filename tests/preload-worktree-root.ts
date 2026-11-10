/**
 * The run's subagent worktree base is a temp dir, set before any test file
 * loads.
 *
 * `createWorktree` resolves its base from `subagentWorktreeBase()`, so a test
 * that spawns through the `subagent` tool has no argument to thread a base
 * through. Per-file opt-in (`tests/helpers/subagent-wt-root.ts`) makes the leak
 * a matter of every spawning file remembering; this makes it impossible for a
 * file that never thinks about it. `bunfig.toml` `[test] preload` loads this
 * file, so it also applies to a nested `bun test` run — each process gets its
 * own root.
 *
 * Realpath'd, because the guard compares symlink-resolved prefixes
 * (`WORKTREE_ROOT_PREFIX` in extensions/worktree-guard.ts): on macOS `tmpdir()`
 * is `/var/folders/…`, whose realpath is `/private/var/folders/…`.
 *
 * Limit: an explicit `home` argument wins over the override, so a consumer that
 * derives from a home it was handed — `planCargoBound`,
 * `disposeWorktreeBuildOutput` — is not redirected. See
 * docs/design/subagent-worktree-root.md.
 */
import { afterAll } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PI_SUBAGENT_WT_ROOT_ENV } from "../extensions/lib/subagent-worktree.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-subagent-wt-run-")));
process.env[PI_SUBAGENT_WT_ROOT_ENV] = root;

// `afterAll` at preload scope runs once, after the process's last test file,
// on a failed run too. Not `process.on("exit")`: bun test never emits it
// (verified on 1.3.11 — an exit handler's file write never appears). A killed
// run leaves the dir; it is empty and under `$TMPDIR`.
afterAll(() => {
	try {
		rmSync(root, { recursive: true, force: true });
	} catch {
		/* best-effort: a leftover temp dir is not the leak this pins */
	}
});
