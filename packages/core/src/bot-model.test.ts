import type { ModelCatalogEntry, ModelCredential } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { connectedModelOptions, parseModelOptionKey, thinkingChoices } from "./bot-model.js";

const catalog: ModelCatalogEntry[] = [
  {
    provider: "anthropic",
    providerName: "Anthropic",
    id: "claude-a",
    label: "Claude A",
    billing: "api",
    thinkingLevels: ["off", "low", "high"],
  },
  { provider: "anthropic", id: "stand-in", label: "Stand-in", billing: "api", placeholder: true },
];

function credential(partial: Partial<ModelCredential>): ModelCredential {
  return {
    id: "cred-1",
    provider: "anthropic",
    label: "Work",
    hasKey: true,
    isDefault: true,
    ...partial,
  };
}

describe("bot model choices", () => {
  it("expands a catalog connection to its models and keeps a free-form one as one pair", () => {
    const options = connectedModelOptions(
      [
        credential({}),
        credential({ id: "cred-2", provider: "local", label: "Box", modelId: "llama" }),
      ],
      catalog,
    );
    expect(options.map((option) => [option.key, option.label])).toEqual([
      ["anthropic::claude-a", "Anthropic · Claude A"],
      ["local::llama", "Box · llama"],
    ]);
  });

  it("offers the thinking levels of the bot's model, or of the space default", () => {
    const me = { defaultProvider: "anthropic", defaultModel: "claude-a" };
    expect(thinkingChoices({ credentials: [], catalog, me }, "")).toEqual({
      levels: ["low", "high"],
      fallback: "medium",
    });
    expect(thinkingChoices({ credentials: [], catalog, me }, "local::llama").levels).toEqual([]);
  });

  it("splits a key at its first separator only", () => {
    expect(parseModelOptionKey("openrouter::meta/llama::free")).toEqual({
      provider: "openrouter",
      modelId: "meta/llama::free",
    });
    expect(parseModelOptionKey("::x")).toBeNull();
  });
});
