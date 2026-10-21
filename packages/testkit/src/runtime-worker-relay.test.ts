import type { AgentToolExecutionResult } from "@rakazo/adapter-kit";
import {
  type AgentRunRequest,
  type AgentRuntimeEvent,
  parseControllerMessage,
  parseGuestMessage,
  type ReplyPart,
} from "@rakazo/adapter-kit";
import { computerObservation, observationToolResult, PiAgentRuntime } from "@rakazo/adapters";
import { guestModelOf, type RelayUsage } from "@rakazo/adapters/runtime-worker";
import { piAiStreamFn, relayedModel, relayPiAiCall } from "@rakazo/adapters/runtime-worker/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { toolResult } from "./file-task.js";
import type { ModelEmulatorRequest } from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";
import { startWorkerRun } from "./worker-run-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const worker = { runId: "run_relay", attemptId: "attempt_relay", fence: 1 };
const KEY = "controller-only-key";

describe("a guest Pi run whose model calls the controller relays", () => {
  it("reaches the model with the controller's key while the guest holds none", async () => {
    const server = await startModelEmulator({
      apiKey: KEY,
      steps: [
        {
          expect(request) {
            expect(request.messages.at(-1)).toMatchObject({ role: "user" });
          },
          response: {
            type: "tool",
            id: "read-1",
            name: "read_note",
            arguments: { name: "todo" },
            argumentChunks: ['{"na', 'me":"to', 'do"}'],
            usage: { promptTokens: 120, completionTokens: 9 },
          },
        },
        {
          expect(request) {
            const result = request.messages.findLast((message) => message.role === "tool");
            expect(result).toMatchObject({ tool_call_id: "read-1" });
            expect(JSON.stringify(result?.content)).toContain("buy milk");
          },
          response: {
            type: "text",
            text: "Your note says: buy milk.",
            usage: { promptTokens: 140, completionTokens: 7 },
          },
        },
      ],
    });
    cleanups.push(() => server.close());

    const frames: string[] = [];
    const usage: Array<RelayUsage | undefined> = [];
    const relay = piAiStreamFn(
      async (body, onPart) => {
        const event = JSON.stringify({
          version: 1,
          kind: "worker.event",
          worker,
          payload: { seq: 1, body },
        });
        frames.push(event);
        const read = parseGuestMessage(JSON.parse(event));
        if (!read.ok || read.message.kind !== "worker.event") throw new Error("unreadable frame");
        const request = read.message.payload.body;
        if (request.type !== "model.request") throw new Error("not a model request");
        usage.push(
          await relayPiAiCall(
            server.model,
            request.call,
            (modelEvent) => {
              const reply = JSON.stringify({
                version: 1,
                kind: "worker.reply",
                worker,
                payload: { re: 1, part: 0, body: { type: "model.event", event: modelEvent } },
              });
              frames.push(reply);
              const parsed = parseControllerMessage(JSON.parse(reply));
              if (!parsed.ok || parsed.message.kind !== "worker.reply")
                throw new Error("unreadable reply");
              onPart(parsed.message.payload.body as ReplyPart);
            },
            {
              signal: new AbortController().signal,
              conversation: { threadId: "thread_relay", botId: "bot_relay" },
            },
          ),
        );
        return { type: "model.end" };
      },
      () => "root",
    );

    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const guestRequest: AgentRunRequest = {
      botId: "bot_relay",
      threadId: "thread_relay",
      runId: worker.runId,
      prompt: "What does my todo note say?",
      instructions: "Answer from the notes.",
      history: [],
      tools: [
        {
          name: "read_note",
          description: "Read a note",
          inputSchema: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
        },
      ],
      model: relayedModel(guestModelOf(server.model)),
      executeTool: async (name, args) => {
        calls.push({ name, args });
        return "buy milk";
      },
    };
    const events: AgentRuntimeEvent[] = [];
    for await (const event of new PiAgentRuntime({ streamFn: relay }).run(guestRequest)) {
      events.push(event);
    }

    server.assertComplete();
    expect(calls).toEqual([{ name: "read_note", args: { name: "todo" } }]);
    expect(events.at(-1)).toEqual({ type: "done", text: "Your note says: buy milk." });
    const measured = { type: "usage", provider: "openai-compatible", model: "offline-fixture" };
    expect(usage).toEqual([
      { ...measured, inputTokens: 120, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { ...measured, inputTokens: 140, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ]);
    expect(guestRequest.model).toEqual({
      provider: "openai-compatible",
      id: "offline-fixture",
      baseUrl: "http://relay.invalid/v1",
    });
    expect(frames.length).toBeGreaterThan(4);
    for (const frame of frames) {
      expect(frame).not.toContain(KEY);
      expect(frame).not.toContain(server.baseUrl);
    }
  });
});

describe("a guest run whose tool results carry images", () => {
  async function imagesPerCall(
    maxImagesPerPrompt: number,
    toolName: string,
    result: (call: number) => AgentToolExecutionResult,
    calls: number,
  ) {
    const sent: string[][] = [];
    const record = (request: ModelEmulatorRequest) =>
      sent.push(
        [...JSON.stringify(request.messages).matchAll(/data:image\/png;base64,([^"]+)/g)].map(
          (match) => Buffer.from(match[1] ?? "", "base64").toString(),
        ),
      );
    const server = await startModelEmulator({
      steps: [
        ...Array.from({ length: calls }, (_, index) => ({
          expect: record,
          response: { type: "tool" as const, id: `call-${index}`, name: toolName, arguments: {} },
        })),
        { expect: record, response: { type: "text", text: "Done." } },
      ],
    });
    cleanups.push(() => server.close());
    const config = { ...server.model, acceptsImages: true, maxImagesPerPrompt };
    const relay = piAiStreamFn(
      async (body, onPart) => {
        await relayPiAiCall(config, body.call, (event) => onPart({ type: "model.event", event }), {
          signal: new AbortController().signal,
          conversation: { threadId: "thread_relay", botId: "bot_relay" },
        });
        return { type: "model.end" };
      },
      () => "root",
    );
    let call = 0;
    const events: AgentRuntimeEvent[] = [];
    for await (const event of new PiAgentRuntime({ streamFn: relay }).run({
      botId: "bot_relay",
      threadId: "thread_relay",
      runId: worker.runId,
      prompt: "Check the page",
      history: [],
      tools: [{ name: toolName, description: toolName, inputSchema: { type: "object" } }],
      model: relayedModel(guestModelOf(config)),
      executeTool: async () => {
        call += 1;
        return result(call);
      },
    })) {
      events.push(event);
    }
    server.assertComplete();
    expect(events.at(-1)).toEqual({ type: "done", text: "Done." });
    return sent;
  }

  it("keeps the guest's whole screenshot history so the relay evicts the oldest a block at a time", async () => {
    const screenshot = (call: number) =>
      observationToolResult(
        computerObservation(Buffer.from(`frame-${call}`), {
          mimeType: "image/png",
          width: 1,
          height: 1,
        }),
      );
    expect(await imagesPerCall(3, "computer_observe", screenshot, 7)).toEqual([
      [],
      ["frame-1"],
      ["frame-1", "frame-2"],
      ["frame-1", "frame-2", "frame-3"],
      ["frame-4"],
      ["frame-4", "frame-5"],
      ["frame-4", "frame-5", "frame-6"],
      ["frame-7"],
    ]);
  });

  it("prunes native image reads beyond the model's budget instead of failing the run", async () => {
    const read = (call: number): AgentToolExecutionResult => ({
      kind: "agent_tool_result",
      content: [
        { type: "text", text: "Read image file [image/png]" },
        {
          type: "image",
          data: Buffer.from(`file-${call}`).toString("base64"),
          mimeType: "image/png",
        },
      ],
    });
    expect(await imagesPerCall(2, "read", read, 3)).toEqual([
      [],
      ["file-1"],
      ["file-1", "file-2"],
      ["file-3"],
    ]);
  });
});

describe("a worker run on a catalog Anthropic model", () => {
  it("completes a run on Anthropic's Messages API through the relay, across a thinking block and a tool call", async () => {
    let listed = "";
    const run = await startWorkerRun({
      protocol: "anthropic",
      steps: [
        {
          expect(request) {
            expect(request.messages.at(-1)).toMatchObject({ role: "user" });
          },
          response: {
            type: "tool",
            id: "toolu_1",
            name: "bash",
            arguments: { command: "echo listed" },
          },
        },
        {
          expect(request) {
            listed = toolResult(request);
          },
          response: {
            type: "tool",
            id: "toolu_2",
            name: "message_user",
            arguments: { message: "Done." },
          },
        },
        {
          expect() {},
          response: {
            type: "text",
            thinking: "The command printed its word.",
            text: JSON.stringify({ version: 1, results: ["Listed"], references: [] }),
            usage: { promptTokens: 210, completionTokens: 12, cacheReadTokens: 64 },
          },
        },
      ],
    });
    cleanups.push(() => run.close());

    const runId = await run.send("List it.");
    await run.continueRun(runId);

    const row = await run.prisma.run.findUniqueOrThrow({ where: { id: runId } });
    expect(row).toMatchObject({ status: "completed", modelProvider: "anthropic" });
    run.model.assertComplete();
    expect(listed).toContain("listed");
    const usage = await run.prisma.usageRecord.findMany({ where: { runId } });
    expect(usage.at(-1)).toMatchObject({ provider: "anthropic", outputTokens: 12 });
    // Anthropic reports cache reads apart from input tokens; the run counts both.
    const finished = (await run.runEntries(runId)).find((entry) => entry.type === "run.finished");
    expect(finished?.payload).toMatchObject({ usage: { inputTokens: 210 + 64, outputTokens: 12 } });
  });
});
