/**
 * Worktree isolation and removal — the tree's whole lifecycle: create it on a
 * branch off the parent HEAD, carry the parent's uncommitted state into it,
 * commit what the child did, then remove it (one unlock → remove →
 * branch-delete sequence, WO-2026-091).
 *
 * Split out of `index.ts` by WO-2026-095. Behaviour is unchanged; the module
 * imports the shared `git` runner, debug logger and the `RunningSubagent`
 * shape from the entry point.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type CommandRunner,
	type BuildOutputReport,
	describeBuildOutput,
	disposeWorktreeBuildOutput,
} from "../lib/build-output-reaper.ts";
import { cargoTargetDirFor, subagentWorktreePath, UnusableWorktreeRootError } from "../lib/subagent-worktree.ts";
import { PI_ASYNC_DEBUG, debugLog, git, type RunningSubagent } from "./index.ts";

// ── Worktree isolation ────────────────────────────────────────────────────

/** Create an isolated git worktree on a branch off the parent HEAD (or optional baseRef).
 *  Returns null if the cwd is not a git repo or worktree creation fails. */
export async function createWorktree(
	parentCwd: string,
	sessionId: string,
	baseRef?: string,
	carryUncommitted: boolean = true,
): Promise<{
	worktreePath: string;
	branchName: string;
	parentHeadCommit: string;
	/** Shared per-clone cargo target dir the child is spawned with. */
	cargoTargetDir: string;
	carried?: CarriedSnapshot;
} | null> {
	const t0 = PI_ASYNC_DEBUG ? Date.now() : 0;
	try {
		const baseCommitRef = baseRef || "HEAD";

		// Run the two independent rev-parse calls concurrently.
		// NOTE: `topLevelResult` is the git() RESULT OBJECT {stdout, stderr,
		// exitCode}; the repo path string must be extracted via .stdout.trim()
		// before passing it around. Passing the object as a path silently kills
		// the carry overlay (spawn cwd invalid → best-effort catch swallows) —
		// caught by real-dispatch E2E, not by the mirror tests.
		const [topLevelResult, headResult] = await Promise.all([
			git(["rev-parse", "--show-toplevel"], parentCwd),
			git(["rev-parse", baseCommitRef], parentCwd),
		]);
		if (PI_ASYNC_DEBUG) debugLog(`createWorktree: rev-parse (parallel): ${Date.now() - t0}ms`);

		if (topLevelResult.exitCode !== 0) return null;
		if (headResult.exitCode !== 0) return null;
		const parentHeadCommit = headResult.stdout.trim();
		const topLevel = topLevelResult.stdout.trim();

		const suffix = sessionId.slice(-12);
		const branchName = `pi-subagent-${suffix}`;
		// Never under os.tmpdir(): the daily cleaner and every reboot destroy
		// trees that hold uncommitted work (decisions/subagents/0NN).
		const repoName = path.basename(topLevel);
		const worktreePath = subagentWorktreePath(repoName, suffix);
		fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

		// Remove stale leftovers from a previous run with the same session id.
		// `sessionId` is a fresh randomUUID slice per spawn and createWorktree is
		// only called on fresh spawns (subagent_resume passes nulls), so there is
		// normally nothing on disk to clean — skip the two git subprocesses when
		// the directory does not exist. When it does, both independent best-effort
		// cleanups still run concurrently, unchanged.
		const tCleanup = PI_ASYNC_DEBUG ? Date.now() : 0;
		if (fs.existsSync(worktreePath)) {
			// Unlock first: a leftover from a previous crashed run carries OUR
			// session id (the branch/path suffix is derived from it), so the lock
			// is ours to drop — and `worktree remove --force` refuses a locked
			// tree (R3-2), so the remove must wait for the unlock. Best-effort: a
			// never-locked leftover still cleans up.
			await git(["worktree", "unlock", worktreePath], parentCwd);
			await Promise.allSettled([
				git(["worktree", "remove", "--force", worktreePath], parentCwd),
				git(["branch", "-D", branchName], parentCwd),
			]);
		}
		if (PI_ASYNC_DEBUG) debugLog(`createWorktree: stale-cleanup (parallel): ${Date.now() - tCleanup}ms`);

		// The carry status only reads the parent tree, so it can be fetched while
		// the worktree materializes below. `git()` never rejects (it resolves with
		// exitCode: 1 on spawn failure), so an unconsumed prefetch (worktree add
		// failed, or the carry gate changed) cannot become an unhandled rejection.
		const carryStatusPromise =
			carryUncommitted && !baseRef
				? git(["status", "--porcelain=v1", "-uall", "-z"], topLevel)
				: undefined;

		// worktree add must be last and fatal on failure.
		const tAdd = PI_ASYNC_DEBUG ? Date.now() : 0;
		const wtResult = await git(
			["worktree", "add", worktreePath, "-b", branchName, parentHeadCommit],
			parentCwd,
		);
		if (PI_ASYNC_DEBUG) debugLog(`createWorktree: worktree add: ${Date.now() - tAdd}ms`);
		if (wtResult.exitCode !== 0) return null;

		// R3-2 (tfd process-controls, owner 2026-10-19): lock the tree as soon as
		// it exists. git refuses `worktree remove --force` on a locked tree, so a
		// hand reap of a live child cannot destroy its uncommitted work; the
		// harness's own cleanup and reap paths unlock first. Best-effort — a
		// missing lock degrades the protection, never the dispatch.
		const lockResult = await git(
			["worktree", "lock", "--reason", `pi-subagent ${sessionId}`, worktreePath],
			parentCwd,
		);
		if (lockResult.exitCode !== 0) {
			debugLog(`createWorktree: worktree lock failed (${lockResult.stderr.trim() || lockResult.exitCode}) — tree ${worktreePath} is unprotected`);
		}

		// Best-effort overlay of the parent's uncommitted state; a failure
		// degrades to the plain HEAD-only worktree, never fails the dispatch.
		// `carried` is present (possibly empty map) when the overlay ran,
		// absent when skipped (carryUncommitted:false / baseRef) or when the
		// overlay threw. In-memory only — no persistence.
		let carried: CarriedSnapshot | undefined;
		if (carryUncommitted && !baseRef) {
			const tCarry = PI_ASYNC_DEBUG ? Date.now() : 0;
			try {
				carried = await carryUncommittedState(topLevel, worktreePath, carryStatusPromise);
			} catch (e: any) {
				debugLog(`createWorktree: carry failed — degrading to HEAD-only: ${e.message || e}`);
			}
			if (PI_ASYNC_DEBUG) debugLog(`createWorktree: carry: ${Date.now() - tCarry}ms`);
		}

		if (PI_ASYNC_DEBUG) debugLog(`createWorktree: total: ${Date.now() - t0}ms`);
		return {
			worktreePath,
			branchName,
			parentHeadCommit,
			cargoTargetDir: cargoTargetDirFor(repoName),
			...(carried !== undefined ? { carried } : {}),
		};
	} catch (e) {
		// A bad PI_SUBAGENT_WT_ROOT is a configuration error, not a failed
		// creation. `null` says "not a git repo / worktree add failed"; folding
		// the override error into it would hide which path was wrong.
		if (e instanceof UnusableWorktreeRootError) throw e;
		return null;
	}
}

