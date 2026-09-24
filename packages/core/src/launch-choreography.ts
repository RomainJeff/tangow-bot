/**
 * Launch choreography: the "bot waking up" sequence the mobile splash plays
 * while the app boots.
 *
 * Translates the mockup's `SOLO` animation
 * (`maquette-splash.dc.html`, variants 1a/2a) into the bloub engine's moods
 * and looks. The mockup loops over ~7s of playback time meant for a page left
 * open; a real launch takes well under a second, so the steps here are held
 * far more briefly — see `design.md` ("on n'allonge jamais le démarrage pour
 * l'animation"). The mockup's one gesture the engine can't reproduce is the
 * wink (no wink expression exists): it is replaced by `fier`, a proud
 * up-right glance.
 *
 * A pure data sequence, not a timer: the caller (the mobile splash) drives
 * playback and decides when to stop or loop.
 */

import type { Look } from "./bloub/engine.js";
import type { ExpressionId } from "./bloub/expressions.js";

export interface LaunchStep {
  /** Seconds to hold this mood/look before moving to the next step. */
  holdSeconds: number;
  mood: ExpressionId;
  /** `null` keeps the mood's own baked-in gaze (a centered look). */
  look: Look | null;
}

const look = (yaw: number, pitch: number): Look => ({
  yaw,
  pitch,
  mix: 1,
  spin: 0,
  wander: 0.2,
});

/**
 * The wake-up sequence, mockup step by step:
 * 1. asleep, looking down (`somnolent`) — also the native splash's frozen frame
 * 2. startled awake, looking up (`surpris`)
 * 3. looks left (`neutre`)
 * 4. looks right (`curieux`)
 * 5. joy (`hilare`)
 * 6. smile (`heureux`)
 * 7. proud glance up-right (`fier`) — stands in for the mockup's wink
 */
export const LAUNCH_CHOREOGRAPHY: readonly LaunchStep[] = [
  { holdSeconds: 0.3, mood: "somnolent", look: look(0, -22) },
  { holdSeconds: 0.3, mood: "surpris", look: look(0, 22) },
  { holdSeconds: 0.5, mood: "neutre", look: look(-24, 0) },
  { holdSeconds: 0.5, mood: "curieux", look: look(24, 0) },
  { holdSeconds: 0.6, mood: "hilare", look: null },
  { holdSeconds: 0.5, mood: "heureux", look: null },
  { holdSeconds: 0.5, mood: "fier", look: look(20, 18) },
];

/**
 * Minimum time the splash stays up once the app is ready, so a fast boot
 * never flashes past the wake-up: the "asleep" and "startled" steps.
 */
export const LAUNCH_WAKE_UP_MINIMUM_SECONDS =
  LAUNCH_CHOREOGRAPHY[0]!.holdSeconds + LAUNCH_CHOREOGRAPHY[1]!.holdSeconds;

/**
 * Step index the sequence restarts at when the boot runs long and the
 * choreography loops — the "looks left" step, so the loop never replays the
 * asleep/startled wake-up.
 */
export const LAUNCH_LOOP_FROM_INDEX = 2;
