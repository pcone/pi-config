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

/** One `lsof -d cwd` pass for the whole box. `cwd` is where the command runs:
 *  the reaper's home, so a home override is honoured. */
export async function lsofProcessCwds(
	run: CommandRunner,
	cwd: string = homedir(),
): Promise<{ cwds: ProcessCwd[]; problem: string | null }> {
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
