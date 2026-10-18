import { afterEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ deltas: [] as string[], parentResult: undefined as unknown }));

type FakeAgentTool = {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
};

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state = { errorMessage: undefined as string | undefined, messages: [] as unknown[] };
    private readonly tools: FakeAgentTool[];
    private readonly listeners: Array<(event: Record<string, unknown>) => void> = [];

    constructor(options: { initialState: { tools: FakeAgentTool[] } }) {
      this.tools = options.initialState.tools;
    }

    subscribe(listener: (event: Record<string, unknown>) => void) {
      this.listeners.push(listener);
    }

    async prompt() {
      const runSubagent = this.tools.find((tool) => tool.name === "run_subagent");
      if (runSubagent) {
        fake.parentResult = await runSubagent.execute("subagent-call", {
          name: "helper",
          task: "help",
        });
        return;
      }
      for (const delta of fake.deltas) {
        this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
      }
      this.emit({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: fake.deltas.join("") }] },
      });
    }

    async waitForIdle() {}
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

afterEach(() => vi.restoreAllMocks());

describe("subagent control tokens", () => {
  it.each([
    { split: ["Done.<|eos|><|eos|>"], progress: ["Done."], text: "Done." },
    { split: ["Hello <|", "eos|>"], progress: ["Hello "], text: "Hello " },
    { split: ["a <", "|x", "|", ">b <|"], progress: ["a ", "a b "], text: "a b <|" },
  ])("never reach the progress card or the parent: $split", async ({ split, progress, text }) => {
    fake.deltas = split;
    fake.parentResult = undefined;
    let clock = 0;
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 1_000));
    const events: Array<{ type: string; progress?: string }> = [];
    for await (const event of new PiAgentRuntime().run(
      {
        botId: "b",
        threadId: "t",
        runId: "subagent-control-tokens",
        prompt: "hi",
        instructions: "Answer",
        history: [],
        tools: [],
        model: { provider: "test", id: "subagent-test-model" },
      },
      { signal: new AbortController().signal },
    ))
      events.push(event);
    const subagent = events.filter((event) => event.type === "subagent");
    expect(
      subagent.flatMap((event) =>
        event.progress && event.progress !== "starting…" ? [event.progress] : [],
      ),
    ).toEqual(progress);
    expect(subagent.at(-1)).toMatchObject({ status: "completed", result: text });
    expect(fake.parentResult).toMatchObject({ content: [{ type: "text", text }] });
  });
});
