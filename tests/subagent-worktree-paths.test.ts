/**
 * The subagent worktree location is one rule with three consumers: the
 * dispatch that creates the tree, the guard that blocks sibling trees, and
 * the cargo target dir shared by a clone's worktrees. A second copy of the
 * path shape in any of them drifts silently — the guard would protect
 * nothing while still reporting a clean pass.
 *
 * `PI_SUBAGENT_WT_ROOT` redirects what derives from the ambient base: creation
 * and the guard's prefix. `planCargoBound` always passes a home and is not
 * redirected; `disposeWorktreeBuildOutput` passes the test seam's, so the
 * dispatch path follows the ambient base — docs/design/subagent-worktree-root.md.
 *
 * Decision: decisions/subagents/045-worktree-location.md.
 */
import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { cargoTargetDirFor, subagentWorktreeBase, subagentWorktreePath } from "../extensions/lib/subagent-worktree.ts";
import { childEnv } from "./helpers/subagent-env.ts";
import { buildSubagentEnv } from "../extensions/subagent-async/index.ts";
import { isBlocked, makeGuardContext } from "../extensions/worktree-guard.ts";
import { isolateSubagentWorktrees } from "./helpers/subagent-wt-root.ts";

const HOME = "/Users/probe";

describe("worktree location", () => {
	test("a subagent tree is repo-named under the subagents namespace", () => {
		expect(subagentWorktreePath("tfd", "abc123456789", HOME)).toBe(
			join(HOME, "Developer/wt/subagents/tfd-abc123456789"),
		);
	});

	test("the base is derived from home, never from tmpdir", () => {
		expect(subagentWorktreeBase(HOME)).toBe(join(HOME, "Developer/wt/subagents"));
		expect(subagentWorktreePath("tfd", "s", HOME)).not.toContain("/tmp");
	});

	test("the cargo target dir is per clone, not per worktree", () => {
		expect(cargoTargetDirFor("tfd", HOME)).toBe(join(HOME, ".cache/cargo-target/tfd"));
	});
});

describe("spawn env", () => {
	const base = {
		sessionId: "subagent-11111111-2222-3333-4444-555555555555",
		allowlist: undefined,
		parentCwdForCleanup: "/Users/probe/Developer/tfd",
	};

	test("an isolated child gets the shared target dir", () => {
		const env = buildSubagentEnv({
			...base,
			worktreePath: "/Users/probe/Developer/wt/subagents/tfd-555555555555",
			cargoTargetDir: "/Users/probe/.cache/cargo-target/tfd",
			depth: 1,
		});
		expect(env.CARGO_TARGET_DIR).toBe("/Users/probe/.cache/cargo-target/tfd");
	});

	test("an unisolated child gets none — it builds in the parent checkout", () => {
		const env = buildSubagentEnv({ ...base, worktreePath: null, cargoTargetDir: null, depth: 1 });
		expect(env.CARGO_TARGET_DIR).toBeUndefined();
	});
});

// Guard assertions derive their paths from the base the guard itself resolved:
// the module resolves its prefix once at load from the ambient base, which
// `bunfig.toml` preloads as a temp dir (tests/preload-worktree-root.ts), and
// `isBlocked` compares symlink-resolved prefixes.
describe("guard discriminator", () => {
	test("a sibling subagent tree is blocked", () => {
		const mine = subagentWorktreePath("tfd", "mine");
		const ctx = makeGuardContext(mine, "");
		expect(isBlocked(join(subagentWorktreePath("tfd", "other"), "src/foo.rs"), ctx).blocked).toBe(true);
	});

	test("the session's own tree is allowed", () => {
		const mine = subagentWorktreePath("tfd", "mine");
		const ctx = makeGuardContext(mine, "");
		expect(isBlocked(join(mine, "src/foo.rs"), ctx).blocked).toBe(false);
	});

	/** The namespace is what makes this safe: hand-made worktrees live in the
	 *  same parent and are not subagent trees. */
	test("a hand-made worktree beside them is NOT blocked by this rule", () => {
		const ctx = makeGuardContext(subagentWorktreePath("tfd", "mine"), "");
		// A hand-made tree lives BESIDE the subagents namespace, in the same
		// parent directory — the case that makes the namespace load-bearing.
		const humanWorktree = join(dirname(subagentWorktreeBase()), "tfd-425");
		expect(isBlocked(join(humanWorktree, "src/foo.rs"), ctx).blocked).toBe(false);
	});
});

/** End-to-end on the real function, not a mirror: a temp repo in, a worktree
 *  at the new location out. The branch name and the returned target dir are
 *  what the spawn site consumes.
 *
 *  `PI_SUBAGENT_WT_ROOT` is set for this row only: the rows above assert the
 *  derivation from home, and the guard resolves its prefix at module load. */
describe("createWorktree", () => {
	test("creates the tree under the subagents namespace and reports the shared target dir", async () => {
		const { createWorktree } = await import("../extensions/subagent-async/index.ts");
		const { execFileSync } = await import("node:child_process");
		const { mkdtempSync, writeFileSync, existsSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { basename, join } = await import("node:path");

		const repo = mkdtempSync(join(tmpdir(), "wt-path-repo-"));
		const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: childEnv() });
		git("init", "-q");
		git("config", "user.email", "probe@example.invalid");
		git("config", "user.name", "probe");
		writeFileSync(join(repo, "file.txt"), "x\n");
		git("add", "-A");
		git("commit", "-qm", "probe");

		const sessionId = "subagent-0b5f1a2c-1111-2222-3333-abcdefabcdef";
		const wtRoot = isolateSubagentWorktrees("pi-wt-path-");
		try {
			const wt = await createWorktree(repo, sessionId);
			expect(wt).not.toBeNull();
			expect(wt!.worktreePath).toBe(join(wtRoot.root, `${basename(repo)}-${sessionId.slice(-12)}`));
			expect(wt!.worktreePath).toBe(subagentWorktreePath(basename(repo), sessionId.slice(-12)));
			expect(existsSync(join(wt!.worktreePath, "file.txt"))).toBe(true);
			expect(git("worktree", "list").toString()).toContain(wt!.worktreePath);
			expect(git("-C", wt!.worktreePath, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(`pi-subagent-${sessionId.slice(-12)}`);
			expect(wt!.cargoTargetDir).toBe(cargoTargetDirFor(basename(repo)));
			git("worktree", "unlock", wt!.worktreePath);
			git("worktree", "remove", "--force", wt!.worktreePath);
			git("branch", "-D", wt!.branchName);
			git("worktree", "prune");
		} finally {
			rmSync(repo, { recursive: true, force: true });
			wtRoot.dispose();
		}
	});
});
