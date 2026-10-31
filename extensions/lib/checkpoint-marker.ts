/**
 * The marker `checkpoint.ts` prefixes to a checkpoint compaction's
 * `customInstructions`, and the one signal that decides summary ownership
 * (owner 2026-10-31, `decisions/checkpoint/003`).
 *
 * `checkpoint.ts:32` still declares its own copy: that file belongs to
 * WO-2026-062. Two copies in `extensions/` until it adopts this one.
 */
export const CHECKPOINT_MARKER = "[CHECKPOINT]";
