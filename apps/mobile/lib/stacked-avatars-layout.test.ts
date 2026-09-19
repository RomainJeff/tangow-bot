import { describe, expect, it } from "vitest";
import { STACKED_AVATAR_OVERLAP, stackedAvatarsLayout } from "./stacked-avatars-layout";

describe("STACKED_AVATAR_OVERLAP", () => {
  it("defines an overlap for every supported size", () => {
    expect(STACKED_AVATAR_OVERLAP[14]).toBe(3);
    expect(STACKED_AVATAR_OVERLAP[16]).toBe(4);
    expect(STACKED_AVATAR_OVERLAP[17]).toBe(4);
    expect(STACKED_AVATAR_OVERLAP[20]).toBe(5);
  });
});

describe("stackedAvatarsLayout", () => {
  it("shows every item when there are fewer than max", () => {
    const { shown, overflow } = stackedAvatarsLayout(["a", "b"], 3);
    expect(shown).toEqual(["a", "b"]);
    expect(overflow).toBe(0);
  });

  it("caps the shown items at max and counts the rest as overflow", () => {
    const { shown, overflow } = stackedAvatarsLayout(["a", "b", "c", "d", "e"], 3);
    expect(shown).toEqual(["a", "b", "c"]);
    expect(overflow).toBe(2);
  });

  it("never overflows negative when there are no items", () => {
    const { shown, overflow } = stackedAvatarsLayout([], 3);
    expect(shown).toEqual([]);
    expect(overflow).toBe(0);
  });
});
