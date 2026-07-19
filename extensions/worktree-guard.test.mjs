/**
 * Unit + integration tests for the worktree-guard path validation logic.
 *
 * Coverage:
 *   - isBlocked(absPath, ctx): pure helper, all denylist permutations
 *   - resolveAbsolute(inputPath, cwd): symlink + non-existent-path handling
 *   - getTargetPath(name, params): per-tool param extraction
 *   - formatViolation(absPath, block, ctx): error message structure
 *   - makeGuardWrapper(name, original, ctx): integration test for the
 *     tool-wrapping delegate vs. block behavior, including the
 *     macOS-realistic resolveAbsolute → isBlocked pipeline.
 *
 * Run with bun:
 *   cd ~/.pi/agent/extensions && bun test worktree-guard.test.mjs
 */

import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import {
	isBlocked,
	resolveAbsolute,
	getTargetPath,
	formatViolation,
	resolveAnchor,
	makeGuardContext,
	makeGuardWrapper,
} from "./worktree-guard.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

// The worktree-guard module computes WORKTREE_ROOT_PREFIX internally. We
// recompute the same value here so tests use realistic production paths.
function productionPrefix() {
	const base = tmpdir().replace(/\/+$/, "");
	try {
		return realpathSync(base) + sep + "pi-subagent-wt-";
	} catch {
		return base + sep + "pi-subagent-wt-";
	}
}

function productionWorktree(suffix) {
	return productionPrefix() + suffix;
}

// ── isBlocked ──────────────────────────────────────────────────────────────

