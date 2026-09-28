import { describe, expect, it } from "vitest";
import { hoverPillPlacement } from "./hover-pill-placement";

const frame = { left: 100, top: 0, right: 800, bottom: 60 };
const pill = { width: 150, height: 34 };

describe("hoverPillPlacement", () => {
  it("puts the pill after a short bot bubble, level with its line", () => {
    const bubble = { left: 100, top: 10, right: 160, bottom: 52 };
    expect(hoverPillPlacement({ frame, pill, bubble })).toEqual({ x: 68, y: 14 });
  });

  it("keeps a tall bubble's pill level with its first line", () => {
    const bubble = { left: 100, top: 0, right: 400, bottom: 300 };
    expect(hoverPillPlacement({ frame, pill, bubble })?.y).toBe(4);
  });

  it("falls back to the corner when the bubble leaves no room beside it", () => {
    const bubble = { left: 100, top: 0, right: 700, bottom: 42 };
    expect(hoverPillPlacement({ frame, pill, bubble })).toBeNull();
  });

  it("keeps a card at the corner", () => {
    expect(hoverPillPlacement({ frame, pill })).toBeNull();
  });
});
