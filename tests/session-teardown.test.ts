/**
 * `disposeSessionLikeTheRuntime` — the teardown a bare `AgentSession` does not do
 * itself (pi-config#25): `session_shutdown` is emitted by pi's runtime wrapper, not
 * by `dispose()`, so a harness that only disposes leaves every extension timer
 * running into the next row.
 */

import { describe, expect, it } from "bun:test";
import { disposeSessionLikeTheRuntime } from "./helpers/session-teardown.ts";

function fakeSession(withHandlers: boolean) {
	const seen: unknown[] = [];
	let disposed = false;
	return {
		seen,
		disposed: () => disposed,
		session: {
			extensionRunner: {
				hasHandlers: (event: string) => withHandlers && event === "session_shutdown",
				emit: async (event: unknown) => {
					seen.push(event);
					return undefined;
				},
			},
			dispose: () => {
				disposed = true;
			},
		},
	};
}

describe("disposeSessionLikeTheRuntime", () => {
	it("emits session_shutdown before disposing, as teardownCurrent does", async () => {
		const f = fakeSession(true);
		await disposeSessionLikeTheRuntime(f.session);
		expect(f.seen).toEqual([{ type: "session_shutdown", reason: "dispose" }]);
		expect(f.disposed()).toBe(true);
	});

	it("skips the event when no extension handles it, and still disposes", async () => {
		const f = fakeSession(false);
		await disposeSessionLikeTheRuntime(f.session);
		expect(f.seen).toEqual([]);
		expect(f.disposed()).toBe(true);
	});

	it("carries the reason the caller gives", async () => {
		const f = fakeSession(true);
		await disposeSessionLikeTheRuntime(f.session, "reload");
		expect(f.seen).toEqual([{ type: "session_shutdown", reason: "reload" }]);
	});
});
