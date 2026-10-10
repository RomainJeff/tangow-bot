import { describe, expect, it } from "vitest";
import { routineFailing } from "./routine-failing.js";

describe("routineFailing", () => {
  it("holds while a routine that is on last finished with a failure", () => {
    expect(routineFailing({ active: true, lastRunStatus: "failed" })).toBe(true);
  });

  it("clears once a later run succeeds or is cancelled", () => {
    expect(routineFailing({ active: true, lastRunStatus: "succeeded" })).toBe(false);
    expect(routineFailing({ active: true, lastRunStatus: "cancelled" })).toBe(false);
  });

  it("does not hold for a routine that never ran or is paused", () => {
    expect(routineFailing({ active: true, lastRunStatus: null })).toBe(false);
    expect(routineFailing({ active: false, lastRunStatus: "failed" })).toBe(false);
  });
});
