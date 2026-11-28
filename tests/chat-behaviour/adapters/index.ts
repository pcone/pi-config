import { TUWUNEL_PLATFORM_OK } from "../../helpers/tuwunel.ts";
import type { Adapter } from "../bus.ts";
import { chatdAdapter } from "./chatd.ts";

/** Every transport the behaviour rows run against; none where the pinned Tuwunel cannot run. */
export const ADAPTERS: readonly Adapter[] = TUWUNEL_PLATFORM_OK ? [chatdAdapter] : [];
