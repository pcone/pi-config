// LIVE-NETWORK: this file makes real billed LLM calls on every full `bun test` run.
// Provider/model: opencode-go/deepseek-v4.1-flash, authorized from the live
// ~/.pi/agent/auth.json. Three prompts plus one compaction summary on the
// compaction row (~60k prompt tokens: a ~29k-token payload prompt, resent once),
// one small prompt on the refusal row; sessions run via `SessionManager.inMemory`,
// so no transcript is persisted. See
// docs/investigations/or-workspace-attribution-2026-10.md.

/**
 * End-to-end idle compaction: a real pi session, the real extension, a real
 * provider, and a cache TTL short enough to fire inside the test.
 *
 * The unit tests drive the handlers with a fake ctx and a `compact` spy, so
 * they cannot catch the failures this file exists for — a `ctx.compact()` that
 * pi refuses, an extension not bound to the TUI, an `agent_settled` that never
 * arrives. Two pi behaviours discovered here and worth keeping in mind:
 *
 *   - `ctx.compact()` works from a timer (no event handler required).
 *   - pi refuses to compact a small session: "Nothing to compact (session too
 *     small)" — `keepRecentTokens` is 20k, so the fixture must exceed it or the
 *     run proves nothing. An idle-compacting session is above 256k by
 *     definition, so this only constrains the fixture.
 *
 * The fixture clears that floor from a prompt, not from a tool read, because a
 * read cannot: the read tool truncates at 50KB (~12.5k tokens), so a session
 * built from one read stays under 20k and pi refuses it. Measured 2026-11-03:
 * one 902-line read left the session at 16,931 tokens against the 20k floor,
 * refused with "Nothing to compact (session too small)". That is why this row
 * reds and greens on identical code — it passed whenever the model happened to
 * page the file with `offset` and cross 20k. The payload prompt below puts
 * ~29.5k tokens in the session whatever the model does with tools.
 *
 * A red must name its cause, so `stubUI` records every `notify` and both rows
 * put the recorded levels, texts and the session's entry types in the assertion
 * message. The no-op proxy that stood here until 2026-11-03 discarded all of
 * them, so a refused compaction, a failed summarization call and a skip all
 * read as the same "no compaction entry".
 *
 * Run: bun test tests/e2e-idle-compaction.test.ts
 */
import { describe, it, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";

const EXTENSION = join(import.meta.dir, "..", "extensions", "auto-checkpoint.ts");
const PROVIDER = "opencode-go";
const MODEL = "deepseek-v4.1-flash";

/** pi's `compaction.keepRecentTokens` default (settings-defaults.js); a session
 *  under it has no cut point, so `ctx.compact()` is refused. */
const KEEP_RECENT_TOKENS = 20_000;

/** Safety net, not the expected wait: compaction lands 4.3–4.8 s after the last
 *  settle (whole runs 11–21 s at load averages of 8–20), and an error
 *  notification ends the wait early, so a refusal reds in ~8 s. */
const COMPACTION_DEADLINE_MS = 180_000;

interface Note {
	level: string;
	text: string;
}

interface Harness {
	cwd: string;
	agentDir: string;
	session: AgentSession;
	sessionManager: SessionManager;
	notes: Note[];
	dispose(): Promise<void>;
}

/** Any missing UI method is a no-op; `notify` is recorded so a red can say why. */
function stubUI(notes: Note[]): any {
	const recorder = {
		notify(text: string, level: string = "info") {
			notes.push({ level, text });
		},
	};
	return new Proxy(recorder, {
		get: (target: any, prop) => (prop in target ? target[prop] : () => undefined),
	});
}

function entryTypes(entries: any[]): string[] {
	return entries.map((e) => (e.customType ? `${e.type}:${e.customType}` : e.type));
}

/** Everything a red needs to name its own cause: what the UI was told, and what
 *  the session actually contains. */
function diagnosis(notes: Note[], entries: any[]): string {
	const told = notes.length ? notes.map((n) => `  [${n.level}] ${n.text}`).join("\n") : "  (none)";
	return `\nnotifications:\n${told}\nentry types: ${entryTypes(entries).join(", ") || "(empty)"}`;
}

async function settle(session: AgentSession): Promise<void> {
	while (session.isStreaming) await new Promise((r) => setTimeout(r, 100));
}

async function startSession(): Promise<Harness> {
	const cwd = await mkdtemp(join(tmpdir(), "pi-idle-e2e-"));
	const agentDir = await mkdtemp(join(tmpdir(), "pi-idle-e2e-agent-"));
	await mkdir(join(cwd, ".pi"), { recursive: true });
	// Fire 1.8 s after settle; any real context clears the threshold.
	await writeFile(
		join(cwd, ".pi", "auto-checkpoint.json"),
		JSON.stringify({ defaultThreshold: 1000, cacheTtlMs: 2000, cooldownMs: 0 }),
	);

	const settingsManager = SettingsManager.inMemory({});
	const modelRuntime = await ModelRuntime.create({
		authPath: join(getAgentDir(), "auth.json"),
		modelsPath: join(getAgentDir(), "models.json"),
	});
	const model = modelRuntime.getModel(PROVIDER, MODEL);
	if (!model) throw new Error(`Model ${PROVIDER}/${MODEL} not found`);

	// A throwaway agent dir: no global extensions or settings leak in.
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		additionalExtensionPaths: [EXTENSION],
		noSkills: true,
		noThemes: true,
		noPromptTemplates: true,
		noContextFiles: true,
		settingsManager,
	});
	await loader.reload();

	const sessionManager = SessionManager.inMemory(cwd);
	const created = await createAgentSession({
		cwd,
		model,
		thinkingLevel: "off",
		modelRuntime,
		resourceLoader: loader,
		tools: ["read"],
		sessionManager,
		settingsManager,
	});
	const notes: Note[] = [];
	// The extension compacts interactive sessions only; bind it as one.
	await created.session.bindExtensions({ uiContext: stubUI(notes), mode: "tui" });

	return {
		cwd,
		agentDir,
		session: created.session,
		sessionManager,
		notes,
		async dispose() {
			try { created.session.dispose(); } catch {}
			await rm(cwd, { recursive: true, force: true }).catch(() => {});
			await rm(agentDir, { recursive: true, force: true }).catch(() => {});
		},
	};
}