/** Per-path snapshot of the carried state; the completion filter compares
 *  the worktree against this to find files the subagent never touched. */
type CarriedEntry = { state: "present"; hash: string } | { state: "absent" };
type CarriedSnapshot = Map<string, CarriedEntry>;

/** sha256 hex of a file's bytes, or `"link:" + target` for a symlink,
 *  or null when the path is absent / not a regular file or symlink.
 *  Single source of truth for the carry snapshot hashes — used by both
 *  carryUncommittedState (capture) and the preCommitSteps completion filter
 *  (compare). Async (fs.promises) so the spawn path never blocks the event
 *  loop on file I/O. Mirrored identically by test-completion-filter.cjs —
 *  keep in sync. */
async function hashCarriedFile(absPath: string): Promise<string | null> {
	try {
		const st = await fs.promises.lstat(absPath);
		if (st.isSymbolicLink()) return "link:" + (await fs.promises.readlink(absPath));
		if (!st.isFile()) return null;
		return createHash("sha256").update(await fs.promises.readFile(absPath)).digest("hex");
	} catch {
		return null;
	}
}

/** Best-effort overlay of the parent's uncommitted working-tree state
 *  (untracked, modified, staged, deleted, renamed, copied) into a fresh
 *  worktree, preserving exec bits and symlinks-as-links. Read-only on the
 *  parent (single `git status`); writes only under `worktreePath`. Never
 *  returns null: a fresh empty map when `git status` fails or there are no
 *  changes. fs-level overlay failures still throw and are caught by the
 *  caller (createWorktree), which degrades to the plain HEAD-only worktree.
 *  Each carried path is recorded in the returned CarriedSnapshot: sha256 of
 *  the exact bytes written into the worktree (computed via hashCarriedFile,
 *  the shared async helper — bytes copied via fs.promises.copyFile and hashed
 *  separately), `"link:"` + target for symlinks, `absent` for carried
 *  deletions; `.git`/unsafe paths are skipped and absent from the snapshot.
 *  Mirrored by test-carry-uncommitted.cjs and test-completion-filter.cjs —
 *  keep in sync.
 *
 *  `statusPromise` may be prefetched by the caller (createWorktree) to overlap
 *  `git status` with `git worktree add`; when omitted, the status is fetched
 *  here. Per-entry ordering (rename delete → copy, etc.) is preserved. */
