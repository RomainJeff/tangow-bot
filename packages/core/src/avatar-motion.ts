/**
 * Shared working-avatar choreography: while a run is active the bot glances
 * around and changes mood at random intervals.
 *
 * Web (`@rakazo/ui-web`) and mobile (`apps/mobile`) both drive the same bloub
 * engine, so the ranges live here and neither surface drifts from the other.
 */

import type { Look } from "./bloub/engine.js";
import type { ExpressionId } from "./bloub/expressions.js";

/**
 * Zero-roll moods only (upstream's cursor-follow list): roll tilts the head and
 * makes the eyes jump vertically between two moods.
 */
export const WORKING_MOODS: readonly ExpressionId[] = [
  "surpris",
  "heureux",
  "hilare",
  "excite",
  "fier",
  "blase",
];

/** Seconds the look takes to reach a new target — slower than a saccade, on purpose. */
export const GLANCE_MORPH = 0.35;

export interface Glance {
  look: Look;
  mood: ExpressionId;
  /** Seconds to hold this glance before drawing the next one. */
  delay: number;
}

const rand = (random: () => number, min: number, max: number) => min + random() * (max - min);

/** One glance: where to look, which mood to wear, and how long to keep both. */
export function nextWorkingGlance(random: () => number = Math.random): Glance {
  return {
    look: {
      yaw: rand(random, -26, 26),
      pitch: rand(random, -8, 18),
      mix: 1,
      spin: 0,
      wander: 0.3,
    },
    mood: WORKING_MOODS[Math.floor(random() * WORKING_MOODS.length)] ?? "heureux",
    delay: rand(random, 1.2, 3.6),
  };
}
