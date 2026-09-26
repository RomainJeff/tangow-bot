import { AVATAR_INK, BotEngine, RAYON, SHAPES } from "@rakazo/core";
import { darkTokens } from "@rakazo/ui-tokens";

type Point = [number, number];
type Curve = [number, number, number, number, number, number];
type Eye = { halfWidth: number; halfHeight: number; radius: number; matrix: number[] };

export type NotificationAvatarShape = { start: Point; curves: Curve[]; eyes: Eye[] };

export const NOTIFICATION_AVATAR_SWIFT_PATH = "targets/notification-service/AvatarShapes.swift";

function numbers(source: string): number[] {
  return (source.match(/-?\d*\.?\d+(?:e-?\d+)?/gi) ?? []).map(Number);
}

function bodyOutline(path: string): { start: Point; curves: Curve[] } {
  const commands = path.match(/[MC][^MCZ]*/g) ?? [];
  const [move, ...rest] = commands;
  if (!move?.startsWith("M") || rest.some((command) => !command.startsWith("C"))) {
    throw new Error(`Unexpected bloub body path: ${path.slice(0, 40)}`);
  }
  const [x, y] = numbers(move.slice(1));
  const curves = rest.flatMap((command) => {
    const values = numbers(command.slice(1));
    const out: Curve[] = [];
    for (let index = 0; index + 6 <= values.length; index += 6) {
      out.push(values.slice(index, index + 6) as Curve);
    }
    return out;
  });
  return { start: [x!, y!], curves };
}

function capsule(path: string, matrix: string): Eye {
  const values = numbers(path);
  const transform = numbers(matrix);
  if (values.length < 9 || transform.length !== 6) {
    throw new Error(`Unexpected bloub eye: ${path} ${matrix}`);
  }
  return {
    halfWidth: -values[0]!,
    halfHeight: -values[8]!,
    radius: values[2]!,
    matrix: transform,
  };
}

export function notificationAvatarShapes(): NotificationAvatarShape[] {
  return SHAPES.map((shape) => {
    const engine = new BotEngine(RAYON, "idle", shape.radii);
    engine.reset("idle", 0);
    engine.setShape(shape.radii, -BotEngine.SHAPE_MORPH);
    const frame = engine.sample(1);
    if (frame.bodyAlpha !== 1 || frame.eyes.some((eye) => eye.alpha !== 1)) {
      throw new Error(`The resting ${shape.id} bloub is not fully opaque`);
    }
    return {
      ...bodyOutline(frame.bodyPath),
      eyes: frame.eyes.map((eye) => capsule(eye.d, eye.matrix)),
    };
  });
}

function swiftNumber(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? `${rounded}.0` : String(rounded);
}

function swiftList(values: readonly number[]): string {
  return `[${values.map(swiftNumber).join(", ")}]`;
}

export function notificationAvatarSwift(): string {
  const shapes = notificationAvatarShapes()
    .map((shape) => {
      const curves = shape.curves.map((curve) => `      ${swiftList(curve)},`).join("\n");
      const eyes = shape.eyes
        .map(
          (eye) =>
            `      AvatarEye(halfWidth: ${swiftNumber(eye.halfWidth)}, halfHeight: ${swiftNumber(eye.halfHeight)}, radius: ${swiftNumber(eye.radius)}, matrix: ${swiftList(eye.matrix)}),`,
        )
        .join("\n");
      return `  AvatarShape(\n    start: ${swiftList(shape.start)},\n    curves: [\n${curves}\n    ],\n    eyes: [\n${eyes}\n    ]\n  ),`;
    })
    .join("\n");
  return `import CoreGraphics

struct AvatarEye {
  let halfWidth: CGFloat
  let halfHeight: CGFloat
  let radius: CGFloat
  let matrix: [CGFloat]
}

struct AvatarShape {
  let start: [CGFloat]
  let curves: [[CGFloat]]
  let eyes: [AvatarEye]
}

let avatarRadius: CGFloat = ${swiftNumber(RAYON)}
let avatarBackground = "${darkTokens.background}"
let avatarLightPaper = "${AVATAR_INK.lightPaper}"
let avatarDarkPaper = "${AVATAR_INK.darkPaper}"
let avatarOutline = "${AVATAR_INK.outline}"
let avatarLightPaperBelow: CGFloat = ${swiftNumber(AVATAR_INK.lightPaperBelow)}
let avatarOutlineAbove: CGFloat = ${swiftNumber(AVATAR_INK.outlineAbove)}

let avatarShapes: [AvatarShape] = [
${shapes}
]
`;
}
