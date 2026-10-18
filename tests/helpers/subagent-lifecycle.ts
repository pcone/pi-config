/** Wait for a child close handler to finish writing its log footer.
 *
 * The close handler removes the running session only after logging its
 * completion footer. Deleting the log earlier races that write and leaks a
 * newly recreated file under /tmp.
 */
import { resolveRunningSession } from "../../extensions/subagent-async/index.ts";

export async function waitUntilUntracked(sid: string, ms = 10_000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (!resolveRunningSession(sid)) return true;
        await new Promise((r) => setTimeout(r, 25));
    }
    return !resolveRunningSession(sid);
}
