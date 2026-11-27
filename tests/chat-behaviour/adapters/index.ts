import type { Adapter } from "../bus.ts";
import { peerLinkAdapter } from "./peer-link.ts";

/** Every transport the behaviour rows run against. */
export const ADAPTERS: readonly Adapter[] = [peerLinkAdapter];

/** Rows a design ruling changed run only where the ruling is built (WO-2026-107 § Preparatory refactor). */
export function adapterNamed(name: string): Adapter | undefined {
	return ADAPTERS.find((a) => a.name === name);
}