describe("isBlocked", () => {
	const ctx = makeGuardContext(
		productionWorktree("abc123"),
		"/Users/scott/Developer/pi-config",
	);

	test("allows a path inside the session's own worktree", () => {
		expect(isBlocked(productionWorktree("abc123"), ctx).blocked).toBe(false);
		expect(isBlocked(productionWorktree("abc123") + sep, ctx).blocked).toBe(false);
		expect(isBlocked(join(productionWorktree("abc123"), "src/foo.ts"), ctx).blocked).toBe(false);
	});

	test("blocks worktree-named siblings (substring-match safety)", () => {
		// Production-worktree suffix "abc123" + "foo" is NOT inside "abc123"
		// (no separator), but IS under the worktree root prefix, so it's
		// treated as another concurrent subagent's worktree.
		expect(isBlocked(productionWorktree("abc123foo"), ctx).blocked).toBe(true);
	});

	test("blocks another concurrent subagent's worktree root", () => {
		const result = isBlocked(productionWorktree("xyz789"), ctx);
		expect(result.blocked).toBe(true);
		expect(result.reasonShort).toMatch(/another concurrent subagent/);
	});

	test("blocks paths inside another concurrent subagent's worktree", () => {
		const result = isBlocked(join(productionWorktree("xyz789"), "foo.rs"), ctx);
		expect(result.blocked).toBe(true);
		expect(result.reasonShort).toMatch(/another concurrent subagent/);
	});

	test("blocks the parent repo's checkout", () => {
		const result = isBlocked("/Users/scott/Developer/pi-config", ctx);
		expect(result.blocked).toBe(true);
		expect(result.reasonShort).toMatch(/parent repo/);
	});

	test("blocks paths inside the parent repo's checkout", () => {
		const result = isBlocked("/Users/scott/Developer/pi-config/extensions/foo.ts", ctx);
		expect(result.blocked).toBe(true);
		expect(result.reasonShort).toMatch(/parent repo/);
	});

	test("does NOT falsely match the parent repo when path is a sibling", () => {
		expect(isBlocked("/Users/scott/Developer/pi-config-other/foo.ts", ctx).blocked).toBe(false);
		expect(isBlocked("/Users/scott/Developer/pi-config.bak", ctx).blocked).toBe(false);
	});

	test("allows unrelated paths everywhere else", () => {
		expect(isBlocked("/etc/resolv.conf", ctx).blocked).toBe(false);
		expect(isBlocked("/usr/bin/node", ctx).blocked).toBe(false);
		expect(isBlocked("/Users/scott/.ssh/id_rsa", ctx).blocked).toBe(false);
		expect(isBlocked("/Users/scott/.aws/credentials", ctx).blocked).toBe(false);
		expect(isBlocked("/tmp/foo.rs", ctx).blocked).toBe(false);
		expect(isBlocked("/tmp/pi-subagent-meta.json", ctx).blocked).toBe(false);
		expect(isBlocked("/tmp/pi-async-debug.log", ctx).blocked).toBe(false);
	});

	test("with only myWorktree set (no parentCwd), allows paths in parent dir", () => {
		const ctxNoParent = makeGuardContext(productionWorktree("abc123"), "");
		expect(isBlocked("/Users/scott/Developer/pi-config/foo.ts", ctxNoParent).blocked).toBe(false);
		expect(isBlocked(join(productionWorktree("xyz789"), "foo.rs"), ctxNoParent).blocked).toBe(true);
	});

	test("with only parentCwd set (no myWorktree), blocks the parent", () => {
		const ctxNoWorktree = makeGuardContext("", "/Users/scott/Developer/pi-config");
		expect(isBlocked("/Users/scott/Developer/pi-config/foo.ts", ctxNoWorktree).blocked).toBe(true);
		expect(isBlocked(join(productionWorktree("xyz789"), "foo.rs"), ctxNoWorktree).blocked).toBe(true);
	});

	test("with both empty, blocks worktree paths (no whitelist to match)", () => {
		const ctxEmpty = makeGuardContext("", "");
		expect(isBlocked(productionWorktree("xyz789"), ctxEmpty).blocked).toBe(true);
		expect(isBlocked("/Users/scott/Developer/pi-config/foo.ts", ctxEmpty).blocked).toBe(false);
	});

	test("handles macOS symlink-resolved paths (production flow)", () => {
		// On macOS, os.tmpdir() returns e.g. /var/folders/dh/.../T, which is
		// a symlink to /private/var/folders/dh/.../T. The ctx's myWorktree
		// should also be resolved through realpathSync (via makeGuardContext),
		// so both sides agree on /private/var/...
		const realWt = realpathSync(tmpdir()) + sep + "pi-subagent-wt-mine";
		const realCtx = makeGuardContext(realWt, "");

		// Path inside own worktree, symlink-resolved
		expect(isBlocked(realWt + sep + "foo.rs", realCtx).blocked).toBe(false);
		// Sibling worktree, symlink-resolved
		expect(isBlocked(realWt.replace("mine", "other") + sep + "foo.rs", realCtx).blocked).toBe(true);
	});

	test("isBlocked with empty-string absPath is a no-op (returns blocked=false)", () => {
		// The wrapper guards against this case (target.length > 0 check), but
		// isBlocked itself should handle it gracefully.
		expect(isBlocked("", ctx).blocked).toBe(false);
	});

	test("isBlocked with parentCwd that has trailing slash", () => {
		const ctxTrailing = makeGuardContext("", "/Users/scott/Developer/pi-config/");
		expect(isBlocked("/Users/scott/Developer/pi-config/foo.ts", ctxTrailing).blocked).toBe(true);
	});
});

