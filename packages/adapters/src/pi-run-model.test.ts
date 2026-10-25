import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveRuntimeModel, thinkingLevelFor } from "./pi-run-model.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The deployment's OpenRouter default, which Pi's static catalog does not know yet. */
function configuredOpenRouterModel() {
  vi.stubEnv("PI_DEFAULT_PROVIDER", " openrouter ");
  vi.stubEnv("PI_DEFAULT_MODEL", "  stealth/ox-alpha  ");
  return resolveRuntimeModel({ provider: "openrouter", id: "  stealth/ox-alpha  " }).model;
}

describe("the model a run calls", () => {
  it("runs a configured OpenRouter model missing from the catalog, with reasoning on", () => {
    const model = configuredOpenRouterModel();

    expect(model).toMatchObject({
      id: "stealth/ox-alpha",
      provider: "openrouter",
      reasoning: true,
    });
    // Thinking "off" becomes effort "none", which OpenRouter's mandatory-reasoning models reject.
    expect(thinkingLevelFor(model!)).toBe("medium");
  });

  it("applies the bot's thinking level to a reasoning model, and keeps a plain model off", () => {
    const model = configuredOpenRouterModel()!;

    expect(thinkingLevelFor(model, "high")).toBe("high");
    expect(thinkingLevelFor({ ...model, reasoning: false }, "high")).toBe("off");
  });
});