/**
 * Poll the transcript until the compaction lands, an error notification
 * arrives, or the deadline passes. Breaking on the error notification is what
 * turns a refusal into a ~8 s red that names itself instead of a 180 s wait
 * that names nothing.
 */
async function waitForCompaction(harness: Harness): Promise<{ compaction?: any; marker?: any }> {
	const deadline = Date.now() + COMPACTION_DEADLINE_MS;
	let compaction: any;
	let marker: any;
	while (Date.now() < deadline) {
		const entries = harness.sessionManager.getEntries() as any[];
		marker = entries.find((e) => e.type === "custom" && e.customType === "auto-checkpoint");
		compaction = entries.find((e) => e.type === "compaction");
		if (marker && compaction && !harness.session.isCompacting) break;
		if (harness.notes.some((n) => n.level === "error")) break;
		await new Promise((r) => setTimeout(r, 250));
	}
	return { compaction, marker };
}

/** ~18 tokens per line through this provider's tokenizer. */
function fillerLines(count: number): string {
	return Array.from(
		{ length: count },
		(_, i) => `export const line_${i} = "filler payload ${i} abcdefghij";`,
	).join("\n");
}

describe("idle compaction (live session)", () => {
	it("compacts itself after the idle delay and leaves a marker", async () => {
		const harness = await startSession();
		try {
			// 1600 lines ≈ 29.5k tokens: above pi's 20k keep floor with ~48%
			// headroom, and independent of whether the model pages the file.
			const payload = fillerLines(1600);
			await harness.session.prompt("Reply with just OK.");
			await settle(harness.session);
			await harness.session.prompt(`Here is a source file, for context.\n\n${payload}\n\nReply with just the word LOGGED.`);
			await settle(harness.session);
			await harness.session.prompt("Thanks — reply with the single word DONE.");
			await settle(harness.session);

			const { compaction, marker } = await waitForCompaction(harness);
			const entries = harness.sessionManager.getEntries() as any[];
			const why = diagnosis(harness.notes, entries);

			expect(compaction, `no compaction entry after ${COMPACTION_DEADLINE_MS / 1000}s${why}`).toBeTruthy();
			expect(marker, `no auto-checkpoint marker${why}`).toBeTruthy();
			// The floor is the whole reason this fixture carries a payload, so pin the
			// count that clears it: a fixture that shrank back under 20k has stopped
			// demonstrating an above-floor session, even where pi accepts it.
			expect(
				marker.data.tokens,
				`the session held ${marker.data.tokens} tokens, at or under pi's ${KEEP_RECENT_TOKENS}-token keep floor${why}`,
			).toBeGreaterThan(KEEP_RECENT_TOKENS);
			expect(marker.data.percent, `percent=${marker.data.percent}${why}`).toBeGreaterThan(0);
			expect(typeof marker.data.idleMinutes).toBe("number");
		} finally {
			await harness.dispose();
		}
	}, 240_000);

	// The refusal path: the one compaction failure that needs no fake provider.
	// A session above the extension's threshold but under pi's keep floor gets
	// its `ctx.compact()` refused, and the row exists to prove the reason
	// reaches the UI stub instead of vanishing.
	it("reports pi's refusal when the session is under the keep floor", async () => {
		const harness = await startSession();
		try {
			// 200 lines ≈ 4.3k tokens: 4× the 1000-token nudge threshold, 4.6×
			// under the keep floor.
			const payload = fillerLines(200);
			await harness.session.prompt(`Here is a source file, for context.\n\n${payload}\n\nReply with just OK.`);
			await settle(harness.session);

			const { compaction } = await waitForCompaction(harness);
			const entries = harness.sessionManager.getEntries() as any[];
			const why = diagnosis(harness.notes, entries);
			const refusal = harness.notes.find(
				(n) => n.level === "error" && n.text.includes("Nothing to compact (session too small)"),
			);

			// The fixture stays under the floor: if a pi change lets it compact,
			// this row must red rather than quietly stop exercising the refusal.
			expect(compaction, `a compaction landed, so the fixture cleared the floor${why}`).toBeFalsy();
			expect(refusal, `pi did not refuse the compaction, so this row proves nothing${why}`).toBeTruthy();
			// The deliverable is the message, so pin both halves of it: the reason
			// the extension reported, and the transcript shape that distinguishes
			// "never fired" from "pi refused".
			expect(why, "a red must carry the reason it went red").toContain("Nothing to compact (session too small)");
			expect(why, "a red must carry the session's entry types").toContain(entryTypes(entries).join(", "));
		} finally {
			await harness.dispose();
		}
	}, 240_000);
});
