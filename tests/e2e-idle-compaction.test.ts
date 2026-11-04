// LIVE-NETWORK: this file makes real billed LLM calls on every full `bun test` run.
// Provider/model: opencode-go/deepseek-v4.1-flash, authorized from the live
// ~/.pi/agent/auth.json. Two prompts plus one compaction summary, ~30k prompt
// tokens billed (the summary read is ~0.3k because the cut lands on the payload);
// the refusal row adds one small prompt.
// Sessions run via `SessionManager.inMemory`, so no transcript is persisted. See
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
 *     small)". The floor is `compaction.keepRecentTokens` (20k by default),
 *     decided by a walk from the transcript's tail that sums chars/4 estimates
 *     until it clears the floor; a session that never gets there has no cut
 *     point and is refused. An idle-compacting session is above 256k by
 *     definition, so this only constrains the fixture.
 *
 * Two estimators matter and they are different numbers: the floor walk's
 * chars/4 sum over messages, and `ctx.getContextUsage()`, which prefers the
 * provider's reported usage — the number the marker records. The fixtures below
 * are sized against the floor estimator.
 *
 * The payload arrives in a prompt, not from a tool read, because a read cannot
 * clear the floor: the read tool truncates at 2000 lines / 50KB (~12.5k tokens
 * by chars/4). Measured 2026-11-03: one 902-line read left the session at
 * 16,931 tokens by `getContextUsage()` — ~12.9k by the floor walk that decides
 * the cut — against the 20k floor, refused with "Nothing to compact (session
 * too small)". That is why this row reds and greens on identical code —
 * it passed whenever the model happened to page the file with `offset` and cross
 * the floor. The payload prompt is 92,179 characters, ~23.0k by chars/4, so it
 * clears the floor whatever the model does — the session has no tools.
 *
 * A red must name its cause, so `stubUI` records every `notify` with its level
 * and both failure-capable rows put the recorded levels, texts and the session's
 * entry types in the assertion message. A no-op proxy discards all of them, and
 * a refused compaction, a failed summarization call and a skip then all read as
 * the same "no compaction entry".
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

/** pi's `compaction.keepRecentTokens` default (settings-defaults.js): the floor
 *  the fixture must clear, and the bound the compaction row pins. */
const KEEP_RECENT_TOKENS = 20_000;

/** Safety net, not the expected wait: compaction lands ~4.5 s after the last
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
		tools: [],
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

interface WaitResult {
	compaction?: any;
	marker?: any;
	elapsedMs: number;
	endedOn: "compaction" | "error notification" | "deadline";
}

/**
 * Poll the transcript until the compaction lands, an error notification
 * arrives, or the deadline passes. Breaking on the error notification is what
 * turns a refusal into a red that names itself ~2 s after the last settle
 * instead of a 180 s wait that names nothing — and the result carries which of the three ended the wait, so
 * the assertion message never claims a timeout that did not elapse.
 */
async function waitForCompaction(harness: Harness): Promise<WaitResult> {
	const startedAt = Date.now();
	const deadline = startedAt + COMPACTION_DEADLINE_MS;
	let compaction: any;
	let marker: any;
	const result = (endedOn: WaitResult["endedOn"]): WaitResult => ({
		compaction,
		marker,
		elapsedMs: Date.now() - startedAt,
		endedOn,
	});
	while (Date.now() < deadline) {
		const entries = harness.sessionManager.getEntries() as any[];
		marker = entries.find((e) => e.type === "custom" && e.customType === "auto-checkpoint");
		compaction = entries.find((e) => e.type === "compaction");
		if (marker && compaction && !harness.session.isCompacting) return result("compaction");
		if (harness.notes.some((n) => n.level === "error")) return result("error notification");
		await new Promise((r) => setTimeout(r, 250));
	}
	return result("deadline");
}

