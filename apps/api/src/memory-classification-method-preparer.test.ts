import type { AgentRunRequest, AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  createMemoryClassificationMethodPreparer,
  MemoryMethodPreparationError,
} from "./memory-classification-method-preparer.js";

const prepared = {
  questions: [
    {
      key: "content_role",
      label: "Content role",
      instructions: "Choose the role described in the user method.",
      options: [
        {
          key: "protocol",
          label: "Protocol",
          description: "Reusable interview preparation steps.",
        },
        { key: "record", label: "Meeting record", description: "Notes from one actual meeting." },
      ],
    },
  ],
};

function runtimeFor(text: string, observe?: (request: AgentRunRequest) => void): AgentRuntime {
  return {
    describe: () => ({
      id: "fake",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { streaming: false, compaction: false, tools: false, scripted: true },
    }),
    abort: async () => undefined,
    async *run(request): AsyncIterable<AgentRuntimeEvent> {
      observe?.(request);
      yield {
        type: "usage",
        inputTokens: 123,
        outputTokens: 44,
        provider: "openai-compatible",
        model: "local-model",
      };
      yield { type: "done", text };
    },
  };
}

const bot = { id: "bot-1", spaceId: "space-1", userId: "user-1", name: "Archivist" };

describe("memory classification method preparation", () => {
  it("compiles only the user's Markdown instructions with tools disabled", async () => {
    let seen: AgentRunRequest | undefined;
    const recordUsage = vi.fn(async () => undefined);
    const prepare = createMemoryClassificationMethodPreparer({
      runtime: runtimeFor(JSON.stringify(prepared), (request) => {
        seen = request;
      }),
      resolveModel: async () => ({ provider: "openai-compatible", id: "local-model" }),
      recordUsage,
    });
    const result = await prepare({
      bot,
      instructions: "# Interview material\n\nClassify by purpose.",
    });

    expect(result).toEqual(prepared);
    expect(seen?.toolPolicy).toBe("none");
    expect(seen?.tools).toEqual([]);
    expect(seen?.history).toEqual([]);
    expect(seen?.prompt).toContain("Classify by purpose");
    expect(seen?.prompt).not.toContain("candidate");
    expect(recordUsage).toHaveBeenCalledWith({
      bot,
      inputTokens: 123,
      outputTokens: 44,
      provider: "openai-compatible",
      model: "local-model",
    });
  });

  it("does not call the model if no generic model is connected", async () => {
    const prepare = createMemoryClassificationMethodPreparer({
      runtime: runtimeFor(JSON.stringify(prepared)),
      resolveModel: async () => null,
    });
    await expect(prepare({ bot, instructions: "Classify by purpose." })).rejects.toMatchObject({
      code: "model_unavailable",
    });
  });

  it("rejects malformed or non-JSON model output instead of saving a partial method", async () => {
    for (const text of [
      "```json\\n{}\\n```",
      JSON.stringify({ questions: [] }),
      JSON.stringify({ ...prepared, extra: true }),
    ]) {
      const prepare = createMemoryClassificationMethodPreparer({
        runtime: runtimeFor(text),
        resolveModel: async () => ({ provider: "openai-compatible", id: "local-model" }),
      });
      await expect(prepare({ bot, instructions: "Classify by purpose." })).rejects.toMatchObject({
        code: "invalid_preparation",
      });
    }
  });

  it("rejects blank and overlong methods before resolving a model", async () => {
    const resolveModel = vi.fn(async () => ({ provider: "openai-compatible", id: "local-model" }));
    const prepare = createMemoryClassificationMethodPreparer({
      runtime: runtimeFor(JSON.stringify(prepared)),
      resolveModel,
    });
    await expect(prepare({ bot, instructions: "  " })).rejects.toBeInstanceOf(
      MemoryMethodPreparationError,
    );
    await expect(prepare({ bot, instructions: "x".repeat(20_001) })).rejects.toMatchObject({
      code: "invalid_instructions",
    });
    expect(resolveModel).not.toHaveBeenCalled();
  });
});
