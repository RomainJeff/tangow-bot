import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { ModelCallRuntime } from "@rakazo/adapters";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelEmulatorStep } from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function call(step: ModelEmulatorStep, tools: AgentRunRequest["tools"] = []) {
  const model = await startModelEmulator({ apiKey: "model-call-key", steps: [step] });
  closers.push(() => model.close());
  const events: AgentRuntimeEvent[] = [];
  for await (const event of new ModelCallRuntime().run({
    botId: "bot",
    threadId: "thread",
    runId: "compact:thread:1",
    prompt: "Summarize the conversation.",
    instructions: "You summarize conversations.",
    history: [],
    tools,
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
});
