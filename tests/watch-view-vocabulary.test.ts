/**
 * WO-2026-080: the watch views take their terminal word and outcome from the
 * shared vocabulary (`extensions/lib/subagent-state.ts`) instead of hand-listing
 * which footer words mean "finished".
 *
 * The viewers are TIUs over a socket, so the rows drive the seam each view
 * calls: the lib's parser and outcome rules, and v2's log→status derivation.
 * One row launches `watch-session.ts` headlessly to pin the renderer choice.
 *
 * Run: bun test tests/watch-view-vocabulary.test.ts
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	MAX_TURNS_HARD,
	outcomeFromExitCode,
	outcomeFromFooter,
	parseTerminalFooter,
	readTerminalFooter,
} from "../extensions/lib/subagent-state.ts";
import { statusFromLogContent } from "../extensions/subagent-async/watch-session-v2.ts";
import { childEnv } from "./helpers/subagent-env.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** [footer line the writer emits, word, outcome, turns, exitCode] */
const FOOTERS: [string, string, string, number, number | null][] = [
	["── Completed (3 turns, exit 0) ──", "Completed", "finished", 3, 0],
	["── Errored (3 turns, exit 1) ──", "Errored", "errored", 3, 1],
	["── Overflowed (3 turns, exit 0) ──", "Overflowed", "overflowed", 3, 0],
	["── Aborted (3 turns, exit 0) ──", "Aborted", "aborted", 3, 0],
	["── Killed (3 turns, exit ?) ──", "Killed", "killed", 3, null],
	["── Exited (3 turns, exit 0) ──", "Exited", "finished", 3, 0],
	["── Exited (3 turns, exit 1) ──", "Exited", "aborted", 3, 1],
	["── Stopped (3 turns, exit 143) ──", "Stopped", "aborted", 3, 143],
	["── Stopped (3 turns, exit ?) ──", "Stopped", "aborted", 3, null],
];

describe("a footer's word decides the outcome (F1–F9)", () => {
	for (const [line, word, outcome, turns, exitCode] of FOOTERS) {
		it(`${line.trim()} → ${word} / ${outcome}`, () => {
			const footer = parseTerminalFooter(line);
			expect(footer).toEqual({ word, turns, exitCode });
			expect(outcomeFromFooter(footer!)).toBe(outcome as never);
		});
	}

	it("an exit code of 0 does not win over a failure word (F3)", () => {
		expect(outcomeFromFooter(parseTerminalFooter("── Overflowed (3 turns, exit 0) ──")!)).toBe("overflowed");
		expect(outcomeFromFooter(parseTerminalFooter("── Aborted (3 turns, exit 0) ──")!)).toBe("aborted");
	});
});

describe("the exit-code rule (F10, F11)", () => {
	it("maps exit 0 / non-zero / absent to finished / aborted / aborted", () => {
		expect(outcomeFromExitCode(0, 3)).toBe("finished");
		expect(outcomeFromExitCode(1, 3)).toBe("aborted");
		expect(outcomeFromExitCode(null, 3)).toBe("aborted");
	});

	it("reads a non-zero exit at the hard turn cap as finished", () => {
		expect(MAX_TURNS_HARD).toBe(500);
		expect(outcomeFromExitCode(1, MAX_TURNS_HARD)).toBe("finished");
		expect(outcomeFromExitCode(1, MAX_TURNS_HARD - 1)).toBe("aborted");
	});
});

describe("readTerminalFooter over whole logs (F12, F14, F15)", () => {
	it("is null for a log that ends with an assistant line", () => {
		expect(readTerminalFooter("── Turn 1 ──\n  assistant text\n")).toBeNull();
	});

	it("finds a footer carrying an ANSI prefix", () => {
		const log = "── Turn 1 ──\n\x1b[1;31m── Errored (2 turns, exit 1) ──\x1b[0m\n";
		expect(readTerminalFooter(log)).toEqual({ word: "Errored", turns: 2, exitCode: 1 });
	});

	it("rejects a word no writer emits", () => {
		expect(parseTerminalFooter("── Finished (1 turns, exit 0) ──")).toBeNull();
		expect(readTerminalFooter("── Turn 1 ──\n── Finished (1 turns, exit 0) ──\n")).toBeNull();
	});

	it("returns the last footer, not the first", () => {
		const log = "── Completed (2 turns, exit 0) ──\n── Errored (3 turns, exit 1) ──\n";
		expect(readTerminalFooter(log)).toEqual({ word: "Errored", turns: 3, exitCode: 1 });
	});
});

