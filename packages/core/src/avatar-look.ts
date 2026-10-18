import { LOOK_PITCH_DEG, LOOK_YAW_DEG } from "./avatar-motion.js";
import type { Look } from "./bloub/engine.js";

export interface PointerLook {
  /** -1 = the pointer is a half-width or more to the left of the centre, 1 = to the right. */
  yaw: number;
  /** -1 = a half-height or more below the centre, 1 = above (the engine's pitch is positive upward). */
  pitch: number;
}

export interface PointerRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const clamp = (value: number) => Math.max(-1, Math.min(1, value));

/**
 * Where an avatar should look for a pointer, relative to the avatar's own box:
 * zero at its centre, +-1 at its edges, held there beyond. A zero-size box has no
 * centre to look from, so it looks straight ahead.
 */
export function pointerLook(pointer: { x: number; y: number }, rect: PointerRect): PointerLook {
  if (!(rect.width > 0) || !(rect.height > 0)) return { yaw: 0, pitch: 0 };
  const yaw = (pointer.x - (rect.left + rect.width / 2)) / (rect.width / 2);
  const pitch = (rect.top + rect.height / 2 - pointer.y) / (rect.height / 2);
  return { yaw: clamp(yaw) || 0, pitch: clamp(pitch) || 0 };
}

/**
 * The engine look for a pointer look. Straight ahead stays straight ahead; the
 * edges land on the ends of the working glance's range, which is deeper upward
 * than downward.
 */
export function pointerGaze({ yaw, pitch }: PointerLook): Look {
  return {
    yaw: yaw * LOOK_YAW_DEG,
    pitch: pitch >= 0 ? pitch * LOOK_PITCH_DEG.max : -pitch * LOOK_PITCH_DEG.min,
    mix: 1,
    spin: 0,
    wander: 0,
  };
}
