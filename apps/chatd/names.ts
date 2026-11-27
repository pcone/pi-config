/**
 * Peer names and the Matrix localparts of their puppets (docs/design/chat.md
 * § Names).
 *
 * A peer name is 1–64 characters of `[A-Za-z0-9._-]` starting with a letter or
 * digit, the rule peer-link's mailbox enforced. `localpart(name)` is `pi-`
 * plus the name with `A–Z` written `_` + lowercase and `_` written `__`, so the
 * map is injective under Matrix's lowercase-only localparts.
 */

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ALPHABET_RE = /^[A-Za-z0-9._-]*$/;

/** The one localpart in the namespace that is no peer's. */
export const SYSTEM_LOCALPART = "pi-system";
export const SYSTEM_NAME = "system";

/** A valid peer name, trimmed; throws naming the rule. */
export function validatePeerName(name: string): string {
	const trimmed = name.trim();
	if (!NAME_RE.test(trimmed)) {
		throw new Error(`Invalid peer name ${JSON.stringify(trimmed)}: use 1-64 chars of [A-Za-z0-9._-]`);
	}
	return trimmed;
}

export function isValidPeerName(name: string): boolean {
	return NAME_RE.test(name);
}

/** `pi-` plus the encoded name. Defined on the whole alphabet; validity is checked at the boundary. */
export function localpart(name: string): string {
	if (!ALPHABET_RE.test(name)) throw new Error(`localpart: ${JSON.stringify(name)} is outside [A-Za-z0-9._-]`);
	let out = "pi-";
	for (const ch of name) {
		if (ch >= "A" && ch <= "Z") out += `_${ch.toLowerCase()}`;
		else if (ch === "_") out += "__";
		else out += ch;
	}
	return out;
}

/** The peer name a puppet localpart encodes, or undefined for a localpart outside the scheme. */
export function peerName(local: string): string | undefined {
	if (!local.startsWith("pi-")) return undefined;
	let out = "";
	const s = local.slice(3);
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (ch === "_") {
			const next = s[i + 1];
			if (next === "_") out += "_";
			else if (next !== undefined && next >= "a" && next <= "z") out += next.toUpperCase();
			else return undefined;
			i++;
		} else if (/[a-z0-9.-]/.test(ch)) out += ch;
		else return undefined;
	}
	return out;
}

export function userId(local: string, serverName: string): string {
	return `@${local}:${serverName}`;
}

/** The localpart of a user id on `serverName`, or undefined for another server's user. */
export function localOf(id: string, serverName: string): string | undefined {
	const suffix = `:${serverName}`;
	if (!id.startsWith("@") || !id.endsWith(suffix)) return undefined;
	return id.slice(1, -suffix.length);
}
