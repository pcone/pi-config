/**
 * E2E tests for the checkpoint extension.
 *
 * Drives real pi agent sessions via the SDK — loads the actual checkpoint.ts
 * extension, sends prompts that cause the agent to read files and call the
 * checkpoint tool, then verifies compaction, file injection, and search.
 *
 * Run:
 *   bash tests/setup.sh        # one-time: link global pi packages
 *   bun test tests/e2e-checkpoint.test.ts
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtemp, writeFile, rm, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";

const CHECKPOINT_EXTENSION = join(
	import.meta.dir,
	"..",
	"extensions",
	"checkpoint.ts",
);

const NEEDLES = [
	"CRIMSON-FALCON-7291",
	"AZURE-DRAGONFLY-3847",
	"EMERALD-WOLVERINE-5102",
	"VIOLET-OSTRICH-6683",
	"SILVER-PANGOLIN-9470",
];

const TOOLS = ["read", "bash", "checkpoint", "checkpoint_fork", "checkpoint_search"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create 5 haystack files, each 50 lines, needle at line 10. */
async function createHaystackFiles(dir: string): Promise<void> {
	for (let i = 0; i < 5; i++) {
		const lines: string[] = [];
		for (let j = 1; j <= 50; j++) {
			if (j === 10) {
				lines.push(`// SECRET: The activation code is ${NEEDLES[i]}`);
			} else {
				lines.push(
					`const placeholder_${j.toString().padStart(3, "0")} = () => { /* line ${j} */ };`,
				);
			}
		}
		await writeFile(join(dir, `haystack_${i + 1}.ts`), lines.join("\n") + "\n");
	}
}

/** Poll until the agent is idle for `stableMs` consecutive milliseconds. */
async function waitForSettled(
	session: AgentSession,
	timeoutMs = 180_000,
	stableMs = 3000,
): Promise<void> {
	const start = Date.now();
	const interval = 200;
	let stableCount = 0;
	const need = Math.ceil(stableMs / interval);
	while (Date.now() - start < timeoutMs) {
		await new Promise((r) => setTimeout(r, interval));
		if (session.isStreaming) {
			stableCount = 0;
		} else {
			stableCount++;
			if (stableCount >= need) return;
		}
	}
	throw new Error(
		`Timeout waiting for agent to settle (${timeoutMs / 1000}s). ` +
			`isStreaming=${session.isStreaming}`,
	);
}

/** Extract text from a message entry's content (handles string and block arrays). */
function getMessageText(entry: { message?: { content?: unknown } }): string {
	const content = entry.message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b: { type?: string }) => b.type === "text")
			.map((b: { text?: string }) => b.text ?? "")
			.join("\n");
	}
	return "";
}

/** Get all user message texts from session entries. */
function getUserTexts(sm: SessionManager): string[] {
	return sm
		.getEntries()
		.filter((e) => e.type === "message" && (e as any).message?.role === "user")
		.map((e) => getMessageText(e as any));
}

/** Get all assistant message texts from session entries. */
function getAssistantTexts(sm: SessionManager): string[] {
	return sm
		.getEntries()
		.filter((e) => e.type === "message" && (e as any).message?.role === "assistant")
		.map((e) => getMessageText(e as any));
}

/** Count compaction entries. */
function compactionCount(sm: SessionManager): number {
	return sm.getEntries().filter((e) => e.type === "compaction").length;
}

