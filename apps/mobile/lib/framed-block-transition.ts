/**
 * 7e's "open at mount vs. answered while mounted" split: a card already
 * answered when the thread opens shows its check with no animation or
 * haptic; a card that flips to answered while it is on screen collapses,
 * cross-fades, draws the check and confirms with a haptic. `FramedBlock`
 * tracks the previous phase in a ref and asks this pure function whether the
 * render it is about to draw counts as that transition.
 */

export type FramedBlockPhase = "open" | "answered";

/**
 * `previous` is `null` only before a card has rendered at all; a card's very
 * first render is never a transition, whichever phase it starts in — the
 * caller seeds its ref with the phase from that first render.
 */
export function framedBlockDidTransitionToAnswered(
  previous: FramedBlockPhase | null,
  next: FramedBlockPhase,
): boolean {
  return previous === "open" && next === "answered";
}
