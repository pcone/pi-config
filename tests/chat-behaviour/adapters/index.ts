import type { Adapter } from "../bus.ts";
import { chatdAdapter } from "./chatd.ts";

/** Every transport the behaviour rows run against. */
export const ADAPTERS: readonly Adapter[] = [chatdAdapter];
