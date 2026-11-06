/**
 * The viewers' text helpers: visible width, escape stripping, truncation,
 * padding and the relative timestamp. Both viewers render the same session log,
 * so the measurement that decides where a line is cut lives here once.
 *
 * `plainLen` is a manual scan, not a regex (WO-2026-088 §Ruling). The regex it
 * replaces matched `ESC [ [0-9;]* <letter>`, so a sequence it could not strip was
 * counted as columns: `"abESC["` measured 4, `"ESC[31"` 4, `"ESC["` 2. The scan
 * reads those bytes as a sequence the terminal never completes, and measures 0.
 *
 * The two forms differ on every escape sequence the regex fails to strip, which
 * is wider than the unterminated tail: a body byte outside `[0-9;]` is left
 * unstripped too, so `ESC[?25l` measures 0 where it measured 6. Both directions
 * occur — the scan counts a stray `ESC` inside a sequence as one visible column,
 * so `ESC[ESC[0m` measures 4 where the regex measured 2 — and the scan is not
 * always the smaller count. Measured over WO-2026-088's alphabet: 28,002
 * divergent strings, 42 of them running that way.
 *
 * The `.cjs` cuts raw log lines, so a line carrying a sequence neither viewer
 * composed measures differently here than it did through the regex — and cuts
 * differently where the two measurements fall either side of the width. SGR
 * bodies, which both viewers compose, measure the same. Every control code
 * counts as zero width, not only the SGR-shaped ones — owner 2026-11-07 (Q-B1,
 * `work-orders/WO-2026-088-view-text-shared-helpers.md`), which is what stops a
 * line carrying a hide-cursor sequence from being cut as though it were ten
 * columns wider than it looks.
 *
 * Importable from plain `node`: the `.cjs` viewer requires this module, so it
 * takes no dependencies and no non-erasable TypeScript syntax.
 */

/**
 * Columns a terminal advances over `s`: everything that is not part of an
 * escape sequence. An unterminated escape sequence advances nothing, so the
 * bytes after it measure 0.
 */
export function plainLen(s: string): number {
	let len = 0;
	let inEscape = false;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (inEscape) {
			if (ch === "\x1b") {
				len++;
				inEscape = false;
				continue;
			}
			if (ch && /[A-Za-z]/.test(ch)) inEscape = false;
			continue;
		}
		if (ch === "\x1b" && s[i + 1] === "[") {
			inEscape = true;
			i++;
			continue;
		}
		len++;
	}
	return len;
}

/** Return `s` with all ANSI escape sequences removed. */
export function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

/** `s` followed by spaces to `width` visible columns; never truncated. */
export function padRight(s: string, width: number): string {
	const len = plainLen(s);
	if (len >= width) return s;
	return s + " ".repeat(width - len);
}

/** Relative age at the coarsest unit that fits: `59s ago`, `1m ago`, `1h ago`. */
export function timeAgo(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	return `${Math.floor(m / 60)}h ago`;
}

/**
 * `str` cut to `width` visible columns, ending in an ellipsis and a reset:
 * `width - 1` visible characters plus `…ESC[0m`. Escape sequences on the kept
 * prefix are preserved whole; input that already fits is returned untouched.
 */
export function truncate(str: string, width: number): string {
	const visible = plainLen(str);
	if (visible <= width) return str;
	let out = "";
	let v = 0;
	let inAnsi = false;
	for (let i = 0; i < str.length && v < width - 1; i++) {
		if (str[i] === "\u001b" && str[i + 1] === "[") {
			inAnsi = true;
			out += str[i];
		} else if (inAnsi) {
			out += str[i];
			if (/[A-Za-z]/.test(str[i])) inAnsi = false;
		} else {
			out += str[i];
			v++;
		}
	}
	return out + "\u2026\u001b[0m";
}
