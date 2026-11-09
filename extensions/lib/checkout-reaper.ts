/**
 * Every checkout under `~/Developer/wt`, reaped when nothing it holds exists
 * anywhere else (WO-2026-092, owner 2026-11-08).
 *
 * One walk classifies each top-level entry — linked `worktree`, standalone
 * `clone`, `scratch` (no `.git`) and `other` — and then the subagent namespace
 * beneath it. A checkout is removed only when every gate holds: clean, nothing
 * only local, unused, idle. One that fails a gate is reported, never deleted,
 * with the specific thing that would be lost: dirty file count, unpushed
 * commits with their branches, stash entries, ignored bytes, or the pid holding
 * it. The report is `~/Developer/wt/.reaper-report.json`, written on every pass
 * whether it held anything or not.
 *
 * Two facts shape the implementation more than the rest:
 *
 * - **Cost.** This runs at every session start. The classification and the one
 *   `lsof` pass cost ~0.5 s on this box's ~300 entries, and a gate costs one
 *   git spawn, so the gates run under a wall-time budget: what the pass did not
 *   reach is reported as deferred, not silently kept.
 * - **Nothing goes with unsaved work.** A gate that cannot be evaluated is a
 *   keep. There is one removal path for a worktree, `removeWorktreeTree`
 *   (WO-2026-091), passed in as `removeWorktree`; this module never runs
 *   `git worktree remove` itself.
 *
 * Design: `docs/design/checkout-reaper.md`. Decision:
 * `decisions/subagents/049-wt-checkout-reaper.md`.
 *
 * No pi import: this module stays unit-testable.
 */
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import {
	type BuildOutputReport,
	type CargoPruneResult,
	type CommandRunner,
	describeBuildOutput,
	pruneCargoArtifactsFor,
	sharedDepInfoFiles,
	spawnRunner,
} from "./build-output-reaper.ts";
import { runGit } from "./git-run.ts";
import { cargoTargetDirFor, cargoTargetRoot, repoNameFromWorktreePath, subagentWorktreeBase } from "./subagent-worktree.ts";
import { listSubagentMetas } from "./subagent-state.ts";

// ── The recorder's calls, as constants ─────────────────────────────────────

/** A checkout whose newest write is older than this is idle enough to be a
 *  candidate. The owner asked for "no longer needed" and left the number to the
 *  recorder, who set 7 days (WO-2026-092 §Rulings). */
export const IDLE_DAYS = 7;

/** Wall-time bound on one pass, gates included. Measured, not asserted:
 *  `docs/design/checkout-reaper.md` §Cost carries the numbers behind it. */
export const REAPER_PASS_BUDGET_MS = 1_800;

/** Where the pass leaves what it kept. Written even when it kept nothing. */
export const REAPER_REPORT_FILE = ".reaper-report.json";

/** Files the scratch size walk stats before it stops and reports a floor. */
const SCRATCH_WALK_CAP = 2_000;

const MS_PER_DAY = 86_400_000;

// ── The walk ───────────────────────────────────────────────────────────────

/** A linked worktree (`.git` file), a standalone clone (`.git` directory), a
 *  directory with no `.git` at all, or a shape this module will not judge. */
export type CheckoutKind = "worktree" | "clone" | "scratch" | "other";

/** Which reaper owns the removal decision. The subagent namespace is 027's
 *  (`reapFinishedWorktrees`): the general walk reports those rows and leaves
 *  their gates alone. */
export type CheckoutScope = "wt" | "subagents";

export interface CheckoutEntry {
	path: string;
	kind: CheckoutKind;
	scope: CheckoutScope;
	/** The repository a linked worktree belongs to, derived from its gitdir. */
	parentCwd: string | null;
	/** `<clone>/.git` or `<clone>/.git/worktrees/<name>`; null for scratch. */
	gitDir: string | null;
	/** Days since the newest write to the checkout's own git metadata, or null
	 *  when none of it could be read. */
	ageDays: number | null;
}

export interface WalkOptions {
	/** `~/Developer/wt`. */
	root: string;
	/** `~/Developer/wt/subagents`. */
	subagentBase: string;
	now?: number;
}

/** `~/Developer/wt` and the subagent namespace inside it, for one home. */
export function wtRoots(home: string = homedir()): { root: string; subagentBase: string } {
	const subagentBase = subagentWorktreeBase(home);
	return { root: path.dirname(subagentBase), subagentBase };
}

/**
 * Every candidate under `root` and `subagentBase`, classified and aged. No
 * spawns: one `readdir` per scope, one `lstat` per entry, and a handful of
 * `stat`s on the paths that move when a checkout is written to.
 *
 * The age is the newest write to the checkout's **own** git metadata — index,
 * HEAD, the worktree's own reflog. A shared path is deliberately not read:
 * `packed-refs` and `refs/` are one copy per clone, so a commit in one worktree
 * would age every sibling. The screen only decides what to look at; the removal
 * itself re-checks the tree's own newest file mtime (`treeNewestWithin`), and a
 * checkout holding uncommitted or unpushed work fails the clean and pushed
 * gates whatever its age says.
 */
export function walkCheckouts(opts: WalkOptions): CheckoutEntry[] {
	const now = opts.now ?? Date.now();
	const entries: CheckoutEntry[] = [];
	const seen = new Set<string>();
	for (const [scope, parent] of [["wt", opts.root], ["subagents", opts.subagentBase]] as const) {
		for (const name of readNames(parent)) {
			const full = path.join(parent, name);
			if (seen.has(full)) continue;
			seen.add(full);
			entries.push(classify(full, scope, now));
		}
	}
	return entries;
}

function readNames(dir: string): string[] {
	let dirents: fs.Dirent[];
	try {
		dirents = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return []; // no such scope: nothing to walk
	}
	return dirents
		.filter((d) => !d.name.startsWith(".") && (d.isDirectory() || d.isSymbolicLink()))
		.map((d) => d.name)
		.sort();
}

