import { describe, expect, it } from "vitest";
import { applyPicks } from "./group-picks.js";

describe("applyPicks", () => {
  it("does not add back someone who left while the settings were open", () => {
    expect(applyPicks(["b"], ["a", "b"], ["a", "b"])).toEqual(["b"]);
  });

  it("applies what was ticked and unticked to the group as it is now", () => {
    expect(applyPicks(["a", "b", "c"], ["a", "b"], ["b", "d"])).toEqual(["b", "c", "d"]);
  });
});
