/**
 * Pinned sessions — a curated, named shortlist of sessions you want to keep
 * track of and relaunch easily, out of the noise of one-off sessions.
 *
 * Pi's /resume already lists *every* session across every project; this adds a
 * hand-picked subset with stable names. The registry is global and each entry
 * remembers its project, so you can resume a pinned session from any pi
 * instance after a reboot — switchSession switches cwd to the session's own.
 *
 *   /pin [name]   pin the current session. Name falls back to the session's
 *                 display name, then to the first user-message excerpt; when
 *                 a name is given it also becomes the session display name
 *                 (so /resume shows it too). Re-pinning renames + refreshes.
 *   /unpin [q]    unpin the current session (no arg), or the pinned session
 *                 whose name/path matches the query. Tab-completes names.
 *   /pinned       pick a pinned session and resume it. Skips entries whose
 *                 file no longer exists; marks the current session with ●.
 *
 * Registry: ~/.pi/pinned-sessions.json, keyed by absolute session-file path.
 * The pin name is authoritative for the pin label; /name alone does not
 * retitle a pin — re-run /pin <new name> to rename a pinned session.
 */

import {
	existsSync,
	readFileSync,
	writeFileSync,
	mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface PinnedEntry {
	/** Display name shown in the /pinned picker. Authoritative for the pin. */
	name: string;
	/** Working directory the session belongs to (remembered so pins survive reboots and cross-project resume). */
	cwd: string;
	/** ms epoch when pinned (or last re-pinned). */
	pinnedAt: number;
	/** Session UUID, for disambiguation when two pins share a name. */
	sessionId: string;
}

/** Registry: absolute session-file path -> pin metadata. */
export type PinnedRegistry = Record<string, PinnedEntry>;

export const REGISTRY_FILE = join(homedir(), ".pi", "pinned-sessions.json");

const MAX_NAME_LEN = 60;

/** Contract $HOME to ~ for readable labels. Pure. */
export function contractHome(p: string, home: string = homedir()): string {
	if (!p) return p;
	if (p === home) return "~";
	if (p.startsWith(home + "/")) return "~" + p.slice(home.length);
	return p;
}

/** Collapse whitespace + truncate to a single presentable line. Pure. */
export function deriveName(raw: string): string {
	const name = raw.replace(/\s+/g, " ").trim();
	if (name.length <= MAX_NAME_LEN) return name;
	return name.slice(0, MAX_NAME_LEN - 1).trimEnd() + "…";
}

/** Structural entry shape — keeps the helper free of a package import for unit tests. */
interface EntryLike {
	type: string;
	message?: { role?: string; content?: unknown };
}

/** Extract the first user message's text from session entries, if any. Pure. */
export function firstUserText(entries: EntryLike[]): string | undefined {
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (!msg || msg.role !== "user") continue;
		const content = msg.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			const text = content
				.filter(
					(b): b is { type: "text"; text: string } =>
						!!b && typeof b === "object" && (b as { type?: string }).type === "text",
				)
				.map((b) => b.text)
				.join(" ")
				.trim();
			if (text) return text;
		}
	}
	return undefined;
}

/** Read + parse the registry; missing/corrupt file yields {}. */
export function readRegistry(file: string = REGISTRY_FILE): PinnedRegistry {
	try {
		if (!existsSync(file)) return {};
		const data = JSON.parse(readFileSync(file, "utf-8"));
		if (!data || typeof data !== "object" || Array.isArray(data)) return {};
		return data as PinnedRegistry;
	} catch {
		return {};
	}
}

/** Write the registry pretty-printed, creating the parent dir. */
export function writeRegistry(reg: PinnedRegistry, file: string = REGISTRY_FILE): void {
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify(reg, null, 2) + "\n");
	} catch {
		/* best-effort; pin state is non-critical */
	}
}

export interface PickerItem {
	path: string;
	/** Unique, human-readable line for ctx.ui.select(). */
	label: string;
	name: string;
}

/** Short disambiguator suffix from a session id (or path tail). */
function shortId(sessionId: string, path: string): string {
	const idTail = sessionId.replace(/-/g, "").slice(-6);
	return idTail || path.slice(-6);
}

/**
 * Build sorted, unique picker items from the registry, skipping entries whose
 * session file no longer exists and marking the current session with ●.
 *
 * `exists` is injected so tests need no real files. Items sort by name
 * (case-insensitive); ties break by path for determinism.
 */
export function buildPickerEntries(
	reg: PinnedRegistry,
	opts: {
		currentPath?: string;
		exists?: (p: string) => boolean;
		home?: string;
	} = {},
): PickerItem[] {
	const exists = opts.exists ?? existsSync;
	const currentPath = opts.currentPath;
	const home = opts.home ?? homedir();

	// Pass 1: live entries + base labels.
	const items: PickerItem[] = [];
	for (const [path, entry] of Object.entries(reg)) {
		if (!exists(path)) continue;
		const cwd = contractHome(entry.cwd, home);
		const base = cwd ? `${entry.name}  ·  ${cwd}` : entry.name;
		items.push({ path, name: entry.name, label: base });
	}

	// Pass 2: ensure label uniqueness; append short id on collision.
	const seen = new Map<string, number>();
	for (const item of items) seen.set(item.label, (seen.get(item.label) ?? 0) + 1);
	for (const item of items) {
		if ((seen.get(item.label) ?? 0) > 1) {
			item.label = `${item.label}  ·  #${shortId(reg[item.path]?.sessionId ?? "", item.path)}`;
		}
	}

	// Pass 3: sort by name, then path.
	items.sort(
		(a, b) =>
			a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
			a.path.localeCompare(b.path),
	);

	// Pass 4: mark current session. Applied after sort so order stays stable.
	if (currentPath) {
		for (const item of items) {
			if (item.path === currentPath) item.label = `● ${item.label}`;
		}
	}

	return items;
}