/** ~57 chars per line: ~14.4 tokens by pi's chars/4 floor estimator, ~18 by the
 *  provider's tokenizer. Fixtures below are sized on the floor estimator. */
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
			// 1600 lines = 92,179 chars ≈ 23.0k tokens by the floor estimator: 15%
			// over pi's 20k floor, and independent of the model (no tools exist).
			const payload = fillerLines(1600);
			await harness.session.prompt("Reply with just OK.");
			await settle(harness.session);
			await harness.session.prompt(`Here is a source file, for context.\n\n${payload}\n\nReply with just the word LOGGED.`);
			await settle(harness.session);

			const wait = await waitForCompaction(harness);
			const entries = harness.sessionManager.getEntries() as any[];
			const why = diagnosis(harness.notes, entries);
			const { compaction, marker } = wait;

			expect(compaction, `no compaction entry after ${wait.elapsedMs}ms (wait ended on: ${wait.endedOn})${why}`).toBeTruthy();
			expect(marker, `no auto-checkpoint marker (wait ended on: ${wait.endedOn})${why}`).toBeTruthy();
			// The marker records `getContextUsage()`, the provider-reported estimate,
			// so this pins that number (28,927 measured) against pi's keep floor — not
			// the floor walk's chars/4 figure, which is what actually decides the cut.
			expect(
				marker.data.tokens,
				`the marker recorded ${marker.data.tokens} tokens (provider-reported) under pi's ${KEEP_RECENT_TOKENS}-token keep floor; ` +
					`the fixture clears that floor by chars/4, so this means it shrank${why}`,
			).toBeGreaterThan(KEEP_RECENT_TOKENS);
			expect(marker.data.percent, `percent=${marker.data.percent}${why}`).toBeGreaterThan(0);
			expect(marker.data.idleMinutes, `idleMinutes=${marker.data.idleMinutes}${why}`).toBeGreaterThanOrEqual(0);
		} finally {
			await harness.dispose();
		}
	}, 240_000);

	// The refusal path: the one compaction failure that needs no fake provider.
	// A session above the extension's threshold but under pi's keep floor gets
	// its `ctx.compact()` refused, and the row exists to prove the reason reaches
	// the UI stub instead of vanishing. It is also the permanent record of the
	// cause this file was fixed for.
	it("reports pi's refusal when the session is under the keep floor", async () => {
		const harness = await startSession();
		try {
			// 200 lines = 11,179 chars ≈ 2.8k tokens by the floor estimator (7× under
			// the floor), 3,901 provider-reported (4× over the 1000-token arm threshold).
			const payload = fillerLines(200);
			await harness.session.prompt(`Here is a source file, for context.\n\n${payload}\n\nReply with just OK.`);
			await settle(harness.session);

			const wait = await waitForCompaction(harness);
			const entries = harness.sessionManager.getEntries() as any[];
			const why = diagnosis(harness.notes, entries);
			const refusal = harness.notes.find(
				(n) => n.level === "error" && n.text.includes("Nothing to compact (session too small)"),
			);

			// The fixture stays under the floor: if a pi change lets it compact, this
			// row must red rather than quietly stop exercising the refusal.
			expect(wait.compaction, `a compaction landed, so the fixture cleared the floor${why}`).toBeFalsy();
			expect(refusal, `pi did not refuse the compaction (wait ended on: ${wait.endedOn})${why}`).toBeTruthy();
			// The wait must end on the notification, not on the deadline: that break is
			// what makes a refusal red in ~2 s instead of ~180 s.
			expect(wait.endedOn, `the wait ended on ${wait.elapsedMs}ms without breaking on the refusal${why}`).toBe(
				"error notification",
			);
			// The deliverable is the message, so pin both halves of it by literal: the
			// reason the extension reported, and the transcript shape that separates
			// "never fired" from "pi refused".
			expect(why, "a red must carry the reason it went red").toContain(
				"[error] Idle compaction failed: Nothing to compact (session too small)",
			);
			expect(why, "a red must carry the session's entry types").toContain(
				"entry types: model_change, thinking_level_change, message",
			);
		} finally {
			await harness.dispose();
		}
	}, 240_000);
});
