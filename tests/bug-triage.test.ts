/**
 * Unit tests for the bug-triage peer trigger predicate.
 *
 * The trigger keys on the session DISPLAY NAME (set via `pi --name
 * bug-triage`), not on PI_PEER_NAME — because an env var is ambient and
 * can outlive the session (export + reuse terminal → silent reactivation).
 * The first test group pins that invariant: a stale PI_PEER_NAME without
 * the matching name must NOT activate the role.
 */
import { describe, it, expect } from "bun:test";
import { isBugTriagePeer } from "../extensions/bug-triage";

describe("isBugTriagePeer — name-based trigger", () => {
	it("is true when the session display name is 'bug-triage'", () => {
		expect(isBugTriagePeer({}, "bug-triage")).toBe(true);
	});

	it("trims surrounding whitespace in the name", () => {
		expect(isBugTriagePeer({}, "  bug-triage  ")).toBe(true);
	});

	it("is false for any other session name", () => {
		expect(isBugTriagePeer({}, "implement")).toBe(false);
		expect(isBugTriagePeer({}, "bug-triage-2")).toBe(false);
	});

	it("is false when there is no session name", () => {
		expect(isBugTriagePeer({}, undefined)).toBe(false);
		expect(isBugTriagePeer({}, "")).toBe(false);
		expect(isBugTriagePeer({}, "   ")).toBe(false);
	});
});

describe("isBugTriagePeer — env-var is NOT the trigger (regression)", () => {
	it("is false when PI_PEER_NAME='bug-triage' but the session has no matching name", () => {
		// The bug: a stale PI_PEER_NAME lingering in the shell must not quietly
		// reactivate the role in an unrelated session reusing the terminal.
		expect(isBugTriagePeer({ PI_PEER_NAME: "bug-triage" }, undefined)).toBe(false);
		expect(isBugTriagePeer({ PI_PEER_NAME: "bug-triage" }, "refactor-auth")).toBe(false);
	});

	it("is true on the session name regardless of PI_PEER_NAME (name wins)", () => {
		// Properly launched: both set. Misconfigured: name set, env not — role
		// still fires on the intentional name signal (a separate warning covers
		// the missing PI_PEER_NAME / broken mailbox).
		expect(isBugTriagePeer({ PI_PEER_NAME: "bug-triage" }, "bug-triage")).toBe(true);
		expect(isBugTriagePeer({ PI_PEER_NAME: "something-else" }, "bug-triage")).toBe(true);
		expect(isBugTriagePeer({}, "bug-triage")).toBe(true);
	});
});

describe("isBugTriagePeer — subagent guard", () => {
	it("is false for a subagent even if named 'bug-triage'", () => {
		expect(isBugTriagePeer({ PI_IS_SUBAGENT: "1" }, "bug-triage")).toBe(false);
	});

	it("ignores an unrelated PI_IS_SUBAGENT value", () => {
		expect(isBugTriagePeer({ PI_IS_SUBAGENT: "0" }, "bug-triage")).toBe(true);
	});
});
