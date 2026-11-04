import { describe, expect, it } from "vitest";
import { coverFromTop, stackFrame } from "./image-stack";

describe("coverFromTop", () => {
  const frame = stackFrame(300);

  it("fills the frame from its top edge with a tall screenshot, cropping the bottom", () => {
    expect(coverFromTop(frame, { width: 1000, height: 3000 })).toEqual({
      left: 0,
      top: 0,
      width: 300,
      height: 900,
    });
  });

  it("centres a wide picture sideways and keeps its top on the frame's", () => {
    expect(coverFromTop(frame, { width: 2000, height: 1000 })).toEqual({
      left: -75,
      top: 0,
      width: 450,
      height: 225,
    });
  });
});
