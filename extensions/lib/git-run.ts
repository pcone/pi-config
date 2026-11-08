/**
 * One bounded `git` invocation, as an outcome rather than an exception.
 *
 * Three extensions run git and each grew its own shape: `seat-sync` needed exit
 * status, stdout and the failing stderr line; `checkpoint-meta` wanted a
 * rejecting promise; `owner-asks` wanted "trimmed stdout or null" with no bound
 * at all. The bound is the convention that matters — a hung git must never hold
 * a caller (`extensions/lib/checkpoint-meta.ts`'s `GIT_TIMEOUT_MS`) — so the
 * command, its timeout and its stderr selection live here and the three keep
 * adapters over it.
 *
 * No pi import: this module stays unit-testable.
 */
import { execFile } from "node:child_process";

/**
 * A git call that has not answered in this long is killed. Comfortably longer
 * than any local `status`/`rev-list` on this box's largest checkout, and short
 * enough that a wedged call cannot hold a session's report.
 */
export const DEFAULT_GIT_TIMEOUT_MS = 5_000;

export interface GitResult {
	ok: boolean;
	/** stdout without its trailing newline. Not `trim()`: `status --porcelain`
	 *  starts its first line with a status column, and stripping it shifts every
	 *  path by one character. */
	out: string;
	/** Last non-empty stderr line — the `fatal:` line, not git's advice. Falls
	 *  back to the spawn's own message when git printed nothing (ENOENT). */
	err: string;
	/** True when the bound killed it rather than git exiting. */
	timedOut: boolean;
}

export interface GitOptions {
	/** Override the bound (the shared fetch uses its own, longer one). */
	timeoutMs?: number;
	/** Extra environment, e.g. `GIT_TERMINAL_PROMPT: "0"` for a fetch. */
	env?: NodeJS.ProcessEnv;
}

export function runGit(cwd: string, args: string[], opts: GitOptions = {}): Promise<GitResult> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
	return new Promise((resolve) => {
		execFile(
			"git",
			args,
			{ cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: opts.env },
			(err, stdout, stderr) => {
				const lines = stderr
					.split("\n")
					.map((line) => line.trim())
					.filter((line) => line !== "");
				resolve({
					ok: !err,
					out: stdout.trimEnd(),
					err: lines.length === 0 ? (err?.message ?? "") : lines[lines.length - 1],
					timedOut: (err as { killed?: boolean } | null)?.killed === true,
				});
			},
		);
	});
}
