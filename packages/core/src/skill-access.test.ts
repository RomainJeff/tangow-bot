import { describe, expect, it } from "vitest";
import {
  asSkillAvailability,
  defaultSkillAvailability,
  isMarketplaceSkillKey,
  isSkillVisible,
  marketplaceSkillKey,
  userSkillKey,
} from "./skill-access.js";

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

  it("disabled hides the skill even from a bot with an explicit include", () => {
    expect(isSkillVisible({ availability: "disabled" })).toBe(false);
    expect(isSkillVisible({ availability: "disabled", override: true })).toBe(false);
    expect(isSkillVisible({ availability: "disabled", override: false })).toBe(false);
  });

  it("builds and recognises marketplace keys", () => {
    expect(marketplaceSkillKey("acme", "writer", "blog-post")).toBe("mkt:acme/writer/blog-post");
    expect(isMarketplaceSkillKey("mkt:a/b/c")).toBe(true);
    expect(isMarketplaceSkillKey("user:a")).toBe(false);
  });

  it("hides marketplace skills by default, keeps user skills visible", () => {
    expect(defaultSkillAvailability("mkt:a/b/c")).toBe("selected");
    expect(defaultSkillAvailability("user:x")).toBe("all");
  });

  it("coerces unknown availability strings to all", () => {
    expect(asSkillAvailability("selected")).toBe("selected");
    expect(asSkillAvailability("disabled")).toBe("disabled");
    expect(asSkillAvailability("garbage")).toBe("all");
    expect(asSkillAvailability(undefined)).toBe("all");
  });
});
