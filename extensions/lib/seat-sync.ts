/**
 * Seat checkout sync: fast-forward a clone's main checkout to its upstream, or
 * say why it cannot.
 *
 * A seat starts its session in the clone itself (`~/Developer/tfd`), so a
 * checkout days behind `origin` is a session running days-old instructions,
 * docs and decision records. Nothing synced it before this module.
 *
 * Three rules carry the safety:
 *
 * - The tree moves only when it is clean (`git status --porcelain -uall` empty)
 *   and not ahead of its upstream (`rev-list --count --left-right` behind only),
 *   and only by `git merge --ff-only`. No `reset`, no `stash`, no non-FF merge.
 * - The gate never touches a worktree: a `.git` *file* is a worktree, and any
 *   path beneath a `wt/` directory is somebody's tree, not a seat checkout.
 * - The session never waits on the network. The caller runs everything below
 *   from a task it does not await; only the fetch waits, and only on itself.
 *
 * Design: `docs/design/seat-sync.md`. Decision:
 * `decisions/sessions/002-seat-checkout-sync.md`.
 */
import { statSync } from "node:fs";
import { join, sep } from "node:path";
import { liveUi, safeNotify } from "./safe-notify.ts";
import { fetchCheckout } from "./git-fetch.ts";
import { runGit } from "./git-run.ts";

/** Footer status key. */
export const STATUS_KEY = "seat-sync";

/** Dirty files named in a warning; past this the rest are a count. */
export const DIRTY_LIST_LIMIT = 10;

/** Subjects named when the checkout is ahead of its upstream. */
export const AHEAD_SUBJECT_LIMIT = 3;

// ── The gate ───────────────────────────────────────────────────────────────

export type ScopeReason = "seat" | "not-a-clone" | "worktree" | "wt-path";

export interface SeatScope {
	isSeat: boolean;
	reason: ScopeReason;
	/** The checkout a sync would act on: the session's cwd. */
	root: string;
}

/**
 * Whether `cwd` is a clone's main checkout. Filesystem only — the upstream probe
 * spawns git, and that runs off the turn path, in `syncSeat`.
 */
export function seatScope(cwd: string): SeatScope {
	// Any `wt` component: `~/Developer/wt/tfd-425`, `~/Developer/wt/subagents/…`.
	// The daily worktree base is where every non-seat tree in this setup lives,
	// and a hand-made clone parked there is still not a seat.
	if (cwd.split(sep).includes("wt")) return { isSeat: false, reason: "wt-path", root: cwd };

	let git: ReturnType<typeof statSync>;
	try {
		git = statSync(join(cwd, ".git"));
	} catch {
		// Not a repository, or a subdirectory of one: a session there rides the
		// checkout it sits in, which is synced when a session starts at its top.
		return { isSeat: false, reason: "not-a-clone", root: cwd };
	}
	if (!git.isDirectory()) return { isSeat: false, reason: "worktree", root: cwd };
	return { isSeat: true, reason: "seat", root: cwd };
}

// ── The decision ───────────────────────────────────────────────────────────

export interface SyncFacts {
	/** `git status --porcelain -uall` lines, verbatim. */
	statusLines: string[];
	behind: number;
	ahead: number;
}

export type SyncPlan =
	| { kind: "dirty" }
	| { kind: "diverged"; ahead: number; behind: number }
	| { kind: "ahead"; ahead: number }
	| { kind: "behind"; behind: number }
	| { kind: "up-to-date" };

/**
 * Which blocker a clean-looking tree actually has. Dirty comes first because a
 * fast-forward needs a clean tree whatever the counts say; divergence before
 * ahead because it needs both numbers to be understood.
 */
export function planSync(facts: SyncFacts): SyncPlan {
	if (facts.statusLines.length > 0) return { kind: "dirty" };
	if (facts.ahead > 0 && facts.behind > 0) return { kind: "diverged", ahead: facts.ahead, behind: facts.behind };
	if (facts.ahead > 0) return { kind: "ahead", ahead: facts.ahead };
	if (facts.behind > 0) return { kind: "behind", behind: facts.behind };
	return { kind: "up-to-date" };
}

/** `git status --porcelain` line → its two status columns and the path they describe. */
export function parseStatusLine(line: string): { code: string; path: string } {
	// The two status columns, as git printed them: no inferred code for a line
	// git never produces.
	const code = line.slice(0, 2).trim();
	const rest = line.slice(3);
	// A rename prints `R  old -> new`; the new path is what exists now.
	const path = rest.includes(" -> ") ? rest.split(" -> ").pop()! : rest;
	return { code, path };
}