// ── isBlocked: parent-repo read allowlist (skills/, agents/) ──────────────
//
// Isolated subagents legitimately need to READ parent-repo skill and agent
// definitions (e.g. the work-order-template SKILL.md). Writes remain blocked.
describe("isBlocked — parent-repo read allowlist (skills/, agents/)", () => {
	const parentCwd = "/Users/scott/Developer/pi-config";
	const ctx = makeGuardContext(productionWorktree("abc123"), parentCwd);

	test("READ of a skill file under skills/ is allowed", () => {
		expect(isBlocked(`${parentCwd}/skills/work-order-template/SKILL.md`, ctx, "read").blocked).toBe(false);
	});

	test("READ of an agent prompt under agents/ is allowed", () => {
		expect(isBlocked(`${parentCwd}/agents/orchestrator.md`, ctx, "read").blocked).toBe(false);
	});

	test("READ of the skills/ dir itself is allowed", () => {
		expect(isBlocked(`${parentCwd}/skills`, ctx, "read").blocked).toBe(false);
	});

	test("default op (no third arg) is read → skills/ allowed", () => {
		expect(isBlocked(`${parentCwd}/skills/foo.md`, ctx).blocked).toBe(false);
	});

	test("WRITE to a file under skills/ is still blocked", () => {
		const r = isBlocked(`${parentCwd}/skills/foo.md`, ctx, "write");
		expect(r.blocked).toBe(true);
		expect(r.reasonShort).toMatch(/parent repo/);
	});

	test("EDIT of a file under agents/ is still blocked", () => {
		expect(isBlocked(`${parentCwd}/agents/orchestrator.md`, ctx, "edit").blocked).toBe(true);
	});

	test("READ of a non-allowlisted parent-repo path is still blocked (regression)", () => {
		const r = isBlocked(`${parentCwd}/extensions/foo.ts`, ctx, "read");
		expect(r.blocked).toBe(true);
		expect(r.reasonShort).toMatch(/parent repo/);
	});

	test("prefix-safety: a dir named skills-evil is NOT treated as skills/", () => {
		expect(isBlocked(`${parentCwd}/skills-evil/foo`, ctx, "read").blocked).toBe(true);
	});
});

// ── resolveAnchor ─────────────────────────────────────────────────────────

describe("resolveAnchor", () => {
	test("returns empty string for empty input", () => {
		expect(resolveAnchor("")).toBe("");
	});

	test("resolves symlinks for existing paths", () => {
		// tmpdir() exists, so this should resolve
		const resolved = resolveAnchor(tmpdir());
		expect(resolved.length).toBeGreaterThan(0);
		expect(resolved.startsWith("/")).toBe(true);
	});

	test("returns the raw input if path doesn't exist", () => {
		expect(resolveAnchor("/this/path/does/not/exist/12345")).toBe("/this/path/does/not/exist/12345");
	});
});

// ── resolveAbsolute ────────────────────────────────────────────────────────

describe("resolveAbsolute", () => {
	test("resolves a relative path against cwd", () => {
		expect(resolveAbsolute("src/foo.ts", "/tmp/wt")).toBe("/tmp/wt/src/foo.ts");
	});

	test("passes through an absolute path (with symlink resolution)", () => {
		const result = resolveAbsolute("/etc/hosts", "/tmp/wt");
		expect(result.startsWith("/")).toBe(true);
		expect(result === "/etc/hosts" || result === "/private/etc/hosts").toBe(true);
	});

	test("resolves symlinks when the path exists", () => {
		const result = resolveAbsolute("/tmp/foo", "/");
		expect(result.startsWith("/")).toBe(true);
	});

	test("handles non-existent paths by resolving parent + joining basename", () => {
		const result = resolveAbsolute("/tmp/this-does-not-exist-12345/foo.ts", "/");
		expect(result.startsWith("/")).toBe(true);
	});

	test("integration: resolveAbsolute → isBlocked catches macOS-realistic sibling", () => {
		// Simulate the production flow: input is a raw path; resolveAbsolute
		// resolves through symlinks; isBlocked then compares against the
		// symlink-resolved myWorktree from ctx.
		const realWt = realpathSync(tmpdir()) + sep + "pi-subagent-wt-mine";
		const realCtx = makeGuardContext(realWt, "");

		// Build a sibling path that, when resolved, looks like a sibling worktree
		const siblingRaw = realWt.replace("mine", "other") + sep + "foo.rs";
		const resolved = resolveAbsolute(siblingRaw, "/");
		expect(isBlocked(resolved, realCtx).blocked).toBe(true);
	});
});

// ── getTargetPath ──────────────────────────────────────────────────────────

