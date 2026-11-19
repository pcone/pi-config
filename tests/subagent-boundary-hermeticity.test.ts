/**
 * The suite's verdict must not depend on the invocation-context PI_SUBAGENT_* environment
 * (pi-config#9, #22).
 *
 * What happened: `bun test` run from INSIDE a subagent failed 11 rows across three files. The
 * harness injects PI_SUBAGENT_ALLOWLIST / PI_SUBAGENT_DEPTH / PI_IS_SUBAGENT into every subagent
 * process; the boundary rows exercise real spawns through the tool gate (extensions/subagent-async
 * reads process.env.PI_SUBAGENT_ALLOWLIST for the allowlist check and subagentDepth() for the
 * nesting cap), so an inherited allowlist refused the `implement`/`orchestrator` spawns those rows
 * are about. Two work-order verifications red identically at base AND landed: the verdict was a
 * property of the invocation context, not of the code under test.
 *
 * The mechanism is injection, always on (owner ruling 2026-11-20, pi-config#22). `.env.test` in
 * the repo root carries the three vars; `bun test` sets NODE_ENV=test and loads it into the env
 * snapshot taken at process start, which is the snapshot a child spawned without `env`
 * receives — so the values reach spawns, not only in-process readers, and a real environment
 * variable still wins. A file whose rows are about something else scrubs them in `beforeAll`
 * (`tests/helpers/subagent-env.ts`), and every spawn passes `env: childEnv()`, which spreads the
 * live env and drops NODE_ENV: a bun child started in this repo with NODE_ENV=test set would
 * re-read `.env.test` and undo the parent's scrub (the owner-asks print-mode row went red that
 * way).
 *
 * Why this replaces the row that ran a child suite: it cost 292 s against a 300 s cap — a single
 * test, marginal by construction, and it grew with every file that gained a spawn site. Injection
 * covers what it covered from the other direction: every file now runs under the injected env in
 * every run, so a file that must be hermetic and is not shows up in the ordinary suite rather than
 * in a nested run of a derived subset. What is lost is the *clean-env* verdict from a plain
 * `bun test` (a dev's run is injected; `PI_SUBAGENT_ALLOWLIST= bun test` restores it) — accepted,
 * because the scrubs are what the rows depend on and they are pinned here.
 *
 * Rows:
 *
 * 1. The run carries the injected env. Without this the other rows pass on a machine where the
 *    injection silently stopped happening, which is the failure mode a vacuous check has.
 * 2. `childEnv()` drops NODE_ENV, so a scrubbed parent's bun child cannot re-read `.env.test`.
 * 3. Every file that makes billed model calls scrubs the gate env. Those rows are the ones whose
 *    verdict a stray allowlist or depth changes for the largest cost, and the detector used to
 *    match only `createAgentSession` — turn-cap's four E rows spawn a real pi and were missed
 *    (2026-11-07), which is why the detector names the pi entry points too.
 * 4. Static: every spawn call site anywhere under tests/ passes an explicit `env`. A spawn that
 *    omits it inherits the startup snapshot even when the parent scrubbed, and that is invisible
 *    until a child which reads the vars appears — so it is pinned, not waited for. The detector
 *    takes spawn names from the node:child_process import list plus Bun.spawn/Bun.spawnSync,
 *    which makes it a LOWER BOUND: a site reached through a renamed helper
 *    (`const run = promisify(execFile)`) is not seen. Row 3 is a lower bound the same way.
 * 5. The static detector fires on a bare spawn and clears an explicit env — the row's own
 *    self-test, so a scanner that sees nothing cannot pass row 4.
 *
 * Not covered here: PI_SUBAGENT_WORKTREE / PI_SUBAGENT_PARENT_CWD
 * (extensions/worktree-guard.ts:298-299) are a different class, read once at extension load inside
 * a pi process, always overwritten at subagent spawn (extensions/subagent-async/rpc.ts,
 * `buildSubagentEnv`), so they cannot survive from a caller; the scrub set stays the three gate
 * vars — see docs/investigations/structure-trend.md.
 *
 * Run: bun test tests/subagent-boundary-hermeticity.test.ts
 */

import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { SUBAGENT_ENV_VARS, childEnv } from "./helpers/subagent-env.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const SELF = join(import.meta.dir, "subagent-boundary-hermeticity.test.ts");

