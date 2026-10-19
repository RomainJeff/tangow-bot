import { describe, expect, it } from "vitest";
import { toolRequiresApproval, toolRequiresExplicitApproval } from "./action-approval.js";
import { defaultSkillAvailability, isSkillVisible } from "./skill-access.js";

describe("memory management is explicitly assigned", () => {
  it("does not enable memory management on ordinary bots", () => {
    const availability = defaultSkillAvailability("builtin:memory-management");
    expect(availability).toBe("selected");
    expect(isSkillVisible({ availability })).toBe(false);
    expect(isSkillVisible({ availability, override: true })).toBe(true);
    expect(isSkillVisible({ availability: "disabled", override: true })).toBe(false);
  });
  it.each(["prepare_memory_method", "review_memory_classification", "change_memory"])(
    "requires exact human approval for %s, even with auto-review",
    (tool) => {
      expect(toolRequiresApproval(tool, false)).toBe(true);
      expect(toolRequiresExplicitApproval(tool)).toBe(true);
    },
  );
});
