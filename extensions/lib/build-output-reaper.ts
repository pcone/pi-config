/**
 * Build output a subagent worktree leaves on disk: its own `target/`, and its
 * share of the clone's shared cargo target dir.
 *
 * Owner 2026-11-08 (WO-2026-091), three asks: removing or reaping a worktree
 * drops its target; a finished tree kept for gating drops its target once its
 * branch lands or is abandoned; the shared per-clone dir is bounded. The box
 * went from ~250 GB free to 22 GB in a day, nearly all of it `target/` dirs and
 * per-worktree copies of workspace crates in `~/.cache/cargo-target`.
 *
 * Both removal sites call in here through `removeWorktreeTree`, so the prune
 * has one place to run. Every function is best-effort by contract: a failure is
 * returned for the caller to report, never thrown, and never blocks a removal.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { cargoTargetDirFor, cargoTargetRoot, repoNameFromWorktreePath } from "./subagent-worktree.ts";

/** Bound on one clone's shared cargo target dir: 20 GiB.
 *
 *  WO-2026-091 §Rulings records this number as the recorder's call for that order
 *  (owner 2026-11-08 asked for a bound and left the value to the recorder).
 *  GiB, not decimal GB: it is measured in `du -sk`'s unit, and GiB is what the
 *  order's premise figures were reported in. */
export const CARGO_TARGET_BOUND_BYTES = 20 * 1024 ** 3;

export function formatBytes(bytes: number): string {
	const gib = bytes / 1024 ** 3;
	if (gib >= 1) return `${gib.toFixed(1)} GiB`;
	const mib = bytes / 1024 ** 2;
	if (mib >= 1) return `${mib.toFixed(1)} MiB`;
	return `${Math.round(bytes / 1024)} KiB`;
}

// ── M1 — the worktree's own `target/` ──────────────────────────────────────

/**
 * Delete `<worktreePath>/target`, when it is a real directory.
 *
 * Returns whether anything was deleted. A symlinked `target/` is left alone:
 * lstat, not stat, because the link may point at a shared or hand-built tree
 * that is not this worktree's to delete. `onFailure` receives the unlink error
 * so the caller can put it in its own report — this never throws.
 */
export function removeWorktreeTarget(worktreePath: string, onFailure?: (detail: string) => void): boolean {
	const target = join(worktreePath, "target");
	let st;
	try {
		st = lstatSync(target);
	} catch {
		return false; // absent: nothing this worktree owns
	}
	if (!st.isDirectory() || st.isSymbolicLink()) return false;
	try {
		rmSync(target, { recursive: true, force: true });
		return true;
	} catch (e) {
		onFailure?.(`${target} not removed: ${e instanceof Error ? e.message : String(e)}`);
		return false;
	}
}

// ── M2 route 1 — the exact route ───────────────────────────────────────────

/** Dep-info files are Makefile rules: `path:` for the crate's own artifacts,
 *  then the sources. Cargo writes those source paths relative to the workspace
 *  root it was invoked for, so this matches only a build whose sources lie
 *  outside the worktree it was run in (the common case is route 2's). */
