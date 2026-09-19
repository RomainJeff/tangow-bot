import { AVATAR_SHAPE_COUNT } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { avatarIdentitySeed, avatarShapeFamily, organicAvatarPath } from "./avatar-shape.js";

describe("organic avatar geometry", () => {
  it("is stable for an identity and repeats by shape family", () => {
    const first = organicAvatarPath(avatarIdentitySeed("research"));
    expect(first).toBe(organicAvatarPath(avatarIdentitySeed("research")));
    // Identity variation comes from the 12 silhouettes + hue, so two seeds that
    // land on the same family share an identical, deterministic path.
    expect(organicAvatarPath(3)).toBe(organicAvatarPath(3 + AVATAR_SHAPE_COUNT));
  });

  it("emits only path geometry from a numeric seed", () => {
    const path = organicAvatarPath(42);
    // roundPoly filleting emits both curve (C) and line (L) commands.
    expect(path).toMatch(/^M[-0-9. ]+(?:[CL][-0-9. ]+)+Z$/);
    expect(path).not.toMatch(/<|>|javascript:|url\(/i);
  });

  it("produces twelve distinct constructed shape families", () => {
    const families = Array.from({ length: AVATAR_SHAPE_COUNT }, (_, seed) =>
      organicAvatarPath(seed),
    );
    expect(new Set(families)).toHaveLength(AVATAR_SHAPE_COUNT);
    expect(families.every((path) => path.startsWith("M") && path.endsWith("Z"))).toBe(true);
    expect(families.every((path) => (path.match(/C/g) ?? []).length >= 3)).toBe(true);
  });

  it("maps a seed to a family within range", () => {
    for (let seed = 0; seed < AVATAR_SHAPE_COUNT * 3; seed += 1) {
      const family = avatarShapeFamily(seed);
      expect(family).toBeGreaterThanOrEqual(0);
      expect(family).toBeLessThan(AVATAR_SHAPE_COUNT);
    }
  });
});
