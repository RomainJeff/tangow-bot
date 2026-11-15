import type { AgentRunRequest } from "@tangow/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { modelsForRequest, resolveRuntimeModel, thinkingLevelFor } from "./pi-run-model.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
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

describe("a run's OAuth credential across model calls", () => {
  it("refreshes with the rotated refresh token on the run's next call", async () => {
    // Anthropic rotates the refresh token on every refresh and accepts each one once.
    // expires_in 60 is inside pi-ai's 5-minute skew, so every token is expired on arrival.
    const unused = new Set(["refresh-0"]);
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const { refresh_token } = JSON.parse(init.body) as { refresh_token: string };
      sent.push(refresh_token);
      if (!unused.delete(refresh_token)) {
        return new Response('{"error":"invalid_grant"}', { status: 400 });
      }
      const n = sent.length;
      unused.add(`refresh-${n}`);
      return new Response(
        JSON.stringify({
          access_token: `access-${n}`,
          refresh_token: `refresh-${n}`,
          expires_in: 60,
        }),
      );
    });
    const persisted: string[] = [];
    const model: AgentRunRequest["model"] = {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      oauth: {
        credential: {
          type: "oauth",
          access: "access-stale",
          refresh: "refresh-0",
          expires: Date.now() - 1000,
        },
        persist: async (next) => {
          persisted.push(next.refresh);
        },
      },
    };

    const first = await modelsForRequest({ model }, "anthropic").getAuth("anthropic");
    const second = await modelsForRequest({ model }, "anthropic").getAuth("anthropic");

    expect(first?.auth.apiKey).toBe("access-1");
    expect(second?.auth.apiKey).toBe("access-2");
    expect(sent).toEqual(["refresh-0", "refresh-1"]);
    expect(persisted).toEqual(["refresh-1", "refresh-2"]);
  });
});