function classify(full: string, scope: CheckoutScope, now: number): CheckoutEntry {
	let dotGit: fs.Stats;
	try {
		dotGit = fs.lstatSync(path.join(full, ".git"));
	} catch {
		return { path: full, kind: "scratch", scope, parentCwd: null, gitDir: null, ageDays: ageOf([full], now) };
	}
	if (dotGit.isFile()) {
		const gitDir = readGitDirFile(path.join(full, ".git"));
		if (!gitDir) return { path: full, kind: "other", scope, parentCwd: null, gitDir: null, ageDays: null };
		return {
			path: full,
			kind: "worktree",
			scope,
			parentCwd: parentRepoOf(gitDir),
			gitDir,
			ageDays: ageOf(metaPaths(gitDir, "worktree"), now),
		};
	}
	if (dotGit.isDirectory()) {
		return { path: full, kind: "clone", scope, parentCwd: null, gitDir: path.join(full, ".git"), ageDays: ageOf(metaPaths(path.join(full, ".git"), "clone"), now) };
	}
	// A symlinked `.git`, a socket, a directory whose `.git` is something else:
	// not a shape this module judges, so not a shape it removes.
	return { path: full, kind: "other", scope, parentCwd: null, gitDir: null, ageDays: null };
}

/** `gitdir: <path>` from a linked worktree's `.git` file. A relative gitdir is
 *  resolved against the worktree, which is what git itself does. */
function readGitDirFile(dotGit: string): string | null {
	let text: string;
	try {
		text = fs.readFileSync(dotGit, "utf8");
	} catch {
		return null;
	}
	const match = /^gitdir:\s*(.+)$/m.exec(text);
	if (!match) return null;
	const target = match[1].trim();
	if (target.length === 0) return null;
	return path.resolve(path.dirname(dotGit), target);
}

/** `<repo>/.git/worktrees/<name>` → `<repo>`. Null for any other admin dir: a
 *  hand-made gitdir gives the removal no parent to run git in, and
 *  `removeWorktreeTree` then falls back to the tree itself. */
function parentRepoOf(gitDir: string): string | null {
	const parts = gitDir.split(path.sep);
	if (parts.length < 4) return null;
	if (parts[parts.length - 3] !== ".git" || parts[parts.length - 2] !== "worktrees") return null;
	const repo = parts.slice(0, -3).join(path.sep);
	return repo.length === 0 ? path.sep : repo;
}

/** The files that move when someone works in *this* checkout. */
function metaPaths(gitDir: string, kind: "worktree" | "clone"): string[] {
	const names =
		kind === "clone"
			? ["index", "HEAD", "ORIG_HEAD", "MERGE_HEAD", "FETCH_HEAD", "packed-refs", "logs/HEAD"]
			: ["index", "HEAD", "ORIG_HEAD", "MERGE_HEAD", "REBASE_HEAD", "locked", "logs/HEAD"];
	return names.map((name) => path.join(gitDir, name));
}

/** Days since the newest mtime among `paths`, or null when not one is readable
 *  — an age nobody read is not "old". */
function ageOf(paths: string[], now: number): number | null {
	let newest = 0;
	for (const p of paths) {
		try {
			const st = fs.statSync(p);
			if (st.mtimeMs > newest) newest = st.mtimeMs;
		} catch {
			/* absent: a checkout has no MERGE_HEAD most of the time */
		}
	}
	return newest === 0 ? null : (now - newest) / MS_PER_DAY;
}

// ── The report ─────────────────────────────────────────────────────────────

/** Why a checkout was left alone. `budget` is not a gate — the pass ran out of
 *  wall time before reaching it, and the next pass will. */
export type KeepGate =
	| "scratch"
	| "other"
	| "active"
	| "age-unknown"
	| "no-cwd-evidence"
	| "in-use"
	| "locked"
	| "dirty"
	| "stash"
	| "unpushed"
	| "git-error"
	| "subagent"
	| "budget"
	| "dry-run";

/** The thing that would be lost if the checkout were deleted now. */
export interface UnsavedFacts {
	/** The branch the checkout has out. */
	branch?: string | null;
	/** `git status --porcelain -uall` lines: modified, staged and untracked. */
	dirtyFiles?: number;
	/** Stash entries this checkout would lose — all of a clone's, the ones on
	 *  this worktree's branch for a worktree. */
	stashes?: number;
	/** Commits on this checkout's local branches not reachable from any remote
	 *  ref, and the branches that carry them. */
	unpushedCommits?: number;
	unpushedBranches?: string[];
	/** Bytes git ignores inside the tree. Deleted with it: an ignored file is not
	 *  a blocker (M2 gate 3), so the report names the bytes instead. */
	ignoredBytes?: number;
	/** The process whose cwd is inside the checkout. */
	pid?: number;
	processCwd?: string;
	/** Days since the newest non-ignored file changed, when the tree failed the
	 *  removal-time mtime check while its git metadata looked old. */
	newestFileDays?: number;
}

/** What went with a removed checkout. */
export interface RemovedFacts {
	/** The branch deleted with it, when one was. */
	branchDeleted?: string | null;
	/** 091's build-output line: `target/` and the clone's shared cargo dir. */
	buildOutput?: string;
	buildOutputReport?: BuildOutputReport;
	/** The shared dir this pass pruned for a checkout 091 does not attribute (a
	 *  seat-made tree outside the subagent namespace). */
	cargo?: CargoPruneResult;
	/** R12: `.d` files this removal took that also named another checkout still
	 *  on disk. That checkout rebuilds the unit; this says so. */
	sharedWith?: Array<{ depInfo: string; checkouts: string[] }>;
}

