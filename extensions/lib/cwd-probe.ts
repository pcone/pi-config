/**
 * Which process is working in a checkout. The unused gate of the checkout reaper
 * asks one question — is any process's working directory this tree or inside it? —
 * and this is where the answer comes from.
 *
 * One sweep answers for the whole box: a per-candidate probe would pay the same
 * cost once per candidate. An empty list with a problem means the evidence is
 * missing, and the caller keeps rather than guessing.
 *
 * Design: `docs/design/checkout-reaper.md`. Extracted from `checkout-reaper.ts`
 * (WO-2026-092's register note, 2026-11-10) so the file's next change did not
 * grow it.
 */
import * as fs from "node:fs";
import { homedir } from "node:os";
import type { CommandRunner } from "./build-output-reaper.ts";

export interface ProcessCwd {
	pid: number;
	cwd: string;
}

/** What one sweep found, and how far it could see. `problem` means no evidence
 *  (`unusedCheck` keeps rather than guessing); `note` rides on a sweep that
 *  answered for only some processes, so the report states its own reach. */
export interface CwdProbe {
	cwds: ProcessCwd[];
	problem: string | null;
	note?: string;
}

/** The sweep this platform can do. macOS has no `/proc`, so `lsof -d cwd` answers
 *  for every process; Linux reads `/proc/<pid>/cwd`, which needs no tool but shows
 *  only this user's processes. `platform` is a parameter for the same reason
 *  `processStartToken`'s is (subagent-state.ts): a row can pin the other arm on
 *  whichever box runs it. */
export async function processCwdProbe(
	run: CommandRunner,
	home: string,
	platform: string = process.platform,
): Promise<CwdProbe> {
	return platform === "linux" ? procCwdProbe() : lsofProcessCwds(run, home);
}

/** Linux: one readlink per pid. Kernel threads have no cwd link, and other users'
 *  processes refuse the read (`EPERM`); both are counted, because the gate's
 *  question is answered only for the processes this user can read. `EPERM` is the
 *  real blind spot and `ENOENT` is a pid that went away mid-sweep, but both mean
 *  "not readable here", and a single count is what the report can honestly say. */
export function procCwdProbe(dir = "/proc"): CwdProbe {
	const cwds: ProcessCwd[] = [];
	let unreadable = 0;
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch (e) {
		return { cwds, problem: `cannot list ${dir}: ${e instanceof Error ? e.message : String(e)}` };
	}
	for (const name of names) {
		const pid = Number.parseInt(name, 10);
		if (!Number.isFinite(pid)) continue;
		try {
			cwds.push({ pid, cwd: fs.readlinkSync(`${dir}/${name}/cwd`) });
		} catch {
			unreadable += 1;
		}
	}
	if (cwds.length === 0) return { cwds, problem: `no readable ${dir}/<pid>/cwd entries` };
	// readdir order is the filesystem's, and `processInside` reports the first match:
	// sort, so the pid the report names does not depend on it.
	cwds.sort((a, b) => a.pid - b.pid);
	return {
		cwds,
		problem: null,
		note: unreadable > 0 ? `cwd sweep: ${unreadable} process${unreadable === 1 ? "" : "es"} not readable (other users or kernel threads)` : undefined,
	};
}

/** macOS: `lsof -d cwd -Fpn`, one pass for the box. `cwd` is where the command
 *  runs: the reaper's home, so a home override is honoured. */
export async function lsofProcessCwds(
	run: CommandRunner,
	cwd: string = homedir(),
): Promise<CwdProbe> {
	const out = await run("lsof", ["-d", "cwd", "-Fpn"], { cwd });
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
