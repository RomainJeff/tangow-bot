import { SPAWN_BOT_INSTRUCTIONS_MAX_LENGTH, SPAWN_BOT_PROMPT_MAX_LENGTH } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";

describe("spawn_bot tool description", () => {
  const description = builtinAgentTools.find((tool) => tool.name === "spawn_bot")?.description;

  it("tells the model the user approves from a card, and the field limits", () => {
    expect(description).toMatch(/approval card/);
    expect(description).toContain(`at most ${SPAWN_BOT_INSTRUCTIONS_MAX_LENGTH} characters`);
    expect(description).toContain(`prompt at most ${SPAWN_BOT_PROMPT_MAX_LENGTH}`);
  });
});

describe("skill_update tool", () => {
  it("offers no way to rename the skill: a bot keeps its name", () => {
    const tool = builtinAgentTools.find((candidate) => candidate.name === "skill_update");
    const schema = tool?.inputSchema as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual([
      "name",
      "skillId",
      "path",
      "description",
      "body",
      "content",
    ]);
    expect(JSON.stringify(tool)).not.toContain("newName");
  });
});
