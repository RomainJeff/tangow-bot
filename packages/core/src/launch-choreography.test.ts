import { describe, expect, it } from "vitest";
import {
  LAUNCH_CHOREOGRAPHY,
  LAUNCH_LOOP_FROM_INDEX,
  LAUNCH_WAKE_UP_LAST_INDEX,
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

  it("plays the whole wake-up, through the smile, before the splash may leave", () => {
    expect(LAUNCH_CHOREOGRAPHY[LAUNCH_WAKE_UP_LAST_INDEX]!.mood).toBe("heureux");
    const expected = LAUNCH_CHOREOGRAPHY.slice(0, LAUNCH_WAKE_UP_LAST_INDEX + 1).reduce(
      (total, step) => total + step.holdSeconds,
      0,
    );
    expect(LAUNCH_WAKE_UP_MINIMUM_SECONDS).toBeCloseTo(expected);
    expect(LAUNCH_WAKE_UP_MINIMUM_SECONDS).toBeGreaterThan(1.5);
    expect(LAUNCH_WAKE_UP_MINIMUM_SECONDS).toBeLessThan(2.5);
  });

  it("loops back to the looking-left step, never replaying the wake-up", () => {
    const loopStep = LAUNCH_CHOREOGRAPHY[LAUNCH_LOOP_FROM_INDEX]!;
    expect(loopStep.mood).toBe("neutre");
    expect(loopStep.look?.yaw).toBeLessThan(0);
    expect(LAUNCH_LOOP_FROM_INDEX).toBeGreaterThan(1);
    expect(LAUNCH_LOOP_FROM_INDEX).toBeLessThan(LAUNCH_CHOREOGRAPHY.length - 1);
  });
});