export interface ReaperRow {
	path: string;
	kind: CheckoutKind;
	scope: CheckoutScope;
	/** Null when no git metadata could be read (`age-unknown`). */
	ageDays: number | null;
	state: "removed" | "kept" | "deferred";
	gate: KeepGate | null;
	detail?: string;
	unsaved?: UnsavedFacts;
	removed?: RemovedFacts;
	/** Scratch rows: measured bytes, and whether the walk stopped early — `true`
	 *  means `bytes` is a floor, not a total. */
	bytes?: number;
	bytesLowerBound?: boolean;
	checkedAt: string;
}

export interface ReaperReport {
	generatedAt: string;
	/** The pass's wall-time bound, and what it actually took. */
	budgetMs: number;
	elapsedMs: number;
	removed: ReaperRow[];
	kept: ReaperRow[];
	deferred: ReaperRow[];
	/** Failures outside any one row. */
	problems: string[];
}

export function reportPath(root: string): string {
	return path.join(root, REAPER_REPORT_FILE);
}

/** The last pass's report, or null when none was written, it is unreadable, or
 *  it is from a shape this build does not know. */
export function readReaperReport(root: string): ReaperReport | null {
	let text: string;
	try {
		text = fs.readFileSync(reportPath(root), "utf8");
	} catch {
		return null;
	}
	try {
		const parsed = JSON.parse(text);
		if (!parsed || typeof parsed !== "object") return null;
		if (!Array.isArray(parsed.removed) || !Array.isArray(parsed.kept) || !Array.isArray(parsed.deferred)) return null;
		return parsed as ReaperReport;
	} catch {
		return null;
	}
}

/** Write the report where the next session start and `/reaper` read it. A
 *  rename keeps a concurrent reader off a half-written file. */
