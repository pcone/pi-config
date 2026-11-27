/**
 * `bin/setup` — the one script that makes a checkout runnable on a machine
 * (owner-approved Linux support, 2026-11-26): the `~/.pi/agent` symlinks pi
 * reads, the `node_modules` links into the globally installed pi, and one line
 * stating whether baba is available here.
 *
 * Every row runs the real script against a skeleton repo in a temp dir, with
 * `HOME` moved and `npm` / `uname` / `bun` replaced on `PATH`, so nothing here
 * touches the checkout's own node_modules or the real `~/.pi/agent`.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { childEnv } from "./helpers/subagent-env.ts";
import { TUWUNEL_ASSET, TUWUNEL_SHA256, tuwunelBinary, tuwunelCacheDir } from "./helpers/tuwunel.ts";

const SETUP = join(import.meta.dir, "..", "bin", "setup");
const HOOK = join(import.meta.dir, "..", "bin", "pre-push");
/** name in `~/.pi/agent` -> the repo path it links to. */
const AGENT_LINKS: Record<string, string> = {
	agents: "agents",
	"APPEND_SYSTEM.md": "APPEND_SYSTEM.md",
	"auto-checkpoint.json": ".pi/auto-checkpoint.json",
	extensions: "extensions",
	"keybindings.json": "keybindings.json",
	"models.json": "models.json",
	prompts: "prompts",
	rules: "rules",
	"settings.json": "settings.json",
	skills: "skills",
	themes: "themes",
	"trust.json": "trust.json",
};
const AGENT_ENTRIES = Object.keys(AGENT_LINKS);
const PI_PACKAGES = ["pi-coding-agent", "pi-agent-core", "pi-ai", "pi-tui"];

const roots: string[] = [];

