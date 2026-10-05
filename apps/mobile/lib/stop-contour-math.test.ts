import { describe, expect, it } from "vitest";
import { hexWithAlpha, stopContourSweepOpacities } from "./stop-contour-math";

describe("stopContourSweepOpacities", () => {
  it("peaks at a quarter and three-quarters turn, troughs at 0, half and a full turn", () => {
    const opacities = stopContourSweepOpacities(8);
    // Index 0 -> turn 0 (trough), index 2 -> turn .25 (peak),
    // index 4 -> turn .5 (trough), index 6 -> turn .75 (peak).
    expect(opacities[0]).toBeCloseTo(0);
    expect(opacities[2]).toBeCloseTo(1);
    expect(opacities[4]).toBeCloseTo(0);
    expect(opacities[6]).toBeCloseTo(1);
  });

  it("ramps linearly between a trough and the next peak", () => {
    const opacities = stopContourSweepOpacities(8);
    // Index 1 -> turn .125, the midpoint between the trough at 0 and the peak at .25.
    expect(opacities[1]).toBeCloseTo(0.5);
  });

  it("returns two full laps of peaks and troughs — one array covering the whole ring", () => {
    const opacities = stopContourSweepOpacities(48);
    expect(opacities).toHaveLength(48);
    expect(Math.max(...opacities)).toBeCloseTo(1);
    expect(Math.min(...opacities)).toBeGreaterThanOrEqual(0);
  });

  it("is empty for a non-positive segment count", () => {
    expect(stopContourSweepOpacities(0)).toEqual([]);
    expect(stopContourSweepOpacities(-3)).toEqual([]);
  });
});

describe("hexWithAlpha", () => {
  it("expands a 6-digit hex with the alpha channel", () => {
    expect(hexWithAlpha("#112233", 1)).toBe("#112233ff");
    expect(hexWithAlpha("#112233", 0)).toBe("#11223300");
  });

  it("expands a shorthand 3-digit hex before appending alpha", () => {
    expect(hexWithAlpha("#123", 1)).toBe("#112233ff");
  });

  it("clamps out-of-range alpha", () => {
    expect(hexWithAlpha("#000000", 2)).toBe("#000000ff");
    expect(hexWithAlpha("#000000", -1)).toBe("#00000000");
  });

  it("passes through a non-hex colour unchanged", () => {
    expect(hexWithAlpha("rgb(1,2,3)", 0.5)).toBe("rgb(1,2,3)");
  });
});