export function writeReaperReport(root: string, report: ReaperReport): void {
	const target = reportPath(root);
	const temp = `${target}.tmp`;
	fs.writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`);
	fs.renameSync(temp, target);
}

/** One line for the session-start summary: what the last pass left held. */
export function summarizeReport(report: ReaperReport): string {
	const parts = [`${report.kept.length} held`, `${report.removed.length} removed`];
	if (report.deferred.length > 0) parts.push(`${report.deferred.length} deferred`);
	const byGate = new Map<KeepGate, number>();
	for (const row of report.kept) {
		if (!row.gate || row.gate === "scratch" || row.gate === "active") continue;
		byGate.set(row.gate, (byGate.get(row.gate) ?? 0) + 1);
	}
	const named = [...byGate.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([gate, n]) => `${gate} ${n}`);
	return `[Reaper] ${parts.join(", ")}${named.length > 0 ? ` (${named.join(", ")})` : ""} as of ${report.generatedAt.slice(11, 16)} — /reaper`;
}

/** `/reaper`: one line per row, grouped, with the unsaved thing named. */
export function formatReport(report: ReaperReport): string {
	const lines: string[] = [];
	const age = (row: ReaperRow): string => (row.ageDays === null ? "age?" : `${row.ageDays.toFixed(1)}d`);
	const unsaved = (row: ReaperRow): string => {
		const f = row.unsaved ?? {};
		const bits: string[] = [];
		if (typeof f.dirtyFiles === "number") bits.push(`${f.dirtyFiles} dirty`);
		if (typeof f.unpushedCommits === "number") {
			const branches = f.unpushedBranches?.length ? ` on ${f.unpushedBranches.join(",")}` : "";
			bits.push(`${f.unpushedCommits} unpushed${branches}`);
		}
		if (typeof f.stashes === "number") bits.push(`${f.stashes} stash`);
		if (typeof f.ignoredBytes === "number") bits.push(`${formatBytes(f.ignoredBytes)} ignored`);
		if (typeof f.pid === "number") bits.push(`pid ${f.pid}`);
		if (typeof f.newestFileDays === "number") bits.push(`newest file ${f.newestFileDays.toFixed(1)}d`);
		return bits.join(", ");
	};

	if (report.removed.length > 0) {
		lines.push(`removed (${report.removed.length}):`);
		for (const row of report.removed) {
			const extras = [
				row.removed?.branchDeleted ? `branch ${row.removed.branchDeleted}` : null,
				row.removed?.buildOutput ?? null,
				...(row.removed?.sharedWith ?? []).map(
					(s) => `shared ${shortPath(s.depInfo)} also named ${s.checkouts.map(shortPath).join(",")}`,
				),
			].filter((bit): bit is string => bit !== null);
			lines.push(`  ${shortPath(row.path)} (${age(row)})${extras.length > 0 ? ` — ${extras.join("; ")}` : ""}`);
		}
	}
	const kept = report.kept.filter((row) => row.gate !== "active");
	if (kept.length > 0) {
		lines.push(`kept (${kept.length}):`);
		for (const row of kept) {
			const what = unsaved(row) || row.detail || "";
			const scratch = typeof row.bytes === "number" ? `${formatBytes(row.bytes)}${row.bytesLowerBound ? "+" : ""}` : "";
			lines.push(`  ${shortPath(row.path)} (${age(row)}) [${row.gate ?? "?"}] ${[what, scratch].filter(Boolean).join(" ")}`.trimEnd());
		}
	}
	const active = report.kept.filter((row) => row.gate === "active");
	if (active.length > 0) {
		lines.push(`active, not actionable (${active.length}): ${active.map((row) => shortPath(row.path)).join(", ")}`);
	}
	if (report.deferred.length > 0) {
		lines.push(`deferred past the ${report.budgetMs} ms budget (${report.deferred.length}) — evaluated at a later session start:`);
		for (const row of report.deferred) lines.push(`  ${shortPath(row.path)} (${age(row)}) ${row.detail ?? ""}`.trimEnd());
	}
	for (const problem of report.problems) lines.push(`problem: ${problem}`);
	if (lines.length === 0) lines.push("nothing held: every checkout under wt/ is in use, young, or gone.");
	lines.push(`report: ${REAPER_REPORT_FILE} (${report.generatedAt}, ${report.elapsedMs} ms)`);
	return lines.join("\n");
}

function shortPath(p: string): string {
	const home = homedir();
	return p.startsWith(`${home}/`) ? `~/${p.slice(home.length + 1)}` : p;
}

function formatBytes(bytes: number): string {
	const mib = bytes / 1024 ** 2;
	if (mib >= 1024) return `${(mib / 1024).toFixed(1)} GiB`;
	if (mib >= 1) return `${mib.toFixed(1)} MiB`;
	return `${Math.round(bytes / 1024)} KiB`;
}

// ── Probes ─────────────────────────────────────────────────────────────────

export interface ProcessCwd {
	pid: number;
	cwd: string;
}

/** One `lsof -d cwd` pass for the whole box: a per-candidate probe would pay
 *  this cost once each. An empty list with a problem means the evidence is
 *  missing, and the caller keeps rather than guessing. */
export async function lsofProcessCwds(run: CommandRunner): Promise<{ cwds: ProcessCwd[]; problem: string | null }> {
	const out = await run("lsof", ["-d", "cwd", "-Fpn"], { cwd: homedir() });
	if (out.exitCode !== 0) {
		return { cwds: [], problem: `lsof -d cwd failed: ${out.stderr.trim() || `exit ${out.exitCode}`}` };
	}
	const cwds: ProcessCwd[] = [];
	let pid = 0;
	for (const line of out.stdout.split("\n")) {
		if (line.startsWith("p")) {
			pid = Number.parseInt(line.slice(1), 10);
			continue;
		}
		if (line.startsWith("n") && pid > 0) cwds.push({ pid, cwd: line.slice(1) });
	}
	return { cwds, problem: null };
}

/** The first process whose cwd is `target` or inside it. Both spellings are
 *  compared: lsof prints resolved paths, and macOS resolves `/var` to
 *  `/private/var`, so a caller's own prefix may not appear verbatim. */
export function processInside(cwds: readonly ProcessCwd[], target: string): ProcessCwd | null {
	const forms = new Set<string>([target]);
	try {
		forms.add(fs.realpathSync(target));
	} catch {
		/* gone: the raw path is all there is */
	}
	for (const proc of cwds) {
		for (const form of forms) {
			if (proc.cwd === form || proc.cwd.startsWith(`${form}/`)) return proc;
		}
	}
	return null;
}

// ── The pass ───────────────────────────────────────────────────────────────

export type RemoveWorktreeFn = (
	deps: { run?: CommandRunner; home?: string },
	rs: { worktreePath: string | null; isolationBranch: string | null; parentHeadCommit: string | null; parentCwd: string },
	policy: { force: boolean; finalCommit: string | null; relockReason: string },
) => Promise<{
	ok: boolean;
	stage?: "unlock" | "remove" | "branch";
	detail?: string;
	buildOutput?: BuildOutputReport;
}>;

export interface ReapCheckoutsOptions {
	root: string;
	subagentBase: string;
	/** The home whose `~/.cache/cargo-target` holds one dir per clone. */
	home?: string;
	now?: number;
	budgetMs?: number;
	/** Gate everything, remove nothing. The dry-run and measurement mode. */
	dryRun?: boolean;
	/** 091's `removeWorktreeTree`. Required: a default here would be a second
	 *  removal path, which this order forbids. */
	removeWorktree: RemoveWorktreeFn;
	/** 027's verdicts for the subagent namespace, so its gates are not re-run
	 *  here (a `ReapResult`, structurally). */
	subagentResults?: ReadonlyArray<{ worktreePath: string; outcome: string; detail?: string }>;
	/** The meta directory 027 reads. A namespace checkout a meta names is 027's
	 *  to decide, whatever this pass makes of its age. */
	metaDir?: string;
	/** Injection seams: the real ones are `runGit`, lsof and `du`. */
	git?: typeof runGit;
	run?: CommandRunner;
	listCwds?: () => Promise<{ cwds: ProcessCwd[]; problem: string | null }>;
}

export interface ReapCheckoutsResult {
	report: ReaperReport;
	/** Where the report was written (or would have been, when the write failed). */
	reportPath: string;
}

/**
 * One pass: walk, gate, remove what nothing else holds, report the rest.
 *
 * The gates run in the order that is cheapest to prove, so a checkout that is
 * young, locked or in use costs no spawn: scratch and namespace ownership,
 * the `locked` marker, age, the `lsof` cwd, then one `git status` — which four
 * of the remaining gates read from.
 */
export async function reapCheckouts(opts: ReapCheckoutsOptions): Promise<ReapCheckoutsResult> {
	const startedAt = Date.now();
	const now = opts.now ?? startedAt;
	const budgetMs = opts.budgetMs ?? REAPER_PASS_BUDGET_MS;
	const report: ReaperReport = {
		generatedAt: new Date(now).toISOString(),
		budgetMs,
		elapsedMs: 0,
		removed: [],
		kept: [],
		deferred: [],
		problems: [],
	};
	const ctx: ReapContext = {
		home: opts.home ?? homedir(),
		now,
		git: opts.git ?? runGit,
		run: opts.run ?? spawnRunner,
		cwds: [],
		cwdProbeFailed: false,
		checkedAt: report.generatedAt,
		entries: [],
		dryRun: opts.dryRun === true,
		removeWorktree: opts.removeWorktree,
	};

	const entries = walkCheckouts({ root: opts.root, subagentBase: opts.subagentBase, now });
	ctx.entries = entries;
	const cwdProbe = opts.listCwds ? await opts.listCwds() : await lsofProcessCwds(ctx.run);
	ctx.cwds = cwdProbe.cwds;
	ctx.cwdProbeFailed = cwdProbe.problem !== null;
	if (cwdProbe.problem) report.problems.push(cwdProbe.problem);

	const governed = namespacePaths(opts, report);
	const overBudget = (): boolean => !ctx.dryRun && Date.now() - startedAt > budgetMs;

	// Oldest first: a pass that runs out of budget spends it on the checkouts
	// most likely to be dead, and the order is stable from pass to pass.
	const ordered = [...entries].sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1) || a.path.localeCompare(b.path));
	for (const entry of ordered) {
		try {
			if (entry.kind === "scratch" || entry.kind === "other") {
				if (overBudget()) {
					report.deferred.push(deferredRow(entry, report.generatedAt, "size not measured"));
					continue;
				}
				report.kept.push(scratchRow(entry, report.generatedAt));
				continue;
			}
			if (entry.scope === "subagents" && governed.has(entry.path)) {
				report.kept.push(subagentRow(entry, opts.subagentResults, report.generatedAt));
				continue;
			}
			if (overBudget()) {
				report.deferred.push(deferredRow(entry, report.generatedAt, "no gate ran"));
				continue;
			}
			const outcome = await gateAndReap(entry, ctx);
			if (outcome.state === "removed") report.removed.push(outcome);
			else report.kept.push(outcome);
		} catch (e) {
			report.problems.push(`${entry.path}: ${e instanceof Error ? e.message : String(e)}`);
			report.kept.push({ ...baseRow(entry, report.generatedAt), gate: "git-error", detail: "gate threw; see problems" });
		}
	}

	report.elapsedMs = Date.now() - startedAt;
	const target = reportPath(opts.root);
	try {
		writeReaperReport(opts.root, report);
	} catch (e) {
		report.problems.push(`${target} not written: ${e instanceof Error ? e.message : String(e)}`);
	}
	return { report, reportPath: target };
}

interface ReapContext {
	home: string;
	now: number;
	git: typeof runGit;
	run: CommandRunner;
	cwds: readonly ProcessCwd[];
	cwdProbeFailed: boolean;
	checkedAt: string;
	entries: readonly CheckoutEntry[];
	dryRun: boolean;
	removeWorktree: RemoveWorktreeFn;
}

/** Every worktree path a subagent meta names: 027's subtree, whose gates this
 *  pass does not second-guess. */
function namespacePaths(opts: ReapCheckoutsOptions, report: ReaperReport): Set<string> {
	const paths = new Set<string>();
	for (const result of opts.subagentResults ?? []) {
		if (typeof result.worktreePath === "string" && result.worktreePath.length > 0) paths.add(result.worktreePath);
	}
	if (!opts.metaDir) return paths;
	try {
		for (const { meta } of listSubagentMetas(opts.metaDir)) {
			if (typeof meta.worktreePath === "string" && meta.worktreePath.length > 0) paths.add(meta.worktreePath);
		}
	} catch (e) {
		report.problems.push(`subagent metas not read: ${e instanceof Error ? e.message : String(e)}`);
	}
	return paths;
}

function deferredRow(entry: CheckoutEntry, checkedAt: string, detail: string): ReaperRow {
	return { ...baseRow(entry, checkedAt), state: "deferred", gate: "budget", detail };
}

function baseRow(entry: CheckoutEntry, checkedAt: string): ReaperRow {
	return { path: entry.path, kind: entry.kind, scope: entry.scope, ageDays: entry.ageDays, state: "kept", gate: null, checkedAt };
}

// ── Scratch, and the subagent namespace ────────────────────────────────────

/** A non-git directory under `wt/`: reported with its age and size, never
 *  deleted (owner ask 3). The size is a capped walk — a scratch tree of
 *  hundreds of thousands of files is named by its floor rather than sized at
 *  the expense of the whole pass. */
function scratchRow(entry: CheckoutEntry, checkedAt: string): ReaperRow {
	const sized = measureTree(entry.path, SCRATCH_WALK_CAP);
	const row: ReaperRow = { ...baseRow(entry, checkedAt), gate: "scratch", bytes: sized.bytes };
	if (sized.truncated) row.bytesLowerBound = true;
	return row;
}

/** The subagent namespace is 027's: report its verdict and leave the gates
 *  alone. A namespace checkout no meta names is nobody's record, and falls
 *  through to this pass's gates. */
function subagentRow(
	entry: CheckoutEntry,
	results: ReapCheckoutsOptions["subagentResults"],
	checkedAt: string,
): ReaperRow {
	const verdict = results?.find((r) => r.worktreePath === entry.path);
	const row: ReaperRow = { ...baseRow(entry, checkedAt), gate: "subagent" };
	row.detail = verdict
		? `subagent ${verdict.outcome}${verdict.detail ? `: ${verdict.detail}` : ""}`
		: "subagent tree held by 027's gates";
	return row;
}

// ── The gates, one checkout ────────────────────────────────────────────────

async function gateAndReap(entry: CheckoutEntry, ctx: ReapContext): Promise<ReaperRow> {
	const keep = (gate: KeepGate, extra?: Partial<ReaperRow>): ReaperRow => ({ ...baseRow(entry, ctx.checkedAt), gate, ...extra });

	// gate 4a — git's own "do not remove me".
	if (entry.kind === "worktree" && entry.gitDir && fs.existsSync(path.join(entry.gitDir, "locked"))) {
		return keep("locked", { detail: "git worktree lock" });
	}
	// gate 5 — idle. No metadata read at all is not an age.
	if (entry.ageDays === null) return keep("age-unknown", { detail: "no readable git metadata" });
	if (entry.ageDays < IDLE_DAYS) return keep("active");

	// gate 4b — unused. Without the probe there is no evidence either way, and
	// "probably fine" is a keep.
	if (ctx.cwdProbeFailed) return keep("no-cwd-evidence", { detail: "lsof unavailable: not removing" });
	const busy = processInside(ctx.cwds, entry.path);
	if (busy) return keep("in-use", { unsaved: { pid: busy.pid, processCwd: busy.cwd } });

	// gate 1 (+ 3's bytes) — one `git status` answers the working tree, the
	// branch and the ignored paths.
	const status = parseStatus(await ctx.git(entry.path, ["--no-optional-locks", "status", "--porcelain", "--branch", "--ignored=matching", "-uall"]));
	if (!status.ok) return keep("git-error", { detail: status.detail });
	const unsaved: UnsavedFacts = { branch: status.branch, dirtyFiles: status.dirtyFiles };
	const ignoredBytes = await ignoredBytesOf(entry, ctx, status.ignoredPaths);
	if (ignoredBytes !== null) unsaved.ignoredBytes = ignoredBytes;
	if (status.dirtyFiles > 0) return keep("dirty", { unsaved });

	const stash = stashesFor(entry, status.branch);
	if (stash.lost > 0) return keep("stash", { unsaved: { ...unsaved, stashes: stash.lost }, detail: stash.detail });

	// gate 2 — nothing only local.
	const local = await unpushed(entry, ctx, status);
	if (!local.ok) return keep("git-error", { detail: local.detail });
	unsaved.unpushedCommits = local.commits;
	if (local.branches.length > 0) unsaved.unpushedBranches = local.branches;
	if (local.commits > 0) return keep("unpushed", { unsaved });

	// gate 5 again, on the tree: metadata is not the whole checkout.
	const fresh = treeNewestWithin(entry.path, ctx.now - IDLE_DAYS * MS_PER_DAY, status.ignoredPaths);
	if (fresh !== null) {
		return keep("active", {
			unsaved: { ...unsaved, newestFileDays: (ctx.now - fresh) / MS_PER_DAY },
			detail: "a file in the tree changed inside the idle window",
		});
	}

	// Every gate holds. R12's scan runs before the removal deletes its evidence.
	const sharedWith = sharedWithLive(entry, ctx);
	const row: ReaperRow = { ...baseRow(entry, ctx.checkedAt), unsaved, removed: { sharedWith } };
	if (sharedWith.length === 0) delete row.removed;
	if (ctx.dryRun) return { ...row, gate: "dry-run", detail: "every gate holds: dry run, nothing removed" };

	const removal = await removeCheckout(entry, ctx, status, sharedWith);
	if (!removal.ok) return keep(removal.gate, { unsaved, detail: removal.detail });
	return { ...row, state: "removed", gate: null, removed: { ...removal.facts, ...(sharedWith.length > 0 ? { sharedWith } : {}) } };
}

// ── Gate 1: `git status`, parsed once for four gates ───────────────────────

interface StatusResult {
	ok: boolean;
	detail?: string;
	branch: string | null;
	upstream: string | null;
	/** Commits on HEAD not on `upstream`; null when there is no usable upstream. */
	ahead: number | null;
	dirtyFiles: number;
	ignoredPaths: string[];
}

/** Porcelain v1 with `--branch` and `--ignored=matching`: a `##` header, one
 *  `!! ` line per ignored path, one line per changed path. */
export function parseStatus(result: { ok: boolean; out: string; err: string; timedOut: boolean }): StatusResult {
	if (!result.ok) {
		const empty: StatusResult = { ok: false, branch: null, upstream: null, ahead: null, dirtyFiles: 0, ignoredPaths: [] };
		return { ...empty, detail: `git status failed${result.timedOut ? " (timed out)" : ""}: ${result.err}` };
	}
	let branch: string | null = null;
	let upstream: string | null = null;
	let ahead: number | null = null;
	let dirtyFiles = 0;
	const ignoredPaths: string[] = [];
	for (const line of result.out.split("\n")) {
		if (line.length === 0) continue;
		if (line.startsWith("## ")) {
			const header = line.slice(3).trim();
			const unborn = /^(?:No commits yet on|Initial commit on) (.+)$/.exec(header);
			if (unborn) {
				branch = unborn[1].trim();
				continue;
			}
			if (/^HEAD \(no branch\)/.test(header)) continue;
			const bracketAt = header.indexOf(" [");
			const names = (bracketAt === -1 ? header : header.slice(0, bracketAt)).split("...");
			branch = names[0].trim() || null;
			upstream = names[1] ? names[1].trim() : null;
			if (upstream === null) continue;
			const bracket = bracketAt === -1 ? null : header.slice(bracketAt + 2).replace(/\]$/, "");
			if (bracket !== null && /\bgone\b/.test(bracket)) {
				upstream = null; // the tracking ref is gone: no evidence of anything
				continue;
			}
			const aheadMatch = bracket === null ? null : /\bahead (\d+)/.exec(bracket);
			// A bracket is only printed when the branch has diverged, so no
			// bracket with a live upstream means in sync.
			ahead = aheadMatch ? Number.parseInt(aheadMatch[1], 10) : 0;
			continue;
		}
		if (line.startsWith("!! ")) {
			ignoredPaths.push(line.slice(3));
			continue;
		}
		dirtyFiles++;
	}
	return { ok: true, branch, upstream, ahead, dirtyFiles, ignoredPaths };
}