async function carryUncommittedState(
	topLevel: string,
	worktreePath: string,
	statusPromise?: Promise<{ stdout: string; stderr: string; exitCode: number }>,
): Promise<CarriedSnapshot> {
	// Fail-fast: a non-string here means the caller passed the git() result
	// object instead of the extracted path (see createWorktree). Throwing makes
	// the caller's best-effort catch log it instead of silently no-oping.
	if (typeof topLevel !== "string" || topLevel.length === 0) {
		throw new TypeError("carryUncommittedState: topLevel must be the repo path string");
	}
	const snapshot: CarriedSnapshot = new Map();
	const res = await (statusPromise ?? git(["status", "--porcelain=v1", "-uall", "-z"], topLevel));
	if (res.exitCode !== 0) return snapshot;

	// Record a present-entry for a path just copied into the worktree.
	// If hashing fails (path gone / not a regular file), the path is left
	// out of the snapshot — the filter then treats it as touched, which
	// degrades to today's commit-everything behavior.
	const recordPresent = async (rel: string) => {
		const hash = await hashCarriedFile(path.join(worktreePath, rel));
		if (hash !== null) snapshot.set(rel, { state: "present", hash });
	};

	const tokens = res.stdout.split("\0");
	for (let i = 0; i < tokens.length; i++) {
		const rec = tokens[i];
		if (rec.length === 0) continue;
		const x = rec[0];
		const y = rec[1];
		const p = rec.slice(3);
		if (unsafeCarryPath(p)) continue;

		if (x === "R" || x === "C") {
			// Rename/copy: the record path is the NEW path; the next NUL
			// token holds the ORIGINAL path.
			const orig = tokens[i + 1] ?? "";
			i++;
			if (unsafeCarryPath(orig)) continue;
			if (x === "R") {
				fs.rmSync(path.join(worktreePath, orig), { recursive: true, force: true });
				snapshot.set(orig, { state: "absent" });
			}
			await copyCarriedFile(topLevel, worktreePath, p);
			await recordPresent(p);
			continue;
		}
		if (x === "D" || y === "D") {
			fs.rmSync(path.join(worktreePath, p), { recursive: true, force: true });
			snapshot.set(p, { state: "absent" });
			continue;
		}
		if (x === "?" && y === "?") {
			await copyCarriedFile(topLevel, worktreePath, p);
			await recordPresent(p);
			continue;
		}
		if (x === "M" || x === "A" || x === "T" || x === "U" || y === "M" || y === "A" || y === "T" || y === "U") {
			if (fs.existsSync(path.join(topLevel, p))) {
				await copyCarriedFile(topLevel, worktreePath, p);
				await recordPresent(p);
			}
		}
	}
	return snapshot;
}

