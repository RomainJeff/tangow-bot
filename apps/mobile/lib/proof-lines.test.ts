import { describe, expect, it } from "vitest";
import { PROOF_LINE_GAP, proofLineHitSlop } from "./proof-lines";
import { nativeTextStyle } from "./typography";

describe("proof lines under a bubble", () => {
  it("gives a line standing alone the 44 pt touch height the design asks for", () => {
    const text = nativeTextStyle("meta").lineHeight;
    expect(text + 2 * proofLineHitSlop(1)).toBeGreaterThanOrEqual(44);
  });

  it("keeps the touch areas of stacked lines from overlapping", () => {
    expect(2 * proofLineHitSlop(2)).toBeLessThanOrEqual(PROOF_LINE_GAP);
    expect(2 * proofLineHitSlop(3)).toBeLessThanOrEqual(PROOF_LINE_GAP);
  });
});
