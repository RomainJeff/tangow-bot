import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { reliableStreamOptions } from "./pi-runtime.js";

describe("Pi runtime transport", () => {
  it.each([
    { source: "provider", provider: "openai-codex", api: "openai-completions" },
    { source: "API", provider: "custom-provider", api: "openai-codex-responses" },
  ])("forces SSE when Codex is identified by $source", ({ provider, api }) => {
    const model = { provider, api } as Model<Api>;

    expect(reliableStreamOptions(model, { transport: "auto", maxRetries: 4 })).toEqual({
      transport: "sse",
      maxRetries: 4,
    });
  });

  it.each(["opencode", "opencode-go"])("sends the OpenCode session header for %s", (provider) => {
    const model = { provider, api: "openai-completions" } as Model<Api>;

    expect(reliableStreamOptions(model, { sessionId: "thread-1:bot-2" })).toEqual({
      sessionId: "thread-1:bot-2",
      headers: { "x-opencode-session": "thread-1:bot-2" },
    });
  });

  it("keeps an explicit OpenCode session header from the caller", () => {
    const model = { provider: "opencode-go", api: "anthropic-messages" } as Model<Api>;

    expect(
      reliableStreamOptions(model, {
        sessionId: "thread-1:bot-2",
        headers: { "x-opencode-session": "caller" },
      }),
    ).toEqual({
      sessionId: "thread-1:bot-2",
      headers: { "x-opencode-session": "caller" },
    });
  });

  it("skips the OpenCode session header when no session id is known", () => {
    const model = { provider: "opencode-go", api: "openai-completions" } as Model<Api>;
    const options = { maxRetries: 2 };

    expect(reliableStreamOptions(model, options)).toBe(options);
  });

  it("leaves other provider transports unchanged", () => {
    const model = { provider: "openrouter", api: "openai-completions" } as Model<Api>;
    const options = { transport: "auto" as const, maxRetries: 2 };

    expect(reliableStreamOptions(model, options)).toBe(options);
  });
});