/** Paths come from git and are trusted, but assert-skip anything odd anyway. */
function unsafeCarryPath(p: string): boolean {
	return p.length === 0 || p.includes("..") || p === ".git" || p.startsWith(".git/");
}

/** Copy one file (or symlink-as-link) from the parent tree into the worktree,
 *  preserving the exec bit. Submodule gitlink dirs are skipped — a known
 *  limitation, submodule contents are not carried. */
async function copyCarriedFile(topLevel: string, worktreePath: string, rel: string): Promise<void> {
	const src = path.join(topLevel, rel);
	const dst = path.join(worktreePath, rel);
	await fs.promises.mkdir(path.dirname(dst), { recursive: true });
	const st = await fs.promises.lstat(src);
	if (st.isSymbolicLink()) {
		await fs.promises.symlink(await fs.promises.readlink(src), dst);
	} else if (st.isDirectory()) {
		return;
	} else {
		await fs.promises.copyFile(src, dst);
		await fs.promises.chmod(dst, st.mode & 0o7777);
	}
}

/** First non-empty line of a task, truncated to a git commit subject.
 *  Handles multi-line work-order tasks without dumping the body into `-m`.
 *  Callers must pass the CLEAN task identity (never the worktree-isolation
 *  preamble wrapper) — see decisions/subagents/009-clean-task-identity.md. */
function subjectFromTask(task: string): string {
	const firstLine = task.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
	return (firstLine ?? "(no task)").slice(0, 72);
}

/** Pre-delivery commit steps: stage, commit, and capture the final commit
 *  hash. Runs BEFORE deliverResult so the parent sees the result immediately.
 *  Returns a status note for the delivered result plus metadata for post-delivery
 *  cleanup. Never throws — failures produce an error note and worktree is left
 *  for inspection (same as the existing failure path). */
