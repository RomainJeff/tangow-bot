import { describe, expect, it } from "vitest";
import { memoryDateInput, memoryDateValue } from "./memory-validity.js";

describe("memory validity dates", () => {
  it("preserves a precise timestamp when its displayed date was not edited", () => {
    const original = "2026-09-21T14:17:00.123Z";
    expect(memoryDateValue(memoryDateInput(original), original, "end")).toBe(original);
  });
  it("includes the whole last day and can clear a prior bound", () => {
    expect(memoryDateValue("2026-09-21", null, "start")).toBe("2026-09-21T00:00:00.000Z");
    expect(memoryDateValue("2026-09-21", null, "end")).toBe("2026-09-21T23:59:59.999Z");
    expect(memoryDateValue("", "2026-09-21T00:00:00.000Z", "start")).toBeNull();
  });
});