/** What `.env.test` injects, and what the harness injects into a spawned subagent. */
const INJECTED: Record<string, string> = {
	PI_SUBAGENT_ALLOWLIST: "review-code,review-tests",
	PI_SUBAGENT_DEPTH: "1",
	PI_IS_SUBAGENT: "1",
};

/**
 * A file makes billed model calls if it starts an in-process SDK session, or if it runs a real
 * `pi` child. The pi shapes are the entry points the live rows use: `PI_BIN` (turn-cap's
 * stand-in execs it) and the stand-in shims themselves. A LOWER BOUND, as row 4's detector is —
 * a new shape has to be added here when it appears.
 */
const BILLED_CALL = /\bcreateAgentSession\b|\bPI_BIN\b|real-pi\.mjs|stand-in-pi\.mjs/;

/** A file scrubs the gate env if it *calls* either helper — an import is not a scrub. */
const SCRUBS_GATE_ENV = /\b(?:scrubSubagentEnv|unsetSubagentEnv)\s*\(/;

const SOURCE_FILE = /\.(?:ts|mts|js|mjs)$/;
const TEST_FILE = /\.test\.(?:ts|mts|js|mjs)$/;

function walk(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...walk(path));
		else if (SOURCE_FILE.test(entry.name)) found.push(path);
	}
	return found;
}

/**
 * `source` with string, template, comment and regex bodies blanked to spaces,
 * so a call named in a comment or a string is not mistaken for code. Offsets
 * and newlines are preserved, so mask slices line up with the raw source.
 */
function codeOnly(source: string): string {
	// `split("")` (code units, not `[...source]`) so mask offsets == source
	// offsets even if a file holds a non-BMP character.
	const out = source.split("");
	const blank = (from: number, to: number) => {
		for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
	};
	let i = 0;
	while (i < source.length) {
		if (source[i] === "/" && source[i + 1] === "/") {
			const stop = source.indexOf("\n", i);
			const end = stop === -1 ? source.length : stop;
			blank(i, end);
			i = end;
		} else if (source[i] === "/" && source[i + 1] === "*") {
			const stop = source.indexOf("*/", i + 2);
			const end = stop === -1 ? source.length : stop + 2;
			blank(i, end);
			i = end;
		} else if (source[i] === '"' || source[i] === "'" || source[i] === "`") {
			const quote = source[i];
			let j = i + 1;
			while (j < source.length) {
				if (source[j] === "\\") j += 2;
				else if (source[j] === quote) break;
				else j++;
			}
			blank(i + 1, j);
			i = j + 1;
		} else if (source[i] === "/" && startsRegex(source, i)) {
			// A regex body may hold quotes or backticks; left unblanked it would
			// open a bogus string that blanked the rest of the file (it did:
			// e2e-checkpoint's /`([^`]+\.jsonl)`/ swallowed the spawnSync below).
			let j = i + 1;
			let inClass = false;
			while (j < source.length) {
				const ch = source[j];
				if (ch === "\\") {
					j += 2;
					continue;
				}
				if (ch === "\n") break;
				if (inClass) {
					if (ch === "]") inClass = false;
				} else if (ch === "[") inClass = true;
				else if (ch === "/") break;
				j++;
			}
			if (j >= source.length || source[j] !== "/") {
				// No terminator on this line: it was a division after all.
				i++;
				continue;
			}
			blank(i + 1, j);
			i = j + 1;
			while (i < source.length && /[a-z]/.test(source[i])) i++; // flags
		} else i++;
	}
	return out.join("");
}

/** `/` here opens a regex, not a division: after an operator or a keyword. */
function startsRegex(source: string, at: number): boolean {
	let k = at - 1;
	while (k >= 0 && /\s/.test(source[k])) k--;
	if (k < 0) return true;
	if ("([{:;,=!&|?+-*%^~<>".includes(source[k])) return true;
	return /(?:^|[^\w$])(?:return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)\s*$/.test(
		source.slice(0, k + 1),
	);
}

