/**
 * The marker `checkpoint.ts` prefixes to a checkpoint compaction's
 * `customInstructions`, and the one signal that decides summary ownership
 * (owner 2026-10-31, `decisions/checkpoint/005`).
 *
 * `checkpoint.ts` imports this constant and declares no copy of its own.
 */
export const CHECKPOINT_MARKER = "[CHECKPOINT]";
