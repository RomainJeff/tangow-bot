import { describe, expect, it, vi } from "vitest";

const deltas = vi.hoisted(() => ({ current: [] as string[] }));

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state = { errorMessage: undefined as string | undefined, messages: [] as unknown[] };
    private readonly listeners: Array<(event: Record<string, unknown>) => void> = [];

    subscribe(listener: (event: Record<string, unknown>) => void) {
      this.listeners.push(listener);
    }

    async prompt() {
      for (const delta of deltas.current) {
        this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
      }
      this.emit({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: deltas.current.join("") }] },
      });
    }

    async waitForIdle() {}
    steer() {}
    followUp() {}
    abort() {}

    private emit(event: Record<string, unknown>) {
      for (const listener of this.listeners) listener(event);
    }
  },
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (_provider: string, modelId: string) => ({ provider: "test", id: modelId }),
    streamSimple: () => {
      throw new Error("the fake agent must not call a provider");
    },
  }),
}));

vi.mock("./pi-local-provider.js", () => ({
  registerLocalProvider: (models: unknown) => models,
}));

vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { PiAgentRuntime } from "./pi-runtime.js";

describe("streamed control tokens", () => {
  it.each([
    { split: ["Hello <|", "eos|>"], text: "Hello " },
    { split: ["<|eo", "s|> world"], text: " world" },
    { split: ["a <", "|x", "|", ">b <|"], text: "a b <|" },
  ])("never reach the thread when split across deltas: $split", async ({ split, text }) => {
    deltas.current = split;
    const events: Array<{ type: string; text?: string }> = [];
    for await (const event of new PiAgentRuntime().run(
      {
        botId: "b",
        threadId: "t",
        runId: "split-control-tokens",
        prompt: "hi",
        instructions: "Answer",
        history: [],
        tools: [],
        model: { provider: "test", id: "split-test-model" },
      },
      { signal: new AbortController().signal },
    ))
      events.push(event);
    const streamed = events.flatMap((event) => (event.type === "text" ? [event.text] : []));
    expect(streamed.join("")).toBe(text);
    expect(events.at(-1)).toEqual({ type: "done", text });
  });
});
