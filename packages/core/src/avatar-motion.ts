/**
 * Working choreography, ported from bloub <https://github.com/jeremy-prt/bloub>
 * (MIT, Copyright (c) 2026 Jérémy Perret): the bot cycles through a handful of
 * bloub states (thinking dots, wink, wide eyes, "!", sleeping dot), each entered
 * with an easeOutQuint morph from the previous one. At rest nothing moves.
 *
 * `workingPose(t)` is the single source of truth: web drives it from
 * requestAnimationFrame, mobile from a Reanimated worklet. Units are ball radii
 * (× `AVATAR_BODY_RADIUS` for SVG user units) and seconds. The numbers are bloub's
 * measurements off the reference video — keep them verbatim.
 */

export interface AvatarDot {
  x: number;
  y: number;
  r: number;
  opacity: number;
}

export interface AvatarPose {
  body: { x: number; y: number; sx: number; sy: number };
  eyes: {
    x: number;
    y: number;
    /** degrees */
    roll: number;
    opacity: number;
    /** [inner, outer] scale relative to the resting capsule */
    scale: [[number, number], [number, number]];
  };
  /** Ellipsis decor: left, middle (also the "!" dot), right. */
  dots: [AvatarDot, AvatarDot, AvatarDot];
}

interface WorkingState {
  /** hold time, seconds */
  duration: number;
  /** entry morph, seconds */
  morph: number;
  pose(local: number): AvatarPose;
}

const DOT_X = [-0.557, -0.013, 0.532] as const;
const DOT_R = 0.165;
const DOT_PEAK = 1.25;
const EYE_W = 0.186;
const EYE_H = 0.412;
const REST_GAZE = { yaw: 28.49, pitch: 28.62 };

const NO_DOT: AvatarDot = { x: 0, y: 0, r: 0, opacity: 0 };

export const REST_POSE: AvatarPose = {
  body: { x: 0, y: 0, sx: 1, sy: 1 },
  eyes: {
    x: 0,
    y: 0,
    roll: 0,
    opacity: 1,
    scale: [
      [1, 1],
      [1, 1],
    ],
  },
  dots: [NO_DOT, NO_DOT, NO_DOT],
};