describe("getTargetPath", () => {
	test("returns params.path for read/write/edit", () => {
		expect(getTargetPath("read", { path: "foo.ts" })).toBe("foo.ts");
		expect(getTargetPath("write", { path: "/abs/foo.ts" })).toBe("/abs/foo.ts");
		expect(getTargetPath("edit", { path: "x.rs" })).toBe("x.rs");
	});

	test("returns params.path or '.' for find/grep", () => {
		expect(getTargetPath("find", { path: "/tmp" })).toBe("/tmp");
		expect(getTargetPath("find", { pattern: "*.ts" })).toBe("."); // path missing
		expect(getTargetPath("grep", { path: "" })).toBe("."); // path empty
		expect(getTargetPath("grep", { path: "src" })).toBe("src");
	});

	test("returns empty string for missing required path on read/write/edit", () => {
		expect(getTargetPath("read", {})).toBe("");
		expect(getTargetPath("write", {})).toBe("");
		expect(getTargetPath("edit", { path: 123 })).toBe("");
	});

	test("returns empty string for unknown tools", () => {
		expect(getTargetPath("bash", { command: "ls" })).toBe("");
	});
});

// ── formatViolation ────────────────────────────────────────────────────────

describe("formatViolation", () => {
	test("includes the absolute path", () => {
		const msg = formatViolation(
			"/tmp/pi-subagent-wt-other/foo.rs",
			{
				blocked: true,
				reasonShort: "this is another concurrent subagent's worktree",
				reasonLong: "your worktree is /tmp/pi-subagent-wt-mine",
			},
			makeGuardContext("/tmp/pi-subagent-wt-mine", "/repo"),
		);
		expect(msg).toContain("/tmp/pi-subagent-wt-other/foo.rs");
		expect(msg).toContain("another concurrent subagent");
		expect(msg).toContain("/tmp/pi-subagent-wt-mine");
	});

	test("includes parent-repo reason when applicable", () => {
		const msg = formatViolation(
			"/repo/foo.ts",
			{ blocked: true, reasonShort: "this is the parent repo's checkout" },
			makeGuardContext("/wt", "/repo"),
		);
		expect(msg).toContain("/repo/foo.ts");
		expect(msg).toContain("parent repo");
	});

	test("uses generic guidance when no myWorktree is set", () => {
		const msg = formatViolation(
			"/x",
			{ blocked: true, reasonShort: "protected" },
			makeGuardContext("", "/repo"),
		);
		expect(msg).toContain("protected directories");
		expect(msg).not.toContain("/wt");
	});

	test("includes reasonLong in Details line when provided", () => {
		const msg = formatViolation(
			"/x",
			{
				blocked: true,
				reasonShort: "short reason",
				reasonLong: "long detail here",
			},
			makeGuardContext("/wt", ""),
		);
		expect(msg).toContain("Details: long detail here.");
	});
});

// ── makeGuardWrapper (integration tests) ───────────────────────────────────