export async function preCommitSteps(rs: RunningSubagent): Promise<{
	note: string;
	finalCommit: string;
	hadChanges: boolean;
}> {
	const notes: string[] = [];
	const { worktreePath, isolationBranch, parentHeadCommit } = rs;
	if (!worktreePath || !isolationBranch || !parentHeadCommit) {
		return { note: "", finalCommit: "", hadChanges: false };
	}

	const t0 = PI_ASYNC_DEBUG ? Date.now() : 0;

	try {
		// Stage and commit any uncommitted changes in the worktree.
		await git(["add", "-A"], worktreePath);
		// Unstage scratch/work-order docs so the auto-commit doesn't leak them
		// into the branch. Dispatch work orders are committed under work-orders/
		// (see agents/orchestrator.md), so this is defense-in-depth against stray
		// WO-*.md scratch copies rather than the primary mechanism (007 validation
		// finding F4 — a 290-line WO doc leaked into the repo this way).
		const stagedNames = (await git(["diff", "--cached", "--name-only"], worktreePath)).stdout;
		const scratch = stagedNames.split("\n").filter((p) => p.length > 0 && /^WO-.*\.md$/i.test(p));
		if (scratch.length > 0) {
			await git(["reset", "-q", "--", ...scratch], worktreePath);
		}

		// Carried files that are byte-identical to what was carried in are
		// the parent's state, not the subagent's work — don't commit them.
		// `git reset -q -- <rel>` restores the index entry for that path to
		// HEAD, so it also unstages carried *deletions* (file absent on the
		// branch). Args-array call handles paths with spaces. Any failure
		// inside the loop degrades via debugLog — never abort preCommitSteps.
		// Mirrored by test-completion-filter.cjs — keep in sync.
		const carried = rs.carried;
		if (carried && carried.size > 0) {
			const untouched: string[] = [];
			try {
				for (const [rel, snap] of carried) {
					const abs = path.join(worktreePath, rel);
					if (snap.state === "absent") {
						if (!fs.existsSync(abs)) untouched.push(rel);
					} else {
						const cur = await hashCarriedFile(abs);
						if (cur === snap.hash) untouched.push(rel);
					}
				}
			} catch (e: any) {
				if (PI_ASYNC_DEBUG) debugLog(`preCommitSteps: carry filter failed — continuing with untouched list: ${e.message || e}`);
			}
			if (untouched.length > 0) {
				await git(["reset", "-q", "--", ...untouched], worktreePath);
			}
		}

		const diffResult = await git(["diff", "--cached", "--quiet"], worktreePath);
		if (diffResult.exitCode !== 0) {
			const commitMsg = `subagent(${rs.agentName}): ${subjectFromTask(rs.task)}`;
			await git(["commit", "-m", commitMsg], worktreePath);
			notes.push(`Uncommitted changes auto-committed to \`${isolationBranch}\`.`);
		}

		// Check whether the branch has diverged from the parent HEAD
		const finalHead = await git(["rev-parse", "HEAD"], worktreePath);
		const finalCommit = finalHead.stdout.trim();
		const hadChanges = diffResult.exitCode !== 0;

		// The branch is worth merging iff it carries commits beyond the parent —
		// either a harness auto-commit (hadChanges) OR the subagent's OWN commit
		// (observed 2026-08-08: a Threefry-removal subagent ran `git commit` itself
		// before completing, leaving nothing staged, so hadChanges was false even
		// though the branch HEAD had moved past the parent — and postDeliveryCleanup
		// then deleted the branch, orphaning the work). Keying the merge hint on the
		// real invariant (finalCommit !== parentHeadCommit) covers both cases.
		if (finalCommit !== parentHeadCommit) {
			notes.push(`Changes preserved on branch \`${isolationBranch}\`.`);
			notes.push(`Merge with: \`git merge ${isolationBranch}\``);
		}

		if (PI_ASYNC_DEBUG) debugLog(`preCommitSteps: ${Date.now() - t0}ms (hadChanges=${hadChanges})`);

		return {
			note: notes.length > 0 ? `\n\n[Isolation] ${notes.join(" ")}` : "",
			finalCommit,
			hadChanges,
		};
	} catch (e: any) {
		notes.push(`Worktree commit error: ${e.message || e}`);
		if (PI_ASYNC_DEBUG) debugLog(`preCommitSteps: FAILED after ${Date.now() - t0}ms: ${e.message || e}`);
		return {
			note: notes.length > 0 ? `\n\n[Isolation] ${notes.join(" ")}` : "",
			finalCommit: "",
			hadChanges: false,
		};
	}
}

// ── Worktree removal ───────────────────────────────────────────────────────

/** The worktree facts a removal needs. `RunningSubagent` satisfies it, and so
 *  does the record the session-start reap rebuilds from a meta file. */
export interface RemovableWorktree {
	worktreePath: string | null;
	isolationBranch: string | null;
	parentHeadCommit: string | null;
	/** The repo the worktree belongs to; the git calls run here. */
	parentCwd: string;
}

/** Per-site removal policy — the only things the two callers disagree on. */
export interface WorktreeRemovalPolicy {
	/** `git worktree remove --force`. Only post-delivery may force: its tree's
	 *  bytes are committed by then. The reap's plain remove is what keeps a race
	 *  from destroying uncommitted work. */
	force: boolean;
	/** The isolation branch's final commit, when the caller knows it. A branch
	 *  that never moved past `parentHeadCommit` is deleted (WO-2026-049); `null`
	 *  keeps it — the reap's case, where the work lives on the branch. */
	finalCommit: string | null;
	/** Reason stamped on the lock a failed removal puts back. */
	relockReason: string;
}

/** Which step of the sequence failed, so the reap can report its own outcome
 *  vocabulary (`kept-unlock-failed` vs `kept-remove-failed`). */
