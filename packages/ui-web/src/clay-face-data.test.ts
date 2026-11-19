import { AVATAR_CHARACTERS } from "@tangow/contracts";
import { describe, expect, it } from "vitest";
import { EXPRESSIONS, faceFor } from "./clay-face-data.js";

describe("clay face data", () => {
  it.each(AVATAR_CHARACTERS.map(({ id }) => id))("draws %s with its own face", (id) => {
    expect(faceFor(id).id).toBe(id);
  });

  it.each([null, "<svg/onload=1>"])("draws the neutral face for %j", (id) => {
    expect(faceFor(id).id).toBe("scout");
  });

  it("knows every character's default expression", () => {
    const missing = AVATAR_CHARACTERS.map(({ id }) => faceFor(id).defaut).filter(
      (key) => !(key in EXPRESSIONS.expressions),
    );
    expect(missing).toEqual([]);
  });
});
