import type { ThreadBlock } from "@ai4s/shared";
import { contextUsed } from "@ai4s/shared";

/** Below this much context, `/compact` is refused: summarizing a conversation
 *  that still fits comfortably only throws detail away. */
export const COMPACT_MIN_TOKENS = 100_000;

export type CompactRefusal =
  /** Nothing to compact: a draft, or a session with no turn yet. */
  | { kind: "empty" }
  /** Compacted, and no new turn since — a second summary would only
   *  summarize the summary. */
  | { kind: "justCompacted" }
  /** The context is still small. */
  | { kind: "small"; used: number; threshold: number };

/**
 * Whether `/compact` should run on this thread, and why not when it should not.
 *
 * The context in use is the last reply's reported usage after the latest
 * compaction — and only after a NEW user turn: the summary message itself
 * reports the old, full context it read. A model with a small window gets half
 * of it as the bar, so compacting stays possible before the window is full.
 * Unknown usage (an agent that reports none) is not a reason to refuse.
 */
export function compactRefusal(
  blocks: readonly ThreadBlock[] | undefined,
  contextLimit = 0,
): CompactRefusal | null {
  if (!blocks?.some((b) => b.kind === "user")) return { kind: "empty" };
  let compacted = -1;
  blocks.forEach((b, i) => {
    if (b.kind === "compaction") compacted = i;
  });
  const since =
    compacted < 0 ? 0 : blocks.findIndex((b, i) => i > compacted && b.kind === "user");
  if (since < 0) return { kind: "justCompacted" };
  let used: number | null = null;
  for (let i = blocks.length - 1; i >= since && used === null; i--) {
    const b = blocks[i];
    if (b.kind === "agent" && b.usage) used = contextUsed(b.usage);
  }
  if (used === null) return null;
  const threshold =
    contextLimit > 0 ? Math.min(COMPACT_MIN_TOKENS, Math.floor(contextLimit / 2)) : COMPACT_MIN_TOKENS;
  return used < threshold ? { kind: "small", used, threshold } : null;
}
