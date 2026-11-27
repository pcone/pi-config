/**
 * Tear down a bare `AgentSession` the way pi's CLI runtime does.
 *
 * `AgentSession.dispose()` aborts, invalidates the extension runner, disconnects and
 * clears its listeners — and emits no event. `session_shutdown` comes from the
 * runtime wrapper instead (`agent-session-runtime.js` `teardownCurrent`/`dispose`:
 * `await emitSessionShutdownEvent(extensionRunner, {type: "session_shutdown", …})`
 * before `session.dispose()`, i.e. `if (runner.hasHandlers(...)) await runner.emit(...)`).
 *
 * A test that builds an `AgentSession` directly therefore leaves every extension that
 * owns a timer running for the rest of the bun process. peer-link's 2 s scan and 5 s
 * heartbeat kept publishing into a mailbox its row had already deleted, and the next
 * row in the file took the ENOENT (pi-config#25). The helper exists so the three e2e
 * harnesses do not each grow their own copy of that two-line teardown.
 *
 * Not a stand-in for the SDK question (issue #25 asks whether `dispose()` should emit
 * it): this makes the harness behave like production while that is undecided.
 */

interface BareSession {
	extensionRunner?: { hasHandlers(event: string): boolean; emit(event: unknown): Promise<unknown> };
	dispose(): void;
}

export async function disposeSessionLikeTheRuntime(
	session: BareSession,
	reason = "dispose",
): Promise<void> {
	const runner = session.extensionRunner;
	if (runner?.hasHandlers("session_shutdown")) {
		await runner.emit({ type: "session_shutdown", reason });
	}
	session.dispose();
}