// ── Gate 1b: the stash entries this checkout would lose ────────────────────

/** A stash lives in the shared repository (`refs/stash` and its reflog), so
 *  removing a linked worktree loses none of them; what it can lose is an entry
 *  made on this worktree's branch, which the reflog names (`WIP on <branch>:`).
 *  A clone carries the whole repository with it, so every entry counts. An entry
 *  whose branch cannot be read counts too — an unknown owner is not a "no". */
function stashesFor(entry: CheckoutEntry, branch: string | null): { lost: number; detail?: string } {
	if (!entry.gitDir) return { lost: 0 };
	const commonDir = commonDirOf(entry.gitDir);
	let reflog = "";
	try {
		reflog = fs.readFileSync(path.join(commonDir, "logs", "refs", "stash"), "utf8");
	} catch {
		/* no stash was ever taken here */
	}
	const branches = reflog
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => /(?:WIP on|On) ([^:]+): /.exec(line)?.[1] ?? null);
	const refExists = fs.existsSync(path.join(commonDir, "refs", "stash"));
	if (branches.length === 0 && refExists) return { lost: 1, detail: "refs/stash present with no readable reflog" };
	if (entry.kind === "clone") {
		return branches.length > 0 ? { lost: branches.length, detail: `${branches.length} stash entries in the clone` } : { lost: 0 };
	}
	const mine = branches.filter((name) => name === branch).length;
	return mine > 0 ? { lost: mine, detail: `${mine} stash entries on branch ${branch ?? "(detached)"}` } : { lost: 0 };
}

