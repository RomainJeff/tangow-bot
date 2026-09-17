import { describe, expect, it } from "vitest";
import {
  lerpPose,
  REST_POSE,
  SWOOSH_COUNT,
  swooshPath,
  WORKING_CYCLE_SECONDS,
  WORKING_STILL_SECONDS,
  workingPose,
} from "./avatar-motion.js";

describe("working avatar pose", () => {
  it("starts at rest, holds expressions, blinks on entry and plays once per cycle", () => {
    expect(WORKING_CYCLE_SECONDS).toBeCloseTo(17.6);
    expect(workingPose(0)).toEqual(REST_POSE);

    // Attentive hold: wider capsules, head turned toward the viewer (down-left).
    const still = workingPose(WORKING_STILL_SECONDS);
    expect(still.eyes.scale[0][0]).toBeCloseTo(0.21 / 0.186, 1);
    expect(still.eyes.x).toBeLessThan(-0.1);
    expect(still.eyes.y).toBeGreaterThan(0.1);
    expect(still.swoosh.opacity).toBe(0);

    // Blink: eyes squash vertically right after a state change.
    const blink = workingPose(2.8 + 0.12);
    expect(blink.eyes.scale[0][1]).toBeLessThan(0.2);
    expect(blink.eyes.scale[1][1]).toBeLessThan(0.2);

    // Happy: mirrored tilts.
    const happy = workingPose(2.8 + 2.6 + 1.5);
    expect(happy.eyes.tilt[0]).toBeCloseTo(14);
    expect(happy.eyes.tilt[1]).toBeCloseTo(-14);

    // Play: swoosh visible mid-state, hidden again at the neutral tail.
    const playStart = 2.8 + 2.6 + 2.4 + 1.6 + 2.6 + 1.6;
    expect(workingPose(playStart + 1).swoosh.opacity).toBe(1);
    expect(workingPose(playStart + 2.2 + 1.5).swoosh.opacity).toBe(0);
  });

  it("draws the swoosh arcs as SVG polylines sweeping leftwards", () => {
    expect(SWOOSH_COUNT).toBe(4);
    const early = swooshPath(0, 0.2, 48);
    const late = swooshPath(0, 1.8, 48);
    expect(early).toMatch(/^M-?\d+\.\d\d -?\d+\.\d\d(L-?\d+\.\d\d -?\d+\.\d\d){24}$/);
    const startX = (d: string) => Number(d.slice(1).split(" ")[0]);
    expect(startX(late)).toBeLessThan(startX(early));
  });

  it("lerps every channel", () => {
    const wink = workingPose(2.8 + 2.6 + 2.4 + 1.6 + 2.6 + 1.5);
    const half = lerpPose(REST_POSE, wink, 0.5);
    expect(half.eyes.scale[1][1]).toBeCloseTo((1 + wink.eyes.scale[1][1]) / 2);
    expect(half.eyes.roll).toBeCloseTo(wink.eyes.roll / 2);
    expect(half.eyes.x).toBeCloseTo(wink.eyes.x / 2);
  });
});
