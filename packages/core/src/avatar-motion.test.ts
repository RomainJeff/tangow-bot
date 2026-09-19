import { describe, expect, it } from "vitest";
import { GLANCE_MORPH, nextWorkingGlance, WORKING_MOODS } from "./avatar-motion.js";

/** Deterministic stand-in for `Math.random`, cycling through fixed draws. */
function draws(values: number[]): () => number {
  let index = 0;
  return () => values[index++ % values.length]!;
}

describe("working glance choreography", () => {
  it("keeps the look inside the head's comfortable range", () => {
    for (const value of [0, 0.25, 0.5, 0.75, 0.999]) {
      const { look, delay } = nextWorkingGlance(draws([value]));
      expect(look.yaw).toBeGreaterThanOrEqual(-26);
      expect(look.yaw).toBeLessThanOrEqual(26);
      expect(look.pitch).toBeGreaterThanOrEqual(-8);
      expect(look.pitch).toBeLessThanOrEqual(18);
      expect(look.mix).toBe(1);
      // Spin rolls the head, which makes the eyes jump between moods.
      expect(look.spin).toBe(0);
      expect(delay).toBeGreaterThanOrEqual(1.2);
      expect(delay).toBeLessThanOrEqual(3.6);
    }
  });

  it("only picks moods the head wears without rolling", () => {
    const moods = new Set(Array.from({ length: 64 }, () => nextWorkingGlance().mood));
    for (const mood of moods) expect(WORKING_MOODS).toContain(mood);
  });

  it("draws a different glance each time", () => {
    const first = nextWorkingGlance(draws([0.1, 0.2, 0.3, 0.4]));
    const second = nextWorkingGlance(draws([0.9, 0.8, 0.7, 0.6]));
    expect(first).not.toEqual(second);
    expect(GLANCE_MORPH).toBeGreaterThan(0);
  });
});
