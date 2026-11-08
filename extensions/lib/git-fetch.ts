/**
 * One `git fetch` per checkout per process.
 *
 * Two extensions want the same refs: `owner-asks` reads the upstream branch to
 * count registry asks, and `seat-sync` fast-forwards the checkout to it. Two
 * fetches of one checkout in one session download the same pack twice, so the
 * command, its environment and its bound live here and both callers share it.
 * A caller that arrives while a fetch is running joins that fetch instead of
 * starting another (`joined`).
 *
 * No pi import: this module stays unit-testable and callable from the Claude
 * Code CLI side, like `owner-asks/lib.ts`.
 */
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";

/**
 * A fetch that has not finished in this long is killed. A remote that is slow,
 * offline, or waiting on credentials would otherwise hold the caller (seat-sync
 * waits on the fetch before deciding to fast-forward) for as long as it likes.
 */
export const FETCH_TIMEOUT_MS = 10_000;

export interface FetchOutcome {
	ok: boolean;
	/** git's stderr, last non-empty line; "" when it printed none. */
	stderr: string;
	/** True when this call joined a fetch already running for the same checkout. */
	joined: boolean;
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

/** Last non-empty line of git's stderr — the `fatal:` line, not its advice. */
function lastLine(text: string): string {
	const lines = text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
	return lines.length === 0 ? "" : lines[lines.length - 1];
}

const inFlight = new Map<string, Promise<FetchOutcome>>();

/**
 * Fetch `root`'s remotes, or join the fetch already running for it. Never
 * rejects: a failure is an outcome, because the callers report it rather than
 * handle it.
 */
export function fetchCheckout(root: string, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<FetchOutcome> {
	const key = keyOf(root);
	const running = inFlight.get(key);
	if (running) return running.then((outcome) => ({ ...outcome, joined: true }));

	const run = spawnFetch(key, timeoutMs);
	// Registered synchronously, so a second caller in the same tick joins.
	inFlight.set(key, run);
	return run.finally(() => {
		inFlight.delete(key);
	});
}

function spawnFetch(root: string, timeoutMs: number): Promise<FetchOutcome> {
	return new Promise((resolve) => {
		execFile(
			"git",
			["fetch", "--quiet"],
			{
				cwd: root,
				timeout: timeoutMs,
				maxBuffer: 1024 * 1024,
				// No prompt: a fetch that waits on credentials hangs until the bound kills it.
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			},
			(err, _stdout, stderr) => {
				if (!err) {
					resolve({ ok: true, stderr: "", joined: false });
					return;
				}
				const timedOut = (err as { killed?: boolean }).killed === true;
				resolve({
					ok: false,
					stderr: timedOut
						? `git fetch --quiet timed out after ${timeoutMs}ms in ${root}`
						: lastLine(stderr) || err.message,
					joined: false,
				});
			},
		);
	});
}
