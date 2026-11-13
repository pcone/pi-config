/**
 * The run's subagent roots are temp dirs, set before any test file loads.
 *
 * Three paths are resolved from inside code a test drives with no argument, so
 * the only seam is process state:
 *
 * - `PI_SUBAGENT_WT_ROOT` — the worktree base `createWorktree` derives from.
 * - `PI_SUBAGENT_META_DIR` — the `pi-subagent-*` dir the `session_start`
 *   recovery scan reads. Unset, that is the box's live `/tmp` registry: other
 *   sessions' running children, their logs, their metas.
 * - `PI_SUBAGENT_CARGO_HOME` — the home whose `~/.cache/cargo-target` the reap's
 *   bound walks, and over the bound prunes with `cargo clean -p`.
 *
 * Per-file opt-in (`tests/helpers/subagent-wt-root.ts`, per-row setters) makes
 * the leak a matter of every file remembering; this makes it impossible for a
 * file that never thinks about it. `bunfig.toml` `[test] preload` loads this
 * file, so it also applies to a nested `bun test` run — each process gets its
 * own roots.
 *
 * Realpath'd, because the guard compares symlink-resolved prefixes
 * (`WORKTREE_ROOT_PREFIX` in extensions/worktree-guard.ts): on macOS `tmpdir()`
 * is `/var/folders/…`, whose realpath is `/private/var/folders/…`.
 *
 * Limit: an explicit argument wins over every override, so a consumer that
 * derives from a path it was handed — `subagentWorktreeBase(home)` — is not
 * redirected, and `reapFinishedWorktrees({ dir, home })` uses the fixture it is
 * given. The pass still resolves the overrides (and refuses an unusable one):
 * the argument names a value, it does not switch the rule off. See
 * docs/design/subagent-worktree-root.md.
 */
import { afterAll } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PI_SUBAGENT_META_DIR_ENV } from "../extensions/lib/subagent-state.ts";
import {
	PI_SUBAGENT_CARGO_HOME_ENV,
	PI_SUBAGENT_WT_ROOT_ENV,
} from "../extensions/lib/subagent-worktree.ts";

const roots = {
	[PI_SUBAGENT_WT_ROOT_ENV]: realpathSync(mkdtempSync(join(tmpdir(), "pi-subagent-wt-run-"))),
	[PI_SUBAGENT_META_DIR_ENV]: realpathSync(mkdtempSync(join(tmpdir(), "pi-subagent-meta-run-"))),
	[PI_SUBAGENT_CARGO_HOME_ENV]: realpathSync(mkdtempSync(join(tmpdir(), "pi-subagent-cargo-run-"))),
};
for (const [name, dir] of Object.entries(roots)) process.env[name] = dir;

// `afterAll` at preload scope runs once, after the process's last test file,
// on a failed run too. Not `process.on("exit")`: bun test never emits it
// (verified on 1.3.11 — an exit handler's file write never appears). A killed
// run leaves the dirs; they are empty and under `$TMPDIR`.
afterAll(() => {
	for (const dir of Object.values(roots)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best-effort: a leftover temp dir is not the leak this pins */
		}
	}
});