/** Case-insensitive name/path matchers for /unpin. Exact hits rank before partial. Pure. */
export function matchPin(
	reg: PinnedRegistry,
	query: string,
): { path: string; entry: PinnedEntry }[] {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	const exact: { path: string; entry: PinnedEntry }[] = [];
	const partial: { path: string; entry: PinnedEntry }[] = [];
	for (const [path, entry] of Object.entries(reg)) {
		const name = entry.name.toLowerCase();
		const endsWithPath = path.toLowerCase().endsWith("/" + query.trim().toLowerCase());
		if (name === q || endsWithPath) exact.push({ path, entry });
		else if (name.includes(q) || path.toLowerCase().includes(q)) partial.push({ path, entry });
	}
	return [...exact, ...partial];
}

interface PinCtx {
	sessionManager: {
		getSessionFile(): string | undefined;
		getCwd(): string;
		getSessionId(): string;
		getEntries(): EntryLike[];
	};
	ui: { notify(m: string, t?: "info" | "warning" | "error"): void };
}

export default function pinnedSessionsExt(pi: ExtensionAPI): void {
	const pinCurrent = (args: string, ctx: PinCtx): boolean => {
		const file = ctx.sessionManager.getSessionFile();
		if (!file) {
			ctx.ui.notify("This session isn't saved yet — send a message first, then /pin.", "warning");
			return false;
		}
		const given = args.trim();
		let name = given;
		if (!name) {
			name =
				pi.getSessionName() ??
				deriveName(firstUserText(ctx.sessionManager.getEntries()) ?? "");
		}
		if (!name) {
			ctx.ui.notify("No name to pin under — name it: /pin <name>", "warning");
			return false;
		}
		name = deriveName(name);
		const reg = readRegistry();
		reg[file] = {
			name,
			cwd: ctx.sessionManager.getCwd(),
			pinnedAt: Date.now(),
			sessionId: ctx.sessionManager.getSessionId(),
		};
		writeRegistry(reg);
		if (given) pi.setSessionName(name); // mirror into the session so /resume shows it too
		ctx.ui.notify(`Pinned as "${name}"`, "info");
		return true;
	};

	pi.on("session_start", async () => {
		pi.events.emit("pi-config:startup-summary-item", {
			key: "pinned",
			order: 40,
			text: "[Pinned] /pin <name> keeps a session; /pinned resumes one; /unpin removes.",
		});
	});

	pi.registerCommand("pin", {
		description: "Pin the current session (with optional name) so it survives in /pinned.",
		handler: async (args, ctx) => {
			pinCurrent(args, ctx);
		},
	});

	pi.registerCommand("unpin", {
		description: "Unpin the current session, or the pinned session matching <query> (name/path).",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const reg = readRegistry();
			const items = Object.values(reg)
				.map((e) => ({ value: e.name, label: e.name }))
				.filter((i) => i.value.toLowerCase().startsWith(prefix.toLowerCase()));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const query = args.trim();
			const reg = readRegistry();
			if (query === "") {
				const file = ctx.sessionManager.getSessionFile();
				const entry = file ? reg[file] : undefined;
				if (file && entry) {
					delete reg[file];
					writeRegistry(reg);
					ctx.ui.notify(`Unpinned "${entry.name}"`, "info");
				} else {
					ctx.ui.notify("Current session isn't pinned.", "info");
				}
				return;
			}
			const matches = matchPin(reg, query);
			if (matches.length === 0) {
				ctx.ui.notify(`No pinned session matches "${query}".`, "info");
				return;
			}
			if (matches.length > 1) {
				const names = matches.map((m) => m.entry.name).slice(0, 8).join(", ");
				ctx.ui.notify(`Ambiguous — matches: ${names}`, "warning");
				return;
			}
			const [{ path, entry }] = matches;
			delete reg[path];
			writeRegistry(reg);
			ctx.ui.notify(`Unpinned "${entry.name}"`, "info");
		},
	});

	pi.registerCommand("pinned", {
		description: "Pick a pinned session and resume it.",
		handler: async (_args, ctx) => {
			const reg = readRegistry();
			const currentPath = ctx.sessionManager.getSessionFile() ?? undefined;
			const items = buildPickerEntries(reg, { currentPath });
			if (items.length === 0) {
				ctx.ui.notify(
					Object.keys(reg).length > 0
						? "No resumable pinned sessions (their files are gone)."
						: "No pinned sessions yet — use /pin <name>.",
					"info",
				);
				return;
			}
			const choice = await ctx.ui.select(
				`Resume a pinned session (${items.length})`,
				items.map((i) => i.label),
			);
			const picked = items.find((i) => i.label === choice);
			if (!picked) return; // cancelled
			const result = await ctx.switchSession(picked.path, {
				withSession: async (c) => {
					c.ui.notify(`Resumed "${picked.name}"`, "info");
				},
			});
			if (result?.cancelled) {
				ctx.ui.notify("Resume cancelled.", "info");
			}
		},
	});
}
