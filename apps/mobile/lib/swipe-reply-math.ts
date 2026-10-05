/**
 * 7g's gesture math, pulled out of the pan handler so it is plain,
 * synchronous and unit-testable — the handler itself only calls these.
 */

/** Past this raw drag distance, the bubble stops following the finger 1:1. */
export const SWIPE_RESISTANCE_START_PX = 40;
/** Fraction of extra drag applied beyond the resistance start. */
export const SWIPE_RESISTANCE_FACTOR = 0.6;
/** Visual offset at which the reply icon pops and a release sets the target. */
export const SWIPE_REPLY_THRESHOLD_PX = 56;

/**
 * Maps a raw rightward drag distance (px) to the bubble's visual offset: 1:1
 * up to `SWIPE_RESISTANCE_START_PX`, then scaled by `SWIPE_RESISTANCE_FACTOR`
 * beyond it. A leftward drag (negative) never moves the bubble.
 */
export function resistedSwipeOffset(rawDx: number): number {
  "worklet";
  if (rawDx <= 0) return 0;
  if (rawDx <= SWIPE_RESISTANCE_START_PX) return rawDx;
  return SWIPE_RESISTANCE_START_PX + (rawDx - SWIPE_RESISTANCE_START_PX) * SWIPE_RESISTANCE_FACTOR;
}

/** Whether a (resisted) visual offset has reached the reply threshold. */
export function hasCrossedSwipeReplyThreshold(offset: number): boolean {
  "worklet";
  return offset >= SWIPE_REPLY_THRESHOLD_PX;
}

/**
 * Whether an update from one raw drag distance to the next just crossed the
 * threshold — the pan handler fires the icon pop + haptic once per crossing,
 * not on every frame past it.
 */
export function crossedSwipeReplyThreshold(previousRawDx: number, nextRawDx: number): boolean {
  "worklet";
  return (
    !hasCrossedSwipeReplyThreshold(resistedSwipeOffset(previousRawDx)) &&
    hasCrossedSwipeReplyThreshold(resistedSwipeOffset(nextRawDx))
  );
}
