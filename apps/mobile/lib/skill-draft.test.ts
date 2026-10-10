import { describe, expect, it } from "vitest";
import { skillDirty, skillText } from "./skill-draft";

const loaded = "---\nname: Coffee\n---\nGrind, brew.";

describe("the SKILL.md field", () => {
  it("shows the loaded SKILL.md when nobody is editing", () => {
    expect(skillText(loaded, null)).toBe(loaded);
    expect(skillText(null, null)).toBe("");
  });

  it("shows the draft while editing", () => {
    expect(skillText(loaded, "Grind, brew, serve.")).toBe("Grind, brew, serve.");
  });

  it("is dirty only while the draft differs from what the server holds", () => {
    expect(skillDirty(loaded, null)).toBe(false);
    expect(skillDirty(loaded, loaded)).toBe(false);
    expect(skillDirty(loaded, "Grind.")).toBe(true);
    expect(skillDirty(null, "Grind.")).toBe(false);
  });
});
