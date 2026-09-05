import { describe, expect, it } from "vitest";
import { asSkillAvailability, isSkillVisible, userSkillKey } from "./skill-access.js";

describe("skill access", () => {
  it("derives a stable key from the case-insensitive unique name", () => {
    expect(userSkillKey("Daily standup")).toBe("user:daily standup");
    expect(userSkillKey("  DAILY STANDUP ")).toBe("user:daily standup");
  });

  it("defaults to visible when nothing is configured", () => {
    expect(isSkillVisible({})).toBe(true);
    expect(isSkillVisible({ availability: "all" })).toBe(true);
    expect(isSkillVisible({ availability: "selected" })).toBe(false);
  });

  it("lets a bot override win over availability", () => {
    expect(isSkillVisible({ availability: "all", override: false })).toBe(false);
    expect(isSkillVisible({ availability: "selected", override: true })).toBe(true);
    expect(isSkillVisible({ availability: "selected", override: null })).toBe(false);
  });

  it("coerces unknown availability strings to all", () => {
    expect(asSkillAvailability("selected")).toBe("selected");
    expect(asSkillAvailability("garbage")).toBe("all");
    expect(asSkillAvailability(undefined)).toBe("all");
  });
});
