/**
 * Where a session's pending waits live, and what they decide.
 *
 * A wait is state, not prose: a seat holding for the owner's ruling, a restart,
 * a peer's reply or a subagent it must gate records it here, and a checkpoint
 * continues only when nothing is pending (decision checkpoint/003). The
 * incident this replaces: a seat replied RESTARTABLE, checkpointed with
 * `continue: true`, and its 4 kB `nextSteps` never mentioned the restart, so the
 * follow-up started new work a minute after compaction. Nothing here reads
 * prompt text.
 *
 * Two kinds. Manual waits are persisted as a full snapshot on the session
 * branch, so they survive compaction and a restart; only
 * `wait_for({ clear: true })` drops one, because a waiting seat still answers
 * mail and goes back to waiting. Derived waits are computed by the feature that
 * owns the state (a running child, an unanswered `expectReply`) and clear when
 * that source ends.
 *
 * The continuation rule and the kickoff prompt live here for the same reason:
 * one rule, one assembly site, so an arm cannot be dropped at a second call.
 *
 * Design: docs/design/checkpoint-waits.md.
 */

import { randomUUID } from "node:crypto";

/** What a session is holding for. */
export type WaitKind = "owner" | "peer" | "restart" | "subagent" | "other";

export const WAIT_KINDS: readonly WaitKind[] = ["owner", "peer", "restart", "subagent", "other"];

/** The `customType` of the snapshot entry and of the injected kickoff message. */
export const WAIT_ENTRY_TYPE = "checkpoint-wait";

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
	/** Epoch ms the wait started; null when its source recorded no start time. */
	since: number | null;
	source: "manual" | "derived";
}

// ---------------------------------------------------------------------------
// Persistence (manual waits)
// ---------------------------------------------------------------------------

/** The snapshot entry's payload. */
interface WaitSnapshot {
	waits: Wait[];
}

/** Where the manual waits live: the session's own branch. */
export interface WaitHost {
	/** The active branch — branch-aware, so an abandoned branch's snapshot is not read. */
	branch(): readonly unknown[];
	/** Append the full manual-wait snapshot (invisible to the model). */
	persist(waits: readonly Wait[]): void;
}

function isWait(value: unknown): value is Wait {
	if (typeof value !== "object" || value === null) return false;
	const w = value as Record<string, unknown>;
	return (
		typeof w.id === "string" &&
		w.id.length > 0 &&
		typeof w.kind === "string" &&
		(WAIT_KINDS as readonly string[]).includes(w.kind) &&
		typeof w.reason === "string" &&
		(w.since === null || typeof w.since === "number") &&
		(w.source === "manual" || w.source === "derived")
	);
}

/**
 * Manual waits from the last snapshot on the branch.
 *
 * Full snapshots rather than deltas: replay takes the last one, so an
 * overwritten or lost entry costs nothing. A malformed snapshot is our own
 * write going wrong, so it throws naming the entry instead of reading as
 * "nothing is pending" — the one answer that starts work.
 */
export function manualWaits(branch: readonly unknown[]): Wait[] {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as { type?: unknown; customType?: unknown; id?: unknown; data?: unknown };
		if (entry?.type !== "custom" || entry.customType !== WAIT_ENTRY_TYPE) continue;
		const waits = (entry.data as Partial<WaitSnapshot> | undefined)?.waits;
		if (!Array.isArray(waits) || !waits.every(isWait)) {
			throw new Error(
				`Malformed ${WAIT_ENTRY_TYPE} snapshot (entry ${String(entry.id)}): expected { waits: Wait[] }`,
			);
		}
		return waits;
	}
	return [];
}

/**
 * Add a manual wait. The snapshot is the only copy: callers read the pending
 * set back through `pendingWaits`, so there is no second in-process truth.
 */
export function addManualWait(host: WaitHost, input: { reason: string; kind?: WaitKind; now?: number }): void {
	const reason = input.reason.trim();
	if (reason.length === 0) {
		throw new Error("wait_for: `reason` must say what the session is waiting for");
	}
	const wait: Wait = {
		id: randomUUID(),
		kind: input.kind ?? "other",
		reason,
		since: input.now ?? Date.now(),
		source: "manual",
	};
	host.persist([...manualWaits(host.branch()), wait]);
}

/** Drop one manual wait by id, or all of them. */
export function clearManualWaits(host: WaitHost, id?: string): void {
	const waits = manualWaits(host.branch());
	if (id === undefined) {
		if (waits.length > 0) host.persist([]);
		return;
	}
	const kept = waits.filter((wait) => wait.id !== id);
	if (kept.length === waits.length) {
		const pending = waits.map((wait) => wait.id).join(", ") || "none";
		throw new Error(`wait_for: no manual wait with id ${id} (manual waits pending: ${pending})`);
	}
	host.persist(kept);
}

// ---------------------------------------------------------------------------
// Derived waits
// ---------------------------------------------------------------------------

/** What a source may need to scope its answer. */
export interface WaitCollection {
	/** This session's id, for a source whose state is keyed by session. */
	sessionId?: string;
}

/**
 * A feature that derives waits from its own state. Registered by the feature
 * that owns the state, so nothing here imports across features.
 */
