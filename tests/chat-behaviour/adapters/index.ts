import { it } from "bun:test";
import type { Adapter } from "../bus.ts";
import { chatdAdapter } from "./chatd.ts";
import { peerLinkAdapter } from "./peer-link.ts";

/** Every transport the behaviour rows run against. */
export const ADAPTERS: readonly Adapter[] = [peerLinkAdapter, chatdAdapter];

/**
 * A row as peer-link has it, which a WO-2026-107 design ruling changes: it
 * runs on peer-link only, until its rewrite under that rule lands.
 */
export function asToday(adapter: Adapter): typeof it | typeof it.skip {
	return adapter.name === "peer-link" ? it : it.skip;
}

/** A row as a WO-2026-107 design ruling has it: it runs where the ruling is built. */
export function asRuled(adapter: Adapter): typeof it | typeof it.skip {
	return adapter.name === "chatd" ? it : it.skip;
}
