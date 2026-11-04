/**
 * Summary ownership at the compaction boundary (WO-2026-061,
 * `decisions/checkpoint/005`).
 *
 * Both `session_before_compact` handlers are the real extension modules,
 * dispatched the way pi's runner does it
 * (`dist/core/extensions/runner.js:812-836`: last non-null result wins, `cancel`
 * short-circuits, a throw is recorded and leaves the prior result standing),
 * with the fleet `compact()` mocked at its module seam so no row touches the
 * network.
 *
 * Run: bash tests/setup.sh && bun test tests/summary-ownership.test.ts
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import { CHECKPOINT_MARKER } from "../extensions/lib/checkpoint-marker.ts";
import { FLEET_MODEL, FLEET_MODEL_SPEC, FLEET_PROVIDER } from "../extensions/lib/fleet-model.ts";

// ---------------------------------------------------------------------------
// The fleet seam
// ---------------------------------------------------------------------------

interface FleetCall {
	preparation: any;
	model: any;
	apiKey: string | undefined;
	headers: any;
	customInstructions: string | undefined;
	signal: AbortSignal | undefined;
	thinkingLevel: string | undefined;
}

const fleetCalls: FleetCall[] = [];

/**
 * What the mocked `compact()` returns: pi's contract (`compaction.d.ts:144`,
 * `CompactionResult`) — the boundary comes from `preparation`, the summary from
 * the summariser. A handler that recomputed either would show up as a
 * difference here.
 */
function fleetCompaction(preparation: any) {
	return {
		summary: "FLEET REWRITE — not the checkpoint's text",
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		details: { rewrittenBy: "fleet" },
		usage: { inputTokens: 1, outputTokens: 1 },
	};
}

let fleetImpl: (call: FleetCall) => Promise<any> = (call) =>
	Promise.resolve(fleetCompaction(call.preparation));

await mock.module("@earendil-works/pi-coding-agent", () => ({
	...piCodingAgent,
	compact: async (
		preparation: any,
		model: any,
		apiKey: string | undefined,
		headers: any,
		customInstructions: string | undefined,
		signal: AbortSignal | undefined,
		thinkingLevel: string | undefined,
	) => {
		const call: FleetCall = {
			preparation,
			model,
			apiKey,
			headers,
			customInstructions,
			signal,
			thinkingLevel,
		};
		fleetCalls.push(call);
		return fleetImpl(call);
	},
}));

// Imported after the mock is registered: `compaction-model.ts` binds the
// mocked `compact()`. `checkpoint.ts` gets the rest of the package unchanged.
const { default: checkpointExtension, _testSetInflightScanDir } = await import(
	"../extensions/checkpoint.ts"
);
const { default: compactionModelExtension } = await import("../extensions/compaction-model.ts");

// In-flight subagent scanning reads the real registry by default; an empty dir
// keeps every composed summary in this file deterministic.
const emptyRegistry = await mkdtemp(join(tmpdir(), "summary-ownership-inflight-"));
_testSetInflightScanDir(emptyRegistry);

afterAll(async () => {
	_testSetInflightScanDir(undefined);
	await rm(emptyRegistry, { recursive: true, force: true });
	mock.restore();
});

// ---------------------------------------------------------------------------
// Handler capture + pi's dispatch
// ---------------------------------------------------------------------------

type Handler = (event: any, ctx: any) => unknown;

interface CapturedExtension {
	name: string;
	/** The `settings.json` entry whose load position this extension registers at. */
	settingsPath: string;
	handlers: Map<string, Handler[]>;
	tools: Map<string, any>;
	sent: Array<{ text: string; options?: unknown }>;
}

function captureExtension(
	name: string,
	settingsPath: string,
	factory: (api: any) => void,
): CapturedExtension {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, any>();
	const sent: Array<{ text: string; options?: unknown }> = [];
	factory({
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool: (def: any) => {
			tools.set(def.name, def);
		},
		registerCommand: () => {},
		sendUserMessage: (text: string, options?: unknown) => {
			sent.push({ text, options });
		},
	});
	return { name, settingsPath, handlers, tools, sent };
}

const SETTINGS_EXTENSIONS: string[] = JSON.parse(
	await readFile(join(import.meta.dir, "..", "settings.json"), "utf8"),
).extensions;