afterAll(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

interface Skeleton {
	root: string;
	repo: string;
	home: string;
	bin: string;
	globalRoot: string;
	bunCalls: string;
}

async function skeleton(opts: {
	/** Omit one package from the fake global install. */
	missingPackage?: string;
	/**
	 * `"repo"` links baba at a real dir, `"dangling"` at a missing one, `"dir"` puts a real
	 * directory where the link belongs (baba cloned in place), `"absent"` leaves nothing.
	 */
	baba?: "repo" | "dangling" | "dir" | "absent";
	/** Platform `uname -s` answers. */
	platform?: string;
	/** Machine `uname -m` answers (default arm64, where no Tuwunel binary exists). */
	machine?: string;
	/** What the `gh` shim's release download writes: a copy of this file, or nothing. */
	ghAsset?: string;
	/** Seed the Tuwunel cache in the fake HOME. */
	tuwunelCached?: boolean;
	/** Put a real file where `~/.pi/agent/settings.json`'s link belongs. */
	realSettingsFile?: boolean;
	/** Omit typebox from the fake global pi, so the second link's target is missing. */
	missingTypebox?: boolean;
	/** Leave `npm` off PATH so `GLOBAL_MODULES` is the only way to resolve pi. */
	noNpm?: boolean;
	/** Leave `extensions/node_modules` out, so the install has to run `bun install`. */
	extensionsInstalled?: boolean;
}): Promise<Skeleton> {
	const root = await mkdtemp(join(tmpdir(), "pi-setup-"));
	roots.push(root);
	const repo = join(root, "repo");
	const home = join(root, "home");
	const bin = join(root, "bin");
	const globalRoot = join(root, "npm-global", "@earendil-works");
	await mkdir(join(repo, "bin"), { recursive: true });
	await mkdir(join(repo, "extensions"), { recursive: true });
	if (opts.extensionsInstalled !== false) await mkdir(join(repo, "extensions", "node_modules"), { recursive: true });
	await mkdir(home, { recursive: true });
	await mkdir(bin, { recursive: true });
	for (const source of Object.values(AGENT_LINKS)) {
		if (source === "extensions") continue;
		const path = join(repo, source);
		if (["agents", "prompts", "rules", "skills", "themes"].includes(source)) await mkdir(path, { recursive: true });
		else {
			await mkdir(join(path, ".."), { recursive: true });
			await writeFile(path, "{}\n");
		}
	}

	// The fake global pi: pi-coding-agent at the top, its dependencies nested the
	// way a real global install puts them, typebox under pi-coding-agent.
	await mkdir(join(globalRoot, "pi-coding-agent", "node_modules", "@earendil-works"), { recursive: true });
	await writeFile(join(globalRoot, "pi-coding-agent", "package.json"), '{"name":"@earendil-works/pi-coding-agent"}\n');
	for (const pkg of PI_PACKAGES) {
		if (pkg === opts.missingPackage) continue;
		const dir = pkg === "pi-coding-agent" ? join(globalRoot, "pi-coding-agent") : join(globalRoot, "pi-coding-agent", "node_modules", "@earendil-works", pkg);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "package.json"), JSON.stringify({ name: `@earendil-works/${pkg}` }));
	}
	if (!opts.missingTypebox) {
		await mkdir(join(globalRoot, "pi-coding-agent", "node_modules", "typebox"), { recursive: true });
		await writeFile(join(globalRoot, "pi-coding-agent", "node_modules", "typebox", "package.json"), '{"name":"typebox"}');
	}

	// baba: the tracked symlink into the baba-pi repo.
	if (opts.baba === "dir") {
		await mkdir(join(repo, "extensions", "baba"), { recursive: true });
	} else if (opts.baba !== "absent") {
		const target = opts.baba === "repo" ? join(root, "baba-pi") : join(root, "no-such-baba-pi");
		if (opts.baba === "repo") await mkdir(target, { recursive: true });
		symlinkSync(target, join(repo, "extensions", "baba"));
	}

	if (opts.realSettingsFile) {
		await mkdir(join(home, ".pi", "agent"), { recursive: true });
		await writeFile(join(home, ".pi", "agent", "settings.json"), '{"real":true}\n');
	}

	const bunCalls = join(root, "bun-calls");
	writeFileSync(bunCalls, "");

	// PATH shims: `bun` records that it ran, `uname` answers the requested
	// platform, `npm` reports the fake global root.
	for (const [name, body] of [
		["bun", `#!/bin/sh\necho "$@" >> "${bunCalls}"\nmkdir -p node_modules\n`],
		[
			"uname",
			`#!/bin/sh\nif [ "$1" = -m ]; then echo "${opts.machine ?? "arm64"}"; else echo "${opts.platform ?? "Darwin"}"; fi\n`,
		],
		// `gh release download … -D <dir>`: records its args, writes the asset it was given.
		[
			"gh",
			`#!/bin/sh\necho "$@" >> "${join(root, "gh-calls")}"\nwhile [ $# -gt 0 ]; do [ "$1" = -D ] && dir="$2"; shift; done\n` +
				(opts.ghAsset ? `cp "${opts.ghAsset}" "$dir/${TUWUNEL_ASSET}"\n` : "exit 1\n"),
		],
		["npm", `#!/bin/sh\necho "${join(root, "npm-global")}"\n`],
		// systemctl records its calls: no row reaches the real user session's systemd.
		["systemctl", `#!/bin/sh\necho "$@" >> "${join(root, "systemctl-calls")}"\n`],
	] as const) {
		const path = join(bin, name);
		writeFileSync(path, body);
		chmodSync(path, 0o755);
	}
	if (opts.noNpm) await rm(join(bin, "npm"));
	writeFileSync(join(root, "gh-calls"), "");
	writeFileSync(join(root, "systemctl-calls"), "");
	await mkdir(join(repo, "apps", "chatd"), { recursive: true });
	writeFileSync(join(repo, "apps", "chatd", "chatd.service"), readFileSync(join(import.meta.dir, "..", "apps", "chatd", "chatd.service")));
	if (opts.tuwunelCached) {
		const cache = tuwunelCacheDir(home);
		await mkdir(cache, { recursive: true });
		writeFileSync(join(cache, TUWUNEL_ASSET), "cached");
		writeFileSync(join(cache, "tuwunel"), "#!/bin/sh\n", { mode: 0o755 });
	}

	const source = readFileSync(SETUP, "utf-8");
	await writeFile(join(repo, "bin", "setup"), source);
	chmodSync(join(repo, "bin", "setup"), 0o755);
	// setup installs bin/pre-push into the repo's git hooks, so the skeleton is a git repo holding it.
	writeFileSync(join(repo, "bin", "pre-push"), readFileSync(HOOK), { mode: 0o755 });
	execFileSync("git", ["init", "-q"], { cwd: repo, env: childEnv() });

	return { root, repo, home, bin, globalRoot, bunCalls };
}

