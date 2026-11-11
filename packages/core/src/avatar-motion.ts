/**
 * Shared working-avatar choreography: while a run is active the bot glances
 * around and changes mood at random intervals.
 *
 * Web (`@tangow/ui-web`) and mobile (`apps/mobile`) both drive the same bloub
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

/** The head's comfortable range, in degrees: a glance and a pointer follow both stay inside it. */
export const LOOK_YAW_DEG = 26;
export const LOOK_PITCH_DEG = { min: -8, max: 18 } as const;

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
      yaw: rand(random, -LOOK_YAW_DEG, LOOK_YAW_DEG),
      pitch: rand(random, LOOK_PITCH_DEG.min, LOOK_PITCH_DEG.max),
      mix: 1,
      spin: 0,
      wander: 0.3,
    },
    mood: WORKING_MOODS[Math.floor(random() * WORKING_MOODS.length)] ?? "heureux",
    delay: rand(random, 1.2, 3.6),
  };
}
