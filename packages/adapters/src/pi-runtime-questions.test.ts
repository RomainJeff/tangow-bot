import type { AgentRuntimeEvent, ConnectorTool } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeAgentState = vi.hoisted(() => ({
  args: {} as Record<string, unknown>,
  tools: [] as Array<{
    name: string;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
  }>,
}));

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state = { errorMessage: undefined, messages: [] };
    private readonly tools: typeof fakeAgentState.tools;
    constructor(options: { initialState: { tools: typeof fakeAgentState.tools } }) {
      this.tools = options.initialState.tools;
      fakeAgentState.tools = this.tools;
    }
    subscribe(_listener: unknown) {}
    async prompt() {
      const askUser = this.tools.find((tool) => tool.name === "ask_user");
      if (!askUser) throw new Error("ask_user tool missing");
      await askUser.execute("call-q-1", fakeAgentState.args);
    }
    async waitForIdle() {}
    abort() {}
  },
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (_provider: string, modelId: string) =>
      modelId === "q-pi-model" ? { provider: "test", id: modelId } : undefined,
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

import { normalizeAskQuestions } from "./ask-user.js";
import { PiAgentRuntime } from "./pi-runtime.js";

const askTool: ConnectorTool = {
  name: "ask_user",
  description: "Ask one to four questions",
  inputSchema: { type: "object", properties: {}, required: [] },
};

const runContext = {
  operationId: "q-pi",
  traceId: "q-pi",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

const runRequest = {
  botId: "bot",
  threadId: "thread",
  runId: "run",
  prompt: "ask me a few questions",
  instructions: "Use ask_user with several questions.",
  history: [],
  tools: [askTool],
  model: { provider: "test", id: "q-pi-model" },
};

describe("Pi multi-question asks", () => {
  beforeEach(() => {
    fakeAgentState.tools = [];
    fakeAgentState.args = {};
  });

  it("normalizes questions with stable ids and emits one ask event", async () => {
    fakeAgentState.args = {
      questions: [
        {
          header: "Cible",
          question: "Ta cible ?",
          options: ["DG PME", "Direction BU"],
        },
        { question: "Ton horizon ?", required: false, multiSelect: true },
      ],
    };
    const runtime = new PiAgentRuntime();
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run(runRequest, runContext)) events.push(event);

    const ask = events.find((event) => event.type === "ask");
    expect(ask).toEqual({
      type: "ask",
      text: "Ta cible ?\nTon horizon ?",
      questions: [
        {
          id: "q1",
          header: "Cible",
          question: "Ta cible ?",
          options: [
            { id: "q1o1", label: "DG PME" },
            { id: "q1o2", label: "Direction BU" },
          ],
        },
        { id: "q2", question: "Ton horizon ?", multiSelect: true, required: false },
      ],
    });
  });

  it("pages and reads out the questions alone, never what an option does (CA21)", async () => {
    fakeAgentState.args = {
      questions: [
        {
          question: "Which fridge?",
          options: [
            { label: "Freestanding", description: "Fits most kitchens", recommended: true },
            "Built-in",
          ],
        },
      ],
    };
    const runtime = new PiAgentRuntime();
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run(runRequest, runContext)) events.push(event);

    expect(events.find((event) => event.type === "ask")).toMatchObject({
      type: "ask",
      text: "Which fridge?",
    });
  });

  it("rejects a malformed question option set", async () => {
    fakeAgentState.args = {
      questions: [{ question: "Ta cible ?", options: ["only-one"] }],
    };
    const runtime = new PiAgentRuntime();
    const events: AgentRuntimeEvent[] = [];
    await expect(async () => {
      for await (const event of runtime.run(runRequest, runContext)) events.push(event);
    }).rejects.toThrow(/two to four unique/);
    expect(events.some((event) => event.type === "ask")).toBe(false);
  });
});

describe("ask_user option normalization (CA20)", () => {
  const optionsOf = (options: unknown[]) =>
    normalizeAskQuestions({ questions: [{ question: "Which fridge?", options }] })?.[0]?.options;

  it("keeps what an option does and its recommended mark, under server ids", () => {
    expect(
      optionsOf([
        {
          id: "allow",
          label: "Freestanding",
          description: "Fits most kitchens",
          recommended: true,
        },
        "Built-in",
      ]),
    ).toEqual([
      { id: "q1o1", label: "Freestanding", description: "Fits most kitchens", recommended: true },
      { id: "q1o2", label: "Built-in" },
    ]);
  });

  it("keeps the mark on the first recommended option only", () => {
    expect(
      optionsOf([
        { label: "A" },
        { label: "B", recommended: true },
        { label: "C", recommended: true },
      ]),
    ).toEqual([
      { id: "q1o1", label: "A" },
      { id: "q1o2", label: "B", recommended: true },
      { id: "q1o3", label: "C" },
    ]);
  });

  it("cuts a description at 80 code points without splitting an emoji", () => {
    const [option] = optionsOf([{ label: "A", description: `${"x".repeat(79)}😀😀` }, "B"]) ?? [];
    expect(option?.description).toBe(`${"x".repeat(79)}😀`);
  });

  it("keeps a question's Markdown line breaks", () => {
    const [question] =
      normalizeAskQuestions({
        questions: [
          {
            question: "Pick one:\n- fast\n  - very  fast\n- cheap\n\n\n\nWhich?",
            options: ["A", "B"],
          },
        ],
      }) ?? [];
    expect(question?.question).toBe("Pick one:\n- fast\n  - very fast\n- cheap\n\nWhich?");
  });

  it("removes bidi, control and zero-width characters, keeps the emoji joiner, and folds spaces", () => {
    const [question] =
      normalizeAskQuestions({
        questions: [
          {
            header: "\u202EFormat\u0007",
            question: "Which\n\n fridge\u200B?",
            options: [
              { label: "Al\u2066low\u2069", description: "Cafe\u0301  👩\u200D💻\uFEFF" },
              "Deny",
            ],
          },
        ],
      }) ?? [];
    expect(question).toEqual({
      id: "q1",
      header: "Format",
      question: "Which\n\n fridge?",
      options: [
        { id: "q1o1", label: "Allow", description: "Café 👩\u200D💻" },
        { id: "q1o2", label: "Deny" },
      ],
    });
  });

  it("refuses labels that only differ by invisible characters", () => {
    expect(() => optionsOf(["Yes", "Ye\u200Bs"])).toThrow(/two to four unique/);
  });

  it("refuses an option object without a label, saying so", () => {
    expect(() => optionsOf([{ description: "Fits most kitchens" }, "B"])).toThrow(
      'each ask_user option is a string or an object with a non-empty "label"',
    );
  });
});