/** The load position `settings.json` gives an extension; a missing entry is loud. */
function settingsIndex(settingsPath: string): number {
	const index = SETTINGS_EXTENSIONS.indexOf(settingsPath);
	if (index < 0) throw new Error(`${settingsPath} is not registered in settings.json`);
	return index;
}

// Dispatch order is the `settings.json` invariant, not a harness assumption:
// `checkpoint.ts` registers first, so `compaction-model.ts` is the result pi
// keeps unless it yields.
const CHECKPOINT_EXT = captureExtension(
	"checkpoint.ts",
	"extensions/checkpoint.ts",
	checkpointExtension,
);
const COMPACTION_MODEL_EXT = captureExtension(
	"compaction-model.ts",
	"extensions/compaction-model.ts",
	compactionModelExtension,
);
const EXTENSIONS = [CHECKPOINT_EXT, COMPACTION_MODEL_EXT].sort(
	(a, b) => settingsIndex(a.settingsPath) - settingsIndex(b.settingsPath),
);

/** Fire one extension's handlers for `event`, in registration order. */
async function emit(
	ext: CapturedExtension,
	event: string,
	ctx: any,
	payload: Record<string, unknown> = {},
) {
	const results: unknown[] = [];
	for (const handler of ext.handlers.get(event) ?? []) {
		results.push(await handler({ type: event, ...payload }, ctx));
	}
	return results;
}

/**
 * pi's `session_before_compact` dispatch across extensions
 * (`runner.js:812-836`): each non-null result replaces the previous one,
 * `cancel` short-circuits, a throw is an extension error and leaves the prior
 * result standing.
 */
