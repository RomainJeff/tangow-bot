import { describe, expect, it } from "vitest";
import { parseControllerMessage, parseGuestMessage } from "./worker-protocol.js";

const worker = { runId: "run_1", attemptId: "attempt_1", fence: 2 };
const run = {
  botId: "bot_a",
  threadId: "thread_1",
  prompt: "List the files.",
  instructions: "Be brief.",
  history: [
    {
      role: "assistant",
      content: "Done.",
      parts: [
        {
          type: "toolCalls",
          calls: [{ id: "c1", name: "bash", args: { command: "ls" }, output: "a" }],
        },
      ],
    },
  ],
  images: [{ name: "shot.png", mimeType: "image/png", data: "iVBORw0KGgo=" }],
  tools: [
    {
      name: "bash",
      description: "Run a command",
      inputSchema: { type: "object", properties: { command: { type: "string" } } },
      where: "guest",
    },
  ],
  model: { provider: "openai-compatible", id: "fixture", maxTokens: 4096 },
  runRecap: true,
};
const start = {
  version: 1,
  kind: "worker.start",
  worker,
  workspace: {
    cwd: "/workspace/bots/bot_a",
    mounts: [
      { path: "/workspace/bots/bot_a", scope: "private", access: "rw" },
      { path: "/workspace/shared", scope: "shared", access: "rw" },
    ],
  },
  computer: "none",
  run,
};

const event = (body: unknown) => ({
  version: 1,
  kind: "worker.event",
  worker,
  payload: { seq: 1, body },
});
const toolCall = {
  type: "tool.call",
  agent: "root",
  callId: "call_1",
  name: "bash",
  args: { command: "ls" },
};

describe("parseControllerMessage", () => {
  it.each([
    ["a v1 start message", start],
    [
      "a streamed model event",
      {
        version: 1,
        kind: "worker.reply",
        worker,
        payload: {
          re: 3,
          part: 0,
          body: {
            type: "model.event",
            event: { type: "text_delta", contentIndex: 0, delta: "hi" },
          },
        },
      },
    ],
    [
      "a tool grant",
      {
        version: 1,
        kind: "worker.reply",
        worker,
        payload: { re: 4, part: 0, body: { type: "tool.grant" } },
      },
    ],
  ])("accepts %s as sent", (_name, message) => {
    expect(parseControllerMessage(JSON.parse(JSON.stringify(message)))).toEqual({
      ok: true,
      message,
    });
  });

  it("refuses an unknown protocol version", () => {
    expect(parseControllerMessage({ version: 2, kind: "worker.cancel", worker })).toEqual({
      ok: false,
      reason: "unsupported_version",
    });
  });

  it.each([
    [
      "a mount naming its volume",
      {
        ...start,
        workspace: {
          cwd: "/workspace/shared",
          mounts: [{ path: "/workspace/shared", scope: "shared", access: "rw", volumeId: "v" }],
        },
      },
    ],
    ["a start without its run input", { ...start, run: undefined }],
    ["a model carrying a key", { ...start, run: { ...run, model: { ...run.model, apiKey: "k" } } }],
    [
      "a model carrying an endpoint",
      { ...start, run: { ...run, model: { ...run.model, baseUrl: "http://10.0.0.1/v1" } } },
    ],
    [
      "a tool carrying its connector route",
      {
        ...start,
        run: { ...run, tools: [{ ...run.tools[0], route: { connectorId: "c", toolName: "t" } }] },
      },
    ],
    ["a guest event", event(toolCall)],
    ["a string", "worker.cancel"],
    ["null", null],
  ])("refuses %s as invalid", (_name, json) => {
    expect(parseControllerMessage(json)).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("parseGuestMessage", () => {
  it.each([
    ["a tool call", event(toolCall)],
    ["a hello", { version: 1, kind: "worker.hello", worker, capability: "rkw1.a.b" }],
    [
      "a model request",
      event({
        type: "model.request",
        agent: "root",
        context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
        options: { sessionId: "s" },
      }),
    ],
  ])("accepts %s as sent", (_name, message) => {
    expect(parseGuestMessage(JSON.parse(JSON.stringify(message)))).toEqual({ ok: true, message });
  });

  it.each([
    ["an event naming a volume", { ...event(toolCall), volumeId: "vol_private_b" }],
    ["a start message", start],
    [
      "a status claiming to be active",
      {
        version: 1,
        kind: "worker.status",
        worker,
        state: "ready",
        providerRef: "vm",
        active: true,
      },
    ],
    ["an event without a fence", { ...event(toolCall), worker: { runId: "r", attemptId: "a" } }],
    [
      "reported usage",
      event({ type: "usage", inputTokens: 1, outputTokens: 1, provider: "p", model: "m" }),
    ],
    [
      "a tool call choosing its connector route",
      event({ ...toolCall, route: { connectorId: "c" } }),
    ],
    [
      "a model request choosing its provider",
      event({
        type: "model.request",
        agent: "root",
        context: { messages: [] },
        options: { provider: "x" },
      }),
    ],
    ["a frame numbered 0", { ...event(toolCall), payload: { seq: 0, body: toolCall } }],
  ])("refuses %s as invalid", (_name, json) => {
    expect(parseGuestMessage(json)).toEqual({ ok: false, reason: "invalid" });
  });

  it("refuses an event of an unknown protocol version", () => {
    expect(parseGuestMessage({ ...event(toolCall), version: 2 })).toEqual({
      ok: false,
      reason: "unsupported_version",
    });
  });
});
