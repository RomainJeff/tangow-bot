import { describe, expect, it } from "vitest";
import { avatarIdentitySeed } from "./avatar-identity.js";
import { SHAPES } from "./bloub/index.js";

describe("avatarIdentitySeed", () => {
  it("is stable for an identity", () => {
    expect(avatarIdentitySeed("research")).toBe(avatarIdentitySeed("research"));
    expect(avatarIdentitySeed("research")).not.toBe(avatarIdentitySeed("github"));
  });

  it("always lands on a shape in the catalogue", () => {
    for (const identity of ["maya", "github", "", "ïvo", "a".repeat(200)]) {
      const shape = SHAPES[avatarIdentitySeed(identity) % SHAPES.length];
      expect(shape).toBeDefined();
    }
  });
});
