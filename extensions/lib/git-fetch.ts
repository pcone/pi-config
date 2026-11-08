/**
 * At most one `git fetch` in flight per checkout, shared by every caller.
 *
 * Two extensions want the same refs: `owner-asks` reads the upstream branch to
 * count registry asks, and `seat-sync` fast-forwards the checkout to it. Two
 * fetches of one checkout in one session download the same pack twice, so the
 * command, its environment and its bound live here. A caller that arrives while
 * a fetch is running joins that fetch instead of starting another (`joined`).
 * A caller that arrives after it finished starts its own — the throttle for
 * "fetched recently enough" is `owner-asks`' five-minute stamp, not this module's.
 *
 * Two shapes, because the callers differ in what they need from it:
 *
 * - **awaited** (default): pipes, so the outcome carries git's stderr, and the
 *   caller's process stays alive until the bound. `seat-sync` needs this: it
 *   reports a failed fetch by quoting it.
 * - **background** (`background: true`): detached, stdio ignored, both the child
 *   and the bound timer unreferenced, so a short-lived caller (the Claude Code
 *   statusline, `~/.claude/commands/asks.md`) exits at once instead of waiting
 *   out the fetch. Nothing captures git's stderr in this shape: a joiner reports
 *   `joined: true` with `stderr: ""`, which is what "no stderr captured" means.
 *   The messages it does carry are this module's own — the bound that killed the
 *   fetch, or a spawn that never reached git.
 *
 * No pi import: this module stays unit-testable, and the Claude Code CLI loads it.
 */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { runGit } from "./git-run.ts";

/**
 * A fetch that has not finished in this long is killed. A remote that is slow,
 * offline, or waiting on credentials would otherwise hold the caller (seat-sync
 * waits on the fetch before deciding to fast-forward) for as long as it likes.
 */
export const FETCH_TIMEOUT_MS = 10_000;

export interface FetchOutcome {
	ok: boolean;
	/** git's stderr, last non-empty line — or the spawn's own message when git
	 *  never ran. "" when there is neither, which is every plain failure of a
	 *  background shape: it captures no stderr. */
	stderr: string;
	/** True when this call joined a fetch already running for the same checkout. */
	joined: boolean;
}

export interface FetchOptions {
	/** Override the bound. */
	timeoutMs?: number;
	/** Do not hold the caller's process open for the fetch, and capture no stderr. */
	background?: boolean;
}

/**
 * Real-path key, so two callers that name one checkout differently (`/Users/…`
 * vs its symlink-resolved form, or a trailing slash) share one fetch instead of
 * racing two.
 */
function keyOf(root: string): string {
	try {
		return realpathSync(root);
	} catch {
		return root;
	}
}

const inFlight = new Map<string, Promise<FetchOutcome>>();

/**
 * Fetch `root`'s remotes, or join the fetch already running for it. Never
 * rejects: a failure is an outcome, because the callers report it rather than
 * handle it.
 */
export function fetchCheckout(root: string, opts: FetchOptions = {}): Promise<FetchOutcome> {
	const key = keyOf(root);
	const running = inFlight.get(key);
	if (running) return running.then((outcome) => ({ ...outcome, joined: true }));

	const run = opts.background ? spawnBackground(key, opts.timeoutMs ?? FETCH_TIMEOUT_MS) : awaited(key, opts.timeoutMs);
	// Registered synchronously, so a second caller in the same tick joins.
	inFlight.set(key, run);
	return run.finally(() => {
		inFlight.delete(key);
	});
}

async function awaited(root: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<FetchOutcome> {
	const result = await runGit(root, ["fetch", "--quiet"], {
		timeoutMs,
		// No prompt: a fetch that waits on credentials hangs until the bound kills it.
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});
	if (result.ok) return { ok: true, stderr: "", joined: false };
	return {
		ok: false,
		stderr: result.timedOut
			? `git fetch --quiet timed out after ${timeoutMs}ms in ${root}`
			: result.err,
		joined: false,
	};
}

function spawnBackground(root: string, timeoutMs: number): Promise<FetchOutcome> {
	return new Promise((resolve) => {
		const child = spawn("git", ["fetch", "--quiet"], {
			cwd: root,
			detached: true,
			stdio: "ignore",
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		});
		// Both handles unreferenced: the caller may exit before the fetch ends,
		// which is the whole point of this shape.
		child.unref();
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			resolve({ ok: false, stderr: `git fetch --quiet timed out after ${timeoutMs}ms in ${root}`, joined: false });
		}, timeoutMs);
		timer.unref();
		child.on("error", (err) => {
			clearTimeout(timer);
			// git printed nothing because it never ran: the spawn's own message is the
			// only diagnosis there is. A non-zero exit is different — this shape does
			// not capture what git said on the way out.
			resolve({ ok: false, stderr: err.message, joined: false });
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			resolve(code === 0 ? { ok: true, stderr: "", joined: false } : { ok: false, stderr: "", joined: false });
		});
	});
}
