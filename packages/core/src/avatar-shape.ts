import { AVATAR_SHAPE_COUNT } from "@rakazo/contracts";

type AvatarPoint = readonly [number, number];
type CornerRadius = number | readonly number[];

interface AvatarShape {
  readonly name: string;
  readonly pts: readonly AvatarPoint[];
  /** Constant fillet radius, or a per-corner array; `0` keeps the Catmull-Rom smoothing. */
  readonly r: CornerRadius;
  /** Eye vertical offset — the eyes follow the optical mass, not the bounding box. */
  readonly oy: number;
  /** Whole-shape vertical shift applied after normalization. */
  readonly dy?: number;
}

const round = (value: number): number => Math.round(value * 100) / 100;

function polyArea(pts: readonly AvatarPoint[]): number {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    area += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(area) / 2;
}

/** Same optical mass for every shape, then recentre on the bounding box. */
function normalize(pts: readonly AvatarPoint[], target: number): AvatarPoint[] {
  const scale = Math.sqrt(target / polyArea(pts));
  const scaled = pts.map(([x, y]) => [x * scale, y * scale] as AvatarPoint);
  const xs = scaled.map((v) => v[0]);
  const ys = scaled.map((v) => v[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  return scaled.map(([x, y]) => [x - cx, y - cy] as AvatarPoint);
}

/** Catmull-Rom → cubic Bézier for the shapes that stay fully round (the disc). */
function smooth(pts: readonly AvatarPoint[]): string {
  const n = pts.length;
  let d = `M${round(pts[0]![0])} ${round(pts[0]![1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n]!;
    const p1 = pts[i]!;
    const p2 = pts[(i + 1) % n]!;
    const p3 = pts[(i + 2) % n]!;
    d += `C${round(p1[0] + (p2[0] - p0[0]) / 6)} ${round(p1[1] + (p2[1] - p0[1]) / 6)} ${round(p2[0] - (p3[0] - p1[0]) / 6)} ${round(p2[1] - (p3[1] - p1[1]) / 6)} ${round(p2[0])} ${round(p2[1])}`;
  }
  return `${d}Z`;
}

/** Circular fillet at every vertex — constant radius is the signature of this set. */
function roundPoly(pts: readonly AvatarPoint[], radius: CornerRadius): string {
  const n = pts.length;
  const k = 0.5523;
  const segs: Array<{ A: AvatarPoint; B: AvatarPoint; p1: AvatarPoint }> = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n]!;
    const p1 = pts[i]!;
    const p2 = pts[(i + 1) % n]!;
    const rr = Array.isArray(radius) ? radius[i]! : (radius as number);
    const d1 = Math.hypot(p0[0] - p1[0], p0[1] - p1[1]);
    const d2 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const v1: AvatarPoint = [(p0[0] - p1[0]) / d1, (p0[1] - p1[1]) / d1];
    const v2: AvatarPoint = [(p2[0] - p1[0]) / d2, (p2[1] - p1[1]) / d2];
    const cos = Math.max(-1, Math.min(1, v1[0] * v2[0] + v1[1] * v2[1]));
    const theta = Math.acos(cos);
    let t = rr / Math.tan(theta / 2);
    t = Math.min(t, d1 * 0.5, d2 * 0.5);
    segs.push({
      A: [p1[0] + v1[0] * t, p1[1] + v1[1] * t],
      B: [p1[0] + v2[0] * t, p1[1] + v2[1] * t],
      p1,
    });
  }
  let d = `M${round(segs[0]!.A[0])} ${round(segs[0]!.A[1])}`;
  for (let i = 0; i < n; i++) {
    const s = segs[i]!;
    const nx = segs[(i + 1) % n]!;
    d += `C${round(s.A[0] + (s.p1[0] - s.A[0]) * k)} ${round(s.A[1] + (s.p1[1] - s.A[1]) * k)} ${round(s.B[0] + (s.p1[0] - s.B[0]) * k)} ${round(s.B[1] + (s.p1[1] - s.B[1]) * k)} ${round(s.B[0])} ${round(s.B[1])}`;
    d += `L${round(nx.A[0])} ${round(nx.A[1])}`;
  }
  return `${d}Z`;
}

function circlePts(cx: number, cy: number, r: number): AvatarPoint[] {
  const pts: AvatarPoint[] = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

/**
 * "Taille douce — direction poussée" (2a): 12 constructed silhouettes, equal
 * optical area (6100 u²), a constant fillet radius of 17 with three documented
 * exceptions (goutte, feuille, arche), plus a per-shape vertical eye correction.
 */
const AVATAR_SHAPES: readonly AvatarShape[] = [
  { name: "disque", pts: circlePts(0, 0, 46), r: 0, oy: 0 },
  {
    name: "galet",
    pts: [
      [-50, -34],
      [50, -34],
      [50, 34],
      [-50, 34],
    ],
    r: 30,
    oy: 0,
  },
  {
    name: "carre",
    pts: [
      [-40, -40],
      [40, -40],
      [40, 40],
      [-40, 40],
    ],
    r: 17,
    oy: 0,
  },
  {
    name: "hexagone",
    pts: [
      [-24, -42],
      [24, -42],
      [48, 0],
      [24, 42],
      [-24, 42],
      [-48, 0],
    ],
    r: 17,
    oy: 0,
  },
  {
    name: "pentagone",
    pts: [
      [0, -48],
      [46, -14],
      [28, 42],
      [-28, 42],
      [-46, -14],
    ],
    r: 17,
    oy: 3,
  },
  {
    name: "losange",
    pts: [
      [0, -50],
      [46, 0],
      [0, 50],
      [-46, 0],
    ],
    r: 17,
    oy: 0,
  },
  {
    name: "triangle",
    pts: [
      [0, -46],
      [44, 38],
      [-44, 38],
    ],
    r: 17,
    oy: 7,
    dy: -3,
  },
  {
    name: "goutte",
    pts: [
      [0, -52],
      [44, 24],
      [-44, 24],
    ],
    r: [11, 40, 40],
    oy: 6,
    dy: 2,
  },
  {
    name: "bouclier",
    pts: [
      [-42, -40],
      [42, -40],
      [42, 4],
      [0, 50],
      [-42, 4],
    ],
    r: [17, 17, 17, 24, 17],
    oy: -3,
    dy: -3,
  },
  {
    name: "feuille",
    pts: [
      [0, -50],
      [46, 0],
      [0, 50],
      [-46, 0],
    ],
    r: [8, 46, 8, 46],
    oy: 0,
  },
  {
    name: "arche",
    pts: [
      [-40, 42],
      [-40, -18],
      [0, -50],
      [40, -18],
      [40, 42],
    ],
    r: [17, 28, 30, 28, 17],
    oy: 2,
  },
  {
    name: "etoile",
    pts: Array.from({ length: 12 }, (_, i) => {
      const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
      const rr = i % 2 ? 26 : 52;
      return [Math.cos(a) * rr, Math.sin(a) * rr] as AvatarPoint;
    }),
    r: 9,
    oy: 0,
  },
];

export function avatarIdentitySeed(identity: string): number {
  let hash = 0;
  for (let index = 0; index < identity.length; index++) {
    hash = (hash << 5) - hash + identity.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

/** The shape family a seed selects (`0 .. AVATAR_SHAPE_COUNT - 1`). */
export function avatarShapeFamily(seed: number): number {
  return seed % AVATAR_SHAPE_COUNT;
}

function shapeForSeed(seed: number): AvatarShape {
  return AVATAR_SHAPES[avatarShapeFamily(seed)] ?? AVATAR_SHAPES[0]!;
}

/** The family's eye vertical offset (`oy`) — the renderer places the eyes at `-h/2 + oy`. */
export function avatarShapeEyeOffset(seed: number): number {
  return shapeForSeed(seed).oy;
}

export function organicAvatarPath(seed: number, phaseOffset = 0): string {
  const shape = shapeForSeed(seed);
  let pts = normalize(shape.pts, 6100).map(([x, y]) => [x, y + (shape.dy ?? 0)] as AvatarPoint);
  // Only the morph target is scaled; `phaseOffset === 0` stays the canonical
  // silhouette so identical seeds always emit an identical path.
  if (phaseOffset !== 0) {
    const phase = ((seed % 360) * Math.PI) / 180 + phaseOffset;
    const xScale = 1 + Math.sin(phase) * 0.02;
    const yScale = 1 + Math.cos(phase) * 0.015;
    pts = pts.map(([x, y]) => [x * xScale, y * yScale] as AvatarPoint);
  }
  return shape.r ? roundPoly(pts, shape.r) : smooth(pts);
}
