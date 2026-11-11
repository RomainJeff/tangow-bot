import { readFileSync } from "node:fs";
import { SPAWN_BOT_INSTRUCTIONS_MAX_LENGTH, SPAWN_BOT_PROMPT_MAX_LENGTH } from "@tangow/contracts";
import { BOT_SKILL_DESCRIPTION_MAX_LENGTH } from "@tangow/core";
import { describe, expect, it } from "vitest";
import { builtinAgentTools, helperCallOf, helperModel } from "./builtin-tools.js";
import { parseConnectorToolArgs } from "./lazy-tool-catalog.js";

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

describe("request_secret parameters", () => {
  const schema = builtinAgentTools.find((tool) => tool.name === "request_secret")!.inputSchema;
  const credential = {
    name: "github_pat",
    origin: "https://api.github.com",
    auth: { type: "bearer" },
  };

  it("takes exactly one destination, credential or connectionId, as the executor does", () => {
    expect(() =>
      parseConnectorToolArgs(schema, {
        label: "GitHub PAT",
        purpose: "api_key",
        credential,
        connectionId: "conn_1",
      }),
    ).toThrow();
    expect(() =>
      parseConnectorToolArgs(schema, { label: "GitHub PAT", purpose: "api_key" }),
    ).toThrow();
    expect(
      parseConnectorToolArgs(schema, { label: "GitHub PAT", purpose: "api_key", credential }),
    ).toMatchObject({ credential });
    expect(
      parseConnectorToolArgs(schema, { label: "c", purpose: "otp", connectionId: "abc" }),
    ).toMatchObject({ connectionId: "abc" });
  });

  it("rejects connectionId with replace, which belongs only on the credential branch", () => {
    expect(() =>
      parseConnectorToolArgs(schema, {
        label: "c",
        purpose: "otp",
        connectionId: "abc",
        replace: true,
      }),
    ).toThrow();
  });
});

describe("helper category calls", () => {
  it.each([undefined, "invalid"])("reads legacy category %s as everyday", async (category) => {
    const call = helperCallOf({ category, model_provider: "ignored", model_id: "ignored" });
    expect(call.category).toBe("everyday");
    const selected = await helperModel(
      {
        resolveCategory: async () => ({
          model: { provider: "scripted", id: "everyday-model" },
          modelDecision: {
            mode: "category",
            requestedCategory: "everyday",
            category: "everyday",
            provider: "scripted",
            modelId: "everyday-model",
          },
        }),
      },
      call,
    );
    expect(selected.modelDecision).toEqual({
      mode: "category",
      requestedCategory: "everyday",
      category: "everyday",
      provider: "scripted",
      modelId: "everyday-model",
      fallback: "legacy_call",
    });
  });
});