export type RemovalStage = "unlock" | "remove" | "branch";

export interface RemoveWorktreeOutcome {
	ok: boolean;
	stage?: RemovalStage;
	/** Failure text for the caller's log / steer / ReapResult.detail. */
	detail?: string;
	/** Build output dropped after a successful removal (WO-2026-091). */
	buildOutput?: BuildOutputReport;
}

export interface RemovalDeps {
	/** Injection seam for tests; defaults to the module's `git()`. */
	git?: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
	/** Injection seam for the build-output pass; defaults to the real reaper. */
	disposeBuildOutput?: (worktreePath: string, parentCwd: string) => Promise<BuildOutputReport>;
	/** Injection seam for the pruner's `cargo` calls (tests). */
	run?: CommandRunner;
	/** Override for the home whose shared cargo dir the prune derives (tests). */
	home?: string;
}

/**
 * The one unlock → remove → branch-delete sequence (WO-2026-091). Post-delivery
 * cleanup and the session-start reap every other detail of, so the build output
 * that dies with a tree has exactly one place to be dropped from.
 *
 * A failure re-locks the tree best-effort: the unlock succeeded, so leaving it
 * unlocked would leave live work unprotected. Never rmtree the directory — the
 * lock exists to prevent exactly that deletion, and the tree's cleanliness is
 * not known on this path.
 */
export async function removeWorktreeTree(
	deps: RemovalDeps,
	rs: RemovableWorktree,
	policy: WorktreeRemovalPolicy,
): Promise<RemoveWorktreeOutcome> {
	const g = deps.git ?? git;
	const { worktreePath, isolationBranch, parentHeadCommit, parentCwd } = rs;
	if (!worktreePath) return { ok: false, stage: "remove", detail: "no worktree path" };

	// The reap's tree outlives its parent checkout, and `git worktree remove` runs
	// fine from inside the tree being removed — the worktree's own `.git` pointer
	// reaches the same object store.
	const repoCwd = fs.existsSync(parentCwd) ? parentCwd : worktreePath;

	const relock = async () => {
		const r = await g(["worktree", "lock", "--reason", policy.relockReason, worktreePath], repoCwd);
		return r.exitCode;
	};

	// R3-2: unlock first — git refuses to remove a locked tree, and that refusal
	// is the protection against reaping a live child's work. A tree that is not
	// locked (spawned before this change, or already unlocked by the other site)
	// is the one tolerated failure; any other unlock error means the lock may
	// still be in force, so the directory is left alone rather than deleted.
	const unlock = await g(["worktree", "unlock", worktreePath], repoCwd);
	if (unlock.exitCode !== 0 && !/is not locked/i.test(unlock.stderr)) {
		const detail = `git worktree unlock failed: ${unlock.stderr.trim() || `exit ${unlock.exitCode}`}`;
		debugLog(`removeWorktreeTree: ${detail}`);
		return { ok: false, stage: "unlock", detail };
	}

	const removeArgs = policy.force
		? ["worktree", "remove", "--force", worktreePath]
		: ["worktree", "remove", worktreePath];
	const remove = await g(removeArgs, repoCwd);
	if (remove.exitCode !== 0) {
		const detail = `git worktree remove failed: ${remove.stderr.trim() || `exit ${remove.exitCode}`}`;
		const relockExit = await relock();
		debugLog(`removeWorktreeTree: ${detail} (re-lock exit ${relockExit})`);
		return { ok: false, stage: "remove", detail };
	}

	// The build output this tree produced dies with it (WO-2026-091): its own
	// target/ and its share of the clone's shared cargo dir. It runs as soon as
	// the tree is gone — before the branch step, so a `branch -D` failure cannot
	// leave the multi-GB share behind for the next reap. Best-effort: a failure is
	// reported to the caller, never thrown, and never undoes the removal.
	let buildOutput: BuildOutputReport;
	try {
		const dispose = deps.disposeBuildOutput ?? ((p: string, parent: string) => disposeWorktreeBuildOutput(p, parent, { run: deps.run, home: deps.home }));
		buildOutput = await dispose(worktreePath, parentCwd);
	} catch (e) {
		const detail = `build-output prune failed: ${e instanceof Error ? e.message : String(e)}`;
		debugLog(`removeWorktreeTree: ${detail}`);
		buildOutput = { targetRemoved: false, problems: [detail] };
	}

	// A branch still at the parent commit committed nothing — neither the harness
	// nor the subagent itself — so delete it. `hadChanges` alone is NOT a safe
	// signal: a subagent that committed its own work leaves nothing staged, so
	// preCommitSteps reports hadChanges=false even though the branch HEAD moved
	// past the parent; keying on finalCommit preserves those commits. (WO-2026-049;
	// the Threefry branch-loss incident, 2026-08-08, where a self-commit's branch
	// was deleted and the work survived only as a dangling commit.)
	if (isolationBranch && parentHeadCommit && policy.finalCommit === parentHeadCommit) {
		const del = await g(["branch", "-D", isolationBranch], repoCwd);
		if (del.exitCode !== 0) {
			// The tree is already gone, so there is nothing to re-lock and no
			// unprotected work: only the branch ref survived.
			const detail = `git branch -D ${isolationBranch} failed: ${del.stderr.trim() || `exit ${del.exitCode}`}`;
			debugLog(`removeWorktreeTree: ${detail}`);
			return { ok: false, stage: "branch", detail, buildOutput };
		}
	}

	return { ok: true, buildOutput };
}

