import { readFileSync } from "node:fs";
import { SPAWN_BOT_INSTRUCTIONS_MAX_LENGTH, SPAWN_BOT_PROMPT_MAX_LENGTH } from "@rakazo/contracts";
import { BOT_SKILL_DESCRIPTION_MAX_LENGTH } from "@rakazo/core";
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

describe("skill description limit", () => {
  it("tells the bot the description cap before it saves, in both tools and the guide", () => {
    const limit = `at most ${BOT_SKILL_DESCRIPTION_MAX_LENGTH} characters`;
    for (const name of ["skill_create", "skill_update"]) {
      const tool = builtinAgentTools.find((candidate) => candidate.name === name);
      const schema = tool?.inputSchema as { properties: { description: { description: string } } };
      expect(schema.properties.description.description.toLowerCase()).toContain(limit);
    }
    const guide = readFileSync(
      new URL("../../../skills/agent/skill-authoring/SKILL.md", import.meta.url),
      "utf8",
    );
    expect(guide).toContain(`(${limit})`);
  });
});
