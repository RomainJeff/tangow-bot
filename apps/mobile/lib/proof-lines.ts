import { motion } from "@tangow/ui-tokens";

export const PROOF_LINE_GAP = 8;

/** A live line waits half an arrival after its bubble, the same beat as on web. */
export const PROOF_LINE_DELAY_MS = motion.arrive / 2;

export const PROOF_ICON_POP_FROM = 0.95;

/**
 * A line alone reaches 44 pt with 14 pt above and below its text. Stacked lines share the gap
 * between them, so each reaches half of it and no tap lands on the neighbour.
 */
export function proofLineHitSlop(count: number): number {
  return count > 1 ? PROOF_LINE_GAP / 2 : 14;
}
