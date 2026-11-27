/**
 * A model HTTP error mails a peer, throttled.
 *
 * A failed model request is an assistant message with `stopReason: "error"`
 * whose `errorMessage` leads with the HTTP status (`429: {"error":…}`). The
 * seat cannot report that itself: a dead request produces no turn. This
 * module runs on `message_end` and hands the finished mail to chatd, which
 * posts it as `@pi-system` DMs (`system_mail`): no tool call, no
 * `sendUserMessage`, no model involvement.
 *
 * Design: docs/design/model-error-mail.md. Rulings:
 * decisions/external-tools/008-model-error-mail.md, 015/15.
 */

/**
 * The leading HTTP status of a provider error message, or undefined.
 * `terminated`, `Operation aborted`, `Request timed out.` and the like are not
 * HTTP responses, so the owner's "4XX/5XX" (decision 008) does not cover them.
 */
const HTTP_ERROR_PREFIX = /^\s*([45]\d{2})\b/;

/** One mail per session per window. */
export const MAIL_THROTTLE_MS = 30 * 60_000;

/** Provider error text carried in the mail, in characters. */
export const MAIL_ERROR_CHARS = 200;

export function modelHttpStatus(errorMessage: string | undefined): number | undefined {
	const match = HTTP_ERROR_PREFIX.exec(errorMessage ?? "");
	return match ? Number(match[1]) : undefined;
}

/** A peer as chatd's `who` reports it. */
export interface MailPeer {
	name: string;
	online: boolean;
	kind: string;
}

export interface ModelErrorMailDeps {
	peerName: () => string;
	sessionId: () => string;
	cwd: () => string;
	/** The peers now: the recipient rule's liveness source and its fallback. */
	peers: () => readonly MailPeer[] | Promise<readonly MailPeer[]>;
	/** The persisted last correspondent (`dev.pi.last_correspondent`), read at connect. */
	persistedCorrespondent: () => string | undefined;
	/** Post the mail as `@pi-system` DMs. Throws when it could not. */
	send: (to: string[], text: string) => void | Promise<void>;
	/** Surface a problem once without throwing into the turn. */
	warn: (message: string) => void;
	now?: () => number;
}

export interface ModelErrorMail {
	onAssistantMessage(message: { stopReason: string; errorMessage?: string; provider: string; model: string }): Promise<void>;
	/** Record the sender of a delivered message (the last-correspondent rule). */
	recordCorrespondent(from: string): void;
}

export interface ModelErrorMailBody {
	peerName: string;
	sessionId: string;
	cwd: string;
	provider: string;
	model: string;
	status: number;
	errorMessage: string;
	suppressed: { count: number; since: number } | null;
}

/** The mail text. No credentials, no prompt text, no summary. */
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
 * Throttle: the first qualifying failure mails at once; further ones inside
 * the window only count; past the window the next one mails with the count. A
 * good assistant message ends the stall.
 */
export function createModelErrorMail(deps: ModelErrorMailDeps): ModelErrorMail {
	const clock = deps.now ?? Date.now;
	let throttle: { start: number; suppressed: number } | undefined;
	let correspondent: string | undefined;
	const warned = new Set<string>();

	function warnOnce(message: string): void {
		if (warned.has(message)) return;
		warned.add(message);
		deps.warn(message);
	}

	/**
	 * The correspondent when it is online, else every online non-subagent peer
	 * (WO-2026-107: DMs from `@pi-system` to each). The owner is always
	 * reachable. Self is never a recipient.
	 */
	async function recipients(): Promise<string[]> {
		const self = deps.peerName();
		const recorded = correspondent ?? deps.persistedCorrespondent();
		const peers = await deps.peers();
		if (recorded && recorded !== self) {
			correspondent = recorded;
			if (recorded === "owner" || peers.some((p) => p.name === recorded && p.online)) return [recorded];
		}
		return peers.filter((p) => p.online && p.name !== self && p.kind !== "subagent").map((p) => p.name);
	}

	async function mail(status: number, errorMessage: string, message: { provider: string; model: string }): Promise<boolean> {
		const to = await recipients();
		if (to.length === 0) {
			warnOnce("model-error-mail: no recipient for a model HTTP error — no peer is online now");
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
			suppressed: throttle && throttle.suppressed > 0 ? { count: throttle.suppressed, since: throttle.start } : null,
		});
		try {
			await deps.send(to, text);
			return true;
		} catch (err) {
			warnOnce(`model-error-mail: could not send the mail: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	return {
		async onAssistantMessage(message) {
			try {
				if (message.stopReason !== "error") {
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
				// The window opens only for a mail that went out.
				if (!(await mail(status, message.errorMessage, message))) return;
				throttle = { start: now, suppressed: 0 };
			} catch (err) {
				warnOnce(`model-error-mail: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
		recordCorrespondent(from) {
			correspondent = from;
		},
	};
}
