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
	onlineExcept,
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
	/** Peers listed in the mailbox now: the recipient rule's liveness source and
	 *  its fallback. */
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
	/** The provider's error text. Required: only a message that matched the
	 *  classifier composes a body, and matching means this text exists. */
	errorMessage: string;
	/** What the throttle dropped before this mail: null when it dropped nothing. */
	suppressed: { count: number; since: number } | null;
}

/** The envelope text. No credentials, no prompt text, no summary. */
export function composeModelErrorMail(body: ModelErrorMailBody): string {
	const lines = [
		`[model-error] ${body.provider}/${body.model} returned HTTP ${body.status}`,
		`session: ${body.peerName} (${body.sessionId})`,
		`cwd: ${body.cwd}`,
		`error: ${body.errorMessage.slice(0, MAIL_ERROR_CHARS).replace(/\r?\n/g, " ")}`,
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
	/**
	 * The open throttle window: when it started and how many qualifying
	 * failures it has dropped. One value, so "a count with no window" cannot be
	 * represented — the counter only exists inside a window.
	 */
	let throttle: { start: number; suppressed: number } | undefined;
	/** Newest envelope sender this process delivered; the persisted copy covers a restart. */
	let correspondent: string | undefined;
	const warned = new Set<string>();

	function warnOnce(message: string): void {
		if (warned.has(message)) return;
		warned.add(message);
		deps.warn(message);
	}

	/**
	 * The recorded correspondent when it is reachable, else every peer online
	 * now.
	 *
	 * A dead pi correspondent is not a recipient: a mail to a peer whose
	 * heartbeat has aged out (a subagent that has exited) queues in an inbox
	 * nobody reads — the silence this mail exists to break (decision
	 * external-tools/008). A registered external peer is reachable while named
	 * even though it is never online: its inbox is read on its user's next
	 * prompt, so naming it delivers where sweeping for it would not (decision
	 * external-tools/003). The sweep stays online-only.
	 *
	 * Self is never a recipient: a session that mailed itself would otherwise
	 * become its own correspondent, and the mail would come back as an injected
	 * user message — the one thing the mail path must never cause.
	 */
	function recipients(): string[] {
		const self = deps.peerName();
		const recorded = correspondent ?? readLastCorrespondent(deps.mailbox(), self);
		const peers = deps.peers();
		const online = onlineExcept(peers, self);
		if (recorded) {
			correspondent = recorded;
			// One reachability predicate, so a later third kind has one home. The
			// self term is explicit here because this arm reads `peers`, not
			// `onlineExcept`'s output.
			const reachable =
				recorded !== self &&
				peers.some(
					(peer) => peer.name === recorded && (peer.online || peer.external === true),
				);
			if (reachable) return [recorded];
		}
		return online.map((peer) => peer.name);
	}

	/** Write the envelope to every recipient. False when nothing was sent. */
	function mail(status: number, errorMessage: string, message: { provider: string; model: string }): boolean {
		const to = recipients();
		if (to.length === 0) {
			warnOnce(
				"model-error-mail: no recipient for a model HTTP error — no peer is online now",
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
			errorMessage,
			suppressed:
				throttle && throttle.suppressed > 0
					? { count: throttle.suppressed, since: throttle.start }
					: null,
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
					throttle = undefined;
					return;
				}
				const status = modelHttpStatus(message.errorMessage);
				if (status === undefined || message.errorMessage === undefined) return;
				const now = clock();
				if (throttle && now - throttle.start < MAIL_THROTTLE_MS) {
					throttle.suppressed += 1;
					return;
				}
				// The window opens only for a mail that went out: an unsendable
				// recipient warns once, and the next failure after a recipient
				// appears still mails.
				if (!mail(status, message.errorMessage, message)) return;
				throttle = { start: now, suppressed: 0 };
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