/** `M docs/x.md` lines, capped at `limit`, and whether anything was left out. */
export function dirtyLines(statusLines: string[], limit: number = DIRTY_LIST_LIMIT): { lines: string[]; omitted: number } {
	const shown = statusLines.slice(0, limit).map((line) => {
		const { code, path } = parseStatusLine(line);
		return `${code} ${path}`;
	});
	return { lines: shown, omitted: statusLines.length - shown.length };
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// ── The report ─────────────────────────────────────────────────────────────

export type SyncOutcome = "skipped" | "up-to-date" | "fast-forwarded" | "blocked";

export interface SeatReport {
	outcome: SyncOutcome;
	/** One line on why: the skip reason, the blocker, or what moved. */
	reason: string;
	/** Status-bar note; absent when the outcome is not worth one. */
	status?: string;
	/** The warning a blocked outcome shows. Absent unless blocked. */
	warning?: string;
	/** Every git invocation, in order — the `PI_SEAT_SYNC_DEBUG=1` line. */
	commands: string[];
}

/**
 * What to append after "failed in <root>". A join of a background fetch carries
 * no stderr (that shape discards it), and saying so beats a colon with nothing
 * after it.
 */
function fetchDetail(fetched: { stderr: string; joined: boolean }): string {
	if (fetched.stderr) return `: ${fetched.stderr}`;
	return fetched.joined ? " (stderr not captured: joined a background fetch)" : "";
}

function blocked(reason: string, status: string, warning: string, commands: string[]): SeatReport {
	return { outcome: "blocked", reason, status, warning, commands };
}

// ── The sync ───────────────────────────────────────────────────────────────

export interface SyncOptions {
	/** Fetch bound; `fetchCheckout`'s own default unless a row needs it shorter. */
	fetchTimeoutMs?: number;
}

/**
 * Fetch, decide, and fast-forward `root` when that is safe. Never rejects for a
 * git outcome — every one of those is a report — so the caller's only failure is
 * a bug.
 */
export async function syncSeat(root: string, opts: SyncOptions = {}): Promise<SeatReport> {
	const commands: string[] = [];
	const git = (args: string[]) => {
		commands.push(`git ${args.join(" ")}`);
		return runGit(root, args);
	};

	// Upstream first: a branch without one has nothing to fast-forward to, and
	// the fetch would be spent for nothing.
	const upstream = await git(["rev-parse", "--abbrev-ref", "@{u}"]);
	if (!upstream.ok) return { outcome: "skipped", reason: `no upstream (${upstream.err})`, commands };
	const upstreamName = upstream.out;

	commands.push("git fetch --quiet");
	const fetched = await fetchCheckout(root, { timeoutMs: opts.fetchTimeoutMs });
	if (!fetched.ok) {
		return blocked(
			"fetch failed",
			"seat sync: BLOCKED — fetch failed",
			`seat sync: BLOCKED — git fetch --quiet failed in ${root}${fetchDetail(fetched)}`,
			commands,
		);
	}

	const status = await git(["status", "--porcelain", "-uall"]);
	if (!status.ok) {
		return blocked(
			"cannot read the working tree",
			"seat sync: BLOCKED — cannot read the working tree",
			`seat sync: BLOCKED — git status --porcelain -uall failed in ${root}: ${status.err}`,
			commands,
		);
	}

	const counts = await git(["rev-list", "--count", "--left-right", "@{u}...HEAD"]);
	if (!counts.ok) {
		return blocked(
			"cannot read the upstream divergence",
			"seat sync: BLOCKED — cannot read the upstream divergence",
			`seat sync: BLOCKED — git rev-list --count --left-right @{u}...HEAD failed in ${root}: ${counts.err}`,
			commands,
		);
	}
	// `--left-right` prints "<behind>\t<ahead>". Exit 0 with anything else is a
	// broken git contract, not a state to guess at.
	const [behind, ahead] = counts.out.split(/\s+/).map(Number);
	if (!Number.isInteger(behind) || !Number.isInteger(ahead)) {
		throw new Error(`unexpected \`rev-list --count --left-right\` output: ${JSON.stringify(counts.out)}`);
	}

	const statusLines = status.out === "" ? [] : status.out.split("\n");
	const plan = planSync({ statusLines, behind, ahead });

	switch (plan.kind) {
		case "up-to-date":
			return { outcome: "up-to-date", reason: `up to date with ${upstreamName}`, commands };

		case "dirty": {
			const { lines, omitted } = dirtyLines(statusLines);
			const total = statusLines.length;
			const more = omitted > 0 ? [`  … and ${omitted} more`] : [];
			return blocked(
				`${plural(total, "dirty file")}`,
				`seat sync: BLOCKED — ${plural(total, "dirty file")}`,
				[
					`seat sync: BLOCKED — ${root} has ${plural(total, "dirty file")} and was not fast-forwarded to ${upstreamName}.`,
					...lines.map((line) => `  ${line}`),
					...more,
					"Commit or clean them; the next session fast-forwards the checkout.",
				].join("\n"),
				commands,
			);
		}

		case "diverged":
			return blocked(
				`diverged from ${upstreamName}: ${ahead} ahead, ${behind} behind`,
				`seat sync: BLOCKED — diverged from ${upstreamName}: ${ahead} ahead, ${behind} behind`,
				`seat sync: BLOCKED — ${root} has diverged from ${upstreamName}: ${plural(ahead, "commit")} it does not have, ${plural(behind, "commit")} it does. Nothing was moved; reconcile by hand.`,
				commands,
			);

		case "ahead": {
			const subjects = await git(["log", `--max-count=${AHEAD_SUBJECT_LIMIT}`, "--format=%s", "@{u}..HEAD"]);
			// The subjects are decoration; the count is the fact. A log that fails
			// leaves them unnamed rather than failing the report.
			const lines = subjects.ok && subjects.out !== "" ? subjects.out.split("\n").map((s) => `  ${s}`) : [];
			return blocked(
				`${plural(ahead, "commit")} ahead of ${upstreamName}`,
				`seat sync: BLOCKED — ${plural(ahead, "commit")} ahead of ${upstreamName}`,
				[
					`seat sync: BLOCKED — ${root} is ${plural(ahead, "commit")} ahead of ${upstreamName}, so there is nothing to fast-forward.`,
					...lines,
					"Push or drop them; nothing was moved.",
				].join("\n"),
				commands,
			);
		}

		case "behind": {
			const merged = await git(["merge", "--ff-only", "@{u}"]);
			if (!merged.ok) {
				return blocked(
					"fast-forward failed",
					"seat sync: BLOCKED — fast-forward failed",
					`seat sync: BLOCKED — git merge --ff-only @{u} failed in ${root}: ${merged.err}`,
					commands,
				);
			}
			return {
				outcome: "fast-forwarded",
				reason: `fast-forwarded ${plural(behind, "commit")}`,
				status: `seat sync: fast-forwarded ${plural(behind, "commit")}`,
				commands,
			};
		}
	}
}

// ── Where it is seen ───────────────────────────────────────────────────────

export interface SeatUi {
	hasUI: boolean;
	ui: {
		setStatus(key: string, text: string | undefined): void;
		notify?(message: string, level?: "info" | "warning" | "error"): void;
		theme: { fg(color: string, text: string): string };
	};
}

/**
 * Write the report where a human sees it: the status line always, and a warning
 * notification for a blocked checkout. `PI_SEAT_SYNC_DEBUG=1` adds the exact
 * git invocations — for a report that cannot be reproduced from the status text.
 *
 * Print/RPC mode has no status bar, so a warning goes to stderr there: it is the
 * one thing the report exists to say, and it must not vanish with the UI.
 */
export function applyReport(ctx: SeatUi, report: SeatReport, debug: boolean): void {
	// Every ctx read happens here, in one guarded take: `hasUI` and `ui` are
	// getters that throw once the session that started this task is replaced or
	// reloaded, and this task deliberately outlives that (`lib/safe-notify.ts`).
	const surface = liveUi(ctx);
	if (!surface) return;
	const { hasUI, ui } = surface;

	const setStatus = (text: string | undefined, color?: "warning"): void => {
		try {
			ui.setStatus(STATUS_KEY, color ? ui.theme.fg(color, text!) : text);
		} catch { /* ctx stale after reload */ }
	};

	if (report.warning) {
		if (hasUI) {
			safeNotify({ ui }, report.warning, "warning");
			setStatus(report.status, "warning");
		} else {
			console.warn(report.warning);
		}
	} else if (hasUI) {
		// An up-to-date or skipped checkout clears the note: it describes this
		// checkout as it stands now, not as a pre-reload sync left it.
		setStatus(report.status);
	}

	if (!debug) return;
	const line = `[seat-sync] ${report.outcome}: ${report.reason}; commands: ${report.commands.join(" ; ") || "none"}`;
	if (hasUI) safeNotify({ ui }, line, "info");
	else console.warn(line);
}
