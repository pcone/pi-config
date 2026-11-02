/**
 * Where a session's pending waits are decided and rendered.
 *
 * A checkpoint continues only when no wait is pending (decision
 * checkpoint/003). The rule lives here, in one function, because it decides
 * whether work starts: it must not be written once per tool. The kickoff
 * prompt is assembled here for the same reason — `checkpoint` and
 * `checkpoint_fork` both send one, and a second assembly site is a second
 * place for the wait to be dropped.
 *
 * Design: docs/design/checkpoint-waits.md.
 */

/** What a session is holding for. */
export type WaitKind = "owner" | "peer" | "restart" | "subagent" | "other";

/**
 * A pending wait. `manual` waits are persisted and cleared only through
 * `wait_for({ clear: true })`; `derived` ones are computed from their source
 * and clear when it ends.
 */
export interface Wait {
	/** Stable within a session: manual waits carry a uuid, derived ones `<source>:<key>`. */
	id: string;
	kind: WaitKind;
	/** One line the model reads at kickoff: who or what the session holds for. */
	reason: string;
	/** Epoch ms the wait started, or the best evidence its source has. */
	since: number;
	source: "manual" | "derived";
}

/** The outcome of the continuation rule, for the tool result. */
export interface Continuation {
	doContinue: boolean;
}

/**
 * The continuation rule, in one place. An explicit `continue` wins; unset
 * continues (waits are not yet consulted here — the wait arm lands with the
 * wait state itself).
 */
export function resolveContinuation(requested: boolean | undefined): Continuation {
	return { doContinue: requested !== false };
}

/** The pieces of a kickoff prompt, in the order the next window reads them. */
export interface KickoffParts {
	/** Context carried forward ahead of the prompt (a file snapshot, a fork's injection). */
	context?: string;
	/** The prompt itself: `nextSteps`, or the default. */
	next: string;
	/** Trailing lines, e.g. the archive path. */
	trailing?: readonly string[];
}

/** Assemble the kickoff prompt: the one assembly site both callers use. */
export function composeKickoff(parts: KickoffParts): string {
	return [parts.context, parts.next, ...(parts.trailing ?? [])]
		.filter((part): part is string => typeof part === "string" && part.length > 0)
		.join("\n\n");
}

/**
 * Send the kickoff prompt. The caller owns delivery (`deliverAs` for a
 * compaction follow-up, the new session's own sender for a fork); this owns
 * composition, so the two paths cannot drift apart.
 */
export async function sendKickoff(input: {
	parts: KickoffParts;
	send: (text: string) => void | Promise<void>;
}): Promise<string> {
	const text = composeKickoff(input.parts);
	await input.send(text);
	return text;
}