async function dispatchBeforeCompact(ctx: any, event: Record<string, unknown>) {
	let result: any;
	const errors: Array<{ extension: string; message: string }> = [];
	const seen: Array<{ extension: string; event: any }> = [];
	for (const ext of EXTENSIONS) {
		for (const handler of ext.handlers.get("session_before_compact") ?? []) {
			const handlerEvent = { type: "session_before_compact", ...event };
			seen.push({ extension: ext.name, event: handlerEvent });
			try {
				const handlerResult = await handler(handlerEvent, ctx);
				if (handlerResult) {
					result = handlerResult;
					if (result.cancel) return { result, errors, seen };
				}
			} catch (err) {
				errors.push({
					extension: ext.name,
					message: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}
	return { result, errors, seen };
}

// ---------------------------------------------------------------------------
// ctx + fixtures
// ---------------------------------------------------------------------------

/**
 * The boundary facts this file's rows share. `fileOps` is part of a real
 * `CompactionPreparation` and the machine block reads it; `R2` compares the
 * whole object, so it is the value the fleet seat is handed too.
 */
const BOUNDARY = {
	firstKeptEntryId: "entry-42",
	tokensBefore: 1234,
	fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
};

interface CtxOptions {
	cwd: string;
	modelFound?: boolean;
	auth?: { ok: true; apiKey: string; headers?: Record<string, string> } | { ok: false; error: string };
}

function makeCtx(opts: CtxOptions) {
	const notifications: Array<{ message: string; level: string }> = [];
	const compactRequests: Array<{ customInstructions?: string; onComplete?: any; onError?: any }> = [];
	const registry = { findCalls: 0, authCalls: 0 };

	const ctx = {
		cwd: opts.cwd,
		model: { contextWindow: 200_000 },
		getContextUsage: () => ({ tokens: 1000, contextWindow: 200_000, percent: 1 }),
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level }),
		},
		sessionManager: {
			getEntries: () => [],
			// The wait store reads the session branch (main's `waitHost`); a
			// checkpoint's continuation is "no wait pending" unless a row records one.
			getBranch: () => [],
			getSessionId: () => "test-session",
			getCwd: () => opts.cwd,
		},
		compact: (request: any) => compactRequests.push(request),
		modelRegistry: {
			find: (provider: string, model: string) => {
				registry.findCalls++;
				return opts.modelFound === false ? undefined : { provider, id: model };
			},
			getApiKeyAndHeaders: async (model: any) => {
				registry.authCalls++;
				return opts.auth ?? { ok: true as const, apiKey: "test-key", headers: { "x-test": "1" } };
			},
		},
	};

	return { ctx, notifications, compactRequests, registry };
}

/**
 * Valid authored fields. `triedAndFailed` cannot be `"none"` here: a checkpoint
 * whose `decisions` and `triedAndFailed` are both N/A is rejected (nothing to
 * resume, WO-2026-062 C10).
 */
function summary(over: Record<string, unknown> = {}) {
	return {
		goal: "A checkpoint owns its summary text",
		filesTouched: ["fixture.ts"],
		decisions: ["none"],
		triedAndFailed: ["the first approach — it failed, so the next window does not retry it"],
		constraints: "none",
		...over,
	};
}

/**
 * The authored text these rows' fixture renders to — a literal, not a
 * re-derivation from `request.customInstructions`, so a composition that drops
 * or truncates the authored half fails the row (R1/R8).
 */
const AUTHORED_TEXT = [
	"Goal: A checkpoint owns its summary text",
	"Files touched: fixture.ts",
	"Decisions: none",
	"Tried and failed (and why):",
	"  - the first approach — it failed, so the next window does not retry it",
	"Constraints: none",
	"Next: RESUME-HERE",
].join("\n");

/**
 * A branch entry the cut boundary can name. `preparation.firstKeptEntryId`
 * always references one (`findProjectedCutPoint` picks a real index), so the
 * merged file-op walk asserts on a miss.
 */
function boundaryEntry(id: string = BOUNDARY.firstKeptEntryId) {
	return { id, parentId: null, type: "message", message: { role: "user", content: [] } };
}

/** A `SessionBeforeCompactEvent` (`types.d.ts:601`) with the given instructions. */
function beforeCompactEvent(
	customInstructions: string | undefined,
	over: Record<string, unknown> = {},
) {
	return {
		preparation: { ...BOUNDARY },
		branchEntries: [boundaryEntry()],
		customInstructions,
		reason: "manual",
		willRetry: false,
		...over,
	};
}

/**
 * Queue a checkpoint through the tool and the compaction trigger. `turn_end`
 * only runs the agent loop's mid-run boundary; the compaction request fires at
 * `agent_settled`, after the run is idle.
 */
async function queueCheckpoint(
	h: ReturnType<typeof makeCtx>,
	args: Record<string, unknown> = {},
) {
	await emit(CHECKPOINT_EXT, "session_start", h.ctx);
	await CHECKPOINT_EXT.tools
		.get("checkpoint")
		.execute("call-1", { summary: summary(), ...args }, undefined, undefined, h.ctx);
	await emit(CHECKPOINT_EXT, "turn_end", h.ctx);
	await emit(CHECKPOINT_EXT, "agent_settled", h.ctx);
	const request = h.compactRequests[h.compactRequests.length - 1];
	if (!request) throw new Error("agent_settled did not request a compaction");
	return request;
}

async function withCwd(run: (cwd: string) => Promise<void>) {
	const cwd = await mkdtemp(join(tmpdir(), "summary-ownership-"));
	try {
		await run(cwd);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

beforeEach(() => {
	fleetCalls.length = 0;
	fleetImpl = (call) => Promise.resolve(fleetCompaction(call.preparation));
	CHECKPOINT_EXT.sent.length = 0;
});

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

describe("summary ownership across the compaction boundary", () => {
	it("load order: settings.json registers checkpoint.ts before compaction-model.ts", () => {
		expect(settingsIndex(CHECKPOINT_EXT.settingsPath)).toBeLessThan(
			settingsIndex(COMPACTION_MODEL_EXT.settingsPath),
		);
		expect(EXTENSIONS).toEqual([CHECKPOINT_EXT, COMPACTION_MODEL_EXT]);
	});

	it("R1: a checkpoint compaction yields before any fleet work; its text is stored", async () => {
		await withCwd(async (cwd) => {
			const h = makeCtx({ cwd });
			const request = await queueCheckpoint(h, { nextSteps: "RESUME-HERE" });
			expect(request.customInstructions?.startsWith(CHECKPOINT_MARKER)).toBe(true);

			const dispatched = await dispatchBeforeCompact(
				h.ctx,
				beforeCompactEvent(request.customInstructions),
			);

			expect(dispatched.errors).toEqual([]);
			expect(fleetCalls).toHaveLength(0);
			expect(h.registry.findCalls).toBe(0);
			expect(h.registry.authCalls).toBe(0);

			const stored = dispatched.result?.compaction;
			// 062 owns the composed text: the authored half is the byte-identical
			// prefix and only the machine block is appended (its content is C1's).
			expect(stored.summary.startsWith(AUTHORED_TEXT)).toBe(true);
			expect(stored.summary.slice(AUTHORED_TEXT.length)).toStartWith("\n\n### Machine facts\n");
			expect(stored.firstKeptEntryId).toBe(BOUNDARY.firstKeptEntryId);
			expect(stored.tokensBefore).toBe(BOUNDARY.tokensBefore);
			// The file trail rides the entry: core never inherits it from a hook
			// compaction, so the next checkpoint would lose it (WO-2026-062 §2).
			expect(stored.details).toEqual({ readFiles: [], modifiedFiles: [] });
			// No summariser call, so no usage is recorded (owner 2026-10-31).
			expect(stored.usage).toBeUndefined();
		});
	});

	it("R2: /compact (no marker) still gets the fleet rewrite", async () => {
		await withCwd(async (cwd) => {
			const h = makeCtx({ cwd });
			const dispatched = await dispatchBeforeCompact(h.ctx, beforeCompactEvent(undefined));

			expect(dispatched.errors).toEqual([]);
			expect(fleetCalls).toHaveLength(1);
			expect(fleetCalls[0].customInstructions).toBeUndefined();
			expect(fleetCalls[0].preparation).toEqual(BOUNDARY);
			expect(fleetCalls[0].model).toEqual({ provider: FLEET_PROVIDER, id: FLEET_MODEL });
			expect(fleetCalls[0].apiKey).toBe("test-key");
			expect(fleetCalls[0].headers).toEqual({ "x-test": "1" });
			expect(fleetCalls[0].thinkingLevel).toBe("low");

			const stored = dispatched.result?.compaction;
			expect(stored.summary).toBe("FLEET REWRITE — not the checkpoint's text");
			expect(stored.firstKeptEntryId).toBe(BOUNDARY.firstKeptEntryId);
			expect(stored.tokensBefore).toBe(BOUNDARY.tokensBefore);
		});
	});

	it("R2b: an event with no customInstructions key at all also takes the fleet path", async () => {
		await withCwd(async (cwd) => {
			const h = makeCtx({ cwd });
			const event = beforeCompactEvent(undefined);
			delete (event as { customInstructions?: string }).customInstructions;
			const dispatched = await dispatchBeforeCompact(h.ctx, event);

			expect(dispatched.errors).toEqual([]);
			expect(fleetCalls).toHaveLength(1);
			expect(dispatched.result?.compaction.summary).toBe(
				"FLEET REWRITE — not the checkpoint's text",
			);
		});
	});

	it("R3: auto compaction (threshold, overflow) still gets the fleet rewrite", async () => {
		for (const reason of ["threshold", "overflow"] as const) {
			fleetCalls.length = 0;
			await withCwd(async (cwd) => {
				const h = makeCtx({ cwd });
				const dispatched = await dispatchBeforeCompact(
					h.ctx,
					beforeCompactEvent(undefined, { reason, willRetry: reason === "overflow" }),
				);

				expect(dispatched.errors).toEqual([]);
				expect(fleetCalls).toHaveLength(1);
				expect(fleetCalls[0].customInstructions).toBeUndefined();
				expect(dispatched.result?.compaction.summary).toBe(
					"FLEET REWRITE — not the checkpoint's text",
				);
				expect(dispatched.result?.compaction.firstKeptEntryId).toBe(
					BOUNDARY.firstKeptEntryId,
				);
			});
		}
	});

	it("R4: a fleet failure is surfaced at error level and overrides nothing", async () => {
		await withCwd(async (cwd) => {
			fleetImpl = async () => {
				throw new Error("fleet provider exploded");
			};
			const h = makeCtx({ cwd });
			const dispatched = await dispatchBeforeCompact(h.ctx, beforeCompactEvent(undefined));

			// The handler swallows nothing into the runner: no extension error,
			// and no compaction result to replace the prior one with.
			expect(dispatched.errors).toEqual([]);
			expect(dispatched.result).toBeUndefined();
			expect(fleetCalls).toHaveLength(1);

			const errors = h.notifications.filter((n) => n.level === "error");
			expect(errors).toHaveLength(1);
			expect(errors[0].message).toContain(FLEET_MODEL_SPEC);
			expect(errors[0].message).toContain("fleet provider exploded");
		});
	});

	it("R5: an unresolvable fleet model warns, never calls compact, overrides nothing", async () => {
		await withCwd(async (cwd) => {
			const h = makeCtx({ cwd, modelFound: false });
			const dispatched = await dispatchBeforeCompact(h.ctx, beforeCompactEvent(undefined));

			expect(dispatched.errors).toEqual([]);
			expect(dispatched.result).toBeUndefined();
			expect(fleetCalls).toHaveLength(0);
			expect(h.registry.authCalls).toBe(0);
			expect(h.notifications.filter((n) => n.level === "error")).toHaveLength(0);
			const warnings = h.notifications.filter((n) => n.level === "warning");
			expect(warnings).toHaveLength(1);
			expect(warnings[0].message).toContain(FLEET_MODEL_SPEC);
		});
	});

	it("R5b: missing auth warns, never calls compact, overrides nothing", async () => {
		await withCwd(async (cwd) => {
			const h = makeCtx({ cwd, auth: { ok: false, error: "no key for fleet seat" } });
			const dispatched = await dispatchBeforeCompact(h.ctx, beforeCompactEvent(undefined));

			expect(dispatched.errors).toEqual([]);
			expect(dispatched.result).toBeUndefined();
			expect(fleetCalls).toHaveLength(0);
			expect(h.notifications.filter((n) => n.level === "error")).toHaveLength(0);
			const warnings = h.notifications.filter((n) => n.level === "warning");
			expect(warnings).toHaveLength(1);
			expect(warnings[0].message).toContain("Compaction auth failed");
			expect(warnings[0].message).toContain("no key for fleet seat");
		});
	});

	it("R6: a user abort is silent and overrides nothing", async () => {
		await withCwd(async (cwd) => {
			const controller = new AbortController();
			controller.abort();
			fleetImpl = async () => {
				throw new Error("aborted by user");
			};
			const h = makeCtx({ cwd });
			const dispatched = await dispatchBeforeCompact(
				h.ctx,
				beforeCompactEvent(undefined, { signal: controller.signal }),
			);

			expect(dispatched.errors).toEqual([]);
			expect(dispatched.result).toBeUndefined();
			// The abort is handled after the call (the pre-existing shape): the
			// signal must reach `compact()`, or this arm is unreachable.
			expect(fleetCalls).toHaveLength(1);
			expect(fleetCalls[0].signal).toBe(controller.signal);
			// Silent: no failure report from the fleet handler. The info notify is
			// checkpoint.ts's own auto-archive, which is not this handler's path.
			expect(h.notifications.filter((n) => n.level === "error")).toEqual([]);
			expect(h.notifications.some((n) => n.message.startsWith("Compaction with"))).toBe(false);
		});
	});

	it("R6b: a surface that throws (stale ctx) still never throws into the runner", async () => {
		await withCwd(async (cwd) => {
			fleetImpl = async () => {
				throw new Error("fleet provider exploded");
			};
			const h = makeCtx({ cwd });
			h.ctx.ui.notify = () => {
				throw new Error("stale extension context");
			};

			// This handler alone: checkpoint.ts's auto-archive path has its own
			// notify calls, in a different handler with its own tests.
			const results = await emit(
				COMPACTION_MODEL_EXT,
				"session_before_compact",
				h.ctx,
				beforeCompactEvent(undefined),
			);

			expect(results).toEqual([undefined]);
			expect(fleetCalls).toHaveLength(1);
		});
	});

	it("R7: checkpoint side effects run regardless of the yield — archive, injection, continuation", async () => {
		await withCwd(async (cwd) => {
			const lines = Array.from({ length: 6 }, (_, i) => `line ${i + 1} of fixture.ts`);
			await writeFile(join(cwd, "fixture.ts"), lines.join("\n") + "\n");

			const h = makeCtx({ cwd });
			await emit(CHECKPOINT_EXT, "session_start", h.ctx);
			await emit(CHECKPOINT_EXT, "tool_result", h.ctx, {
				toolCallId: "read-1",
				toolName: "read",
				input: { path: "fixture.ts", offset: 1, limit: 3 },
				content: [{ type: "text", text: lines.slice(0, 3).join("\n") }],
				isError: false,
			});

			const result = await CHECKPOINT_EXT.tools
				.get("checkpoint")
				.execute(
					"call-1",
					{
						summary: summary(),
						nextSteps: "RESUME-HERE",
						relevantPaths: [{ path: "fixture.ts" }],
					},
					undefined,
					undefined,
					h.ctx,
				);
			await emit(CHECKPOINT_EXT, "turn_end", h.ctx);
			await emit(CHECKPOINT_EXT, "agent_settled", h.ctx);
			const request = h.compactRequests[h.compactRequests.length - 1];

			const dispatched = await dispatchBeforeCompact(
				h.ctx,
				beforeCompactEvent(request.customInstructions),
			);
			// The side effects below are the checkpoint handler's own calls: they
			// run whichever handler's compaction pi keeps, so this row is a
			// non-regression guard. R1 owns the ownership discrimination.
			expect(fleetCalls).toHaveLength(0);

			// Archive: written by the tool before compaction.
			expect(result.content[0].text).toContain("Checkpoint queued.");
			const archives = (await readdir(join(cwd, ".pi", "checkpoints"))).filter((f) =>
				f.endsWith(".jsonl"),
			);
			expect(archives).toHaveLength(1);

			// Injection + continuation: built by the marker path, delivered by
			// pi through onComplete.
			await request.onComplete?.({
				...(dispatched.result?.compaction ?? {}),
				estimatedTokensAfter: 100,
			});
			expect(CHECKPOINT_EXT.sent).toHaveLength(1);
			expect(CHECKPOINT_EXT.sent[0].text).toContain("[fixture.ts]");
			expect(CHECKPOINT_EXT.sent[0].text).toContain("line 1 of fixture.ts");
			expect(CHECKPOINT_EXT.sent[0].text).toContain("RESUME-HERE");
			expect(CHECKPOINT_EXT.sent[0].options).toEqual({ deliverAs: "followUp" });
			expect(
				h.notifications.some((n) => n.level === "info" && n.message.includes("Checkpoint complete")),
			).toBe(true);
		});
	});

	it("R8: the marker survives to the ownership predicate, and the stored text is checkpoint's", async () => {
		await withCwd(async (cwd) => {
			const h = makeCtx({ cwd });
			const request = await queueCheckpoint(h, { nextSteps: "RESUME-HERE" });
			const dispatched = await dispatchBeforeCompact(
				h.ctx,
				beforeCompactEvent(request.customInstructions),
			);

			// The marker is intact on the event the second handler dispatches on.
			const seenByModel = dispatched.seen.find(
				(s) => s.extension === COMPACTION_MODEL_EXT.name,
			);
			expect(seenByModel?.event.customInstructions).toBe(request.customInstructions);
			expect(seenByModel?.event.customInstructions).toContain(CHECKPOINT_MARKER);

			// What pi stores is that same text with the marker consumed once, plus
			// the machine block 062 appends; the fleet never rewrote either half.
			// Asserted against the literal authored text, so dropping it is a red row.
			const stored = String(dispatched.result?.compaction.summary);
			expect(stored.startsWith(AUTHORED_TEXT)).toBe(true);
			expect(stored).toContain("### Machine facts");
			expect(fleetCalls).toHaveLength(0);
		});
	});
});

// ---------------------------------------------------------------------------
// WO-2026-073 — the integration's own rows
//
// The four days this cost were not a wrong summary: they were a *call* nobody
// saw. These rows assert on the transport and on the dispatch table, not on the
// text a handler happened to return.
// ---------------------------------------------------------------------------

/**
 * Replace `globalThis.fetch` for the duration of a row. The fleet summarisation
 * leaves through pi-ai's own dispatch rather than the coding-agent
 * `ModelRuntime`, so a row that only spies on the mocked `compact()` seam would
 * miss a re-implementation that calls the provider directly. Probe that
 * establishes the bypass: `docs/investigations/pi-1.4-compaction-override-2026-11.md`
 * §1 (its `globalThis.fetch` wrapper is the artefact that caught the four-day
 * bug). Any request is recorded and refused.
 */
async function withoutTransport(run: (requests: string[]) => Promise<void>) {
	const realFetch = globalThis.fetch;
	const requests: string[] = [];
	globalThis.fetch = (async (input: any) => {
		requests.push(String(input?.url ?? input));
		throw new Error("row: unexpected network request");
	}) as typeof globalThis.fetch;
	try {
		await run(requests);
	} finally {
		globalThis.fetch = realFetch;
	}
}

describe("WO-2026-073: ownership is decided before the call, not after it", () => {
	it("I1: the marker path makes no fleet request at all — not on the seam, not on the wire", async () => {
		await withoutTransport(async (requests) => {
			await withCwd(async (cwd) => {
				const h = makeCtx({ cwd });
				const request = await queueCheckpoint(h, { nextSteps: "RESUME-HERE" });
				// Calls this row counts are the ones after the checkpoint queued:
				// the checkpoint's own tool path must not have reached the fleet either.
				expect(fleetCalls).toHaveLength(0);
				expect(requests).toEqual([]);

				const dispatched = await dispatchBeforeCompact(
					h.ctx,
					beforeCompactEvent(request.customInstructions),
				);

				expect(dispatched.errors).toEqual([]);
				// The three seams a call-then-discard implementation would trip:
				// the fleet `compact()`, the model lookup, and auth resolution.
				expect(fleetCalls).toHaveLength(0);
				expect(requests).toEqual([]);
				expect(h.registry.findCalls).toBe(0);
				expect(h.registry.authCalls).toBe(0);
				// Nothing was discarded: the checkpoint handler's result is what pi keeps.
				expect(String(dispatched.result?.compaction.summary)).toContain(
					"### Machine facts",
				);
			});
		});
	});

	it("I2: the marker is the only yielding shape — /compact and auto still take the fleet seat", async () => {
		// `checkpoint.ts` prefixes the marker, but it also survives mid-text on the
		// post-reload path, so the predicate is `includes`, not `startsWith`.
		const yielding = [
			CHECKPOINT_MARKER,
			`${CHECKPOINT_MARKER}\nGoal: authored`,
			`${CHECKPOINT_MARKER} and more`,
		];
		const fleetBound = [
			undefined,
			"",
			"Summarize the conversation so far",
			"CHECKPOINT",
			"[CHECKPOINT", // the marker with no closing bracket
			"CHECKPOINT]",
		];
		for (const reason of ["manual", "threshold", "overflow"] as const) {
			for (const customInstructions of yielding) {
				fleetCalls.length = 0;
				await withCwd(async (cwd) => {
					const h = makeCtx({ cwd });
					const dispatched = await dispatchBeforeCompact(
						h.ctx,
						beforeCompactEvent(customInstructions, { reason }),
					);
					expect(dispatched.errors).toEqual([]);
					expect(fleetCalls).toHaveLength(0);
				});
			}
		}
		for (const reason of ["manual", "threshold", "overflow"] as const) {
			for (const customInstructions of fleetBound) {
				fleetCalls.length = 0;
				await withCwd(async (cwd) => {
					const h = makeCtx({ cwd });
					const dispatched = await dispatchBeforeCompact(
						h.ctx,
						beforeCompactEvent(customInstructions, { reason }),
					);
					expect(dispatched.errors).toEqual([]);
					expect(fleetCalls).toHaveLength(1);
					expect(dispatched.result?.compaction.summary).toBe(
						"FLEET REWRITE — not the checkpoint's text",
					);
				});
			}
		}
	});

	it("I3: a fleet failure on any non-checkpoint path is loud, and the message names the failure", async () => {
		for (const reason of ["manual", "threshold", "overflow"] as const) {
			fleetCalls.length = 0;
			await withoutTransport(async (requests) => {
				await withCwd(async (cwd) => {
					fleetImpl = async () => {
						throw new Error(`provider 503 on ${reason}`);
					};
					const h = makeCtx({ cwd });
					const dispatched = await dispatchBeforeCompact(
						h.ctx,
						beforeCompactEvent(undefined, { reason }),
					);

					// No override (pi's default stands) and no extension error (which
					// would leave a prior result standing silently).
					expect(dispatched.errors).toEqual([]);
					expect(dispatched.result).toBeUndefined();
					expect(fleetCalls).toHaveLength(1);
					expect(requests).toEqual([]);

					// Exactly one surface, at error, naming both the seat and the cause:
					// the old silent `undefined` left no trace at all.
					const errors = h.notifications.filter((n) => n.level === "error");
					expect(errors).toHaveLength(1);
					expect(errors[0].message).toContain(FLEET_MODEL_SPEC);
					expect(errors[0].message).toContain(`provider 503 on ${reason}`);
					expect(h.notifications.filter((n) => n.level === "warning")).toEqual([]);
				});
			});
		}
		fleetImpl = (call) => Promise.resolve(fleetCompaction(call.preparation));
	});
});