function depInfoNamesPath(content: string, worktreePath: string): boolean {
	if (!content.includes(worktreePath)) return false;
	const escaped = worktreePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|[\\s:])${escaped}(/|$)`, "m").test(content);
}

export interface ExactPruneResult {
	/** `.d` files read. */
	depInfoScanned: number;
	/** `.d` files naming the dead worktree — the crates it owns. */
	depInfoMatched: number;
	filesDeleted: number;
	dirsDeleted: number;
	/** Read/delete failures, unswallowed. */
	problems: string[];
}

/**
 * `pruneCargoArtifactsFor`'s route 1, alone so the bound can run a per-path
 * exact pass without a `cargo clean` per path.
 *
 * A `.d` naming the worktree owns that crate unit: delete its sibling artifacts
 * by stem (`.rmeta`, `.rlib`, `.a`, `.so`, the linked binary, `.o` parts, the
 * `.d` itself) and its `.fingerprint` / `build` dirs. Cargo names dep-info by
 * the *target* (`foo_bar-<hash>.d`) and fingerprints by the *package*
 * (`foo-bar-<hash>`), so both spellings are tried. Incremental dirs carry no
 * path and are left for route 2.
 */
export function pruneExactArtifacts(cargoTargetDir: string, worktreePath: string): ExactPruneResult {
	const result: ExactPruneResult = { depInfoScanned: 0, depInfoMatched: 0, filesDeleted: 0, dirsDeleted: 0, problems: [] };

	const dropPath = (p: string, isDir: boolean): void => {
		try {
			rmSync(p, { recursive: isDir, force: true });
			if (isDir) result.dirsDeleted++;
			else result.filesDeleted++;
		} catch (e) {
			result.problems.push(`${p} not removed: ${e instanceof Error ? e.message : String(e)}`);
		}
	};

	let profiles: string[];
	try {
		profiles = readdirSync(cargoTargetDir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
	} catch (e) {
		result.problems.push(`${cargoTargetDir} not readable: ${e instanceof Error ? e.message : String(e)}`);
		return result;
	}

	for (const profile of profiles) {
		const depsDir = join(cargoTargetDir, profile, "deps");
		let depInfo: string[];
		try {
			depInfo = readdirSync(depsDir).filter((f) => f.endsWith(".d"));
		} catch {
			continue; // no deps dir in this profile
		}
		const stems = new Set<string>();
		for (const name of depInfo) {
			result.depInfoScanned++;
			let content: string;
			try {
				content = readFileSync(join(depsDir, name), "utf8");
			} catch (e) {
				result.problems.push(`${join(depsDir, name)} not readable: ${e instanceof Error ? e.message : String(e)}`);
				continue;
			}
			if (depInfoNamesPath(content, worktreePath)) stems.add(name.slice(0, -".d".length));
		}
		if (stems.size === 0) continue;
		result.depInfoMatched += stems.size;

		let depEntries: string[] = [];
		try {
			depEntries = readdirSync(depsDir);
		} catch { /* listed above */ }

		for (const stem of stems) {
			// Every artifact of the unit shares the stem: `lib<stem>.rlib` and
			// `<stem>.rmeta` for a library target, `<stem>.<hash>.rcgu.o` parts, the
			// `<stem>` binary for a bin target. Cargo prefixes library artifacts with
			// `lib`, which the stem (taken from the `.d` name) does not carry.
			const names = [stem, `lib${stem}`];
			for (const name of depEntries) {
				if (!names.some((n) => name === n || name.startsWith(`${n}.`))) continue;
				dropPath(join(depsDir, name), false);
			}
			// `<pkg>-<hash>`: cargo uses the target name (`_`) for dep-info and the
			// package name (`-`) for fingerprints and build-script output.
			const cut = stem.lastIndexOf("-");
			if (cut <= 0) continue;
			const hash = stem.slice(cut + 1);
			const pkgNames = new Set([stem.slice(0, cut), stem.slice(0, cut).replace(/_/g, "-")]);
			for (const pkg of pkgNames) {
				for (const [sub, isDir] of [[".fingerprint", true], ["build", true]] as const) {
					const candidate = join(cargoTargetDir, profile, sub, `${pkg}-${hash}`);
					let st;
					try {
						st = lstatSync(candidate);
					} catch {
						continue;
					}
					if (st.isDirectory()) dropPath(candidate, isDir);
				}
			}
		}
	}

	return result;
}

// ── M2 route 2 — the coarse route ──────────────────────────────────────────

export type CommandRunner = (
	cmd: string,
	args: string[],
	opts: { cwd: string; env?: Record<string, string> },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

const spawnRunner: CommandRunner = (cmd, args, opts) =>
	new Promise((resolve) => {
		const env = { ...process.env, ...opts.env };
		const child = spawn(cmd, args, { cwd: opts.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
		child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
		child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
		child.on("error", (e: Error) => resolve({ stdout, stderr: stderr || e.message, exitCode: 1 }));
	});

/** `[workspace] members = [...]` entries of a Cargo.toml, or null when the
 *  manifest is not a workspace. Quote/comma splitting only: the entries are
 *  paths, and a glob entry is reported rather than expanded. */
export function cargoWorkspaceMembers(manifest: string): string[] | null {
	if (!/^\s*\[workspace\]/m.test(manifest)) return null;
	const match = /^\s*members\s*=\s*\[([\s\S]*?)\]/m.exec(manifest);
	if (!match) return [];
	return match[1]
		.split("\n")
		.map((line) => line.replace(/#.*$/, ""))
		.join("\n")
		.split(",")
		.map((entry) => entry.trim().replace(/^["']|["']$/g, "").trim())
		.filter((entry) => entry.length > 0);
}

export interface CoarsePruneResult {
	/** Members `cargo clean -p` ran for. */
	membersCleaned: string[];
	problems: string[];
}

/**
 * `cargo clean -p <member>` for every workspace member of the parent checkout.
 *
 * This drops every copy of the workspace crate, including other worktrees' —
 * it cannot tell them apart — while leaving registry-crate artifacts, the
 * expensive half the shared dir exists to keep. A repo that is not a cargo
 * workspace has nothing to clean this way.
 */
export async function cleanCargoWorkspaceMembers(
	cargoTargetDir: string,
	parentCwd: string,
	run: CommandRunner = spawnRunner,
): Promise<CoarsePruneResult> {
	const result: CoarsePruneResult = { membersCleaned: [], problems: [] };
	const manifest = join(parentCwd, "Cargo.toml");
	let text: string;
	try {
		text = readFileSync(manifest, "utf8");
	} catch {
		result.problems.push(`no ${manifest}: not a cargo workspace`);
		return result;
	}
	const members = cargoWorkspaceMembers(text);
	if (members === null) {
		result.problems.push(`${manifest} is not a [workspace] manifest`);
		return result;
	}
	for (const member of members) {
		if (member.includes("*")) {
			result.problems.push(`workspace member glob not expanded: ${member}`);
			continue;
		}
		const cleaned = await run("cargo", ["clean", "-p", member], {
			cwd: parentCwd,
			env: { CARGO_TARGET_DIR: cargoTargetDir },
		});
		if (cleaned.exitCode === 0) result.membersCleaned.push(member);
		else result.problems.push(`cargo clean -p ${member} failed: ${cleaned.stderr.trim() || `exit ${cleaned.exitCode}`}`);
	}
	return result;
}

// ── M2 — one worktree's share of the shared dir ────────────────────────────

export interface CargoPruneResult {
	route: "exact" | "coarse" | "none";
	depInfoScanned: number;
	depInfoMatched: number;
	filesDeleted: number;
	dirsDeleted: number;
	membersCleaned: string[];
	problems: string[];
}

export interface CargoPruneOptions {
	/** The parent checkout route 2 runs in. Absent → route 2 cannot run. */
	parentCwd?: string;
	/** Injection seam for the coarse route's cargo calls (tests). */
	run?: CommandRunner;
}

/**
 * Drop one worktree's artifacts from a clone's shared cargo target dir.
 *
 * Route 1 (exact) when a `.d` names the worktree; otherwise route 2, which is
 * all-or-nothing per workspace crate. Both are best-effort: failures come back
 * in `problems`, never thrown.
 */
export async function pruneCargoArtifactsFor(
	cargoTargetDir: string,
	worktreePath: string,
	opts: CargoPruneOptions = {},
): Promise<CargoPruneResult> {
	const exact = pruneExactArtifacts(cargoTargetDir, worktreePath);
	const base = {
		depInfoScanned: exact.depInfoScanned,
		depInfoMatched: exact.depInfoMatched,
		filesDeleted: exact.filesDeleted,
		dirsDeleted: exact.dirsDeleted,
		membersCleaned: [] as string[],
		problems: [...exact.problems],
	};
	if (exact.depInfoMatched > 0) return { route: "exact", ...base };

	if (!opts.parentCwd) return { route: "none", ...base, problems: [...base.problems, "no parent checkout for the coarse route"] };
	const coarse = await cleanCargoWorkspaceMembers(cargoTargetDir, opts.parentCwd, opts.run);
	return {
		route: coarse.membersCleaned.length > 0 ? "coarse" : "none",
		...base,
		membersCleaned: coarse.membersCleaned,
		problems: [...base.problems, ...coarse.problems],
	};
}

// ── Both, for one removal ──────────────────────────────────────────────────

export interface BuildOutputReport {
	/** `<worktreePath>/target` was a real directory and was deleted. */
	targetRemoved: boolean;
	/** The shared-dir prune, when the path names a clone under the namespace. */
	cargo?: CargoPruneResult;
	/** Unswallowed failures from either step. */
	problems: string[];
}

/** M1 then M2 for a worktree that has just been removed. */
export async function disposeWorktreeBuildOutput(
	worktreePath: string,
	parentCwd: string,
	opts: { run?: CommandRunner; home?: string } = {},
): Promise<BuildOutputReport> {
	const problems: string[] = [];
	const targetRemoved = removeWorktreeTarget(worktreePath, (detail) => problems.push(detail));
	const repoName = repoNameFromWorktreePath(worktreePath, opts.home);
	if (!repoName) return { targetRemoved, problems }; // not a subagent worktree: no shared dir
	const cargo = await pruneCargoArtifactsFor(cargoTargetDirFor(repoName, opts.home), worktreePath, {
		parentCwd,
		run: opts.run,
	});
	return { targetRemoved, cargo, problems };
}

/** One line for a `ReapResult.detail` / debug log, or null when nothing was
 *  dropped and nothing went wrong. */
export function describePrune(cargo: CargoPruneResult): string | null {
	const parts: string[] = [];
	if (cargo.depInfoMatched > 0) {
		parts.push(
			`${cargo.filesDeleted} files + ${cargo.dirsDeleted} dirs from ${cargo.depInfoMatched}/${cargo.depInfoScanned} .d (exact)`,
		);
	} else if (cargo.membersCleaned.length > 0) {
		parts.push(`cargo clean -p ${cargo.membersCleaned.join(",")} (coarse)`);
	} else if (cargo.route === "none" && cargo.depInfoScanned > 0) {
		parts.push(`shared dir untouched (${cargo.depInfoMatched}/${cargo.depInfoScanned} .d)`);
	}
	if (cargo.problems.length > 0) parts.push(`problems: ${cargo.problems.join("; ")}`);
	return parts.length > 0 ? parts.join("; ") : null;
}

/** Same, for a whole M1 + M2 pass. */
export function describeBuildOutput(report: BuildOutputReport): string | null {
	const parts: string[] = [];
	if (report.targetRemoved) parts.push("target/ removed");
	if (report.cargo) {
		const prune = describePrune(report.cargo);
		if (prune) parts.push(prune);
	}
	if (report.problems.length > 0) parts.push(`problems: ${report.problems.join("; ")}`);
	return parts.length > 0 ? parts.join("; ") : null;
}

// ── M4 — a worktree kept for gating ────────────────────────────────────────

export interface LandedTargetResult {
	dropped: boolean;
	/** `merged` / `gone` end the build output's claim; `live` keeps it. */
	state: "merged" | "gone" | "live" | "unknown";
	/** Unswallowed failures from the target delete, for the caller's report. */
	problems: string[];
	/** Why the branch state could not be read — informational, not a failure. */
	detail?: string;
}

export interface LandedTargetOptions {
	/** Injection seam for tests. */
	run?: CommandRunner;
}

/**
 * M4: a tree the reap keeps (because its tree is not reapable) keeps its
 * `target/` only while its isolation branch still holds unlanded work. Once the
 * branch is merged into the parent's current HEAD, or no longer exists, the
 * build output has no claim on disk and goes; the tree itself stays, so
 * `subagent_resume` and inspection still work.
 */
export async function dropLandedWorktreeTarget(
	facts: { worktreePath: string; branch: string | null; parentCwd: string },
	opts: LandedTargetOptions = {},
): Promise<LandedTargetResult> {
	const run = opts.run ?? spawnRunner;
	const { worktreePath, branch, parentCwd } = facts;
	if (!branch) return { dropped: false, state: "unknown", problems: [], detail: "no isolation branch recorded" };
	if (!existsSync(parentCwd)) {
		return { dropped: false, state: "unknown", problems: [], detail: `parent checkout gone: ${parentCwd}` };
	}

	const drop = (state: "merged" | "gone"): LandedTargetResult => {
		const problems: string[] = [];
		const dropped = removeWorktreeTarget(worktreePath, (detail) => problems.push(detail));
		return { dropped, state, problems };
	};

	// `-c color.branch=false`: with `color.branch=always` every listed name carries
	// ANSI codes, the comparison below never matches and M4 would silently never
	// fire.
	const merged = await run("git", ["-c", "color.branch=false", "branch", "--merged", "HEAD"], { cwd: parentCwd });
	if (merged.exitCode !== 0) {
		return { dropped: false, state: "unknown", problems: [], detail: `git branch --merged failed: ${merged.stderr.trim()}` };
	}
	// `git branch` lists `* <name>`, `+ <name>` (in another worktree) and spaces.
	const isMerged = merged.stdout.split("\n").some((line) => line.replace(/^[*+]?\s*/, "").trim() === branch);
	if (isMerged) return drop("merged");

	const exists = await run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: parentCwd });
	if (exists.exitCode !== 0) return drop("gone");
	return { dropped: false, state: "live", problems: [] };
}

// ── M3 — the bound ─────────────────────────────────────────────────────────

export interface DeadWorktree {
	worktreePath: string;
	/** The parent checkout, for the coarse pass. Empty when the meta has none. */
	parentCwd: string;
}

/**
 * Allocated size of `dir` in bytes, in `du -sk`'s unit — the measure the order
 * states the bound in and the one its premise measured.
 *
 * `du` is the native tool that counts an extent shared by clones or hard links
 * once. Summing `st_blocks` per file does not: on this box it over-reports
 * `~/.cache/cargo-target/tfd-gate-424-prep` by 2.2x (17.7 GiB against du's
 * 8.2 GiB), because cargo's build-script outputs are hard-linked into the
 * worktree's own target. A bound that fires at half the stated size is worse
 * than no bound. Cost: one walk per clone dir, ~1.1 s for this box's 12.4 GiB.
 *
 * Throws when the measure fails. A directory that cannot be measured is not an
 * under-bound directory, and answering 0 would switch the bound off silently —
 * the caller reports the failure instead.
 */
export async function dirSizeBytes(dir: string, run: CommandRunner = spawnRunner): Promise<number> {
	const sized = await run("du", ["-sk", dir], { cwd: homedir() });
	if (sized.exitCode !== 0) {
		throw new Error(`du -sk ${dir} failed: ${sized.stderr.trim() || `exit ${sized.exitCode}`}`);
	}
	const kb = Number.parseInt(sized.stdout.trim().split(/\s+/)[0] ?? "", 10);
	if (!Number.isFinite(kb)) throw new Error(`du -sk ${dir} printed no size: ${JSON.stringify(sized.stdout.trim())}`);
	return kb * 1024;
}

export interface CargoBoundAction {
	cargoTargetDir: string;
	/** Dead worktrees whose share route 1 tries, path by path. */
	worktreePaths: string[];
	/** One coarse pass over the clone's workspace members, when route 1 leaves
	 *  the dir over the bound. */
	coarsePrune: boolean;
}

/**
 * The bound's plan, pure: which shared dirs are over `boundBytes` and what the
 * reap may do about them. Over-bound dirs get route 1 for every dead worktree
 * of that clone, then one coarse pass. Under the bound, nothing.
 */
export function planCargoBound(
	dirSizes: Array<{ cargoTargetDir: string; bytes: number }>,
	dead: DeadWorktree[],
	boundBytes: number = CARGO_TARGET_BOUND_BYTES,
	home: string = homedir(),
): CargoBoundAction[] {
	const actions: CargoBoundAction[] = [];
	for (const dir of dirSizes) {
		if (dir.bytes <= boundBytes) continue;
		const paths: string[] = [];
		for (const candidate of dead) {
			const repoName = repoNameFromWorktreePath(candidate.worktreePath, home);
			if (!repoName) continue;
			if (cargoTargetDirFor(repoName, home) !== dir.cargoTargetDir) continue;
			if (!paths.includes(candidate.worktreePath)) paths.push(candidate.worktreePath);
		}
		actions.push({ cargoTargetDir: dir.cargoTargetDir, worktreePaths: paths, coarsePrune: true });
	}
	return actions;
}

export interface CargoBoundEntryReport {
	cargoTargetDir: string;
	beforeBytes: number;
	afterBytes: number;
	/** Still over the bound after both passes: reported, never force-cleaned. */
	overBound: boolean;
	route: "none" | "exact" | "coarse";
	worktreePathsPruned: number;
	depInfoScanned: number;
	depInfoMatched: number;
	membersCleaned: string[];
	problems: string[];
}

export interface CargoBoundReport {
	boundBytes: number;
	entries: CargoBoundEntryReport[];
	/** Unswallowed failures outside any one entry — e.g. a dir that could not be
	 *  measured, which therefore cannot be judged over the bound. */
	problems: string[];
}

export interface CargoBoundOptions {
	/** The home whose `~/.cache/cargo-target` holds one dir per clone. */
	home?: string;
	deadWorktrees: DeadWorktree[];
	boundBytes?: number;
	/** Injection seams: a real 20 GB fixture is not how R5 gets tested. */
	sizeOf?: (dir: string) => number | Promise<number>;
	run?: CommandRunner;
}

/**
 * M3: enforce the bound on every clone's shared dir, once per reap.
 *
 * Order: route 1 for each dead worktree of an over-bound clone, re-measure,
 * then one coarse pass over that clone's workspace members, re-measure. A dir
 * still over is reported as over-bound — never a full `cargo clean`, which is
 * exactly the registry rebuild the shared dir exists to avoid.
 */
export async function enforceCargoTargetBound(opts: CargoBoundOptions): Promise<CargoBoundReport> {
	const sizeOf = opts.sizeOf ?? dirSizeBytes;
	const boundBytes = opts.boundBytes ?? CARGO_TARGET_BOUND_BYTES;
	const home = opts.home ?? homedir();
	const cacheRoot = cargoTargetRoot(home);
	const report: CargoBoundReport = { boundBytes, entries: [], problems: [] };

	let cloneDirs: string[];
	try {
		cloneDirs = readdirSync(cacheRoot, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => join(cacheRoot, e.name));
	} catch {
		return report; // no shared dir yet: nothing is over a bound
	}

	// One walk per clone dir, concurrently: a reap cannot start a second one
	// before this finishes, and two `du` runs on one volume cost the slower one.
	// A dir whose size cannot be read is reported and skipped: it has no size to
	// compare with the bound, and treating that as 0 would disable the bound.
	const dirSizes: Array<{ cargoTargetDir: string; bytes: number }> = [];
	for (const cargoTargetDir of cloneDirs) {
		try {
			dirSizes.push({ cargoTargetDir, bytes: await sizeOf(cargoTargetDir) });
		} catch (e) {
			report.problems.push(`could not measure ${cargoTargetDir}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	const parentCwdFor = (cargoTargetDir: string): string | undefined =>
		opts.deadWorktrees.find((d) => {
			const repoName = repoNameFromWorktreePath(d.worktreePath, home);
			return repoName !== null && cargoTargetDirFor(repoName, home) === cargoTargetDir && d.parentCwd.length > 0;
		})?.parentCwd;

	for (const action of planCargoBound(dirSizes, opts.deadWorktrees, boundBytes, home)) {
		const entry: CargoBoundEntryReport = {
			cargoTargetDir: action.cargoTargetDir,
			beforeBytes: dirSizes.find((d) => d.cargoTargetDir === action.cargoTargetDir)!.bytes,
			afterBytes: 0,
			overBound: false,
			route: "none",
			worktreePathsPruned: 0,
			depInfoScanned: 0,
			depInfoMatched: 0,
			membersCleaned: [],
			problems: [],
		};

		// (a) route 1 for every dead worktree path of this clone.
		let pruned = 0;
		for (const worktreePath of action.worktreePaths) {
			const exact = pruneExactArtifacts(action.cargoTargetDir, worktreePath);
			entry.depInfoScanned += exact.depInfoScanned;
			entry.depInfoMatched += exact.depInfoMatched;
			entry.problems.push(...exact.problems);
			if (exact.depInfoMatched > 0) pruned++;
		}
		entry.worktreePathsPruned = pruned;
		if (pruned > 0) entry.route = "exact";

		// (b) still over: one coarse pass for the clone.
		let after: number;
		try {
			after = await sizeOf(action.cargoTargetDir);
		} catch (e) {
			entry.problems.push(`could not re-measure: ${e instanceof Error ? e.message : String(e)}`);
			entry.afterBytes = entry.beforeBytes;
			entry.overBound = true;
			report.entries.push(entry);
			continue;
		}
		if (after > boundBytes && action.coarsePrune) {
			const parentCwd = parentCwdFor(action.cargoTargetDir);
			if (parentCwd) {
				const coarse = await cleanCargoWorkspaceMembers(action.cargoTargetDir, parentCwd, opts.run);
				entry.membersCleaned = coarse.membersCleaned;
				entry.problems.push(...coarse.problems);
				if (coarse.membersCleaned.length > 0) entry.route = "coarse";
				after = await sizeOf(action.cargoTargetDir);
			} else {
				entry.problems.push("no parent checkout recorded for this clone: coarse pass skipped");
			}
		}
		entry.afterBytes = after;
		entry.overBound = after > boundBytes;
		report.entries.push(entry);
	}

	return report;
}