export interface WaitSource {
	/** Stable id. Re-registering under the same id replaces the source (reload, second instance). */
	id: string;
	/** The waits this source currently implies. Called on demand; must not persist anything. */
	collect(input: WaitCollection): Wait[];
}

// The registry lives on globalThis so two extension entry points that load
// this module through different specifiers (and a reload that re-evaluates
// them) still see one set of sources. Module-level state would fork it.
const REGISTRY_KEY = "__pi_wait_sources_v1__";
const globals = globalThis as Record<string, unknown>;
const sources = (globals[REGISTRY_KEY] ??= new Map<string, WaitSource>()) as Map<string, WaitSource>;

/** Register a derived-wait source. */
export function registerWaitSource(source: WaitSource): void {
	sources.set(source.id, source);
}

/** @internal test hook — forget every registered source. */
export function _testClearWaitSources(): void {
	sources.clear();
}

/** Manual waits plus every derived wait, in registration order. */
export function pendingWaits(host: WaitHost, input: WaitCollection = {}): Wait[] {
	const waits = [...manualWaits(host.branch())];
	for (const source of sources.values()) waits.push(...source.collect(input));
	return waits;
}

// ---------------------------------------------------------------------------
// Continuation
// ---------------------------------------------------------------------------

export type ContinuationOutcome = "explicit-continue" | "explicit-stop" | "no-wait" | "wait-pending";

/** What the checkpoint will do next, and which arm decided it. */
export interface Continuation {
	doContinue: boolean;
	outcome: ContinuationOutcome;
}

/**
 * The continuation rule, in one place. `continue` left unset continues only
 * when no wait is pending; an explicit `true` or `false` overrides. Prompt text
 * is never consulted — the wait is state or it does not exist.
 */
export function resolveContinuation(requested: boolean | undefined, waits: readonly Wait[]): Continuation {
	if (requested !== undefined) {
		return { doContinue: requested, outcome: requested ? "explicit-continue" : "explicit-stop" };
	}
	return waits.length > 0
		? { doContinue: false, outcome: "wait-pending" }
		: { doContinue: true, outcome: "no-wait" };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** `kind: reason`, the shape every surface uses. */
export function waitLine(wait: Wait): string {
	return `${wait.kind}: ${wait.reason}`;
}

/** The resolved outcome, as the checkpoint tool result states it. */
export function outcomeLabel(continuation: Continuation, hasWaits: boolean): string {
	switch (continuation.outcome) {
		case "explicit-continue":
			return hasWaits ? "continuing anyway (continue: true overrides the wait)" : "continuing (continue: true)";
		case "explicit-stop":
			return "not continuing (continue: false)";
		case "wait-pending":
			return "not continuing";
		case "no-wait":
			return "continuing";
	}
}

/** `1 wait pending — peer: reply from bug-triage → not continuing`. */
export function describePending(waits: readonly Wait[], continuation: Continuation): string {
	const count = waits.length;
	const head = count === 0 ? "No wait pending" : count === 1 ? "1 wait pending" : `${count} waits pending`;
	const list = count === 0 ? "" : ` — ${waits.map(waitLine).join("; ")}`;
	return `${head}${list} → ${outcomeLabel(continuation, count > 0)}`;
}

/** The `wait_for` tool result: every pending wait, with the ids that clear it. */
export function renderWaitList(waits: readonly Wait[]): string {
	if (waits.length === 0) {
		return "No waits pending. The next checkpoint continues unless you pass `continue: false`.";
	}
	const lines = [`${waits.length} wait${waits.length === 1 ? "" : "s"} pending:`];
	for (const wait of waits) {
		const since = wait.since === null ? "" : `, since ${new Date(wait.since).toISOString()}`;
		lines.push(`  - ${waitLine(wait)} (${wait.source}${since}) [id ${wait.id}]`);
	}
	lines.push(
		"Leaving `continue` unset stops the next checkpoint. " +
			`Clear a manual wait with wait_for({ clear: true${waits.some((w) => w.source === "manual") ? ', id: "<id>"' : ""} }); ` +
			"a derived wait clears when its source ends. An inbound message does not clear a wait.",
	);
	return lines.join("\n");
}

/**
 * The kickoff's wait section, which opens the prompt. A seat that restarted or
 * resumed with a wait still pending reads it before its own next steps.
 */
export function waitKickoff(waits: readonly Wait[]): string {
	if (waits.length === 0) return "";
	const [first, ...rest] = waits;
	const lines = [`WAITING ON: ${waitLine(first)}`];
	for (const wait of rest) lines.push(`ALSO WAITING ON: ${waitLine(wait)}`);
	lines.push(
		"Answer what arrives and start nothing else. " +
			"A manual wait clears only through wait_for({ clear: true }); a derived wait clears when its source ends.",
	);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Kickoff
// ---------------------------------------------------------------------------

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
export function composeKickoff(parts: KickoffParts, waits: readonly Wait[]): string {
	return [waitKickoff(waits), parts.context, parts.next, ...(parts.trailing ?? [])]
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
	waits: readonly Wait[];
	send: (text: string) => void | Promise<void>;
}): Promise<string> {
	const text = composeKickoff(input.parts, input.waits);
	await input.send(text);
	return text;
}
