/**
 * A model HTTP error mails a peer, throttled.
 *
 * A failed model request is an assistant message with `stopReason: "error"`
 * whose `errorMessage` leads with the HTTP status (`429: {"error":…}`). The
 * seat cannot report that itself: a dead request produces no turn, so nothing
 * in the transcript is the model's to write. This module runs on `message_end`
 * and writes a peer-link envelope directly — `sendEnvelope`, not a tool call,
 * not `sendUserMessage`. Delivery is unchanged: a pi peer picks it up on its
 * next inbox scan, a Claude Code peer on its user's next prompt (decision 003).
 *
 * Design: docs/design/model-error-mail.md. Rulings and the choices the order
 * settled: decisions/external-tools/008-model-error-mail.md.
 *
 * Cost: no timer and no polling. `onAssistantMessage` is one stop-reason test
 * per assistant message, plus one string test and, at most once per window,
 * one envelope write. The mailbox is only read when a mail is about to go out.
 */

import {
	newEnvelope,
	readLastCorrespondent,
	sendEnvelope,
	writeLastCorrespondent,
	type PeerInfo,
} from "./mailbox.ts";

/**
 * The leading HTTP status of a provider error message, or undefined.
 *
 * Exactly this and nothing else: `terminated`, `Operation aborted`,
 * `Request timed out.`, `Connection error.`, `Stream ended without
 * finish_reason`, `This operation was aborted` and `Provider returned error`
 * are not HTTP responses with a status, so the owner's "4XX/5XX" (decision
 * 008) does not cover them and they mail nothing.
 */
const HTTP_ERROR_PREFIX = /^\s*([45]\d{2})\b/;

/** One mail per session per window. */
export const MAIL_THROTTLE_MS = 30 * 60_000;

/** Provider error text carried in the mail, in characters. */
export const MAIL_ERROR_CHARS = 200;

/** The HTTP status an assistant error message reports, if it reports one. */
export function modelHttpStatus(errorMessage: string | undefined): number | undefined {
	const match = HTTP_ERROR_PREFIX.exec(errorMessage ?? "");
	return match ? Number(match[1]) : undefined;
}

export interface ModelErrorMailDeps {
	/** Mailbox root and this session's peer identity. */
	mailbox: () => string;
	peerName: () => string;
	/** Identity of this session and its working directory, for the mail body. */
	sessionId: () => string;
	cwd: () => string;
	/** Peers listed in the mailbox now — the broadcast fallback. */
	peers: () => readonly PeerInfo[];
	/** Surface a problem once without throwing into the turn. */
	warn: (message: string) => void;
	/** Injectable clock (tests). */
	now?: () => number;
}

export interface ModelErrorMail {
	/** Call for every assistant `message_end`. The model fields are required:
	 *  an `AssistantMessage` always carries them, so a missing one is a caller
	 *  bug, not a state the mail has to render around. */
	onAssistantMessage(message: {
		stopReason: string;
		errorMessage?: string;
		provider: string;
		model: string;
	}): void;
	/** Record the sender of a delivered envelope (the last-correspondent rule). */
	recordCorrespondent(from: string): void;
}

export interface ModelErrorMailBody {
	peerName: string;
	sessionId: string;
	cwd: string;
	provider: string;
	model: string;
	status: number;
	errorMessage?: string;
	/** What the throttle dropped before this mail: null when it dropped nothing. */
	suppressed: { count: number; since: number } | null;
}

/** The envelope text. No credentials, no prompt text, no summary. */
export function composeModelErrorMail(body: ModelErrorMailBody): string {
	const lines = [
		`[model-error] ${body.provider}/${body.model} returned HTTP ${body.status}`,
		`session: ${body.peerName} (${body.sessionId})`,
		`cwd: ${body.cwd}`,
		`error: ${(body.errorMessage ?? "").slice(0, MAIL_ERROR_CHARS).replace(/\r?\n/g, " ")}`,
	];
	if (body.suppressed) {
		const { count, since } = body.suppressed;
		lines.push(`suppressed: ${count} more qualifying failures since ${new Date(since).toISOString()}`);
	}
	return lines.join("\n");
}