/** The repository a worktree's gitdir belongs to. A linked worktree's gitdir
 *  records it in `commondir` (`../..`); the main worktree *is* the common dir. */
function commonDirOf(gitDir: string): string {
	let link: string;
	try {
		link = fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
	} catch {
		return gitDir;
	}
	if (link.length === 0) return gitDir;
	return path.resolve(gitDir, link);
}

// ── Gate 2: nothing only local ─────────────────────────────────────────────

/** Commits the checkout holds that no remote ref holds, with the branches that
 *  carry them.
 *
 *  A worktree dies alone, so its own branch is the spec (HEAD). A clone takes
 *  every local branch with it, so all of them are (`--branches`) — that is R4's
 *  shape: a merged branch beside another one that exists only locally. `%S`
 *  names the ref that reached each commit, so the count and the branches come
 *  out of one spawn. */
async function unpushed(
	entry: CheckoutEntry,
	ctx: ReapContext,
	status: StatusResult,
): Promise<{ ok: true; commits: number; branches: string[] } | { ok: false; detail: string }> {
	// A worktree in sync with its upstream has nothing only local: `ahead 0`
	// means every commit on HEAD is reachable from that remote ref.
	if (entry.kind === "worktree" && status.upstream !== null && status.ahead === 0) return { ok: true, commits: 0, branches: [] };
	const spec = entry.kind === "clone" ? "--branches" : "HEAD";
	const result = await ctx.git(entry.path, [
		"-c",
		"color.ui=false",
		"-c",
		"log.showSignature=false",
		"log",
		"--source",
		spec,
		"--not",
		"--remotes",
		"--pretty=format:%H%x09%S",
	]);
	if (!result.ok) return { ok: false, detail: `git log --not --remotes failed: ${result.err}` };
	const branches = new Set<string>();
	let commits = 0;
	for (const line of result.out.split("\n")) {
		if (line.length === 0) continue;
		commits++;
		const name = line.split("\t")[1]?.trim();
		if (!name) continue;
		// `%S` prints "HEAD" for the spec itself, which is the branch git has out.
		branches.add(name === "HEAD" ? (status.branch ?? "HEAD") : name.replace(/^refs\/heads\//, ""));
	}
	return { ok: true, commits, branches: [...branches].sort() };
}

// ── Gate 3: the bytes git ignores ──────────────────────────────────────────

async function ignoredBytesOf(entry: CheckoutEntry, ctx: ReapContext, ignored: readonly string[]): Promise<number | null> {
	if (ignored.length === 0) return 0;
	const result = await ctx.run("du", ["-csk", ...ignored], { cwd: entry.path });
	if (result.exitCode !== 0) return null;
	const total = result.stdout
		.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.find((parts) => parts[1] === "total");
	const kb = Number.parseInt(total?.[0] ?? "", 10);
	return Number.isFinite(kb) ? kb * 1024 : null;
}

// ── Gate 5, second half: the tree's own mtimes ─────────────────────────────

/** The newest mtime in the tree at or after `cutoff`, or null when every file
 *  (outside git's own storage and the ignored paths) is older. Ignored paths
 *  are left out on purpose: build output is not work, and gate 3 already names
 *  the bytes it costs. Stops at the first hit — the caller only asks whether the
 *  tree is fresh. */
export function treeNewestWithin(root: string, cutoff: number, ignored: readonly string[] = []): number | null {
	const skip = new Set<string>([".git"]);
	for (const p of ignored) skip.add(p.replace(/\/$/, ""));
	const stack: Array<{ dir: string; rel: string }> = [{ dir: root, rel: "" }];
	while (stack.length > 0) {
		const { dir, rel } = stack.pop()!;
		let ents: fs.Dirent[];
		try {
			ents = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const ent of ents) {
			const childRel = rel.length === 0 ? ent.name : `${rel}/${ent.name}`;
			if (ent.name === ".git" || skip.has(childRel) || (rel.length === 0 && skip.has(ent.name))) continue;
			const full = path.join(dir, ent.name);
			let st: fs.Stats;
			try {
				st = fs.lstatSync(full);
			} catch {
				continue;
			}
			if (st.mtimeMs >= cutoff) return st.mtimeMs;
			if (st.isDirectory()) stack.push({ dir: full, rel: childRel });
		}
	}
	return null;
}

function measureTree(dir: string, cap: number): { bytes: number; truncated: boolean } {
	let bytes = 0;
	let seen = 0;
	const walk = (d: string): boolean => {
		let ents: fs.Dirent[];
		try {
			ents = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			return true;
		}
		for (const ent of ents) {
			if (seen >= cap) return false;
			const full = path.join(d, ent.name);
			let st: fs.Stats;
			try {
				st = fs.lstatSync(full);
			} catch {
				continue;
			}
			seen++;
			if (st.isDirectory()) {
				if (!walk(full)) return false;
			} else {
				bytes += st.blocks * 512;
			}
		}
		return true;
	};
	const complete = walk(dir);
	return { bytes, truncated: !complete };
}

// ── R12: a `.d` that names two checkouts ───────────────────────────────────

/** The shared cargo dirs a checkout's build output could sit in: the namespace
 *  rule 091 attributes by, plus the directory names a seat-made tree is known by
 *  (`~/.cache/cargo-target/<tree>` is what a seat sets when it spawns one).
 *  Only dirs that exist come back. */
function sharedDirsFor(entry: CheckoutEntry, home: string): string[] {
	const dirs: string[] = [];
	const namespaced = repoNameFromWorktreePath(entry.path, home);
	if (namespaced) dirs.push(cargoTargetDirFor(namespaced, home));
	const root = cargoTargetRoot(home);
	for (const name of [path.basename(entry.path), entry.parentCwd ? path.basename(entry.parentCwd) : ""]) {
		if (name.length === 0) continue;
		const candidate = path.join(root, name);
		if (!dirs.includes(candidate)) dirs.push(candidate);
	}
	return dirs.filter((dir) => fs.existsSync(dir));
}

/** R12: `.d` files this checkout's removal will take that also name another
 *  checkout still on disk. Dep-info is keyed by crate unit, so one `.d` can name
 *  two worktrees and the artifacts under its stem are one copy: the other tree
 *  rebuilds the unit, and its own later removal degrades to the coarse route.
 *  The row says so, so the rebuild is explained rather than discovered. */
function sharedWithLive(entry: CheckoutEntry, ctx: ReapContext): Array<{ depInfo: string; checkouts: string[] }> {
	const live = ctx.entries
		.filter((other) => other.path !== entry.path && other.kind !== "scratch" && other.kind !== "other")
		.map((other) => other.path);
	const found: Array<{ depInfo: string; checkouts: string[] }> = [];
	for (const dir of sharedDirsFor(entry, ctx.home)) found.push(...sharedDepInfoFiles(dir, entry.path, live));
	return found;
}

// ── The removal ────────────────────────────────────────────────────────────

interface RemovalOutcome {
	ok: boolean;
	gate?: KeepGate;
	detail?: string;
	facts?: RemovedFacts;
}

async function removeCheckout(
	entry: CheckoutEntry,
	ctx: ReapContext,
	status: StatusResult,
	sharedWith: Array<{ depInfo: string; checkouts: string[] }>,
): Promise<RemovalOutcome> {
	if (entry.kind === "clone") {
		try {
			fs.rmSync(entry.path, { recursive: true, force: true });
		} catch (e) {
			return { ok: false, gate: "git-error", detail: `rm -rf failed: ${e instanceof Error ? e.message : String(e)}` };
		}
		const facts: RemovedFacts = { branchDeleted: status.branch };
		if (sharedWith.length > 0) facts.sharedWith = sharedWith;
		const pruned = await pruneSharedShare(entry, ctx);
		if (pruned) facts.cargo = pruned;
		return { ok: true, facts };
	}

	const head = await ctx.git(entry.path, ["rev-parse", "HEAD"]);
	if (!head.ok) return { ok: false, gate: "git-error", detail: `git rev-parse HEAD failed: ${head.err}` };
	const headSha = head.out.trim();

	// 091 deletes the branch when its final commit equals the commit it started
	// from — its test for "nothing unsaved on it". The reaper has proved the
	// same thing more strongly (gate 2: every commit on the branch is on a remote
	// ref), so both facts it compares are the branch's own HEAD.
	const removal = await ctx.removeWorktree(
		{ run: ctx.run, home: ctx.home },
		{
			worktreePath: entry.path,
			isolationBranch: status.branch,
			parentHeadCommit: headSha,
			parentCwd: entry.parentCwd ?? entry.path,
		},
		{ force: false, finalCommit: headSha, relockReason: `wt reaper: ${entry.path} (removal failed)` },
	);
	if (!removal.ok) {
		return {
			ok: false,
			gate: removal.stage === "unlock" ? "locked" : "git-error",
			detail: `removal failed (${removal.stage ?? "?"}): ${removal.detail ?? "no detail"}`,
		};
	}
	const facts: RemovedFacts = { branchDeleted: status.branch };
	if (removal.buildOutput) {
		facts.buildOutputReport = removal.buildOutput;
		const line = describeBuildOutput(removal.buildOutput);
		if (line) facts.buildOutput = line;
	}
	if (sharedWith.length > 0) facts.sharedWith = sharedWith;
	// 091 attributes by the subagent namespace, so a seat-made tree's share of
	// `~/.cache/cargo-target/<tree>` is left where it was; this pass drops it.
	if (!removal.buildOutput?.cargo) {
		const pruned = await pruneSharedShare(entry, ctx);
		if (pruned) {
			facts.cargo = pruned;
			const line = `${pruned.filesDeleted} files + ${pruned.dirsDeleted} dirs from ${pruned.depInfoMatched}/${pruned.depInfoScanned} .d (exact)`;
			facts.buildOutput = facts.buildOutput ? `${facts.buildOutput}; ${line}` : line;
		}
	}
	return { ok: true, facts };
}

/** 091's route 1 for a tree its namespace rule does not attribute, one shared dir
 *  at a time. Route 2 is deliberately not run here: the bound (M3) owns the
 *  coarse pass, and running it per removal would rebuild other trees' crates
 *  inside a session-start pass. */
async function pruneSharedShare(entry: CheckoutEntry, ctx: ReapContext): Promise<CargoPruneResult | null> {
	for (const dir of sharedDirsFor(entry, ctx.home)) {
		const pruned = await pruneCargoArtifactsFor(dir, entry.path, { run: ctx.run });
		if (pruned.depInfoMatched > 0) return pruned;
	}
	return null;
}
