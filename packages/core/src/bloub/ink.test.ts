import { describe, expect, it } from "vitest";
import { AVATAR_INK, avatarInk } from "./ink.js";

describe("avatarInk", () => {
  it("punches light eyes into a dark body and outlines a pale one", () => {
    expect(avatarInk("#101014")).toEqual({ paper: AVATAR_INK.lightPaper, outline: null });
    expect(avatarInk("#E5484D")).toEqual({ paper: AVATAR_INK.darkPaper, outline: null });
    expect(avatarInk("#FFF")).toEqual({ paper: AVATAR_INK.darkPaper, outline: AVATAR_INK.outline });
  });
});
