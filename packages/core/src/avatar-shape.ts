/**
 * Bot avatar geometry, ported from bloub <https://github.com/jeremy-prt/bloub>
 * (MIT License, Copyright (c) 2026 Jérémy Perret).
 *
 * Body = radial profile r(θ) sampled at 64 angles (θ=0 right, clockwise, unit =
 * rest ball radius) turned into a closed Catmull-Rom path. Eyes = two capsules
 * painted on a unit sphere and projected orthographically, which is what gives
 * the `\\` lean and the far eye its depth compression. The numbers below are
 * measurements off the reference video, not settings — keep them verbatim.
 */
import { AVATAR_SHAPE_COUNT } from "@rakazo/contracts";

/** Rest ball radius in viewBox units (renderers use `viewBox="-60 -60 120 120"`). */
export const AVATAR_BODY_RADIUS = 48;

const SAMPLES = 64;
const TAU = Math.PI * 2;
const COS = Array.from({ length: SAMPLES }, (_, i) => Math.cos((i / SAMPLES) * TAU));
const SIN = Array.from({ length: SAMPLES }, (_, i) => Math.sin((i / SAMPLES) * TAU));
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Shape families, index = `seed % AVATAR_SHAPE_COUNT`: cercle, galet, squircle, capsule, triangle, hexagone, nuage, goutte, oeuf, pentagone. */
const RADII: readonly (readonly number[])[] = [
  new Array<number>(SAMPLES).fill(1),
  [
    0.9765, 0.9614, 0.9462, 0.9319, 0.919, 0.9083, 0.8998, 0.8937, 0.8899, 0.8881, 0.8879, 0.8889,
    0.8906, 0.8927, 0.8948, 0.8967, 0.8985, 0.9002, 0.9021, 0.9044, 0.9076, 0.9118, 0.9175, 0.9248,
    0.9336, 0.9439, 0.9553, 0.9672, 0.979, 0.99, 0.9992, 1.0059, 1.0095, 1.0092, 1.0048, 0.9963,
    0.9837, 0.9675, 0.9486, 0.9278, 0.9064, 0.8856, 0.8666, 0.8506, 0.8386, 0.8315, 0.8297, 0.8333,
    0.8422, 0.8559, 0.8736, 0.8942, 0.9164, 0.9391, 0.9608, 0.9804, 0.9967, 1.0091, 1.0169, 1.02,
    1.0184, 1.0126, 1.0031, 0.9908,
  ],
  [
    0.9591, 0.9637, 0.9776, 1.0007, 1.0321, 1.0696, 1.108, 1.1383, 1.15, 1.1383, 1.108, 1.0696,
    1.0321, 1.0007, 0.9776, 0.9637, 0.9591, 0.9637, 0.9776, 1.0007, 1.0321, 1.0696, 1.108, 1.1383,
    1.15, 1.1383, 1.108, 1.0696, 1.0321, 1.0007, 0.9776, 0.9637, 0.9591, 0.9637, 0.9776, 1.0007,
    1.0321, 1.0696, 1.108, 1.1383, 1.15, 1.1383, 1.108, 1.0696, 1.0321, 1.0007, 0.9776, 0.9637,
    0.9591, 0.9637, 0.9776, 1.0007, 1.0321, 1.0696, 1.108, 1.1383, 1.15, 1.1383, 1.108, 1.0696,
    1.0321, 1.0007, 0.9776, 0.9637,
  ],
  [
    1.04, 1.0363, 1.0265, 1.0095, 0.9868, 0.9576, 0.9235, 0.8842, 0.8409, 0.7945, 0.7457, 0.703,
    0.6711, 0.6479, 0.6321, 0.623, 0.62, 0.623, 0.6321, 0.6479, 0.6711, 0.703, 0.7457, 0.7945,
    0.8409, 0.8842, 0.9235, 0.9576, 0.9868, 1.0095, 1.0265, 1.0363, 1.04, 1.0363, 1.0265, 1.0095,
    0.9868, 0.9576, 0.9235, 0.8842, 0.8409, 0.7945, 0.7457, 0.703, 0.6711, 0.6479, 0.6321, 0.623,
    0.62, 0.623, 0.6321, 0.6479, 0.6711, 0.703, 0.7457, 0.7945, 0.8409, 0.8842, 0.9235, 0.9576,
    0.9868, 1.0095, 1.0265, 1.0363,
  ],
  [
    0.8429, 0.8981, 0.971, 1.0481, 1.0972, 1.1168, 1.1142, 1.0831, 1.025, 0.9444, 0.878, 0.8277,
    0.7901, 0.7628, 0.7443, 0.7335, 0.73, 0.7335, 0.7443, 0.7628, 0.7901, 0.8277, 0.878, 0.9444,
    1.025, 1.0831, 1.1142, 1.1168, 1.0972, 1.0481, 0.971, 0.8981, 0.8429, 0.8014, 0.7709, 0.7496,
    0.7363, 0.7304, 0.7316, 0.7399, 0.7558, 0.78, 0.8139, 0.8596, 0.9201, 0.9991, 1.0679, 1.1057,
    1.12, 1.1057, 1.0679, 0.9991, 0.9201, 0.8596, 0.8139, 0.78, 0.7558, 0.7399, 0.7316, 0.7304,
    0.7363, 0.7496, 0.7709, 0.8014,
  ],
  [
    1.04, 1.0245, 0.9879, 0.9606, 0.9436, 0.936, 0.9375, 0.9482, 0.9685, 0.9996, 1.0329, 1.0381,
    1.0126, 0.9776, 0.9538, 0.94, 0.9355, 0.94, 0.9538, 0.9776, 1.0126, 1.0381, 1.0329, 0.9996,
    0.9685, 0.9482, 0.9375, 0.936, 0.9436, 0.9606, 0.9879, 1.0245, 1.04, 1.0245, 0.9879, 0.9606,
    0.9436, 0.936, 0.9375, 0.9482, 0.9685, 0.9996, 1.0329, 1.0381, 1.0126, 0.9776, 0.9538, 0.94,
    0.9355, 0.94, 0.9538, 0.9776, 1.0126, 1.0381, 1.0329, 0.9996, 0.9685, 0.9482, 0.9375, 0.936,
    0.9436, 0.9606, 0.9879, 1.0245,
  ],
  [
    0.9157, 0.9505, 0.976, 0.9922, 0.9987, 0.9956, 0.9829, 0.9606, 0.9291, 0.8886, 0.8395, 0.8587,
    0.8746, 0.8866, 0.8944, 0.898, 0.8972, 0.8921, 0.8828, 0.8694, 0.8522, 0.8346, 0.8845, 0.9273,
    0.9626, 0.9897, 1.0085, 1.0186, 1.02, 1.0126, 0.9964, 0.9718, 0.939, 0.8985, 0.8507, 0.7964,
    0.7772, 0.8064, 0.8297, 0.8469, 0.8576, 0.8618, 0.8593, 0.8502, 0.8347, 0.8129, 0.7851, 0.7519,
    0.7137, 0.6712, 0.656, 0.6974, 0.7336, 0.7641, 0.7885, 0.8064, 0.8175, 0.8219, 0.8193, 0.8098,
    0.7936, 0.7709, 0.8201, 0.8721,
  ],
  [
    0.6151, 0.6442, 0.6737, 0.7041, 0.7351, 0.7658, 0.7954, 0.8249, 0.8515, 0.8773, 0.8995, 0.9201,
    0.9363, 0.9499, 0.9596, 0.9653, 0.9679, 0.9653, 0.9596, 0.9499, 0.9363, 0.9201, 0.8995, 0.8773,
    0.8515, 0.8249, 0.7954, 0.7658, 0.7351, 0.7041, 0.6737, 0.6442, 0.6151, 0.5879, 0.5661, 0.551,
    0.5418, 0.5379, 0.5393, 0.5459, 0.5582, 0.5766, 0.6024, 0.637, 0.6827, 0.7433, 0.8244, 0.9354,
    1.04, 0.9354, 0.8244, 0.7433, 0.6827, 0.637, 0.6024, 0.5766, 0.5582, 0.5459, 0.5393, 0.5379,
    0.5418, 0.551, 0.5661, 0.5879,
  ],
  [
    0.8369, 0.8424, 0.8497, 0.8585, 0.8674, 0.8775, 0.8878, 0.8983, 0.9089, 0.9185, 0.9288, 0.9374,
    0.9445, 0.9504, 0.9543, 0.9559, 0.9555, 0.9519, 0.9466, 0.9389, 0.9302, 0.9193, 0.9085, 0.8969,
    0.8852, 0.8734, 0.8625, 0.8513, 0.8411, 0.8325, 0.8243, 0.8179, 0.8137, 0.8112, 0.8102, 0.8128,
    0.8178, 0.8262, 0.8374, 0.8518, 0.8702, 0.8922, 0.9169, 0.9446, 0.9741, 1.0023, 1.0267, 1.0433,
    1.0481, 1.0393, 1.0216, 0.997, 0.9697, 0.9418, 0.9169, 0.8949, 0.876, 0.8604, 0.849, 0.8394,
    0.8337, 0.8314, 0.8305, 0.8326,
  ],
  [
    0.9789, 0.9532, 0.9375, 0.9312, 0.9339, 0.9458, 0.9674, 0.9998, 1.0438, 1.0746, 1.0776, 1.0529,
    1.0077, 0.9729, 0.9493, 0.9355, 0.931, 0.9355, 0.9493, 0.9729, 1.0077, 1.0529, 1.0776, 1.0746,
    1.0438, 0.9998, 0.9674, 0.9458, 0.9339, 0.9312, 0.9375, 0.9532, 0.9789, 1.0162, 1.0596, 1.0789,
    1.0708, 1.0348, 0.9924, 0.9622, 0.9426, 0.9327, 0.9318, 0.9399, 0.9575, 0.9854, 1.0252, 1.066,
    1.08, 1.066, 1.0252, 0.9854, 0.9575, 0.9399, 0.9318, 0.9327, 0.9426, 0.9622, 0.9924, 1.0348,
    1.0708, 1.0789, 1.0596, 1.0162,
  ],
];

