/**
 * One canonical form for a path our code compares or stats.
 *
 * A path arrives spelled however the caller saw it. On macOS `/var/folders/…`
 * and `/private/var/folders/…` name one directory, and tools disagree about
 * which they print: `lsof` and `git worktree list` print resolved paths, an env
 * override arrives as the caller typed it, and a session file arrives as the
 * child process spelled it. Two spellings of one directory compare unequal, so
 * a prefix test or a Set key silently misses.
 *
 * The fix is to canonicalise once, where the path enters, and compare the
 * canonical form everywhere after. `worktree-guard.ts` hand-rolled this
 * (`resolveAnchor`, and `WORKTREE_ROOT_PREFIX` resolved at module load, both
 * documented as "consistent with the symlink-resolved absolute paths") before
 * this module existed; it is the same operation, so both call sites now share
 * it.
 *
 * A path that does not exist yet is not an error: the nearest existing ancestor
 * is resolved and the rest rejoined. Worktree bases and agent dirs are created
 * lazily, and a caller canonicalising one before its first dispatch must not
 * fail or, worse, fall back to the raw spelling.
 */

import { realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";

/**
 * `path` with every symlinked component resolved, or `path` itself when no
 * component of it exists.
 */
export function canonicalPath(path: string): string {
	if (!path) return path;
	const trailing = path.endsWith(sep) && path !== sep ? sep : "";
	let prefix = "";
	let rest = trailing ? path.slice(0, -1) : path;
	for (;;) {
		try {
			return realpathSync(prefix + rest) + trailing;
		} catch {
			const cut = rest.lastIndexOf(sep);
			// Nothing resolvable anywhere: the raw path is all there is.
			if (cut < 1) return path;
			prefix = rest.slice(0, cut);
			rest = rest.slice(cut);
		}
	}
}

/**
 * `path` canonicalised and with a trailing separator, for prefix tests against
 * a directory. `"/a/b/"` rather than `"/a/b"` so `/a/bc` does not match.
 */
export function canonicalDirPrefix(path: string): string {
	const base = canonicalPath(path).replace(/\/+$/, "");
	return join(base, sep) === base ? base : `${base}${sep}`;
}
