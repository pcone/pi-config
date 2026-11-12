/**
 * WO-2026-095 R2: the extension's registration surface, pinned before the file
 * is split by responsibility. Loading the module and registering against a stub
 * `pi` must yield the same tools and commands at every extraction commit, and
 * the names external importers take from `index.ts` must still resolve there.
 *
 * This is the split's load-order check too: a module graph that evaluates in a
 * broken order throws here, on load, rather than at the first dispatch.
 *
 * Run: bun test tests/subagent-async-surface.test.ts
 */

import { describe, expect, it } from "bun:test";
import subagentFactory, * as entry from "../extensions/subagent-async/index.ts";

/** The pre-split registration surface (index.ts at 5771f56). */
const TOOLS = [
	"subagent",
	"subagent_kill",
	"subagent_resume",
	"subagent_review_status",
	"subagent_status",
	"subagent_steer",
	"subagent_stop",
	"wait",
];

/** The pre-split set, plus `reaper` (WO-2026-092: the wt/ checkout reaper's
 *  on-demand view of the report it wrote at session start). */
const COMMANDS = ["attach", "detach", "reaper", "subagents", "watch"];

/** Every value name `tests/` and `extensions/` import from the entry point at
 *  5771f56. Types are erased and cannot be listed here; these are the ones a
 *  runtime import resolves. */
const ENTRY_EXPORTS = [
	"MAX_ORCHESTRATOR_NESTING_DEPTH",
	"_testAttachSessionId",
	"_testLiveSessionCtx",
	"_testRunning",
	"_testSetAttachState",
	"_testSetLiveSessionCtx",
	"buildSpawnMeta",
	"buildSubagentArgs",
	"buildSubagentEnv",
	"buildSubagentProcessEnv",
	"bumpStaleWatchdog",
	"completeWorkRecord",
	"decideRecoveryAdoption",
	"defaultOwnerProbe",
	"deliverCloseResult",
	"deliverResult",
	"describeUnknownSession",
	"detach",
	"dispatchKillSignals",
	"findRunningByQuery",
	"getParentTrackerKey",
	"isOwnerAlive",
	"metaPath",
	"nextSubagentDepth",
	"normalizeIdQuery",
	"notifyChildDetached",
	"observeCommit",
	"openWorkRecord",
	"parseWorkOrderPolicy",
	"processStartToken",
	"readMetaJson",
	"readPersistedSpawns",
	"readSessionCwd",
	"readSessionExchange",
	"reapFinishedWorktrees",
	"recoverOrphanedSubagents",
	"removeWorktreeTree",
	"reportDeclaresOwnerAsks",
	"resolveChildModel",
	"resolveGlobalAppendPrompt",
	"resolveRunningSession",
	"resolveSubagentMeta",
	"resolveTrackerKey",
	"rpcSend",
	"selfStartToken",
	"subagentDepth",
	"subagentNestingBlock",
	"taskDeclaresPolicySkip",
	"terminalOutcome",
	"turnCapStep",
	"turnCapTurn",
	"updateFooter",
	"updateMetaJson",
	"validateResumeMeta",
	"writeMetaJson",
];

function register() {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const pi: any = {
		events: { emit: () => {} },
		registerTool: (def: any) => tools.set(def.name, def),
		registerCommand: (name: string, def: any) => commands.set(name, def),
		on: () => {},
		sendUserMessage: () => {},
		ui: { setStatus: () => {}, notify: () => {}, setWidget: () => {} },
	};
	subagentFactory(pi);
	return { tools, commands };
}

describe("the extension's registration surface (WO-2026-095 R2)", () => {
	it("registers exactly the pre-split tool set", () => {
		const { tools } = register();
		expect([...tools.keys()].sort()).toEqual(TOOLS);
	});

	it("registers exactly the pre-split command set", () => {
		const { commands } = register();
		expect([...commands.keys()].sort()).toEqual(COMMANDS);
	});

	it("every name external importers take from the entry point still resolves there", () => {
		const missing = ENTRY_EXPORTS.filter((name) => (entry as Record<string, any>)[name] === undefined);
		expect(missing).toEqual([]);
	});

	it("the entry point's default export is the factory", () => {
		expect(typeof subagentFactory).toBe("function");
	});
});
