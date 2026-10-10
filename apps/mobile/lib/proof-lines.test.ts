import { describe, expect, it } from "vitest";
import { PROOF_LINE_DELAY_MS, PROOF_LINE_GAP, proofLineHitSlop } from "./proof-lines";

describe("proof lines under a bubble", () => {
  it("gives a line standing alone the 44 pt touch height the design asks for", () => {
    const text = 16;
    expect(text + 2 * proofLineHitSlop(1)).toBeGreaterThanOrEqual(44);
  });

  it("keeps the touch areas of stacked lines from overlapping", () => {
    expect(2 * proofLineHitSlop(2)).toBeLessThanOrEqual(PROOF_LINE_GAP);
    expect(2 * proofLineHitSlop(3)).toBeLessThanOrEqual(PROOF_LINE_GAP);
  });

  it("waits the same half arrival as web before a live line rises", () => {
    expect(PROOF_LINE_DELAY_MS).toBe(120);
  });
});
