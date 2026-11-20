import { describe, expect, it } from "vitest";
import { faceFor } from "./clay-face";

describe("clay face on iPhone", () => {
  it.each([null, undefined, "", "__proto__", "<svg/onload=1>", "x".repeat(10_000)])(
    "draws the neutral face for %j",
    (id) => {
      expect(faceFor(id).id).toBe("scout");
    },
  );
});