/**
 * Per-family eye-centre nudge (ball-radius units) so the capsules never read as
 * a notch in narrow silhouettes. Solved once in bloub (`eyefit.ts`, idle × neutre)
 * and pasted here; circle-like families are 0 by construction.
 */
const EYE_FIT: readonly (readonly [number, number])[] = [
  [0, 0],
  [-0.0118, 0.0205],
  [0, 0],
  [-0.0448, 0.0775],
  [-0.003, 0.0052],
  [0, 0],
  [-0.0171, 0.0296],
  [-0.0171, 0.0296],
  [0, 0],
  [0, 0],
];

/**
 * Rest eye frames from bloub `eyePoses(REST_GAZE = {yaw: 28.49, pitch: 28.62, roll: -13})`
 * on a unit sphere: centre (x, y) and tangent basis (a, b, c, d) as an SVG matrix.
 * The far eye's narrower basis is depth compression, not a typo.
 */
const REST_EYES = [
  { x: 0.189, y: -0.409, a: 0.8875, b: -0.318, c: 0.4203, d: 0.8553 },
  { x: 0.6182, y: -0.5143, a: 0.6642, b: -0.0626, c: 0.4203, d: 0.8553 },
] as const;
const EYE_W = 0.186;
const EYE_H = 0.412;

