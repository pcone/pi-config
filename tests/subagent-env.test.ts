/**
 * tests/helpers/subagent-env.ts — the one env-control helper the subagent-boundary
 * files share (pi-config#9).
 *
 * Two things are load-bearing enough to pin here rather than re-derive in the files
 * that import it: the scrub restores exactly what it found (including "was absent"),
 * and `childEnv()` carries the *live* env — including a variable set after the
 * process started, which is the value a spawn that omits `env` may not get. Which
 * default the runner uses for an omitted `env` is the runner's business and changed
 * between bun 1.3.11 and 1.4.5; this file pins what our code owes instead.
 *
 * Run: bun test tests/subagent-env.test.ts
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { SUBAGENT_ENV_VARS, childEnv, scrubSubagentEnv } from "./helpers/subagent-env.ts";

/** Run `bun -e <code>` and return its stdout; a dead spawn fails loudly. */
function bunEval(code: string, env?: NodeJS.ProcessEnv): string {
	const run = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", timeout: 30_000, env });
	expect(run.error).toBeUndefined();
	expect(run.status).toBe(0);
	return run.stdout;
}

describe("scrubSubagentEnv", () => {
	it("unsets every harness var, then restores exactly what it found", () => {
		const saved = SUBAGENT_ENV_VARS.map((key) => [key, process.env[key]] as const);
		try {
			process.env.PI_SUBAGENT_ALLOWLIST = "review-code,review-tests";
			process.env.PI_SUBAGENT_DEPTH = "1";
			process.env.PI_IS_SUBAGENT = "1";

			const restore = scrubSubagentEnv();
			for (const key of SUBAGENT_ENV_VARS) expect(process.env[key]).toBeUndefined();

			restore();
			expect(process.env.PI_SUBAGENT_ALLOWLIST).toBe("review-code,review-tests");
			expect(process.env.PI_SUBAGENT_DEPTH).toBe("1");
			expect(process.env.PI_IS_SUBAGENT).toBe("1");
		} finally {
			for (const [key, value] of saved) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("restores 'absent' as absent instead of writing an empty stamp", () => {
		const saved = SUBAGENT_ENV_VARS.map((key) => [key, process.env[key]] as const);
		try {
			for (const key of SUBAGENT_ENV_VARS) delete process.env[key];
			scrubSubagentEnv()();
			for (const key of SUBAGENT_ENV_VARS) expect(key in process.env).toBe(false);
		} finally {
			for (const [key, value] of saved) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});

describe("childEnv", () => {
	it("carries the live env: an in-process deletion removes the key, overrides win", () => {
		const saved = process.env.PI_SUBAGENT_ALLOWLIST;
		try {
			process.env.PI_SUBAGENT_ALLOWLIST = "implement";
			delete process.env.PI_SUBAGENT_ALLOWLIST;
			expect("PI_SUBAGENT_ALLOWLIST" in childEnv()).toBe(false);
			expect(childEnv({ PI_SUBAGENT_ALLOWLIST: "implement" }).PI_SUBAGENT_ALLOWLIST).toBe("implement");
			// `undefined` removes rather than writing the string "undefined".
			process.env.PI_SUBAGENT_ALLOWLIST = "implement";
			expect("PI_SUBAGENT_ALLOWLIST" in childEnv({ PI_SUBAGENT_ALLOWLIST: undefined })).toBe(false);
		} finally {
			if (saved === undefined) delete process.env.PI_SUBAGENT_ALLOWLIST;
			else process.env.PI_SUBAGENT_ALLOWLIST = saved;
		}
	});

	it("reaches a real child with the override, whatever the runner's env says", () => {
		const out = bunEval("process.stdout.write(process.env.PI_SUBAGENT_DEPTH ?? '<unset>')", childEnv({ PI_SUBAGENT_DEPTH: "2" }));
		expect(out).toBe("2");
	}, 30_000);

	it("is complete: it carries the live env, so no spawn depends on the runner's default", () => {
		// The default for a spawn that omits `env` changed between bun 1.3.11 and
		// 1.4.5 (startup snapshot, then the live env), so a row pinning that default
		// pins the runner, not us. What we own: `childEnv()` spreads the *live* env,
		// so a var set after startup reaches the child on either version.
		const key = "PROBE_LIVE_ONLY";
		expect(process.env[key]).toBeUndefined();
		process.env[key] = "set-after-startup";
		try {
			const env = childEnv({ PI_SUBAGENT_DEPTH: "2" });
			expect(env[key]).toBe("set-after-startup");
			expect(env.PI_SUBAGENT_DEPTH).toBe("2");
			const out = bunEval("process.stdout.write(process.env.PROBE_LIVE_ONLY ?? '<unset>')", env);
			expect(out).toBe("set-after-startup");
		} finally {
			delete process.env[key];
		}
	}, 30_000);
});
