import { describe, expect, it } from "vitest";
import {
  LAUNCH_CHOREOGRAPHY,
  LAUNCH_LOOP_FROM_INDEX,
  LAUNCH_WAKE_UP_MINIMUM_SECONDS,
} from "./launch-choreography.js";

describe("launch choreography", () => {
  it("starts asleep, looking down, and ends on a proud up-right glance", () => {
    const first = LAUNCH_CHOREOGRAPHY[0]!;
    const last = LAUNCH_CHOREOGRAPHY.at(-1)!;
    expect(first.mood).toBe("somnolent");
    expect(first.look?.pitch).toBeLessThan(0);
    expect(last.mood).toBe("fier");
    expect(last.look?.yaw).toBeGreaterThan(0);
    expect(last.look?.pitch).toBeGreaterThan(0);
  });

  it("holds every step for a positive, finite duration", () => {
    for (const step of LAUNCH_CHOREOGRAPHY) {
      expect(step.holdSeconds).toBeGreaterThan(0);
      expect(Number.isFinite(step.holdSeconds)).toBe(true);
    }
  });

  it("never lets a look drive without mixing in (or the mood's own gaze wins by accident)", () => {
    for (const step of LAUNCH_CHOREOGRAPHY) {
      if (step.look) expect(step.look.mix).toBe(1);
    }
  });

  it("sizes the wake-up minimum to exactly the asleep + startled steps", () => {
    const expected = LAUNCH_CHOREOGRAPHY[0]!.holdSeconds + LAUNCH_CHOREOGRAPHY[1]!.holdSeconds;
    expect(LAUNCH_WAKE_UP_MINIMUM_SECONDS).toBeCloseTo(expected);
    expect(LAUNCH_WAKE_UP_MINIMUM_SECONDS).toBeGreaterThan(0);
  });

  it("loops back to the looking-left step, never replaying the wake-up", () => {
    const loopStep = LAUNCH_CHOREOGRAPHY[LAUNCH_LOOP_FROM_INDEX]!;
    expect(loopStep.mood).toBe("neutre");
    expect(loopStep.look?.yaw).toBeLessThan(0);
    expect(LAUNCH_LOOP_FROM_INDEX).toBeGreaterThan(1);
    expect(LAUNCH_LOOP_FROM_INDEX).toBeLessThan(LAUNCH_CHOREOGRAPHY.length - 1);
  });
});