export function avatarIdentitySeed(identity: string): number {
  let hash = 0;
  for (let index = 0; index < identity.length; index++) {
    hash = (hash << 5) - hash + identity.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

function familyRadii(seed: number): readonly number[] {
  return RADII[seed % AVATAR_SHAPE_COUNT] ?? RADII[0]!;
}

/**
 * Body outline for a shape family. `phaseOffset` drives bloub's breath: height
 * only, ±0.5 %, width constant. Same 64 points for every family, so any two
 * outputs morph cleanly with `<animate attributeName="d">`.
 */
export function organicAvatarPath(seed: number, phaseOffset = 0): string {
  const radii = familyRadii(seed);
  const sy = 1 + Math.sin(phaseOffset) * 0.005;
  const pts = radii.map((r, i) => ({
    x: r * COS[i]! * AVATAR_BODY_RADIUS,
    y: r * SIN[i]! * sy * AVATAR_BODY_RADIUS,
  }));
  const n = pts.length;
  let d = `M${r2(pts[0]!.x)} ${r2(pts[0]!.y)}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n]!;
    const p1 = pts[i]!;
    const p2 = pts[(i + 1) % n]!;
    const p3 = pts[(i + 2) % n]!;
    d += `C${r2(p1.x + (p2.x - p0.x) / 6)} ${r2(p1.y + (p2.y - p0.y) / 6)} ${r2(p2.x - (p3.x - p1.x) / 6)} ${r2(p2.y - (p3.y - p1.y) / 6)} ${r2(p2.x)} ${r2(p2.y)}`;
  }
  return `${d}Z`;
}

function radiusAtAngle(radii: readonly number[], angle: number): number {
  const t = ((((angle / TAU) % 1) + 1) % 1) * SAMPLES;
  const i = Math.floor(t);
  const a = radii[i % SAMPLES] ?? 1;
  const b = radii[(i + 1) % SAMPLES] ?? 1;
  return a + (b - a) * (t - i);
}

/** Capsule (stadium) centred on the origin — the exact eye shape. */
function capsulePath(w: number, h: number): string {
  const hw = w / 2;
  const hh = h / 2;
  const r = Math.min(hw, hh);
  return (
    `M${r2(-hw)} ${r2(-hh + r)}A${r2(r)} ${r2(r)} 0 0 1 ${r2(-hw + r)} ${r2(-hh)}` +
    `L${r2(hw - r)} ${r2(-hh)}A${r2(r)} ${r2(r)} 0 0 1 ${r2(hw)} ${r2(-hh + r)}` +
    `L${r2(hw)} ${r2(hh - r)}A${r2(r)} ${r2(r)} 0 0 1 ${r2(hw - r)} ${r2(hh)}` +
    `L${r2(-hw + r)} ${r2(hh)}A${r2(r)} ${r2(r)} 0 0 1 ${r2(-hw)} ${r2(hh - r)}Z`
  );
}

export interface OrganicAvatarFace {
  /** Midpoint of the two eyes in viewBox units — wrap the eyes in `translate(x y)` so blinks squash around it. */
  x: number;
  y: number;
  /** Eye paths with `matrix(...)` transforms relative to (x, y). Eyes are meant to be cut out of the body (mask), not painted on it. */
  eyes: readonly { d: string; transform: string }[];
}

export function organicAvatarFace(seed: number): OrganicAvatarFace {
  const radii = familyRadii(seed);
  const [fitX, fitY] = EYE_FIT[seed % AVATAR_SHAPE_COUNT] ?? [0, 0];
  const R = AVATAR_BODY_RADIUS;
  const d = capsulePath(EYE_W * R, EYE_H * R);
  const placed = REST_EYES.map((e) => {
    // Eyes live on a sphere; pro-rate their centre onto the real outline so they
    // stay inside non-circular bodies.
    const fit = radiusAtAngle(radii, Math.atan2(e.y, e.x));
    return { ...e, px: (e.x * fit + fitX) * R, py: (e.y * fit + fitY) * R };
  });
  const x = r2((placed[0]!.px + placed[1]!.px) / 2);
  const y = r2((placed[0]!.py + placed[1]!.py) / 2);
  return {
    x,
    y,
    eyes: placed.map((e) => ({
      d,
      transform: `matrix(${e.a} ${e.b} ${e.c} ${e.d} ${r2(e.px - x)} ${r2(e.py - y)})`,
    })),
  };
}