function clamp(v: number): number {
  "worklet";
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerp(a: number, b: number, k: number): number {
  "worklet";
  return a + (b - a) * k;
}

/** bloub `dotPulse`: cosine rise over a quarter wave, hold, snap back. */
function dotPulse(t: number, index: number): number {
  "worklet";
  const p = ((((t - index * 0.5) / 1.5) % 1) + 1) % 1;
  const k = p < 0.5 ? 0.5 - 0.5 * Math.cos(p * Math.PI * 2) : 0;
  return clamp(k * 2);
}

// ponytail: bloub projects eyes on a sphere; a sine offset of the gaze delta is
// close enough at avatar sizes.
function faced(
  gaze: { yaw: number; pitch: number; roll: number },
  eyes: [[number, number], [number, number]],
  over: Partial<Omit<AvatarPose, "eyes">> = {},
): AvatarPose {
  "worklet";
  const rad = Math.PI / 180;
  return {
    ...REST_POSE,
    ...over,
    eyes: {
      x: Math.sin((gaze.yaw - REST_GAZE.yaw) * rad) * 0.55,
      y: Math.sin((gaze.pitch - REST_GAZE.pitch) * rad) * 0.55,
      roll: gaze.roll + 13,
      opacity: 1,
      scale: [
        [eyes[0][0] / EYE_W, eyes[0][1] / EYE_H],
        [eyes[1][0] / EYE_W, eyes[1][1] / EYE_H],
      ],
    },
  };
}

function faceless(body: AvatarPose["body"], dots: AvatarPose["dots"] = REST_POSE.dots): AvatarPose {
  "worklet";
  return { body, eyes: { ...REST_POSE.eyes, opacity: 0 }, dots };
}

const STATES: WorkingState[] = [
  {
    duration: 1,
    morph: 0.45,
    pose: () => {
      "worklet";
      return REST_POSE;
    },
  },
  {
    duration: 2.6,
    morph: 0.4,
    pose: (t) => {
      "worklet";
      const dot = (i: number): AvatarDot => {
        const k = dotPulse(t, i);
        return {
          x: DOT_X[i]!,
          y: 0,
          r: DOT_R * (1 + (DOT_PEAK - 1) * k),
          opacity: 0.55 + 0.45 * k,
        };
      };
      // The ball BECOMES the middle dot, so the morph stays continuous.
      const mid = DOT_R * (1 + (DOT_PEAK - 1) * dotPulse(t, 1));
      return faceless({ x: DOT_X[1], y: 0, sx: mid, sy: mid }, [dot(0), NO_DOT, dot(2)]);
    },
  },
  {
    duration: 1.6,
    morph: 0.3,
    // The closed eye is a dash WIDER than the open one, not a squashed capsule.
    pose: () => {
      "worklet";
      return faced({ yaw: -5.37, pitch: 4.55, roll: 6.7 }, [
        [0.236, 0.464],
        [0.447, 0.089],
      ]);
    },
  },
  {
    duration: 1.8,
    morph: 0.55,
    pose: () => {
      "worklet";
      return faced({ yaw: 6.92, pitch: -21.96, roll: 11.6 }, [
        [0.356, 0.875],
        [0.356, 0.875],
      ]);
    },
  },
  {
    duration: 2,
    morph: 0.45,
    // ponytail: bloub's "!" bar is a truncated cone; a squashed body reads the same.
    pose: () => {
      "worklet";
      return faceless({ x: 0, y: -0.216, sx: 0.24, sy: 0.42 }, [
        NO_DOT,
        { x: -0.012, y: 0.526, r: 0.113, opacity: 1 },
        NO_DOT,
      ]);
    },
  },
  {
    duration: 2.4,
    morph: 0.5,
    pose: (t) => {
      "worklet";
      // Vertical bounce: ±0.19 around +0.11, period 0.6 s.
      const y = 0.11 + Math.sin(t * ((Math.PI * 2) / 0.6)) * 0.19;
      return faceless({ x: 0, y, sx: 0.1585, sy: 0.1585 });
    },
  },
];

/** Length of one full working cycle, seconds. */
export const WORKING_CYCLE_SECONDS = STATES.reduce((sum, s) => sum + s.duration, 0);

/** Frozen frame used under reduced motion: thinking dots, mid-pulse. */
export const WORKING_STILL_SECONDS = STATES[0]!.duration + 1.1;

export function lerpPose(a: AvatarPose, b: AvatarPose, k: number): AvatarPose {
  "worklet";
  const dot = (i: number): AvatarDot => ({
    x: lerp(a.dots[i]!.x, b.dots[i]!.x, k),
    y: lerp(a.dots[i]!.y, b.dots[i]!.y, k),
    r: lerp(a.dots[i]!.r, b.dots[i]!.r, k),
    opacity: lerp(a.dots[i]!.opacity, b.dots[i]!.opacity, k),
  });
  return {
    body: {
      x: lerp(a.body.x, b.body.x, k),
      y: lerp(a.body.y, b.body.y, k),
      sx: lerp(a.body.sx, b.body.sx, k),
      sy: lerp(a.body.sy, b.body.sy, k),
    },
    eyes: {
      x: lerp(a.eyes.x, b.eyes.x, k),
      y: lerp(a.eyes.y, b.eyes.y, k),
      roll: lerp(a.eyes.roll, b.eyes.roll, k),
      opacity: lerp(a.eyes.opacity, b.eyes.opacity, k),
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
    dots: [dot(0), dot(1), dot(2)],
  };
}

/** `t` = seconds since the bot started working; loops every `WORKING_CYCLE_SECONDS`. */
export function workingPose(t: number): AvatarPose {
  "worklet";
  const local = ((t % WORKING_CYCLE_SECONDS) + WORKING_CYCLE_SECONDS) % WORKING_CYCLE_SECONDS;
  const last = STATES[STATES.length - 1]!;
  // First pass morphs in from rest; later cycles morph from the last state.
  let previous = t < WORKING_CYCLE_SECONDS ? REST_POSE : last.pose(last.duration);
  let start = 0;
  for (let i = 0; i < STATES.length; i += 1) {
    const state = STATES[i]!;
    if (local < start + state.duration) {
      const k = 1 - (1 - clamp((local - start) / state.morph)) ** 5;
      return lerpPose(previous, state.pose(local - start), k);
    }
    start += state.duration;
    previous = state.pose(state.duration);
  }
  return REST_POSE;
}