describe("makeGuardWrapper", () => {
	function makeMockOriginal(behavior) {
		const calls = [];
		return {
			calls,
			execute: async (id, params, signal, onUpdate) => {
				calls.push({ id, params, signal, onUpdate });
				return behavior?.(calls) ?? { content: [{ type: "text", text: "OK" }], details: {} };
			},
		};
	}

	test("delegates to original when path is inside own worktree", async () => {
		const realWt = realpathSync(tmpdir()) + sep + "pi-subagent-wt-mine";
		const ctx = makeGuardContext(realWt, "");
		const original = makeMockOriginal();
		const wrapped = makeGuardWrapper("read", original, ctx);

		const extCtx = { cwd: realWt };
		const result = await wrapped("id1", { path: "src/foo.ts" }, undefined, undefined, extCtx);

		expect(original.calls.length).toBe(1);
		expect(original.calls[0].id).toBe("id1");
		expect(result.content[0].text).toBe("OK");
	});

	test("throws when path is in a sibling worktree", async () => {
		const realWt = realpathSync(tmpdir()) + sep + "pi-subagent-wt-mine";
		const ctx = makeGuardContext(realWt, "");
		const original = makeMockOriginal();
		const wrapped = makeGuardWrapper("read", original, ctx);

		const extCtx = { cwd: realWt };
		const siblingPath = realWt.replace("mine", "other") + sep + "foo.rs";

		await expect(
			wrapped("id1", { path: siblingPath }, undefined, undefined, extCtx),
		).rejects.toThrow(/Worktree-guard violation/);

		// Original must NOT have been called
		expect(original.calls.length).toBe(0);
	});

	test("throws when path is the parent repo", async () => {
		const ctx = makeGuardContext("/wt-mine", "/parent-repo");
		const original = makeMockOriginal();
		const wrapped = makeGuardWrapper("write", original, ctx);

		const extCtx = { cwd: "/wt-mine" };

		await expect(
			wrapped("id1", { path: "/parent-repo/foo.ts" }, undefined, undefined, extCtx),
		).rejects.toThrow(/parent repo/);

		expect(original.calls.length).toBe(0);
	});

	test("delegates for find with default cwd", async () => {
		const realWt = realpathSync(tmpdir()) + sep + "pi-subagent-wt-mine";
		const ctx = makeGuardContext(realWt, "");
		const original = makeMockOriginal();
		const wrapped = makeGuardWrapper("find", original, ctx);

		const extCtx = { cwd: realWt };
		// find with no path → "." which resolves to ctx.cwd = worktree
		const result = await wrapped("id1", { pattern: "*.ts" }, undefined, undefined, extCtx);

		expect(original.calls.length).toBe(1);
		expect(result.content[0].text).toBe("OK");
	});

	test("blocks find with root outside worktree", async () => {
		const realWt = realpathSync(tmpdir()) + sep + "pi-subagent-wt-mine";
		const ctx = makeGuardContext(realWt, "");
		const original = makeMockOriginal();
		const wrapped = makeGuardWrapper("find", original, ctx);

		const extCtx = { cwd: realWt };
		const outsideRoot = realWt.replace("mine", "other");

		await expect(
			wrapped("id1", { pattern: "*.ts", path: outsideRoot }, undefined, undefined, extCtx),
		).rejects.toThrow(/Worktree-guard violation/);

		expect(original.calls.length).toBe(0);
	});

	test("skips check when getTargetPath returns empty string", async () => {
		// When the params have no path field at all, the wrapper should NOT
		// throw — it should delegate to the original (which will validate
		// the params itself).
		const ctx = makeGuardContext("/wt-mine", "/parent-repo");
		const original = makeMockOriginal();
		const wrapped = makeGuardWrapper("read", original, ctx);

		const extCtx = { cwd: "/wt-mine" };
		await wrapped("id1", {}, undefined, undefined, extCtx);

		expect(original.calls.length).toBe(1);
	});

	test("integration: macOS symlink-resolved sibling is blocked end-to-end", async () => {
		// This is the bug that review-tests CRITICAL finding #2 identified:
		// when input paths are symlink-resolved (e.g. /private/var/.../T/...),
		// the own-worktree whitelist check fails because ctx.myWorktree was
		// stored as the unresolved /var/... path. With resolveAnchor applied
		// at construction time, both sides agree on /private/var/...
		const realWt = realpathSync(tmpdir()) + sep + "pi-subagent-wt-mine";
		const ctx = makeGuardContext(realWt, "");
		const original = makeMockOriginal();
		const wrapped = makeGuardWrapper("write", original, ctx);

		const extCtx = { cwd: realWt };
		// Construct a sibling path via realpath through resolveAbsolute
		const siblingRaw = realWt.replace("mine", "other") + sep + "foo.rs";
		// siblingRaw is already symlink-resolved (realWt is), so resolveAbsolute
		// returns it unchanged. The wrapper's isBlocked check must catch it.

		await expect(
			wrapped("id1", { path: siblingRaw }, undefined, undefined, extCtx),
		).rejects.toThrow(/another concurrent subagent/);

		expect(original.calls.length).toBe(0);
	});

	test("read wrapper DELEGATES for a skills/ path (skill loading works)", async () => {
		const parentCwd = "/Users/scott/Developer/pi-config";
		const ctx = makeGuardContext("/wt-mine", parentCwd);
		const original = makeMockOriginal();
		const wrapped = makeGuardWrapper("read", original, ctx);
		const extCtx = { cwd: "/wt-mine" };
		await wrapped("id1", { path: `${parentCwd}/skills/work-order-template/SKILL.md` }, undefined, undefined, extCtx);
		expect(original.calls.length).toBe(1);
	});

	test("write wrapper THROWS for a skills/ path (writes still blocked)", async () => {
		const parentCwd = "/Users/scott/Developer/pi-config";
		const ctx = makeGuardContext("/wt-mine", parentCwd);
		const original = makeMockOriginal();
		const wrapped = makeGuardWrapper("write", original, ctx);
		const extCtx = { cwd: "/wt-mine" };
		await expect(
			wrapped("id1", { path: `${parentCwd}/skills/foo.md` }, undefined, undefined, extCtx),
		).rejects.toThrow(/parent repo/);
		expect(original.calls.length).toBe(0);
	});
});