/** The child-spawn call names this source declares (aliases resolved). */
function spawnApiNames(source: string): string[] {
	const names = new Set<string>(["Bun.spawn", "Bun.spawnSync"]);
	const imports = /import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*["'](?:node:)?child_process["']/g;
	for (const match of source.matchAll(imports)) {
		for (const part of match[1].split(",")) {
			const name = part.trim().split(/\s+as\s+/).pop()?.trim() ?? "";
			if (/^\w+$/.test(name)) names.add(name);
		}
	}
	return [...names];
}

/** Split `text` at its depth-0 commas, ignoring commas inside (), [] and {}. */
function splitTopLevel(text: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "(" || ch === "[" || ch === "{") depth++;
		else if (ch === ")" || ch === "]" || ch === "}") depth--;
		else if (ch === "," && depth === 0) {
			parts.push(text.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(text.slice(start));
	return parts;
}

type CallSite = { index: number; args: string[] };

/** Every spawn call site in `source`, its arguments split at depth 0. */
function callSites(source: string): CallSite[] {
	const mask = codeOnly(source);
	const sites: CallSite[] = [];
	for (const name of spawnApiNames(source)) {
		const pattern = new RegExp(`(?<![\\w.$])${name.replace(/\./g, "\\.")}\\s*\\(`, "g");
		for (const match of mask.matchAll(pattern)) {
			const open = (match.index ?? 0) + match[0].length - 1;
			let depth = 0;
			let close = -1;
			for (let i = open; i < mask.length; i++) {
				const ch = mask[i];
				if (ch === "(") depth++;
				else if (ch === ")") {
					depth--;
					if (depth === 0) {
						close = i;
						break;
					}
				}
			}
			if (close === -1) continue;
			// Args are split on the raw source at the mask's comma offsets: the
			// mask preserves offsets, and a comma only counts at depth 0.
			const interior = mask.slice(open + 1, close);
			const args: string[] = [];
			let depth2 = 0;
			let start = 0;
			for (let i = 0; i < interior.length; i++) {
				const ch = interior[i];
				if (ch === "(" || ch === "[" || ch === "{") depth2++;
				else if (ch === ")" || ch === "]" || ch === "}") depth2--;
				else if (ch === "," && depth2 === 0) {
					args.push(source.slice(open + 1 + start, open + 1 + i));
					start = i + 1;
				}
			}
			args.push(source.slice(open + 1 + start, close));
			sites.push({ index: match.index ?? 0, args });
		}
	}
	return sites;
}

/** Whether a call's options argument is an object literal carrying an `env`. */
function hasExplicitEnv(options: string | undefined): boolean {
	const text = (options ?? "").trim();
	if (!text.startsWith("{") || !text.endsWith("}")) return false;
	const properties = splitTopLevel(codeOnly(text).slice(1, -1));
	return properties.some((property) => /^\s*env\s*(?::|,|$)/.test(property));
}

/** "file:line — why" for every spawn in `path` that does not pass an explicit env. */
function spawnSiteProblems(path: string, source = readFileSync(path, "utf8")): string[] {
	const problems: string[] = [];
	for (const site of callSites(source)) {
		const options = site.args.length > 1 ? site.args[site.args.length - 1] : undefined;
		if (hasExplicitEnv(options)) continue;
		const line = source.slice(0, site.index).split("\n").length;
		const where = `${path === SELF ? "<fixture>" : relative(REPO_ROOT, path)}:${line}`;
		problems.push(
			options === undefined || !options.trim().startsWith("{")
				? `${where} — no options object: pass \`env\` explicitly (\`env: childEnv()\`)`
				: `${where} — options omit \`env\`: a spawn without it gets bun's startup env snapshot`,
		);
	}
	return problems;
}

/**
 * "file — why" for a file whose raw source calls a spawn API that the mask no
 * longer shows. The scan asserts nothing when it sees nothing, so a mask that
 * swallows code (a regex literal holding a backtick once did, hiding
 * e2e-checkpoint's spawnSync) would turn this row silently green.
 */
function detectorBlindSpots(path: string): string[] {
	const source = readFileSync(path, "utf8");
	if (callSites(source).length > 0) return [];
	// Names come from the masked source: a `node:child_process` import inside a fixture string is
	// not this file's import, and a self-test that spells one must not flag itself. The call
	// itself is searched in the raw source, because the case this row exists for is a call the
	// mask swallowed — e2e-checkpoint's /`([^`]+.jsonl)`/ once blanked the spawnSync below it.
	for (const name of spawnApiNames(codeOnly(source))) {
		if (name.startsWith("Bun.")) continue;
		if (new RegExp(`(?<![\\w.$])${name}\\s*\\(`).test(source)) {
			return [`${relative(REPO_ROOT, path)} — raw source calls ${name}() but the scanner found no site`];
		}
	}
	return [];
}

describe("subagent-boundary hermeticity", () => {
	it("this run carries the injected gate env", () => {
		// The other rows read the env, so a run that lost the injection would pass by testing
		// nothing. `.env.test` supplies it; a real environment variable (a subagent's own run)
		// wins over the file, so the value is checked for presence, not for the file's shape —
		// except PI_IS_SUBAGENT, which the harness always sets to 1.
		for (const key of SUBAGENT_ENV_VARS) {
			expect({ key, set: process.env[key] !== undefined }).toEqual({ key, set: true });
		}
		expect(process.env.PI_IS_SUBAGENT).toBe("1");
	});

	it("childEnv drops NODE_ENV, so a scrubbed parent's bun child cannot re-read .env.test", () => {
		expect(process.env.NODE_ENV).toBe("test"); // bun test sets it, which is the hazard
		expect(childEnv().NODE_ENV).toBeUndefined();
		// An explicit override is a caller's choice, and one that is not NODE_ENV still lands.
		expect(childEnv({ PI_IS_SUBAGENT: undefined })).toMatchObject({ PI_SUBAGENT_DEPTH: "1" });
		expect(childEnv({ PI_IS_SUBAGENT: undefined }).PI_IS_SUBAGENT).toBeUndefined();
	});

	it("every file that makes billed model calls scrubs the gate env", () => {
		// This file's own detector source names the markers, so it matches itself; it makes no
		// billed calls.
		const paths = walk(import.meta.dir).filter((path) => TEST_FILE.test(path) && path !== SELF);
		const billed = paths.filter((path) => BILLED_CALL.test(readFileSync(path, "utf8")));
		// Vacuity guard: 5 files when this row landed — turn-cap's four E rows, the two e2e
		// files, peer-link and model-inheritance. turn-cap is named because it is the file the
		// createAgentSession-only detector missed (2026-11-07).
		expect(billed.length).toBeGreaterThanOrEqual(5);
		expect(billed).toContain(join(import.meta.dir, "turn-cap.test.ts"));
		const unscrubbed = billed.filter((path) => !SCRUBS_GATE_ENV.test(readFileSync(path, "utf8")));
		expect(unscrubbed.map((path) => relative(REPO_ROOT, path))).toEqual([]);
	});

	it("every child spawn under tests/ passes an explicit env", () => {
		const paths = walk(import.meta.dir);
		const inventory = paths.filter((path) => callSites(readFileSync(path, "utf8")).length > 0);
		// Inventory floor: "nothing reported" also describes a scanner that sees
		// nothing. 11 files / 16 sites when this row landed.
		expect(inventory.length).toBeGreaterThanOrEqual(8);
		expect(paths.flatMap((path) => detectorBlindSpots(path))).toEqual([]);
		expect(paths.flatMap((path) => spawnSiteProblems(path))).toEqual([]);
	});

	it("the spawn-env detector fires on a bare spawn and clears an explicit env", () => {
		const bare = `import { spawnSync } from "node:child_process";\nspawnSync("bun", ["test"]);\n`;
		const bareArgs = `import { execFileSync } from "node:child_process";\nexecFileSync("git", ["init"], { cwd: repo });\n`;
		const commentOnly = `// spawnSync("bun", ["test"]) in a comment is not a call site\nconst x = 1;\n`;
		const explicit = `import { execFileSync } from "node:child_process";\nexecFileSync("git", ["init"], { cwd: repo, env: childEnv() });\n`;
		const bunSpawn = `Bun.spawn(["true"], { env: childEnv() });\n`;

		expect(spawnSiteProblems(SELF, bare)).toHaveLength(1);
		expect(spawnSiteProblems(SELF, bareArgs)).toHaveLength(1);
		expect(spawnSiteProblems(SELF, commentOnly)).toEqual([]);
		expect(spawnSiteProblems(SELF, explicit)).toEqual([]);
		expect(spawnSiteProblems(SELF, bunSpawn)).toEqual([]);
	});
});
