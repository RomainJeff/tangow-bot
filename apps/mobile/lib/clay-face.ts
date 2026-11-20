import expressionsFile from "@tangow/avatars/face/expressions.json";
import faceFile from "@tangow/avatars/face/visages.json";
import type {
  CharacterFace,
  ExpressionsFile,
  EyePose,
  FaceFile,
  FaceState,
  HeadPose,
  MouthShape,
} from "@tangow/contracts";
import { characterById, eyeTargets, headTarget, mouthShape, settingsOf } from "@tangow/contracts";

export const FACES: FaceFile = faceFile;
const EXPRESSIONS: ExpressionsFile = expressionsFile;

/** The face of a catalogue character; missing or unknown is the neutral character's. */
export function faceFor(character: string | null | undefined): CharacterFace {
  const { id } = characterById(character);
  return FACES.persos.find((face) => face.id === id) ?? FACES.persos[0]!;
}

/** A face's pose: both eyes, the lean of the head, the mouth. Looking at you sets the gaze ahead. */
export interface FacePose {
  eyes: EyePose[];
  head: HeadPose;
  mouth: MouthShape;
}

export function poseOf(
  face: CharacterFace,
  state: Pick<FaceState, "expression" | "gaze">,
): FacePose {
  const settings = settingsOf(EXPRESSIONS, state.expression);
  const eyes = eyeTargets(face, settings);
  return {
    eyes: state.gaze === "user" ? eyes.map((eye) => ({ ...eye, gx: 0, gy: 0 })) : eyes,
    head: headTarget(settings),
    mouth: mouthShape(face.bouche, face.yeux[0]!.r, settings),
  };
}

function mix<T extends object>(from: T, to: T, k: number): T {
  const out = { ...from };
  for (const key of Object.keys(to) as Array<keyof T>) {
    const a = from[key] as number;
    (out[key] as number) = a + ((to[key] as number) - a) * k;
  }
  return out;
}

/** The pose `k` of the way from one pose to another. */
export function mixPose(from: FacePose, to: FacePose, k: number): FacePose {
  return {
    eyes: from.eyes.map((eye, i) => mix(eye, to.eyes[i]!, k)),
    head: mix(from.head, to.head, k),
    mouth: mix(from.mouth, to.mouth, k),
  };
}

/** Whether two poses are drawn the same, so there is nothing to ease. */
export function samePose(a: FacePose, b: FacePose): boolean {
  const same = (x: object, y: object) =>
    Object.entries(x).every(([key, value]) => (y as Record<string, unknown>)[key] === value);
  return (
    a.eyes.every((eye, i) => same(eye, b.eyes[i]!)) &&
    same(a.head, b.head) &&
    same(a.mouth, b.mouth)
  );
}
