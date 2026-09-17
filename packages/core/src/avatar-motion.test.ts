import { describe, expect, it } from "vitest";
import {
  lerpPose,
  REST_POSE,
  WORKING_CYCLE_SECONDS,
  WORKING_STILL_SECONDS,
  workingPose,
} from "./avatar-motion.js";

describe("working avatar pose", () => {
  it("starts at rest, cycles, and shows the thinking dots on the still frame", () => {
    expect(WORKING_CYCLE_SECONDS).toBe(11.4);
    expect(workingPose(0)).toEqual(REST_POSE);
    expect(workingPose(WORKING_CYCLE_SECONDS + 0.5)).toEqual(REST_POSE);

    const still = workingPose(WORKING_STILL_SECONDS);
    expect(still.eyes.opacity).toBe(0);
    expect(still.body.sx).toBeLessThan(0.25);
    expect(still.dots[0].x).toBeCloseTo(-0.557);
    expect(still.dots[2].x).toBeCloseTo(0.532);
    expect(still.dots[1].opacity).toBe(0);

    // Entry morph: body half-way between ball and dot early in thinking.
    const entering = workingPose(1.05);
    expect(entering.body.sx).toBeGreaterThan(still.body.sx);
    expect(entering.body.sx).toBeLessThan(1);
  });

  it("lerps every channel", () => {
    const wink = workingPose(1 + 2.6 + 1.5);
    const half = lerpPose(REST_POSE, wink, 0.5);
    expect(half.eyes.scale[1][1]).toBeCloseTo((1 + wink.eyes.scale[1][1]) / 2);
    expect(half.eyes.roll).toBeCloseTo(wink.eyes.roll / 2);
  });
});
