/**
 * Working choreography, ported from bloub <https://github.com/jeremy-prt/bloub>
 * (MIT, Copyright (c) 2026 Jérémy Perret). While working the bot slowly cycles
 * through bloub expressions (attentive, curious, happy, surprised, confused, a
 * wink), blinking on every change, with a small gaze drift so the hold never
 * looks frozen. Once per cycle it "plays": a bouquet of thin arcs sweeps across
 * the body. The body itself never moves; at rest nothing moves at all.
 *
 * `workingPose(t)` is the single source of truth: web drives it from
 * requestAnimationFrame, mobile from a Reanimated worklet. Units are ball radii
 * (× `AVATAR_BODY_RADIUS` for SVG user units), degrees and seconds. Expression
 * numbers are bloub's — keep them verbatim.
 */

export interface AvatarPose {
  eyes: {
    /** eye-pair offset from its resting spot, ball radii */
    x: number;
    y: number;
    /** whole-pair roll, degrees */
    roll: number;
    /** per-eye tilt, degrees, positive = top leans right */
    tilt: [number, number];
    /** [inner, outer] scale relative to the resting capsule */
    scale: [[number, number], [number, number]];
  };
  /** Play swoosh: `t` drives `swooshPath`, opacity 0 hides it. */
  swoosh: { t: number; opacity: number };
}

interface Gaze {
  yaw: number;
  pitch: number;
  roll: number;
}
type EyeSizes = [[number, number], [number, number]];
type Tilts = [number, number];

interface WorkingState {
  /** hold time, seconds */
  duration: number;
  /** entry morph, seconds */
  morph: number;
  pose(local: number): AvatarPose;
}

const EYE_W = 0.186;
const EYE_H = 0.412;
const REST_GAZE: Gaze = { yaw: 28.49, pitch: 28.62, roll: -13 };
/** bloub expressions turn the whole head; halve the travel so eyes stay on the body. */
const HEAD_TURN = 0.5;
const BLINK_SECONDS = 0.24;
const PLAY_SECONDS = 2.2;

export const REST_POSE: AvatarPose = {
  eyes: {
    x: 0,
    y: 0,
    roll: 0,
    tilt: [0, 0],
    scale: [
      [1, 1],
      [1, 1],
    ],
  },
  swoosh: { t: 0, opacity: 0 },
};

