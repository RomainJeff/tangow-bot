import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { AgentRunRequest, AgentRuntimeEvent } from "@tangow/adapter-kit";
import { ModelCallRuntime, TraceExporter } from "@tangow/adapters";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelEmulatorStep } from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function call(
  step: ModelEmulatorStep,
  tools: AgentRunRequest["tools"] = [],
  runtime = new ModelCallRuntime(),
  answer?: AgentRunRequest["answer"],
) {
  const model = await startModelEmulator({ apiKey: "model-call-key", steps: [step] });
  closers.push(() => model.close());
  const events: AgentRuntimeEvent[] = [];
  for await (const event of runtime.run({
    botId: "bot",
    threadId: "thread",
    runId: "compact:thread:1",
    prompt: "Summarize the conversation.",
    instructions: "You summarize conversations.",
    history: [],
    tools,
    answer,
    model: model.model,
  })) {
    events.push(event);
  }
  return { events, model };
}

describe("the controller's own model call", () => {
  it("sends the instructions and prompt once, and answers with the text and its spend", async () => {
    const { events, model } = await call({
      expect(request) {
        expect(request.messages).toEqual([
          { role: "system", content: "You summarize conversations." },
          { role: "user", content: "Summarize the conversation." },
        ]);
        expect(request.tools ?? []).toEqual([]);
      },
      response: {
        type: "text",
        text: "- The launch is Tuesday.",
        usage: { promptTokens: 12, completionTokens: 5 },
      },
    });
    model.assertComplete();
    expect(events).toEqual([
      expect.objectContaining({ type: "usage", inputTokens: 12, outputTokens: 5 }),
      { type: "done", text: "- The launch is Tuesday." },
    ]);
  });

  it("throws a provider failure instead of answering with it", async () => {
    await expect(
      call({ expect() {}, response: { type: "error", status: 400, message: "bad request" } }),
    ).rejects.toThrow();
  });

  it("refuses tools, which only a worker runs", async () => {
    await expect(
      call({ expect() {}, response: { type: "text", text: "unused" } }, [
        { name: "write", description: "Write a file.", inputSchema: { type: "object" } },
      ]),
    ).rejects.toThrow("A model call takes no tools");
  });

  it("exports each call as a trace when an exporter is set", async () => {
    const payloads: unknown[] = [];
    const exporter = new TraceExporter({ send: async (payload) => void payloads.push(payload) });
    const answer: ModelEmulatorStep = {
      expect() {},
      response: { type: "text", text: "- The launch is Tuesday." },
    };
    await call(answer, [], new ModelCallRuntime({ exporter, serviceName: "rakazo-worker" }));
    await exporter.flush();

    expect(payloads).toHaveLength(1);
    const exported = JSON.stringify(payloads[0]);
    expect(exported).toContain("rakazo-worker");
    expect(exported).toContain("The launch is Tuesday.");
  });

  describe("asked for a typed answer", () => {
    const answer = {
      schemas: [
        {
          name: "summary",
          description: "The conversation's summary.",
          schema: {
            type: "object",
            properties: { points: { type: "array", items: { type: "string" } } },
            required: ["points"],
          },
        },
      ],
    };

    it("offers each schema to fill in, strict where the provider can, and returns what fills it", async () => {
      const entry = builtinModels().getModel("anthropic", "claude-haiku-4-5")!;
      const emulator = await startModelEmulator({
        apiKey: "model-call-key",
        protocol: "anthropic",
        modelId: entry.id,
        steps: [
          {
            expect() {},
            response: {
              type: "tool",
              id: "filled",
              name: "summary",
              arguments: { points: ["The launch is Tuesday."] },
            },
          },
        ],
      });
      const catalogUrl = entry.baseUrl;
      entry.baseUrl = emulator.baseUrl;
      closers.push(async () => {
        entry.baseUrl = catalogUrl;
        await emulator.close();
      });
      const events: AgentRuntimeEvent[] = [];
      for await (const event of new ModelCallRuntime().run({
        botId: "bot",
        threadId: "thread",
        runId: "summary:thread:1",
        prompt: "Summarize the conversation.",
        instructions: "You summarize conversations.",
        history: [],
        tools: [],
        answer,
        model: { provider: "anthropic", id: entry.id, apiKey: "model-call-key" },
      })) {
        events.push(event);
      }
      emulator.assertComplete();
      expect(emulator.rawRequests[0]).toMatchObject({
        tools: [
          {
            name: "summary",
            strict: true,
            input_schema: { additionalProperties: false, required: ["points"] },
          },
        ],
      });
      expect(events.at(-1)).toEqual({
        type: "done",
        answer: { name: "summary", value: { points: ["The launch is Tuesday."] } },
      });
    });

    it.each<[string, ModelEmulatorStep["response"]]>([
      ["text", { type: "text", text: "The launch is Tuesday." }],
      ["a schema it was not offered", { type: "tool", id: "x", name: "write", arguments: {} }],
      [
        "two answers",
        {
          type: "tool",
          id: "first",
          name: "summary",
          arguments: { points: ["a"] },
          siblings: [{ id: "second", name: "summary", arguments: { points: ["b"] } }],
        },
      ],
    ])("answers nothing typed when the model gives %s", async (_, response) => {
      const { events } = await call({ expect() {}, response }, [], new ModelCallRuntime(), answer);
      expect(events.at(-1)).toEqual(expect.objectContaining({ type: "done" }));
      expect(events.at(-1)).not.toHaveProperty("answer");
    });
  });
});
