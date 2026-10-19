import {
  type AgentRunRequest,
  type AgentRuntimeEvent,
  parseControllerMessage,
  parseGuestMessage,
  type ReplyPart,
} from "@rakazo/adapter-kit";
import { PiAgentRuntime } from "@rakazo/adapters";
import {
  guestModelOf,
  type RelayUsage,
  relayedModel,
  relayModelRequest,
  relayStreamFn,
} from "@rakazo/adapters/runtime-worker";
import { afterEach, describe, expect, it } from "vitest";
import { startModelEmulator } from "./model-emulator.js";

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
    const relay = relayStreamFn(
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
          await relayModelRequest(server.model, request, (modelEvent) => {
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
          }),
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