/** Post-delivery cleanup: remove the worktree directory and delete the branch
 *  when no changes were committed. Runs async after deliverResult; failures are
 *  logged and surfaced as a steer warning, never fatal. */
export async function postDeliveryCleanup(
	pi: ExtensionAPI,
	rs: RunningSubagent,
	finalCommit: string,
	hadChanges: boolean,
): Promise<void> {
	const { worktreePath, isolationBranch, parentHeadCommit } = rs;
	if (!worktreePath || !isolationBranch || !parentHeadCommit) return;

	const t0 = PI_ASYNC_DEBUG ? Date.now() : 0;
	const outcome = await removeWorktreeTree({}, rs, {
		force: true,
		finalCommit,
		relockReason: `pi-subagent ${rs.sessionId} (cleanup failed)`,
	});

	const buildOutput = outcome.buildOutput ? describeBuildOutput(outcome.buildOutput) : null;
	if (outcome.ok) {
		if (PI_ASYNC_DEBUG) {
			debugLog(`postDeliveryCleanup: ${Date.now() - t0}ms (hadChanges=${hadChanges})${buildOutput ? ` — ${buildOutput}` : ""}`);
		}
		return;
	}

	if (PI_ASYNC_DEBUG) debugLog(`postDeliveryCleanup: FAILED after ${Date.now() - t0}ms: ${outcome.detail}`);
	// Surface the warning to the parent via steer. A removal failure re-locked the
	// tree (or never unlocked it), so live work stays guarded and the worktree is
	// still on disk; a branch-delete failure happens after the tree is gone, so it
	// says only that the ref survived. A prune problem from the same removal rides
	// along: the branch failure used to be the only thing the parent heard.
	const where =
		outcome.stage === "branch"
			? `the worktree is removed; branch \`${rs.isolationBranch}\` still exists`
			: `worktree at ${worktreePath} may need manual removal`;
	const pruned = buildOutput ? ` — build output: ${buildOutput}` : "";
	try {
		pi.sendUserMessage(
			`[subagent ${rs.sessionId.slice(-8)}] warning: worktree cleanup failed: ${outcome.detail} — ${where}${pruned}`,
			{ deliverAs: "steer" },
		);
	} catch { /* steer failed — nothing we can do */ }
}

export async function writeTempFile(name: string, content: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-async-subagent-"));
	const safeName = name.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await fs.promises.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

export function getFinalOutput(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") {
					return part.text.replace(/^\s*\[session_id:[^\]]*\]\s*$/gim, "").trimEnd();
				}
			}
		}
	}
	return "";
}