// ── The reap's build-output half ───────────────────────────────────────────

export interface ReapBuildOutputOptions {
	/** The home whose `~/.cache/cargo-target` holds one dir per clone. */
	home?: string;
	/** Injection seams, passed through to the bound and M4. */
	run?: CommandRunner;
	sizeOf?: (dir: string) => number | Promise<number>;
}

export interface KeptTargetNote {
	/** Fragments for the caller's `ReapResult.detail`: the drop, and its failures. */
	notes: string[];
	/** Why nothing was dropped — informational, for the caller's log. */
	keptBecause: string | null;
}

/**
 * One reap's build-output half: the dead set M3 prunes, M4 for a tree the reap
 * keeps, and M3 itself once at the end.
 *
 * The reap owns its loop and its gates; this owns everything that touches a
 * `target/` or a shared dir, so there is one implementation of it and the reap
 * is not the repo's fastest-growing file. Lines and detail fragments come back
 * to the caller: this module never writes to the reap's log and never throws.
 */
export interface ReapBuildOutput {
	/** Record a namespace worktree path that no longer exists. One `existsSync`,
	 *  idempotent: called on the registry walk the reap already does. A path
	 *  outside the namespace has no clone to attribute to and is ignored. */
	noteGone(worktreePath: string, parentCwd: string): void;
	/** M4 for a tree the reap is keeping. */
	dropKeptTarget(facts: { worktreePath: string; branch: string | null; parentCwd: string }): Promise<KeptTargetNote>;
	/** M3 once, at the end of the reap. Returns the log lines it would have written. */
	enforceBound(): Promise<string[]>;
}