/**
 * Per-session model-error mailing.
 *
 * Throttle: the first qualifying failure mails at once. Further qualifying
 * failures inside the window only increment a counter. Once the window has
 * passed, the next qualifying failure mails and carries the count it dropped.
 * A non-error assistant message ends the stall — the window and the counter
 * clear, so a new stall after a good turn mails immediately.
 */
export function createModelErrorMail(deps: ModelErrorMailDeps): ModelErrorMail {
	const clock = deps.now ?? Date.now;
	let windowStart: number | undefined;
	let suppressed = 0;
	/** Newest envelope sender this process delivered; the persisted copy covers a restart. */
	let correspondent: string | undefined;
	const warned = new Set<string>();

	function warnOnce(message: string): void {
		if (warned.has(message)) return;
		warned.add(message);
		deps.warn(message);
	}

	/**
	 * The recorded correspondent, else the peers online now.
	 *
	 * Self is excluded on both paths: a session that mailed itself would
	 * otherwise become its own correspondent, and the mail would come back as an
	 * injected user message — the one thing the mail path must never cause.
	 */
	function recipients(): string[] {
		const self = deps.peerName();
		const recorded = correspondent ?? readLastCorrespondent(deps.mailbox(), self);
		if (recorded && recorded !== self) {
			correspondent = recorded;
			return [recorded];
		}
		return deps.peers()
			.filter((peer) => peer.online && peer.name !== self)
			.map((peer) => peer.name);
	}

	/** Write the envelope to every recipient. False when nothing was sent. */
	function mail(status: number, message: Parameters<ModelErrorMail["onAssistantMessage"]>[0]): boolean {
		const to = recipients();
		if (to.length === 0) {
			warnOnce(
				"model-error-mail: no recipient for a model HTTP error — no peer has ever mailed " +
					"this session and no peer is online",
			);
			return false;
		}
		const text = composeModelErrorMail({
			peerName: deps.peerName(),
			sessionId: deps.sessionId(),
			cwd: deps.cwd(),
			provider: message.provider,
			model: message.model,
			status,
			errorMessage: message.errorMessage,
			// `windowStart` is set iff a window is open, and only a dropped
			// window leaves a count, so the two travel together.
			suppressed:
				suppressed > 0 && windowStart !== undefined ? { count: suppressed, since: windowStart } : null,
		});
		const from = deps.peerName();
		try {
			for (const peer of to) {
				sendEnvelope(deps.mailbox(), newEnvelope(from, peer, text));
			}
			return true;
		} catch (err) {
			warnOnce(
				`model-error-mail: could not write the envelope: ${err instanceof Error ? err.message : String(err)}`,
			);
			return false;
		}
	}

	return {
		onAssistantMessage(message) {
			try {
				if (message.stopReason !== "error") {
					// A good turn ends the stall: the next failure mails immediately.
					windowStart = undefined;
					suppressed = 0;
					return;
				}
				const status = modelHttpStatus(message.errorMessage);
				if (status === undefined) return;
				const now = clock();
				if (windowStart !== undefined && now - windowStart < MAIL_THROTTLE_MS) {
					suppressed += 1;
					return;
				}
				// The window opens only for a mail that went out: an unsendable
				// recipient warns once, and the next failure after a recipient
				// appears still mails.
				if (!mail(status, message)) return;
				windowStart = now;
				suppressed = 0;
			} catch (err) {
				warnOnce(
					`model-error-mail: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},

		recordCorrespondent(from) {
			correspondent = from;
			try {
				writeLastCorrespondent(deps.mailbox(), deps.peerName(), from);
			} catch (err) {
				warnOnce(
					`model-error-mail: could not record the last correspondent: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
		},
	};
}
