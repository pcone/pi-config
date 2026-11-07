/** Wait for a child close handler to finish writing its log footer.
 *
 * The close handler removes the running session only after logging its
 * completion footer. Deleting the log earlier races that write and leaks a
 * newly recreated file under /tmp.
 */
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { metaPath, resolveRunningSession } from "../../extensions/subagent-async/index.ts";

/** Remove everything a real spawn leaves for a handle: its meta, log, socket and
 *  its child transcript under `~/.pi/agent/sessions`. One mechanism for the
 *  cleanup row, so a K-row run leaves no `/tmp` or `/resume` litter behind. */
export function removeSpawnArtifacts(sid: string): void {
	const files = [metaPath(sid), `/tmp/pi-subagent-${sid}.log`, `/tmp/pi-subagent-${sid}.sock`];
	const sessionsRoot = join(homedir(), ".pi", "agent", "sessions");
	try {
		for (const dir of readdirSync(sessionsRoot)) {
			let entries: string[] = [];
			try {
				entries = readdirSync(join(sessionsRoot, dir));
			} catch {
				continue;
			}
			for (const entry of entries) if (entry.endsWith(`_${sid}.jsonl`)) files.push(join(sessionsRoot, dir, entry));
		}
	} catch {
		// no transcripts directory
	}
	for (const f of files) {
		try {
			rmSync(f, { force: true });
		} catch {
			// best-effort
		}
	}
}

export async function waitUntilUntracked(sid: string, ms = 10_000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (!resolveRunningSession(sid)) return true;
        await new Promise((r) => setTimeout(r, 25));
    }
    return !resolveRunningSession(sid);
}
