import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface PendingGoAction {
	/** Short label describing what /go will do (shown on prep + in /go feedback). */
	label: string;
	/** Run with a real command context. switchSession/newSession must be the LAST awaited call;
	 *  put post-replacement work in their withSession callback. */
	run: (ctx: ExtensionCommandContext) => Promise<void>;
}

const KEY = "__pi_go_registry_v1__";
const store = ((globalThis as Record<string, unknown>)[KEY] ??= { pending: null }) as {
	pending: PendingGoAction | null;
};

/** Stash the action /go will run next. Latest registration replaces any prior one. */
export function setPendingGo(action: PendingGoAction): void {
	store.pending = action;
}
export function peekPendingGo(): PendingGoAction | null {
	return store.pending;
}
export function takePendingGo(): PendingGoAction | null {
	const a = store.pending;
	store.pending = null;
	return a;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("go", {
		description:
			"Commit the most recently prepared deferred action (e.g. a prepared session fork). " +
			"Actions that need a user-initiated command context stage themselves; /go runs the latest.",
		handler: async (_args, ctx) => {
			const action = takePendingGo();
			if (!action) {
				ctx.ui.notify("Nothing to go — no action is pending.", "info");
				return;
			}
			try {
				await action.run(ctx);
			} catch (err) {
				ctx.ui.notify(
					`/go (${action.label}) failed: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		},
	});
}
