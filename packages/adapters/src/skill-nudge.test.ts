import { describe, expect, it } from "vitest";
import { SKILL_NUDGE_TOOL_DEFS } from "./skill-nudge.js";

describe("the skill nudge's tools", () => {
  it("offer no draft folder, in their schema or in their description", () => {
    expect(SKILL_NUDGE_TOOL_DEFS.map((tool) => tool.name).sort()).toEqual([
      "skill_create",
      "skill_read",
      "skill_search",
      "skill_update",
    ]);
    for (const tool of SKILL_NUDGE_TOOL_DEFS) {
      const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties;
      expect(properties).not.toHaveProperty("path");
      expect(tool.description).not.toMatch(/\bpass path\b|workspace folder/i);
    }
  });
});