async function run(env: Skeleton, extraEnv: Record<string, string> = {}) {
	// The shims first, then the system dirs bash needs; a real `npm` or `uname`
	// from a user's PATH (Homebrew) stays out of reach, so the shim answers.
	const path = [env.bin, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
	const proc = Bun.spawn(["bash", join(env.repo, "bin", "setup")], {
		cwd: env.repo,
		env: { ...process.env, HOME: env.home, PATH: path, GLOBAL_MODULES: "", ...extraEnv },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { out, err, code, all: out + err };
}

describe("bin/setup — node_modules links into the global pi", () => {
	it("links every package the extensions import, plus typebox, resolved from npm root -g", async () => {
		const env = await skeleton({ baba: "repo" });
		const result = await run(env);
		expect({ code: result.code, err: result.err }).toEqual({ code: 0, err: "" });

		const scope = join(env.repo, "node_modules", "@earendil-works");
		for (const pkg of ["pi-agent-core", "pi-ai", "pi-tui"]) {
			const link = join(scope, pkg);
			expect(lstatSync(link).isSymbolicLink()).toBe(true);
			expect(existsSync(join(link, "package.json"))).toBe(true);
		}
		expect(readlinkSync(join(scope, "pi-coding-agent"))).toBe(join(env.globalRoot, "pi-coding-agent"));
		expect(existsSync(join(env.repo, "node_modules", "typebox", "package.json"))).toBe(true);
	}, 20_000);

	it("fails with both paths named, and leaves no dangling link, when a package is missing", async () => {
		const env = await skeleton({ baba: "repo", missingPackage: "pi-ai" });
		const result = await run(env);
		expect(result.code).toBe(1);
		expect(result.err).toContain("cannot find a global install of pi-ai");
		expect(result.err).toContain(join(env.globalRoot, "pi-ai"));
		// No half-made link for the package that failed or the ones after it.
		expect(existsSync(join(env.repo, "node_modules", "@earendil-works", "pi-ai"))).toBe(false);
		expect(existsSync(join(env.repo, "node_modules", "typebox"))).toBe(false);
	}, 20_000);

	it("refuses a link whose target is missing, and leaves no dangling link", async () => {
		const env = await skeleton({ baba: "repo", missingTypebox: true });
		const result = await run(env);
		expect(result.code).toBe(1);
		expect(result.err).toContain("typebox: ");
		expect(result.err).toContain(join(env.globalRoot, "pi-coding-agent", "node_modules", "typebox"));
		// The failed link is not left pointing at nothing: a dangling specifier makes
		// bun's resolver spin and hides the real cause behind a hang.
		expect(existsSync(join(env.repo, "node_modules", "typebox"))).toBe(false);
		// The packages linked before it still resolve.
		expect(existsSync(join(env.repo, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"))).toBe(true);
	}, 20_000);

	it("is idempotent: a second run relinks and still resolves", async () => {
		const env = await skeleton({ baba: "repo" });
		expect((await run(env)).code).toBe(0);
		const again = await run(env);
		expect(again.code).toBe(0);
		expect(existsSync(join(env.repo, "node_modules", "typebox", "package.json"))).toBe(true);
		for (const entry of AGENT_ENTRIES) expect(existsSync(join(env.home, ".pi", "agent", entry))).toBe(true);
	}, 20_000);

	it("installs extensions/ dependencies only when they are missing", async () => {
		const env = await skeleton({ baba: "repo", extensionsInstalled: false });
		expect((await run(env)).code).toBe(0);
		expect(readFileSync(env.bunCalls, "utf-8").trim()).toBe("install --frozen-lockfile");
		// The second run sees the tree the first one installed and stays off the network.
		expect((await run(env)).code).toBe(0);
		expect(readFileSync(env.bunCalls, "utf-8").trim()).toBe("install --frozen-lockfile");
	}, 20_000);
});

describe("bin/setup — ~/.pi/agent links", () => {
	it("links every entry pi reads, each resolving into the repo", async () => {
		const env = await skeleton({ baba: "repo" });
		expect((await run(env)).code).toBe(0);
		for (const [name, source] of Object.entries(AGENT_LINKS)) {
			const link = join(env.home, ".pi", "agent", name);
			expect(lstatSync(link).isSymbolicLink()).toBe(true);
			expect(readlinkSync(link)).toBe(join(env.repo, source));
			expect(existsSync(link)).toBe(true);
		}
		// The two renamed on the way in, spelled out: a wrong source path here is a
		// link that resolves to nothing pi can read.
		expect(readlinkSync(join(env.home, ".pi", "agent", "auto-checkpoint.json")))
			.toBe(join(env.repo, ".pi", "auto-checkpoint.json"));
		expect(readlinkSync(join(env.home, ".pi", "agent", "trust.json"))).toBe(join(env.repo, "trust.json"));
	}, 20_000);

	it("refuses to replace a real file, naming it, and leaves it as it was", async () => {
		const env = await skeleton({ baba: "repo", realSettingsFile: true });
		const result = await run(env);
		expect(result.code).toBe(1);
		expect(result.err).toContain(join(env.home, ".pi", "agent", "settings.json"));
		expect(lstatSync(join(env.home, ".pi", "agent", "settings.json")).isSymbolicLink()).toBe(false);
		expect(readFileSync(join(env.home, ".pi", "agent", "settings.json"), "utf-8")).toBe('{"real":true}\n');
	}, 20_000);

	it("keeps the working link when a later run fails, instead of leaving the dir half-installed", async () => {
		const env = await skeleton({ baba: "repo" });
		expect((await run(env)).code).toBe(0);
		const settings = join(env.home, ".pi", "agent", "settings.json");
		expect(existsSync(settings)).toBe(true);

		// The repo loses the file the link points at — a stale checkout, a partial pull.
		await rm(join(env.repo, "settings.json"));
		const failed = await run(env);
		expect(failed.code).toBe(1);
		expect(failed.err).toContain("settings.json: ");
		// The link that worked before is still there: a failed install reports, it does not
		// dismantle the machine's config on its way out. It dangles now, because the file it
		// points at is the one that went missing — that is the state the next good run repairs.
		expect(lstatSync(settings).isSymbolicLink()).toBe(true);
		expect(readlinkSync(settings)).toBe(join(env.repo, "settings.json"));
	}, 20_000);

	it("uses GLOBAL_MODULES when npm is not on PATH, and says so when neither answers", async () => {
		const env = await skeleton({ baba: "repo", noNpm: true });
		const missing = await run(env);
		expect(missing.code).toBe(1);
		expect(missing.err).toContain("npm is not on PATH");

		const overridden = await run(env, { GLOBAL_MODULES: env.globalRoot });
		expect(overridden.code).toBe(0);
		expect(overridden.out).toContain(`Global pi: ${env.globalRoot}`);
	}, 20_000);
});

describe("bin/setup — pre-push hook and pi.mainline", () => {
	const hookPath = (env: Skeleton) => join(realpathSync(env.repo), ".git", "hooks", "pre-push");
	const mainline = (env: Skeleton) => {
		const r = spawnSync("git", ["-C", env.repo, "config", "--get", "pi.mainline"], {
			encoding: "utf-8",
			env: childEnv({ HOME: env.home }),
		});
		return { status: r.status, out: r.stdout.trim() };
	};

	it("links the hook as a relative symlink that resolves to bin/pre-push", async () => {
		const env = await skeleton({ baba: "repo" });
		expect((await run(env)).code).toBe(0);
		expect(lstatSync(hookPath(env)).isSymbolicLink()).toBe(true);
		expect(readlinkSync(hookPath(env))).toBe("../../bin/pre-push");
		expect(realpathSync(hookPath(env))).toBe(realpathSync(join(env.repo, "bin", "pre-push")));
	}, 20_000);

	it("is idempotent: a second run relinks the hook and keeps pi.mainline", async () => {
		const env = await skeleton({ baba: "repo" });
		expect((await run(env)).code).toBe(0);
		expect((await run(env)).code).toBe(0);
		expect(readlinkSync(hookPath(env))).toBe("../../bin/pre-push");
		expect(mainline(env).out).toBe("main");
	}, 20_000);

	it("refuses a real file at the hook path, naming it, and leaves it as it was", async () => {
		const env = await skeleton({ baba: "repo" });
		writeFileSync(hookPath(env), "#!/bin/sh\necho mine\n");
		const result = await run(env);
		expect(result.code).toBe(1);
		expect(result.err).toContain(hookPath(env));
		expect(lstatSync(hookPath(env)).isSymbolicLink()).toBe(false);
		expect(readFileSync(hookPath(env), "utf-8")).toBe("#!/bin/sh\necho mine\n");
	}, 20_000);

	it("sets pi.mainline to main when unset", async () => {
		const env = await skeleton({ baba: "repo" });
		expect(mainline(env).status).toBe(1);
		const result = await run(env);
		expect(result.code).toBe(0);
		expect(mainline(env).out).toBe("main");
		expect(result.out).toContain("pi.mainline: unset, set to main");
	}, 20_000);

	it("leaves pi.mainline alone when it is already set", async () => {
		const env = await skeleton({ baba: "repo" });
		execFileSync("git", ["-C", env.repo, "config", "--local", "pi.mainline", "hamster"], { env: childEnv({ HOME: env.home }) });
		const result = await run(env);
		expect(result.code).toBe(0);
		expect(mainline(env).out).toBe("hamster");
		expect(result.out).not.toContain("pi.mainline");
	}, 20_000);
});

describe("bin/setup — baba", () => {
	it("names the repo it links when the checkout can load baba", async () => {
		const env = await skeleton({ baba: "repo" });
		const result = await run(env);
		expect(result.code).toBe(0);
		expect(result.out).toContain(`baba: ${join(env.root, "baba-pi")}`);
	}, 20_000);

	it("says where baba is when it is a real directory, not a link", async () => {
		const env = await skeleton({ baba: "dir" });
		const result = await run(env);
		expect(result.code).toBe(0);
		expect(result.out).toContain(`baba: in place at ${join(env.repo, "extensions", "baba")}`);
	}, 20_000);

	it("states baba unavailable on Linux, and still installs", async () => {
		const env = await skeleton({ baba: "dangling", platform: "Linux" });
		const result = await run(env);
		expect({ code: result.code, err: result.err }).toEqual({ code: 0, err: "" });
		expect(result.out).toContain("baba: unavailable here");
		expect(result.out).toContain("semantic_search");
		// The install still finished: baba's absence is not a reason to leave a box unconfigured.
		expect(existsSync(join(env.home, ".pi", "agent", "settings.json"))).toBe(true);
	}, 20_000);

	it("stops the install on macOS, where a missing baba is a broken setup", async () => {
		const env = await skeleton({ baba: "dangling", platform: "Darwin" });
		const result = await run(env);
		expect(result.code).toBe(1);
		expect(result.err).toContain("extensions/baba does not resolve");
		expect(result.err).toContain(join(env.root, "no-such-baba-pi"));
	}, 20_000);
});

describe("bin/setup — the Tuwunel test binary", () => {
	const ghCalls = (env: Skeleton) => readFileSync(join(env.root, "gh-calls"), "utf8");

	it("leaves a cached binary alone, and fetches nothing", async () => {
		const env = await skeleton({ baba: "dangling", platform: "Linux", machine: "x86_64", tuwunelCached: true });
		const result = await run(env);
		expect(result.code).toBe(0);
		expect(result.out).toContain(`tuwunel: cached at ${tuwunelCacheDir(env.home)}`);
		expect(ghCalls(env)).toBe("");
	}, 20_000);

	it("says the chat rows cannot run where no release binary exists", async () => {
		const env = await skeleton({ baba: "dangling", platform: "Linux", machine: "aarch64" });
		const result = await run(env);
		expect(result.code).toBe(0);
		expect(result.out).toContain("tuwunel: no release binary for Linux aarch64");
		expect(ghCalls(env)).toBe("");
	}, 20_000);

	it("refuses an archive whose sha256 is not the pinned one, and removes it", async () => {
		const bogus = join(await mkdtemp(join(tmpdir(), "bogus-")), "asset");
		roots.push(join(bogus, ".."));
		writeFileSync(bogus, "not the release");
		const env = await skeleton({ baba: "dangling", platform: "Linux", machine: "x86_64", ghAsset: bogus });
		const result = await run(env);
		expect(result.code).toBe(1);
		expect(result.err).toContain(`expected ${TUWUNEL_SHA256}`);
		expect(existsSync(join(tuwunelCacheDir(env.home), TUWUNEL_ASSET))).toBe(false);
		expect(ghCalls(env)).toContain(`release download v2.1.0 -R matrix-construct/tuwunel -p ${TUWUNEL_ASSET}`);
	}, 20_000);

	it("fetches the pinned release, checks it and unpacks an executable", async () => {
		const real = join(tuwunelBinary(), "..", TUWUNEL_ASSET);
		const env = await skeleton({ baba: "dangling", platform: "Linux", machine: "x86_64", ghAsset: real });
		const result = await run(env);
		expect(result.code).toBe(0);
		expect(result.out).toContain("tuwunel: fetched v2.1.0");
		expect(lstatSync(join(tuwunelCacheDir(env.home), "tuwunel")).mode & 0o111).not.toBe(0);
	}, 60_000);
});

describe("bin/setup — chatd.service", () => {
	const calls = (env: Skeleton) => readFileSync(join(env.root, "systemctl-calls"), "utf8");

	it("writes the unit into the user unit directory, pointing at this checkout, and enables it", async () => {
		const env = await skeleton({ baba: "repo" });
		const result = await run(env);
		expect(result.code).toBe(0);
		const unit = readFileSync(join(env.home, ".config", "systemd", "user", "chatd.service"), "utf8");
		expect(unit).toContain(`ExecStart=${join(env.bin, "bun")} ${env.repo}/apps/chatd/main.ts`);
		expect(unit).toContain("Restart=on-failure");
		expect(unit).not.toContain("@");
		expect(calls(env)).toBe("--user daemon-reload\n--user enable chatd.service\n");
	}, 20_000);

	it("with SYSTEMD_USER_DIR, writes the unit there and touches no systemd", async () => {
		const env = await skeleton({ baba: "repo" });
		const dir = join(env.root, "units");
		const result = await run(env, { SYSTEMD_USER_DIR: dir });
		expect(result.code).toBe(0);
		expect(existsSync(join(dir, "chatd.service"))).toBe(true);
		expect(existsSync(join(env.home, ".config", "systemd", "user", "chatd.service"))).toBe(false);
		expect(calls(env)).toBe("");
		expect(result.out).toContain("not enabled");
	}, 20_000);
});
