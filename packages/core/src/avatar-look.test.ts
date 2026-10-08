import { describe, expect, it } from "vitest";
import { pointerGaze, pointerLook } from "./avatar-look.js";

const rect = { left: 100, top: 200, width: 40, height: 20 };

describe("pointerLook", () => {
  it.each([
    ["the centre", { x: 120, y: 210 }, { yaw: 0, pitch: 0 }],
    ["the right edge", { x: 140, y: 210 }, { yaw: 1, pitch: 0 }],
    ["the left edge", { x: 100, y: 210 }, { yaw: -1, pitch: 0 }],
    ["the top edge", { x: 120, y: 200 }, { yaw: 0, pitch: 1 }],
    ["the bottom edge", { x: 120, y: 220 }, { yaw: 0, pitch: -1 }],
    ["halfway to the right", { x: 130, y: 210 }, { yaw: 0.5, pitch: 0 }],
    ["far past the corner", { x: 5000, y: -5000 }, { yaw: 1, pitch: 1 }],
    ["far past the other corner", { x: -5000, y: 5000 }, { yaw: -1, pitch: -1 }],
  ])("maps %s", (_, pointer, expected) => {
    expect(pointerLook(pointer, rect)).toEqual(expected);
  });

  it.each([
    ["no width", { left: 0, top: 0, width: 0, height: 20 }],
    ["no height", { left: 0, top: 0, width: 40, height: 0 }],
    ["NaN size", { left: 0, top: 0, width: Number.NaN, height: 20 }],
  ])("looks straight ahead in a box with %s", (_, empty) => {
    expect(pointerLook({ x: 10, y: 10 }, empty)).toEqual({ yaw: 0, pitch: 0 });
  });

  it("never returns -0", () => {
    expect(Object.is(pointerLook({ x: 120, y: 210 }, rect).yaw, 0)).toBe(true);
  });
});

describe("pointerGaze", () => {
  it("keeps straight ahead straight and lands the edges on the glance range", () => {
    expect(pointerGaze({ yaw: 0, pitch: 0 })).toEqual({
      yaw: 0,
      pitch: 0,
      mix: 1,
      spin: 0,
      wander: 0,
    });
    expect(pointerGaze({ yaw: 1, pitch: 1 })).toMatchObject({ yaw: 26, pitch: 18 });
    expect(pointerGaze({ yaw: -1, pitch: -1 })).toMatchObject({ yaw: -26, pitch: -8 });
  });
});