function clamp(v: number): number {
  "worklet";
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerp(a: number, b: number, k: number): number {
  "worklet";
  return a + (b - a) * k;
}

/** bloub `eyePoses`: the eye pair sits where the head's forward vector meets the sphere. */
function project(gaze: Gaze): [number, number] {
  "worklet";
  const rad = Math.PI / 180;
  return [Math.sin(gaze.yaw * rad) * Math.cos(gaze.pitch * rad), -Math.sin(gaze.pitch * rad)];
}

const REST_POINT = project(REST_GAZE);

function faced(gaze: Gaze, eyes: EyeSizes, tilt: Tilts): AvatarPose {
  "worklet";
  const [px, py] = project(gaze);
  return {
    eyes: {
      x: (px - REST_POINT[0]) * HEAD_TURN,
      y: (py - REST_POINT[1]) * HEAD_TURN,
      roll: gaze.roll - REST_GAZE.roll,
      tilt,
      scale: [
        [eyes[0][0] / EYE_W, eyes[0][1] / EYE_H],
        [eyes[1][0] / EYE_W, eyes[1][1] / EYE_H],
      ],
    },
    swoosh: REST_POSE.swoosh,
  };
}

/** Same capsule on both eyes, tilts mirrored (bloub `pair`). */
function pair(w: number, h: number, tilt = 0): [EyeSizes, Tilts] {
  return [
    [
      [w, h],
      [w, h],
    ],
    [tilt, -tilt],
  ];
}

function hold(duration: number, gaze: Gaze, [eyes, tilt]: [EyeSizes, Tilts]): WorkingState {
  return {
    duration,
    morph: 0.45,
    pose: () => {
      "worklet";
      return faced(gaze, eyes, tilt);
    },
  };
}

const STATES: WorkingState[] = [
  hold(2.8, { yaw: 4, pitch: 5, roll: -4 }, pair(0.21, 0.44)),
  // curious: the head tilt carries it, both eyes lean the same way
  hold(2.6, { yaw: 16, pitch: -9, roll: -15 }, [
    [
      [0.24, 0.46],
      [0.2, 0.38],
    ],
    [-8, -8],
  ]),
  hold(2.4, { yaw: 5, pitch: 9, roll: 0 }, pair(0.27, 0.17, 14)),
  hold(1.6, { yaw: 3, pitch: -3, roll: 0 }, pair(0.45, 0.47)),
  // confused: mismatched sizes AND tilts
  hold(2.6, { yaw: -14, pitch: 3, roll: 8 }, [
    [
      [0.2, 0.44],
      [0.28, 0.17],
    ],
    [-18, 14],
  ]),
  // wink: the closed eye is a dash WIDER than the open one
  hold(1.6, { yaw: -5.37, pitch: 4.55, roll: 6.7 }, [
    [
      [0.236, 0.464],
      [0.447, 0.089],
    ],
    [0, 0],
  ]),
  {
    duration: PLAY_SECONDS,
    morph: 0.5,
    pose: (t) => {
      "worklet";
      const pose = faced(
        { yaw: 12, pitch: -8, roll: -6 },
        [
          [0.18, 0.34],
          [0.18, 0.34],
        ],
        [0, 0],
      );
      pose.swoosh = { t, opacity: clamp(t / 0.35) * clamp((PLAY_SECONDS - t) / 0.5) };
      return pose;
    },
  },
  hold(1.8, REST_GAZE, pair(EYE_W, EYE_H)),
];

/** Length of one full working cycle, seconds. */
export const WORKING_CYCLE_SECONDS = STATES.reduce((sum, s) => sum + s.duration, 0);

/** Frozen frame used under reduced motion: attentive, mid-hold. */
export const WORKING_STILL_SECONDS = 1.4;

export const SWOOSH_COUNT = 4;

/**
 * bloub `SWOOSH` through `arcRender`: four nested, nearly edge-on ellipses
 * sweeping right to left over the body. Returns an SVG path in viewBox units.
 * Drawn in the body colour behind the body, so no front/back split is needed.
 */
export function swooshPath(index: number, t: number, radius: number): string {
  "worklet";
  const TAU = Math.PI * 2;
  const a = 0.78 + index * 0.2;
  const k = 0.05 + index * 0.02;
  const tilt = -0.62 + index * 0.05;
  const cx = 0.45 - t * 0.42;
  const cy = -0.12;
  const spin = 0.06 * index + t * 0.3 * TAU;
  const cu = Math.cos(tilt);
  const su = Math.sin(tilt);
  const N = 24;
  let d = "";
  for (let i = 0; i <= N; i += 1) {
    const th = spin + (i / N) * 0.4 * TAU;
    const ct = Math.cos(th);
    const st = Math.sin(th);
    const x = (a * (ct * cu - st * su * k) + cx) * radius;
    const y = (a * (ct * su + st * cu * k) + cy) * radius;
    d += `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  return d;
}

export function lerpPose(a: AvatarPose, b: AvatarPose, k: number): AvatarPose {
  "worklet";
  return {
    eyes: {
      x: lerp(a.eyes.x, b.eyes.x, k),
      y: lerp(a.eyes.y, b.eyes.y, k),
      roll: lerp(a.eyes.roll, b.eyes.roll, k),
      tilt: [lerp(a.eyes.tilt[0], b.eyes.tilt[0], k), lerp(a.eyes.tilt[1], b.eyes.tilt[1], k)],
      scale: [
        [
          lerp(a.eyes.scale[0][0], b.eyes.scale[0][0], k),
          lerp(a.eyes.scale[0][1], b.eyes.scale[0][1], k),
        ],
        [
          lerp(a.eyes.scale[1][0], b.eyes.scale[1][0], k),
          lerp(a.eyes.scale[1][1], b.eyes.scale[1][1], k),
        ],
      ],
    },
    swoosh: {
      t: lerp(a.swoosh.t, b.swoosh.t, k),
      opacity: lerp(a.swoosh.opacity, b.swoosh.opacity, k),
    },
  };
}

/** `t` = seconds since the bot started working; loops every `WORKING_CYCLE_SECONDS`. */
export function workingPose(t: number): AvatarPose {
  "worklet";
  const TAU = Math.PI * 2;
  const local = ((t % WORKING_CYCLE_SECONDS) + WORKING_CYCLE_SECONDS) % WORKING_CYCLE_SECONDS;
  const last = STATES[STATES.length - 1]!;
  // First pass morphs in from rest; later cycles morph from the last state.
  let previous = t < WORKING_CYCLE_SECONDS ? REST_POSE : last.pose(last.duration);
  let start = 0;
  for (let i = 0; i < STATES.length; i += 1) {
    const state = STATES[i]!;
    if (local < start + state.duration) {
      const elapsed = local - start;
      const k = 1 - (1 - clamp(elapsed / state.morph)) ** 5;
      const pose = lerpPose(previous, state.pose(elapsed), k);
      // bloub `liveliness`: slow gaze drift on incommensurate periods, damped,
      // faded in so the first frame is exactly the resting face.
      const drift = clamp(t / 0.6);
      pose.eyes.x +=
        (Math.sin((t / 11.3) * TAU + 0.4) * 0.03 + Math.sin((t / 3.7) * TAU + 2.1) * 0.008) * drift;
      pose.eyes.y +=
        (Math.sin((t / 9.1) * TAU + 1.3) * 0.024 + Math.sin((t / 4.3) * TAU + 0.7) * 0.007) * drift;
      // bloub `blinkIn`: a vertical screen-space squash on every state entry.
      const lid = 1 - Math.sin(Math.PI * clamp(elapsed / BLINK_SECONDS));
      const squash = 0.06 + 0.94 * lid;
      pose.eyes.scale[0][1] *= squash;
      pose.eyes.scale[1][1] *= squash;
      return pose;
    }
    start += state.duration;
    previous = state.pose(state.duration);
  }
  return REST_POSE;
}