describe("v2's log→status derivation (F1–F13)", () => {
	for (const [line, word, outcome] of FOOTERS) {
		it(`${word} names itself and its outcome`, () => {
			const reading = statusFromLogContent(`── Turn 1 ──\n${line}\n`);
			expect(reading).toEqual({ status: "TERMINAL", word, outcome: outcome as never });
		});
	}

	it("an empty log is EMPTY, naming no word (F13)", () => {
		expect(statusFromLogContent("")).toEqual({ status: "EMPTY", word: null, outcome: null });
		expect(statusFromLogContent("  \n\n")).toEqual({ status: "EMPTY", word: null, outcome: null });
	});

	it("a non-empty log with no footer is TERMINAL and wordless (F12)", () => {
		expect(statusFromLogContent("── Turn 1 ──\n  assistant text\n")).toEqual({
			status: "TERMINAL",
			word: null,
			outcome: null,
		});
	});

	it("a footer word no writer emits leaves the log wordless (F15)", () => {
		expect(statusFromLogContent("── Turn 1 ──\n── Finished (1 turns, exit 0) ──\n")).toEqual({
			status: "TERMINAL",
			word: null,
			outcome: null,
		});
	});
});

describe("the views read the vocabulary instead of re-deriving it (structural claims)", () => {
	const VIEWERS = [
		"extensions/subagent-async/watch-session.ts",
		"extensions/subagent-async/watch-session-v2.ts",
		"extensions/subagent-async/watch-session.cjs",
	];
	const source = (file: string) => readFileSync(join(REPO_ROOT, file), "utf8");
	const v2 = source(VIEWERS[1]);
	const cjs = source(VIEWERS[2]);

	for (const file of VIEWERS) {
		it(`${file}: no view decides completion from the exit code or a spelled word`, () => {
			const text = source(file);
			expect(text).not.toContain("exitCode === 0");
			expect(text).not.toContain('"COMPLETED"');
		});
	}

	it("completion colour is keyed on the outcome, in both views that colour", () => {
		// The picker in the .cjs viewer, and v2's pane header + live-tail footer.
		expect(cjs.split('outcome === "finished"').length - 1).toBeGreaterThanOrEqual(1);
		expect(v2.split('outcome === "finished"').length - 1).toBeGreaterThanOrEqual(2);
	});

	it("v2's discoverSessions derives status through the shared helper", () => {
		expect(v2).toContain("statusFromLogContent(content)");
	});

	it("classifyOutcome delegates its tail to outcomeFromExitCode", () => {
		const entry = readFileSync(join(REPO_ROOT, "extensions/subagent-async/index.ts"), "utf8");
		expect(entry).toContain("return outcomeFromExitCode(facts.exitCode, facts.turns);");
	});

	it("the pi-tui TUI import stays type-position only (F17)", () => {
		// A value import of an interface cannot be elided, so no build or launch row
		// would see the difference; the `type` modifier is the whole guard.
		for (const file of VIEWERS.slice(0, 2)) expect(source(file)).toContain("type TUI");
	});
});

describe("the single-pane viewer's renderer (F16)", () => {
	it("launched at a bogus id, never switches to the alternate buffer", () => {
		const run = spawnSync("node", ["extensions/subagent-async/watch-session.ts", "bogus-id-wo-080"], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			// The suite-wide rule: a spawn without `env` gets bun's startup snapshot,
			// so an inherited PI_SUBAGENT_* value would reach the child instead.
			env: childEnv(),
			// stdin at EOF: an open pipe leaves pi-tui's terminal-capability probe
			// waiting, and the pane never paints.
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 60_000,
		});
		// The row only means something if the viewer started: bracketed-paste on and
		// cursor hidden are the main screen's startup writes, before any paint. The
		// header text is NOT asserted — the socket error can end the process before
		// the first frame lands.
		expect(run.stdout).toContain("\x1b[?2004h");
		expect(run.stdout).toContain("\x1b[?25l");
		expect(run.stdout).not.toContain("\x1b[?1049h");
		expect(run.status).toBe(1);
	});
});