// ── Extension wiring (default export) ─────────────────────────────────────

describe("default-export extension wiring", () => {
	async function withEnv(vars, fn) {
		const old = {};
		for (const [k, v] of Object.entries(vars)) {
			old[k] = process.env[k];
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		try {
			return await fn();
		} finally {
			for (const [k, v] of Object.entries(old)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	}

	function makeMockPi() {
		const registered = [];
		return {
			pi: { registerTool: (t) => registered.push(t) },
			registered,
		};
	}

	let extension;

	test("registers no tools when both env vars are unset", async () => {
		await withEnv(
			{ PI_SUBAGENT_WORKTREE: undefined, PI_SUBAGENT_PARENT_CWD: undefined },
			async () => {
				const mod = await import("./worktree-guard.ts");
				if (!extension) extension = mod.default;
				const { pi, registered } = makeMockPi();
				extension(pi);
				expect(registered.length).toBe(0);
			},
		);
	});

	test("registers no tools when both env vars are empty strings", async () => {
		await withEnv(
			{ PI_SUBAGENT_WORKTREE: "", PI_SUBAGENT_PARENT_CWD: "" },
			async () => {
				const mod = await import("./worktree-guard.ts");
				if (!extension) extension = mod.default;
				const { pi, registered } = makeMockPi();
				extension(pi);
				expect(registered.length).toBe(0);
			},
		);
	});

	test("registers wrapped tools when worktree env is set", async () => {
		await withEnv(
			{
				PI_SUBAGENT_WORKTREE: "/tmp/pi-subagent-wt-test",
				PI_SUBAGENT_PARENT_CWD: undefined,
			},
			async () => {
				const mod = await import("./worktree-guard.ts");
				if (!extension) extension = mod.default;
				const { pi, registered } = makeMockPi();
				extension(pi);

				const names = registered.map((t) => t.name).sort();
				expect(names).toEqual(["edit", "find", "grep", "read", "write"]);

				// Verify label is updated
				const readTool = registered.find((t) => t.name === "read");
				expect(readTool.label).toBe("read (guarded)");
			},
		);
	});

	test("registered tools spread the original's parameters schema and description", async () => {
		await withEnv(
			{
				PI_SUBAGENT_WORKTREE: "/tmp/pi-subagent-wt-test",
				PI_SUBAGENT_PARENT_CWD: undefined,
			},
			async () => {
				const mod = await import("./worktree-guard.ts");
				if (!extension) extension = mod.default;
				const { pi, registered } = makeMockPi();
				extension(pi);

				const readTool = registered.find((t) => t.name === "read");
				// Original's parameters schema and description are preserved
				expect(readTool.parameters).toBeDefined();
				expect(readTool.description).toMatch(/Read the contents/);
			},
		);
	});
});