export function createReapBuildOutput(opts: ReapBuildOutputOptions = {}): ReapBuildOutput {
	const home = opts.home ?? homedir();
	const dead = new Map<string, DeadWorktree>();
	return {
		noteGone(worktreePath, parentCwd) {
			if (!repoNameFromWorktreePath(worktreePath, home)) return;
			if (existsSync(worktreePath)) return;
			if (dead.has(worktreePath)) return;
			dead.set(worktreePath, { worktreePath, parentCwd });
		},
		async dropKeptTarget(facts) {
			const landed = await dropLandedWorktreeTarget(facts, { run: opts.run });
			const notes = [landed.dropped ? `target/ dropped (branch ${landed.state})` : null, ...landed.problems];
			return {
				notes: notes.filter((note): note is string => note !== null),
				keptBecause: landed.detail ?? null,
			};
		},
		async enforceBound() {
			const lines: string[] = [];
			try {
				const bound = await enforceCargoTargetBound({
					home,
					deadWorktrees: [...dead.values()],
					run: opts.run,
					sizeOf: opts.sizeOf,
				});
				for (const problem of bound.problems) lines.push(`reap: cargo bound: ${problem}`);
				for (const entry of bound.entries) {
					lines.push(
						`reap: shared dir ${entry.overBound ? "OVER" : "under"} bound ${entry.cargoTargetDir}: ` +
							`${formatBytes(entry.beforeBytes)} → ${formatBytes(entry.afterBytes)} ` +
							`(bound ${formatBytes(bound.boundBytes)}, route ${entry.route}, ${entry.worktreePathsPruned} dead paths)` +
							`${entry.problems.length > 0 ? ` problems: ${entry.problems.join("; ")}` : ""}`,
					);
				}
			} catch (e) {
				// The reap runs on every session start: a bound that cannot run reports
				// it and lets the reap finish, rather than aborting the walk's results.
				lines.push(`reap: cargo bound failed: ${e instanceof Error ? e.message : String(e)}`);
			}
			return lines;
		},
	};
}