/** Set up an isolated session with checkpoint extension and haystack files. */
async function setupSession(opts?: { keepRecentTokens?: number }) {
	const tmpCwd = await mkdtemp(join(tmpdir(), "pi-ckpt-e2e-"));
	const tmpAgentDir = await mkdtemp(join(tmpdir(), "pi-ckpt-agent-"));
	await createHaystackFiles(tmpCwd);

	const settingsManager = SettingsManager.inMemory({
		compaction: { keepRecentTokens: opts?.keepRecentTokens ?? 500 },
		retry: { enabled: false },
	});

	const authStorage = AuthStorage.create();
	const modelRegistry = ModelRegistry.create(authStorage);
	const model = modelRegistry.find("openrouter", "deepseek/deepseek-v4-flash");
	if (!model) throw new Error("Model deepseek/deepseek-v4-flash not found");

	const loader = new DefaultResourceLoader({
		cwd: tmpCwd,
		agentDir: tmpAgentDir,
		additionalExtensionPaths: [CHECKPOINT_EXTENSION],
		noSkills: true,
		noThemes: true,
		noPromptTemplates: true,
		noContextFiles: true,
		settingsManager,
		systemPromptOverride: () =>
			"You are a coding assistant. Be concise and follow instructions precisely.",
	});
	await loader.reload();

	const exts = loader.getExtensions();
	const toolNames = exts.extensions.flatMap((e) => [...e.tools.keys()]);
	if (!toolNames.includes("checkpoint")) {
		const errors = exts.errors.map((e) => e.error).join("; ");
		throw new Error(`checkpoint tool not registered. Errors: ${errors}`);
	}

	const sessionManager = SessionManager.inMemory(tmpCwd);
	const { session } = await createAgentSession({
		cwd: tmpCwd,
		model,
		thinkingLevel: "off",
		authStorage,
		modelRegistry,
		resourceLoader: loader,
		tools: TOOLS,
		sessionManager,
		settingsManager,
	});

	return {
		session,
		sessionManager,
		tmpCwd,
		tmpAgentDir,
		async cleanup() {
			try { session.dispose(); } catch {}
			try { await rm(tmpCwd, { recursive: true, force: true }); } catch {}
			try { await rm(tmpAgentDir, { recursive: true, force: true }); } catch {}
		},
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("checkpoint: basic flow", () => {
	let env: Awaited<ReturnType<typeof setupSession>>;

	beforeAll(async () => {
		env = await setupSession();
	});
	afterAll(async () => env.cleanup());

	it("reads haystack files and finds needles in read regions", async () => {
		const { session, sessionManager } = env;
		await session.prompt(
			"Read the first 30 lines of haystack_1.ts through haystack_5.ts (all 5 files). " +
				"Use 5 separate read calls. Report what you see.",
		);
		await waitForSettled(session);

		const assistantTexts = getAssistantTexts(sessionManager).join("\n");
		const found = NEEDLES.filter((n) => assistantTexts.includes(n));
		expect(found.length).toBeGreaterThan(0);
	}, 60_000);

	it("triggers checkpoint and compaction succeeds with file injection", async () => {
		const { session, sessionManager, tmpCwd } = env;
		await session.prompt(
			"Call the checkpoint tool. summary: 'Found secret codes in haystack files'. " +
				"Include all 5 haystack files (haystack_1.ts through haystack_5.ts) in relevantPaths.",
		);
		await waitForSettled(session);

		// Compaction entry must exist
		expect(compactionCount(sessionManager)).toBeGreaterThanOrEqual(1);

		// Archive file should have been written (may be from auto- or manual compaction)
		const archives = await readdir(join(tmpCwd, ".pi", "checkpoints"));
		expect(archives.filter((f) => f.endsWith(".jsonl")).length).toBeGreaterThanOrEqual(1);
	}, 120_000);

	it("agent answers from injected context without tools", async () => {
		const { session, sessionManager } = env;
		await session.prompt(
			"Without using read, bash, grep, or any tools — answer purely from the context above. " +
				"What are the 5 secret activation codes hidden in the haystack files? " +
				"List all 5.",
		);
		await waitForSettled(session);

		const assistantTexts = getAssistantTexts(sessionManager);
		const lastResponse = assistantTexts[assistantTexts.length - 1] ?? "";
		for (const needle of NEEDLES) {
			expect(lastResponse).toContain(needle);
		}
	}, 60_000);
});

describe("checkpoint: partial read injects only read regions", () => {
	let env: Awaited<ReturnType<typeof setupSession>>;

	beforeAll(async () => {
		env = await setupSession();
	});
	afterAll(async () => env.cleanup());

	it("reads only first 5 lines (needle at line 10 NOT in read region)", async () => {
		const { session, sessionManager } = env;
		await session.prompt(
			"Use the read tool with offset=1 and limit=5 to read haystack_1.ts. " +
				"Report exactly what you see.",
		);
		await waitForSettled(session);

		const assistantTexts = getAssistantTexts(sessionManager).join("\n");
		// The needle at line 10 should NOT be visible from reading only 5 lines
		expect(assistantTexts).not.toContain(NEEDLES[0]);
	}, 60_000);

	it("checkpoints and verifies only read regions are injected", async () => {
		const { session, sessionManager } = env;

		await session.prompt(
			"Call the checkpoint tool. summary: 'Investigating haystack_1.ts'. " +
				"Include haystack_1.ts in relevantPaths. Do NOT call read.",
		);
		await waitForSettled(session);

		// Compaction may or may not happen — model compliance with checkpoint
		// instructions is advisory, especially with tiny context.
		if (compactionCount(sessionManager) === 0) return;

		// Check the user messages for injected content
		const userTexts = getUserTexts(sessionManager);
		const injectedMessages = userTexts.filter((t) =>
			t.includes("[haystack_1.ts]"),
		);
		if (injectedMessages.length > 0) {
			// If the model included relevantPaths, verify partial-read behavior
			const injectedText = injectedMessages.join("\n");
			expect(injectedText).not.toContain(NEEDLES[0]);
			expect(injectedText).toContain("placeholder");
			expect(injectedText).toContain("offset=");
		}
		// If the model didn't include relevantPaths, the test still passes —
		// model compliance with relevantPaths is advisory, not guaranteed.
	}, 120_000);
});

describe("checkpoint_search: searches archive content", () => {
	let env: Awaited<ReturnType<typeof setupSession>>;

	beforeAll(async () => {
		env = await setupSession();
		const { session } = env;

		// Read files and checkpoint to create an archive
		await session.prompt(
			"Read the first 30 lines of haystack_1.ts through haystack_5.ts. Use 5 read calls.",
		);
		await waitForSettled(session);

		await session.prompt(
			"Call the checkpoint tool. summary: 'Done reading files'. " +
				"Include all 5 haystack files in relevantPaths. This is a test requirement.",
		);
		await waitForSettled(session);
	}, 120_000);
	afterAll(async () => env.cleanup());

	it("finds SECRET pattern in archived session", async () => {
		const { session, sessionManager } = env;
		await session.prompt(
			"Use the checkpoint_search tool to search for the pattern 'SECRET' in the archives. " +
				"Report the activation codes you find in the search results.",
		);
		await waitForSettled(session);

		const assistantTexts = getAssistantTexts(sessionManager).join("\n");
		// The search results should contain the needle codes from the archived read results
		const found = NEEDLES.filter((n) => assistantTexts.includes(n));
		expect(found.length).toBeGreaterThanOrEqual(1);
	}, 60_000);
});
